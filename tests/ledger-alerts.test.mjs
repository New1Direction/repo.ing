import test from 'node:test'
import assert from 'node:assert/strict'
import { createLedgerAlerts } from '../src/ledger-alerts.mjs'
import { RECONCILE_BEHIND_HOLD_MS, RECONCILE_HOLD_MS, RECONCILE_REPEAT_MS } from '../src/reconcile.mjs'

const PASS_MS = 80_000
const marketOf = id => ({ githubRepoId: String(id), mint: `mint${id}`, pool: `pool${id}`, fullName: `local/market-${id}` })
const MATCH = { status: 'MATCH', difference: 0n }, ahead = { status: 'MISMATCH', difference: -5n }, behind = { status: 'MISMATCH', difference: 5n }
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
// Runs passes until `until`; each pass does what `each()` does. Returns the rows stored per pass.
async function passes({ clock, rows }, until, each) {
  const stored = []
  while (clock.at < until) {
    clock.at = Math.min(until, clock.at + PASS_MS)
    const before = rows.size
    await each()
    stored.push({ at: clock.at, rows: rows.size - before })
  }
  return stored
}
const queued = at => ({ status: 'digest', queuedAt: new Date(at).toISOString() })

test('a market whose ledger stays unmatched is recorded once, at the hold, for the next ledger message', async () => {
  const m = monitor(), began = m.clock.at
  const market = marketOf(7)
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 5 * PASS_MS, () => m.alerts.market(m.emit(7), market).settle(ahead, '2026-10-05T08:00:30.000Z'))
  assert.deepEqual(stored.filter(pass => pass.rows).map(pass => pass.rows), [1])
  const raisedAt = stored.find(pass => pass.rows).at
  assert.deepEqual(m.of('7:'), [{ ledger: 'fees', status: 'MISMATCH', reason: null, lagging: false, since: new Date(began + PASS_MS).toISOString(), difference: '-5',
    fullName: 'local/market-7', observedAt: '2026-10-05T08:00:30.000Z', url: 'https://repo.ing/token/mint7', delivery: queued(raisedAt) }])
  // A ledger that matches is never recorded.
  await passes(m, m.clock.at + 2 * RECONCILE_HOLD_MS, () => m.alerts.market(m.emit(8), marketOf(8)).settle(MATCH))
  assert.deepEqual(m.of('8:'), [])
})

test('a ledger that is only behind the chain is recorded after an hour, by the same monitor', async () => {
  const m = monitor(), began = m.clock.at
  await passes(m, began + RECONCILE_BEHIND_HOLD_MS - 1, () => m.alerts.market(m.emit(7), marketOf(7)).settle(behind))
  assert.deepEqual(m.of('7:'), [])
  await passes(m, began + RECONCILE_BEHIND_HOLD_MS + 2 * PASS_MS, () => m.alerts.market(m.emit(7), marketOf(7)).settle(behind))
  assert.deepEqual(m.of('7:').map(detail => [detail.status, detail.lagging, detail.difference]), [['MISMATCH', true, '5']])
})

