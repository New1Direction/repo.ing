import test from 'node:test'
import assert from 'node:assert/strict'
import { createLedgerAlerts } from '../src/ledger-alerts.mjs'
import { RECONCILE_BEHIND_HOLD_MS, RECONCILE_HOLD_MS, RECONCILE_REPEAT_MS, RECONCILE_STALE_MS } from '../src/reconcile.mjs'

const PASS_MS = 80_000
const marketOf = id => ({ githubRepoId: String(id), mint: `mint${id}`, pool: `pool${id}`, fullName: `local/market-${id}` })
const MATCH = { status: 'MATCH', difference: 0n }, ahead = { status: 'MISMATCH', difference: -5n }, behind = { status: 'MISMATCH', difference: 5n }
// The alert feed: a row is stored once per event key, and rows can be marked as cleared.
function store() {
  const rows = new Map(), failing = { clear: false }
  const feed = repoId => ({
    record: async (key, detail) => {
      const eventKey = `${repoId ?? 'protocol'}:${key}`
      if (rows.has(eventKey)) return null
      const row = { id: rows.size + 1, eventKey, detail: { ...detail } }
      rows.set(eventKey, row)
      return row
    },
    clear: async (ids, at) => {
      if (failing.clear) throw Error('connect ECONNREFUSED')
      for (const row of rows.values()) if (ids.includes(row.id)) row.detail.clearedAt = at
    },
  })
  return { rows, feed, failing, of: prefix => [...rows.values()].filter(row => row.eventKey.startsWith(prefix)).map(row => row.detail) }
}
function monitor(options = {}) {
  const clock = { at: Date.parse('2026-10-05T08:00:00.000Z') }
  return { clock, alerts: createLedgerAlerts({ now: () => clock.at, ...options }), ...store() }
}
// Runs passes until `until`; each pass does what `each()` does. Returns the rows stored per pass.
async function passes({ clock, alerts, rows }, until, each, passMs = PASS_MS) {
  const stored = []
  while (clock.at < until) {
    clock.at = Math.min(until, clock.at + passMs)
    const before = rows.size
    alerts.beginPass()
    await each()
    stored.push({ at: clock.at, rows: rows.size - before })
  }
  return stored
}
const iso = at => new Date(at).toISOString(), queued = at => ({ status: 'digest', queuedAt: iso(at) })

test('a market whose ledger stays unmatched is recorded once, at the hold, for the next ledger message', async () => {
  const m = monitor(), began = m.clock.at
  const market = marketOf(7)
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 5 * PASS_MS, () => m.alerts.market(m.feed(7), market).settle(ahead, '2026-10-05T08:00:30.000Z'))
  assert.deepEqual(stored.filter(pass => pass.rows).map(pass => pass.rows), [1])
  const raisedAt = stored.find(pass => pass.rows).at
  assert.deepEqual([...m.rows.keys()], [`7:fees:${began + PASS_MS}:difference:0`])
  assert.deepEqual(m.of('7:'), [{ ledger: 'fees', status: 'MISMATCH', reason: null, lagging: false, difference: '-5', fullName: 'local/market-7',
    observedAt: '2026-10-05T08:00:30.000Z', url: 'https://repo.ing/token/mint7', kind: 'difference', repeat: false, since: iso(began + PASS_MS), delivery: queued(raisedAt) }])
  // A ledger that matches is never recorded.
  await passes(m, m.clock.at + 2 * RECONCILE_HOLD_MS, () => m.alerts.market(m.feed(8), marketOf(8)).settle(MATCH))
  assert.deepEqual(m.of('8:'), [])
})

test('a ledger that is behind the chain with nothing recorded is recorded after an hour, by the same monitor', async () => {
  const m = monitor(), began = m.clock.at
  await passes(m, began + RECONCILE_BEHIND_HOLD_MS - 1, () => m.alerts.market(m.feed(7), marketOf(7)).settle(behind))
  assert.deepEqual(m.of('7:'), [])
  await passes(m, began + RECONCILE_BEHIND_HOLD_MS + 2 * PASS_MS, () => m.alerts.market(m.feed(7), marketOf(7)).settle(behind))
  assert.deepEqual(m.of('7:').map(detail => [detail.status, detail.lagging, detail.kind, detail.difference]), [['MISMATCH', true, 'behind', '5']])
})

