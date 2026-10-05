import test from 'node:test'
import assert from 'node:assert/strict'
import { createLedgerAlerts, LEDGER_PAGES_PER_PASS } from '../src/ledger-alerts.mjs'
import { RECONCILE_HOLD_MS, RECONCILE_REPEAT_MS } from '../src/reconcile.mjs'
import { pendingDelivery } from '../src/reserve-alerts.mjs'

const PASS_MS = 80_000
const marketOf = id => ({ githubRepoId: String(id), mint: `mint${id}`, pool: `pool${id}`, fullName: `local/market-${id}` })
const MATCH = { status: 'MATCH', difference: 0n }, ahead = { status: 'MISMATCH', difference: -5n }
// The alert feed's unique event key: a row is stored once.
function feed() {
  const rows = new Map()
  const emit = repoId => async (key, detail) => {
    const eventKey = `${repoId ?? 'protocol'}:${key}`
    if (rows.has(eventKey)) return null
    rows.set(eventKey, detail)
    return { id: rows.size, eventKey }
  }
  return { rows, emit, of: prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, detail]) => detail) }
}
function monitor(options = {}) {
  const clock = { at: Date.parse('2026-10-05T08:00:00.000Z') }
  return { clock, alerts: createLedgerAlerts({ now: () => clock.at, ...options }), ...feed() }
}
// Runs passes until `until`; each pass settles what `each(pass)` does and finishes. Returns the rows stored per pass.
async function passes({ clock, alerts, rows }, until, each) {
  const stored = []
  while (clock.at < until) {
    clock.at = Math.min(until, clock.at + PASS_MS)
    const before = rows.size, pass = alerts.beginPass()
    await each(pass)
    stored.push({ at: clock.at, summary: await pass.finish(feedSummary), rows: rows.size - before })
  }
  return stored
}
let feedSummary

test('a market whose ledger stays unmatched gets one alert at the hold, sent to the operator', async () => {
  const m = monitor(), began = m.clock.at
  feedSummary = m.emit(null)
  const market = marketOf(7)
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 5 * PASS_MS, pass => pass.market(m.emit(7), market).settle(ahead, '2026-10-05T08:00:30.000Z'))
  assert.equal(stored.reduce((sum, pass) => sum + pass.rows, 0), 1)
  const [detail] = m.of('7:')
  assert.deepEqual({ ledger: detail.ledger, status: detail.status, lagging: detail.lagging, fullName: detail.fullName, url: detail.url, observedAt: detail.observedAt },
    { ledger: 'fees', status: 'MISMATCH', lagging: false, fullName: 'local/market-7', url: 'https://repo.ing/token/mint7', observedAt: '2026-10-05T08:00:30.000Z' })
  assert.equal(detail.since, new Date(began + PASS_MS).toISOString())
  assert.equal(detail.delivery.status, 'pending')
  // A ledger that matches is never alerted.
  await passes(m, m.clock.at + 2 * RECONCILE_HOLD_MS, pass => pass.market(m.emit(8), marketOf(8)).settle(MATCH))
  assert.deepEqual(m.of('8:'), [])
})

test('a pass that fails before it reads the ledger leaves it unchecked; a failure after the ledger was read is about something else', async () => {
  const m = monitor(), began = m.clock.at
  feedSummary = m.emit(null)
  const until = began + RECONCILE_HOLD_MS + 2 * PASS_MS
  await passes(m, until, async pass => {
    // Its chain read keeps failing.
    await pass.market(m.emit(1), marketOf(1)).fail('RPC_UNAVAILABLE', true)
    // Its pool is not the market's: the state read refuses it before the ledger is reached.
    await pass.market(m.emit(2), marketOf(2)).fail('CONFIG_OR_POOL_MISMATCH', false)
    // Its ledger matched; a later step of the pass failed.
    const third = pass.market(m.emit(3), marketOf(3))
    await third.settle(MATCH)
    await third.fail('LP_SETTLEMENT_MISMATCH', false)
    // Its ledger does not match, and a later step failed too: the ledger's own finding stands.
    const fourth = pass.market(m.emit(4), marketOf(4))
    await fourth.settle(ahead)
    await fourth.fail('STALE_PROGRESS', true)
  })
  const one = m.of('1:'), two = m.of('2:'), four = m.of('4:')
  assert.deepEqual([one.length, two.length, m.of('3:').length, four.length], [1, 1, 0, 1])
  assert.deepEqual([one[0].status, one[0].reason, one[0].lagging], ['UNAVAILABLE', 'RPC_UNAVAILABLE', true])
  assert.deepEqual([two[0].status, two[0].reason, two[0].lagging], ['ERROR', 'CONFIG_OR_POOL_MISMATCH', false])
  assert.deepEqual([four[0].status, four[0].reason, four[0].lagging], ['MISMATCH', null, false])
  // Without a state read there is no observation time: the alert carries the pass's own.
  assert.match(one[0].observedAt, /^2026-10-05T08:1\d:\d\d\.000Z$/)
})