test('a pass that fails before it reads the ledger leaves it unchecked; a failure after the ledger was read is about something else', async () => {
  const m = monitor(), began = m.clock.at
  const until = began + RECONCILE_HOLD_MS + 2 * PASS_MS
  await passes(m, until, async () => {
    // Its chain read keeps failing.
    await m.alerts.market(m.emit(1), marketOf(1)).fail('RPC_UNAVAILABLE', true)
    // Its pool is not the market's: the state read refuses it before the ledger is reached.
    await m.alerts.market(m.emit(2), marketOf(2)).fail('CONFIG_OR_POOL_MISMATCH', false)
    // Its ledger matched; a later step of the pass failed.
    const third = m.alerts.market(m.emit(3), marketOf(3))
    await third.settle(MATCH)
    await third.fail('LP_SETTLEMENT_MISMATCH', false)
    // Its ledger does not match, and a later step failed too: the ledger's own finding stands.
    const fourth = m.alerts.market(m.emit(4), marketOf(4))
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

test('a later step failing does not turn a ledger that is only behind into one that was never read', async () => {
  const m = monitor(), began = m.clock.at
  const pass = async () => {
    const ledger = m.alerts.market(m.emit(5), marketOf(5))
    await ledger.settle(behind)
    await ledger.fail('STALE_PROGRESS', true)
  }
  await passes(m, began + RECONCILE_HOLD_MS + 5 * PASS_MS, pass)
  assert.deepEqual(m.of('5:'), [], 'still the hour of a ledger that is only behind')
  await passes(m, began + RECONCILE_BEHIND_HOLD_MS + 2 * PASS_MS, pass)
  assert.deepEqual(m.of('5:').map(detail => [detail.status, detail.reason, detail.lagging]), [['MISMATCH', null, true]])
})

test('an outage that touches every market records every market, and none of them is sent by itself', async () => {
  const m = monitor(), began = m.clock.at, markets = Array.from({ length: 52 }, (_, i) => marketOf(100 + i))
  const outage = () => Promise.all(markets.map(market => m.alerts.market(m.emit(market.githubRepoId), market).fail('EVIDENCE_UNAVAILABLE', false)))
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 4 * PASS_MS, outage)
  assert.deepEqual(stored.filter(pass => pass.rows).map(pass => pass.rows), [52], 'every market crosses the hold in the same pass')
  assert.deepEqual([...new Set([...m.rows.values()].map(detail => detail.delivery.status))], ['digest'])
  assert.deepEqual([...m.rows.keys()].filter(key => key.startsWith('protocol:')), [], 'no row of the monitor own beside them')
  // While it lasts each is recorded again once per repeat period.
  const later = await passes(m, began + RECONCILE_HOLD_MS + RECONCILE_REPEAT_MS + 2 * PASS_MS, outage)
  assert.deepEqual(later.filter(pass => pass.rows).map(pass => pass.rows), [52])
  assert.equal(m.rows.size, 104)
})

test('an alert that already exists is not stored twice: another worker recorded it', async () => {
  const m = monitor(), began = m.clock.at
  const twin = createLedgerAlerts({ now: () => m.clock.at })
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => {
    assert.notEqual(await twin.market(m.emit(1), marketOf(1)).settle(ahead), undefined)
    const mine = await m.alerts.market(m.emit(1), marketOf(1)).settle(ahead)
    assert.equal(mine, null, 'the second to record gets nothing back')
  })
  assert.deepEqual(stored.filter(pass => pass.rows).map(pass => pass.rows), [1])
})

test('the monitor failing before it reaches any market is recorded after the hold; a pass that reaches them ends it', async () => {
  const m = monitor(), began = m.clock.at
  await passes(m, began + RECONCILE_HOLD_MS - 1, () => m.alerts.checks(m.emit(null), 'RPC_UNAVAILABLE'))
  assert.deepEqual(m.of('protocol:checks:'), [])
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 3 * PASS_MS, () => m.alerts.checks(m.emit(null), 'RPC_UNAVAILABLE'))
  const raisedAt = stored.find(pass => pass.rows).at
  assert.deepEqual(m.of('protocol:checks:'), [{ ledger: 'checks', reason: 'RPC_UNAVAILABLE', since: new Date(began + PASS_MS).toISOString(),
    observedAt: new Date(raisedAt).toISOString(), delivery: queued(raisedAt) }])
  // It reaches the markets again, then fails briefly: nothing new.
  await passes(m, m.clock.at + PASS_MS, () => m.alerts.checks(m.emit(null), null))
  const resumed = m.clock.at
  await passes(m, m.clock.at + 5 * PASS_MS, () => m.alerts.checks(m.emit(null), 'RPC_RATE_LIMITED'))
  assert.equal(m.of('protocol:checks:').length, 1)
  // That brief failure started a new episode: if it lasts, it is recorded with its own start, not the old one's.
  await passes(m, resumed + RECONCILE_HOLD_MS + 2 * PASS_MS, () => m.alerts.checks(m.emit(null), 'RPC_RATE_LIMITED'))
  assert.deepEqual(m.of('protocol:checks:').map(detail => [detail.reason, detail.since]),
    [['RPC_UNAVAILABLE', new Date(began + PASS_MS).toISOString()], ['RPC_RATE_LIMITED', new Date(resumed + PASS_MS).toISOString()]])
})

test('the platform ledgers are recorded after the hold, with what does not match', async () => {
  const m = monitor(), began = m.clock.at
  const revenue = { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] }, liquidity = { status: 'MATCH', problems: [] }
  await passes(m, began + RECONCILE_HOLD_MS + 3 * PASS_MS, () => m.alerts.platform(m.emit(null), { revenue, liquidity }))
  // First seen on the first pass; recorded on the first pass at least the hold later.
  const raisedAt = began + PASS_MS * Math.ceil((PASS_MS + RECONCILE_HOLD_MS) / PASS_MS)
  assert.deepEqual(m.of('protocol:platform:'), [{ ledger: 'platform', revenue: 'MISMATCH', liquidity: 'MATCH', problems: ['Allocations exceed claimed platform revenue'],
    since: new Date(began + PASS_MS).toISOString(), observedAt: new Date(raisedAt).toISOString(), delivery: queued(raisedAt) }])
  await passes(m, m.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, () => m.alerts.platform(m.emit(null), { revenue: { status: 'MATCH' }, liquidity }))
  assert.equal(m.of('protocol:platform:').length, 1)
  // Liquidity alone not matching is the platform ledger not matching too.
  const other = monitor()
  await passes(other, other.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, () => other.alerts.platform(other.emit(null), { revenue: { status: 'MATCH' }, liquidity: { status: 'MISMATCH', problems: ['x'] } }))
  assert.deepEqual(other.of('protocol:platform:').map(detail => [detail.revenue, detail.liquidity]), [['MATCH', 'MISMATCH']])
})

test('the platform ledgers and the monitor own checks are two ledgers: neither ends, hides or renames the other', async () => {
  const mismatch = { revenue: { status: 'MISMATCH', problems: [] }, liquidity: { status: 'MATCH', problems: [] } }
  // The checks pass every time while the platform ledger does not match: the platform ledger is still recorded.
  const m = monitor()
  await passes(m, m.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => { await m.alerts.checks(m.emit(null), null); await m.alerts.platform(m.emit(null), mismatch) })
  assert.deepEqual([m.of('protocol:platform:').length, m.of('protocol:checks:').length], [1, 0])
  // Both from the same pass, for the same time: two rows.
  const both = monitor()
  await passes(both, both.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => { await both.alerts.checks(both.emit(null), 'RPC_UNAVAILABLE'); await both.alerts.platform(both.emit(null), mismatch) })
  assert.deepEqual([both.of('protocol:platform:').length, both.of('protocol:checks:').length], [1, 1])
  assert.equal(both.rows.size, 2)
  // A market whose repository id reads like one of them is still its own ledger.
  const named = monitor()
  await passes(named, named.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => {
    await named.alerts.checks(named.emit(null), null)
    await named.alerts.market(named.emit('checks'), { ...marketOf(9), githubRepoId: 'checks' }).settle(ahead)
  })
  assert.equal(named.of('checks:').length, 1)
})