test('a market whose pass keeps ending in review is recorded as itself, whichever step failed; its fee ledger keeps its own finding', async () => {
  const m = monitor(), began = m.clock.at
  const until = began + RECONCILE_HOLD_MS + 2 * PASS_MS
  await passes(m, until, async () => {
    // Its chain read keeps failing: the pass never reaches the ledger.
    await m.alerts.market(m.feed(1), marketOf(1)).failed('RPC_UNAVAILABLE', true)
    // Its pool is not the market's: the state read refuses it.
    await m.alerts.market(m.feed(2), marketOf(2)).failed('CONFIG_OR_POOL_MISMATCH', false)
    // Its ledger matched; a later step of the pass fails every time.
    const third = m.alerts.market(m.feed(3), marketOf(3))
    await third.settle(MATCH)
    await third.failed('LP_SETTLEMENT_MISMATCH', false)
    // Its ledger does not match, and a later step fails too: two findings.
    const fourth = m.alerts.market(m.feed(4), marketOf(4))
    await fourth.settle(ahead)
    await fourth.failed('STALE_PROGRESS', true)
    // Verified, with a matching ledger: nothing.
    const fifth = m.alerts.market(m.feed(5), marketOf(5))
    await fifth.settle(MATCH)
    await fifth.verified()
  })
  const shape = detail => [detail.ledger, detail.status, detail.reason, detail.lagging, detail.kind]
  assert.deepEqual(m.of('1:').map(shape), [['market', 'UNAVAILABLE', 'RPC_UNAVAILABLE', true, 'unchecked']])
  assert.deepEqual(m.of('2:').map(shape), [['market', 'ERROR', 'CONFIG_OR_POOL_MISMATCH', false, 'unchecked']])
  assert.deepEqual(m.of('3:').map(shape), [['market', 'ERROR', 'LP_SETTLEMENT_MISMATCH', false, 'unchecked']])
  assert.deepEqual(m.of('4:').map(shape).sort(), [['fees', 'MISMATCH', null, false, 'difference'], ['market', 'UNAVAILABLE', 'STALE_PROGRESS', true, 'unchecked']])
  assert.deepEqual(m.of('5:'), [])
  const [pass] = m.of('1:')
  assert.deepEqual([pass.fullName, pass.url, pass.since, pass.delivery.status], ['local/market-1', 'https://repo.ing/token/mint1', iso(began + PASS_MS), 'digest'])
  assert.match(pass.observedAt, /^2026-10-05T08:1\d:\d\d\.000Z$/)
  assert.deepEqual([...m.rows.keys()].filter(key => key.startsWith('4:')).sort(), [`4:fees:${began + PASS_MS}:difference:0`, `4:market:${began + PASS_MS}:unchecked:0`])
})

test('a pass that failed does not touch the fee ledger: a ledger that is only behind keeps its hour', async () => {
  const m = monitor(), began = m.clock.at
  const pass = async () => {
    const market = m.alerts.market(m.feed(5), marketOf(5))
    await market.settle(behind)
    await market.failed('STALE_PROGRESS', true)
  }
  await passes(m, began + RECONCILE_HOLD_MS + 5 * PASS_MS, pass)
  assert.deepEqual(m.of('5:').map(detail => detail.ledger), ['market'], 'the pass is recorded; the ledger is still inside its hour')
  await passes(m, began + RECONCILE_BEHIND_HOLD_MS + 2 * PASS_MS, pass)
  assert.deepEqual(m.of('5:fees:').map(detail => [detail.status, detail.reason, detail.lagging, detail.kind]), [['MISMATCH', null, true, 'behind']])
})

test('a pass that verifies again ends its episode; one failed pass in between is nothing', async () => {
  const m = monitor(), began = m.clock.at
  // Fails for most of the hold, verifies once, fails again for most of the hold: never recorded.
  let pass = 0
  await passes(m, began + 3 * 3_600_000, async () => {
    const market = m.alerts.market(m.feed(6), marketOf(6))
    if (pass++ % 10 === 9) await market.verified()
    else await market.failed('RPC_RATE_LIMITED', true)
  })
  assert.deepEqual(m.of('6:'), [])
})