test('an outage that touches every market sends a few alerts and one summary; the rest are recorded unsent', async () => {
  const m = monitor(), began = m.clock.at, markets = Array.from({ length: 52 }, (_, i) => marketOf(100 + i))
  feedSummary = m.emit(null)
  const outage = pass => Promise.all(markets.map(market => pass.market(m.emit(market.githubRepoId), market).fail('EVIDENCE_UNAVAILABLE', false)))
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 4 * PASS_MS, outage)
  const crossing = stored.filter(pass => pass.rows > 0)
  assert.equal(crossing.length, 1, 'every market crosses the hold in the same pass')
  assert.equal(crossing[0].rows, 53, '52 market alerts and their summary')
  const details = markets.flatMap(market => m.of(`${market.githubRepoId}:`))
  assert.equal(details.filter(detail => detail.delivery.status === 'pending').length, LEDGER_PAGES_PER_PASS)
  assert.deepEqual(details.filter(detail => detail.delivery.status !== 'pending').map(detail => detail.delivery), Array(52 - LEDGER_PAGES_PER_PASS).fill({ status: 'off', reason: 'SUMMARIZED' }))
  const [summary] = m.of('protocol:summary:')
  assert.deepEqual({ ledger: summary.ledger, count: summary.count, status: summary.delivery.status }, { ledger: 'summary', count: 52 - LEDGER_PAGES_PER_PASS, status: 'pending' })
  // While it lasts nothing more is sent until the repeat period, and then again a few and one summary.
  const later = await passes(m, began + RECONCILE_HOLD_MS + RECONCILE_REPEAT_MS + 2 * PASS_MS, outage)
  assert.deepEqual(later.filter(pass => pass.rows > 0).map(pass => pass.rows), [53])
  assert.equal(m.of('protocol:summary:').length, 2)
  const sent = [...m.rows.values()].filter(detail => detail.delivery.status === 'pending').length
  assert.equal(sent, 2 * (LEDGER_PAGES_PER_PASS + 1))
})

test('an alert that already exists is not counted against the pass: another worker raised it', async () => {
  const m = monitor({ pagesPerPass: 1 }), began = m.clock.at
  feedSummary = m.emit(null)
  const markets = [marketOf(1), marketOf(2)]
  // A second worker on the same clock stores market 1's alert first, every pass.
  const twin = createLedgerAlerts({ now: () => m.clock.at, pagesPerPass: 1 })
  const settle = async (pass, list) => { for (const market of list) await pass.market(m.emit(market.githubRepoId), market).settle(ahead) }
  while (m.clock.at < began + RECONCILE_HOLD_MS + 2 * PASS_MS) {
    m.clock.at += PASS_MS
    const other = twin.beginPass(), mine = m.alerts.beginPass()
    await settle(other, [markets[0]])
    await settle(mine, markets)
    assert.equal(await other.finish(m.emit(null)), null)
    assert.equal(await mine.finish(m.emit(null)), null, 'nothing was left unsent')
  }
  assert.deepEqual([m.of('1:').length, m.of('2:').length], [1, 1])
  assert.deepEqual([m.of('1:')[0].delivery.status, m.of('2:')[0].delivery.status], ['pending', 'pending'])
})

test('the chain checks failing for the hold raise one alert; a pass that can verify the chain ends it', async () => {
  const m = monitor(), began = m.clock.at
  feedSummary = m.emit(null)
  await passes(m, began + RECONCILE_HOLD_MS - 1, pass => pass.checks(m.emit(null), 'RPC_UNAVAILABLE'))
  assert.deepEqual(m.of('protocol:checks:'), [])
  await passes(m, began + RECONCILE_HOLD_MS + 3 * PASS_MS, pass => pass.checks(m.emit(null), 'RPC_UNAVAILABLE'))
  const [checks] = m.of('protocol:checks:')
  assert.deepEqual({ ledger: checks.ledger, reason: checks.reason, since: checks.since, status: checks.delivery.status },
    { ledger: 'checks', reason: 'RPC_UNAVAILABLE', since: new Date(began + PASS_MS).toISOString(), status: 'pending' })
  assert.equal(m.of('protocol:checks:').length, 1)
  // It verifies again, then fails briefly: no new alert.
  await passes(m, m.clock.at + PASS_MS, pass => pass.checks(m.emit(null), null))
  await passes(m, m.clock.at + 5 * PASS_MS, pass => pass.checks(m.emit(null), 'RPC_RATE_LIMITED'))
  assert.equal(m.of('protocol:checks:').length, 1)
})

test('the platform ledgers alert after the hold, with what does not match', async () => {
  const m = monitor(), began = m.clock.at
  feedSummary = m.emit(null)
  const revenue = { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] }, liquidity = { status: 'MATCH', problems: [] }
  await passes(m, began + RECONCILE_HOLD_MS + 3 * PASS_MS, pass => pass.platform(m.emit(null), { revenue, liquidity }))
  // First seen on the first pass; raised on the first pass at least the hold later.
  const raisedAt = began + PASS_MS * Math.ceil((PASS_MS + RECONCILE_HOLD_MS) / PASS_MS)
  assert.deepEqual(m.of('protocol:platform:'), [{ ledger: 'platform', revenue: 'MISMATCH', liquidity: 'MATCH', problems: ['Allocations exceed claimed platform revenue'],
    since: new Date(began + PASS_MS).toISOString(), observedAt: new Date(raisedAt).toISOString(), delivery: pendingDelivery(raisedAt) }])
  await passes(m, m.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, pass => pass.platform(m.emit(null), { revenue: { status: 'MATCH' }, liquidity }))
  assert.equal(m.of('protocol:platform:').length, 1)
})