test('an outage that touches every market records every market, and none of them is sent by itself', async () => {
  const m = monitor(), began = m.clock.at, markets = Array.from({ length: 52 }, (_, i) => marketOf(100 + i))
  const outage = () => Promise.all(markets.map(market => m.alerts.market(m.feed(market.githubRepoId), market).failed('EVIDENCE_UNAVAILABLE', false)))
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 4 * PASS_MS, outage)
  assert.deepEqual(stored.filter(pass => pass.rows).map(pass => pass.rows), [52], 'every market crosses the hold in the same pass')
  assert.deepEqual([...new Set([...m.rows.values()].map(row => row.detail.delivery.status))], ['digest'])
  assert.deepEqual([...m.rows.keys()].filter(key => key.startsWith('protocol:')), [], 'no row of the monitor own beside them')
  // While it lasts each is recorded again once per repeat period, as a repeat.
  const later = await passes(m, began + RECONCILE_HOLD_MS + RECONCILE_REPEAT_MS + 2 * PASS_MS, outage)
  assert.deepEqual(later.filter(pass => pass.rows).map(pass => pass.rows), [52])
  assert.equal(m.rows.size, 104)
  assert.deepEqual([...m.rows.values()].map(row => row.detail.repeat).filter(Boolean).length, 52)
})

test('two workers that both watch a ledger each record it; the same worker never records it twice', async () => {
  const m = monitor(), began = m.clock.at
  // A second worker that started half a minute later: its episode has its own start, so its row has its own key.
  const second = { at: 0 }, twin = createLedgerAlerts({ now: () => second.at })
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 4 * PASS_MS, async () => {
    await m.alerts.market(m.feed(1), marketOf(1)).settle(ahead)
    second.at = m.clock.at + 30_000
    await twin.market(m.feed(1), marketOf(1)).settle(ahead)
  })
  assert.equal(stored.reduce((sum, pass) => sum + pass.rows, 0), 2, 'one row each; the ledger message counts the ledger once (tests/ledger-digest.test.mjs)')
  assert.equal(new Set(m.of('1:').map(detail => detail.since)).size, 2)
})

test('a ledger that matches again is marked cleared on every row its episode recorded', async () => {
  const m = monitor(), began = m.clock.at
  const market = () => m.alerts.market(m.feed(7), marketOf(7))
  await passes(m, began + RECONCILE_HOLD_MS + RECONCILE_REPEAT_MS + 2 * PASS_MS, () => market().settle(ahead))
  assert.deepEqual(m.of('7:').map(detail => [detail.repeat, detail.clearedAt]), [[false, undefined], [true, undefined]])
  m.clock.at += PASS_MS
  await market().settle(MATCH)
  const clearedAt = iso(m.clock.at)
  assert.deepEqual(m.of('7:').map(detail => detail.clearedAt), [clearedAt, clearedAt])
  // Marked once: later matching passes change nothing, and a new episode's row starts uncleared.
  m.clock.at += PASS_MS
  await market().settle(MATCH)
  assert.deepEqual(m.of('7:').map(detail => detail.clearedAt), [clearedAt, clearedAt])
  await passes(m, m.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, () => market().settle(ahead))
  assert.deepEqual(m.of('7:').map(detail => detail.clearedAt), [clearedAt, clearedAt, undefined])
  // The same for a market's pass, the checks and the platform ledgers.
  const others = monitor(), revenue = { status: 'MISMATCH', problems: [] }, liquidity = { status: 'MATCH', problems: [] }
  await passes(others, others.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => {
    await others.alerts.market(others.feed(3), marketOf(3)).failed('RPC_UNAVAILABLE', true)
    await others.alerts.checks(others.feed(null), 'RPC_UNAVAILABLE')
    await others.alerts.platform(others.feed(null), { revenue, liquidity })
  })
  assert.equal(others.rows.size, 3)
  others.clock.at += PASS_MS
  await others.alerts.market(others.feed(3), marketOf(3)).verified()
  await others.alerts.checks(others.feed(null), null)
  await others.alerts.platform(others.feed(null), { revenue: { status: 'MATCH' }, liquidity })
  assert.deepEqual([...others.rows.values()].map(row => row.detail.clearedAt), Array(3).fill(iso(others.clock.at)))
})

test('marking as cleared never fails the pass that found the match, and is done by the next matching pass', async () => {
  const m = monitor(), began = m.clock.at
  const market = () => m.alerts.market(m.feed(7), marketOf(7))
  await passes(m, began + RECONCILE_HOLD_MS + 2 * PASS_MS, () => market().settle(ahead))
  m.failing.clear = true
  m.clock.at += PASS_MS
  assert.equal(await market().settle(MATCH), null)
  assert.deepEqual(m.of('7:').map(detail => detail.clearedAt), [undefined])
  m.failing.clear = false
  m.clock.at += PASS_MS
  await market().settle(MATCH)
  assert.deepEqual(m.of('7:').map(detail => detail.clearedAt), [iso(m.clock.at)])
})

test('the monitor not getting through its markets is recorded after the hold; a pass that does ends it', async () => {
  const m = monitor(), began = m.clock.at
  await passes(m, began + RECONCILE_HOLD_MS - 1, () => m.alerts.checks(m.feed(null), 'RPC_UNAVAILABLE'))
  assert.deepEqual(m.of('protocol:checks:'), [])
  const stored = await passes(m, began + RECONCILE_HOLD_MS + 3 * PASS_MS, () => m.alerts.checks(m.feed(null), 'RPC_UNAVAILABLE'))
  const raisedAt = stored.find(pass => pass.rows).at
  assert.deepEqual(m.of('protocol:checks:'), [{ ledger: 'checks', reason: 'RPC_UNAVAILABLE', observedAt: iso(raisedAt), kind: 'unchecked', repeat: false,
    since: iso(began + PASS_MS), delivery: queued(raisedAt) }])
  // It gets through again, then fails briefly: nothing new.
  await passes(m, m.clock.at + PASS_MS, () => m.alerts.checks(m.feed(null), null))
  const resumed = m.clock.at
  await passes(m, m.clock.at + 5 * PASS_MS, () => m.alerts.checks(m.feed(null), 'RPC_RATE_LIMITED'))
  assert.equal(m.of('protocol:checks:').length, 1)
  // That brief failure started a new episode: if it lasts, it is recorded with its own start, not the old one's.
  await passes(m, resumed + RECONCILE_HOLD_MS + 2 * PASS_MS, () => m.alerts.checks(m.feed(null), 'RPC_RATE_LIMITED'))
  assert.deepEqual(m.of('protocol:checks:').map(detail => [detail.reason, detail.since]),
    [['RPC_UNAVAILABLE', iso(began + PASS_MS)], ['RPC_RATE_LIMITED', iso(resumed + PASS_MS)]])
})

test('the platform ledgers are recorded after the hold, with what does not match', async () => {
  const m = monitor(), began = m.clock.at
  const revenue = { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] }, liquidity = { status: 'MATCH', problems: [] }
  await passes(m, began + RECONCILE_HOLD_MS + 3 * PASS_MS, () => m.alerts.platform(m.feed(null), { revenue, liquidity }))
  // First seen on the first pass; recorded on the first pass at least the hold later.
  const raisedAt = began + PASS_MS * Math.ceil((PASS_MS + RECONCILE_HOLD_MS) / PASS_MS)
  assert.deepEqual(m.of('protocol:platform:'), [{ ledger: 'platform', revenue: 'MISMATCH', liquidity: 'MATCH', problems: ['Allocations exceed claimed platform revenue'],
    observedAt: iso(raisedAt), kind: 'difference', repeat: false, since: iso(began + PASS_MS), delivery: queued(raisedAt) }])
  await passes(m, m.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, () => m.alerts.platform(m.feed(null), { revenue: { status: 'MATCH' }, liquidity }))
  assert.equal(m.of('protocol:platform:').length, 1)
  // Liquidity alone not matching is the platform ledger not matching too.
  const other = monitor()
  await passes(other, other.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, () => other.alerts.platform(other.feed(null), { revenue: { status: 'MATCH' }, liquidity: { status: 'MISMATCH', problems: ['x'] } }))
  assert.deepEqual(other.of('protocol:platform:').map(detail => [detail.revenue, detail.liquidity]), [['MATCH', 'MISMATCH']])
})

test('each thing the monitor watches is its own ledger: none ends, hides or renames another', async () => {
  const mismatch = { revenue: { status: 'MISMATCH', problems: [] }, liquidity: { status: 'MATCH', problems: [] } }
  // The checks pass every time while the platform ledger does not match: the platform ledger is still recorded.
  const m = monitor()
  await passes(m, m.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => { await m.alerts.checks(m.feed(null), null); await m.alerts.platform(m.feed(null), mismatch) })
  assert.deepEqual([m.of('protocol:platform:').length, m.of('protocol:checks:').length], [1, 0])
  // Both from the same pass, for the same time: two rows.
  const both = monitor()
  await passes(both, both.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => { await both.alerts.checks(both.feed(null), 'RPC_UNAVAILABLE'); await both.alerts.platform(both.feed(null), mismatch) })
  assert.deepEqual([both.of('protocol:platform:').length, both.of('protocol:checks:').length], [1, 1])
  assert.equal(both.rows.size, 2)
  // A market's pass verifying does not end its fee ledger's episode, and a matching ledger does not end a failing pass.
  const market = monitor()
  await passes(market, market.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => {
    const one = market.alerts.market(market.feed(1), marketOf(1))
    await one.settle(ahead)
    await one.verified()
    const two = market.alerts.market(market.feed(2), marketOf(2))
    await two.settle(MATCH)
    await two.failed('RPC_UNAVAILABLE', true)
  })
  assert.deepEqual([market.of('1:').map(detail => detail.ledger), market.of('2:').map(detail => detail.ledger)], [['fees'], ['market']])
  // A market whose repository id reads like one of the monitor's own ledgers is still a market.
  const named = monitor()
  await passes(named, named.clock.at + RECONCILE_HOLD_MS + 2 * PASS_MS, async () => {
    await named.alerts.checks(named.feed(null), null)
    await named.alerts.platform(named.feed(null), { revenue: { status: 'MATCH' }, liquidity: { status: 'MATCH' } })
    await named.alerts.market(named.feed('checks'), { ...marketOf(9), githubRepoId: 'checks' }).settle(ahead)
    await named.alerts.market(named.feed('platform'), { ...marketOf(9), githubRepoId: 'platform' }).failed('RPC_UNAVAILABLE', true)
  })
  assert.deepEqual([named.of('checks:').length, named.of('platform:').length], [1, 1])
})

test('slow passes do not end every episode on every pass: the stale limit follows the pass cadence', async () => {
  // A provider that hangs on one read makes a pass over the markets take thirteen minutes, longer than the fixed stale limit.
  const SLOW_PASS_MS = 13 * 60_000
  assert.ok(SLOW_PASS_MS > RECONCILE_STALE_MS)
  const m = monitor(), began = m.clock.at
  const stored = await passes(m, began + 3 * 3_600_000, () => m.alerts.market(m.feed(7), marketOf(7)).settle(ahead), SLOW_PASS_MS)
  assert.equal(stored.reduce((sum, pass) => sum + pass.rows, 0), 1)
  assert.equal(m.of('7:')[0].since, iso(began + 2 * SLOW_PASS_MS), 'one episode, from the pass on which the new pace was known')
  // A real gap is still a gap: after passes at the usual pace, nothing settles the ledger for an hour, and the episode is over.
  const gap = monitor(), start = gap.clock.at
  await passes(gap, start + 10 * PASS_MS, () => gap.alerts.market(gap.feed(7), marketOf(7)).settle(ahead))
  gap.clock.at += 3_600_000
  const after = await passes(gap, gap.clock.at + 5 * PASS_MS, () => gap.alerts.market(gap.feed(7), marketOf(7)).settle(ahead))
  assert.deepEqual(after.map(pass => pass.rows), [0, 0, 0, 0, 0], 'a new hold starts when the passes resume')
})
