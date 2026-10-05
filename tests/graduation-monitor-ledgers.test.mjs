import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createGraduationMonitor } from '../src/graduation-readiness.mjs'
import { PUBLIC_GRADUATION_MAX_AGE_MS } from '../src/graduation-state.mjs'
import { RECONCILE_BEHIND_HOLD_MS, RECONCILE_HOLD_MS } from '../src/reconcile.mjs'

// The graduation monitor's operator alerts, end to end through runOnce, with the chain and the database replaced by
// stand-ins: which step of a pass settles what. tests/graduation-readiness.test.mjs runs the same monitor on a validator.
const PASS_MS = 80_000, LEDGER = 'RECONCILIATION_MISMATCH'
const MATCH = { status: 'MATCH', difference: 0n }, ahead = { status: 'MISMATCH', difference: -5n }, behind = { status: 'MISMATCH', difference: 5n }
const key = () => Keypair.generate().publicKey.toBase58()
const marketOf = id => ({ githubRepoId: String(id), mint: key(), pool: key(), creatorWallet: key(), fullName: `local/market-${id}` })
// A verified curve market far from graduation, read just now.
const stateOf = (market, { age = 0, reserve = '1000000000', slot = 10, ...extra } = {}) => ({ repoId: market.githubRepoId, mint: market.mint, curve: market.pool, config: 'config',
  phase: 'CURVE', status: 'bonding', reserveLamports: reserve, thresholdLamports: '85000000000', remainingLamports: '84000000000', progressPercent: 1.17, slots: [slot, slot],
  checkedAt: new Date(Date.now() - age).toISOString(), chainTime: new Date(Date.now() - age).toISOString(), migration: null, partnerWallet: null, platform: null, destination: null, ...extra })

// What the monitor asks of PostgreSQL: a market's advisory lock, its last observation, the alert feed (one row per event
// key, rows can be marked cleared) and the reads of a curve market's pass. Everything else it writes is accepted.
function database() {
  const alerts = new Map(), observations = new Map(), busy = new Set(), fault = { on: null, connect: null }
  const store = (eventKey, repoId, kind, detail) => {
    if (alerts.has(eventKey)) return { rows: [] }
    alerts.set(eventKey, { id: alerts.size + 1, repoId, kind, detail: JSON.parse(detail) })
    return { rows: [{ id: alerts.size, kind, repoId, createdAt: new Date() }] }
  }
  const query = async (sql, params = []) => {
    if (fault.on?.(sql)) throw Error('connect ECONNREFUSED 10.0.0.5:5432')
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: !busy.has(params[0]) }] }
    if (sql.startsWith('insert into graduation_alerts') && sql.includes("'RESERVE_MOVED'")) return store(params[0], params[1], 'RESERVE_MOVED', params[2])
    if (sql.startsWith('insert into graduation_alerts')) return store(...params)
    if (sql.startsWith('update graduation_alerts') && sql.includes('{clearedAt}')) {
      for (const alert of alerts.values()) if (params[0].includes(alert.id) && alert.kind === LEDGER) alert.detail.clearedAt = params[1]
      return { rows: [] }
    }
    if (sql.startsWith('insert into graduation_observations') && sql.includes("'VERIFIED'")) { observations.set(params[0], { github_repo_id: params[0], status: 'VERIFIED', observation: params[1], reconciliation: params[2] }); return { rows: [] } }
    if (sql.startsWith('select * from graduation_observations')) return { rows: observations.has(params[0]) ? [observations.get(params[0])] : [] }
    if (sql.includes('as lifetime')) return { rows: [{ lifetime: '0', damm24h: '0' }] }
    if (sql.includes('count(*)::int as count')) return { rows: [{ count: 0 }] }
    return { rows: [] }
  }
  // Rows of the ledger alert kind under one event-key prefix, e.g. '7:fees', '7:market', 'protocol:checks'.
  const recorded = prefix => { const [owner, ledger] = prefix.split(':'); return [...alerts].filter(([eventKey, row]) => row.kind === LEDGER && eventKey.startsWith(`${owner}:${LEDGER}:${ledger}:`)).map(([, row]) => row.detail) }
  const released = []
  const connect = async () => { if (fault.connect?.()) throw Error('remaining connection slots are reserved'); return { query, release(broken) { released.push(Boolean(broken)) } } }
  return { alerts, busy, fault, recorded, released, query, connect }
}

function world({ markets = [marketOf(7)], ...options } = {}) {
  const clock = { at: Date.parse('2026-10-05T08:00:00.000Z') }, db = database()
  // What each pass finds; a test changes these between passes.
  const found = { chain: null, ledgers: null, state: market => stateOf(market), reconcile: () => MATCH, balance: () => 1,
    revenue: { status: 'MATCH', problems: [] }, liquidity: { status: 'MATCH', problems: [] } }
  const rpc = () => ({ rpcEndpoint: 'http://127.0.0.1:8899', getGenesisHash: async () => 'genesis', getSlot: async () => { if (found.chain) throw Error(found.chain); return 1 },
    getBalance: async () => found.balance() })
  const monitor = createGraduationMonitor({ pool: db, connection: rpc(), verification: rpc(), config: key(), env: {}, now: () => clock.at,
    readState: async ({ market }) => found.state(market), reconciler: { reconcile: async repoId => found.reconcile(repoId) },
    readLedgers: async () => { if (found.ledgers) throw Error(found.ledgers); return { revenue: {}, reserve: {}, liquidity: found.liquidity, revenueCheck: found.revenue, markets } }, ...options })
  return { clock, db, found, markets, monitor }
}
// Runs passes until `until`. A pass that rejects is returned as its error.
async function passes({ clock, monitor }, until) {
  const results = []
  while (clock.at < until) {
    clock.at = Math.min(until, clock.at + PASS_MS)
    results.push(await monitor.runOnce().catch(error => error))
  }
  return results
}
const iso = at => new Date(at).toISOString()
const ledgerAlerts = pass => pass.flatMap(result => result.alerts).filter(alert => alert.kind === LEDGER).length

test('a market whose ledger stops matching is recorded after the hold, on the monitor clock; one that matches never is', async () => {
  const w = world({ markets: [marketOf(7), marketOf(8)] }), began = w.clock.at
  w.found.reconcile = repoId => repoId === '7' ? ahead : MATCH
  const read = []
  w.found.state = market => { const state = stateOf(market); read.push(state.checkedAt); return state }
  const before = await passes(w, began + RECONCILE_HOLD_MS)
  assert.deepEqual(before.at(-1).map(result => [result.repoId, result.status, result.reconciliation]), [['7', 'VERIFIED', 'MISMATCH'], ['8', 'VERIFIED', 'MATCH']])
  assert.deepEqual(w.db.recorded('7:fees'), [], 'held')
  const after = await passes(w, began + RECONCILE_HOLD_MS + 3 * PASS_MS)
  const [row] = w.db.recorded('7:fees')
  assert.deepEqual([row.ledger, row.status, row.lagging, row.kind, row.repeat, row.fullName, row.since, row.delivery.status],
    ['fees', 'MISMATCH', false, 'difference', false, 'local/market-7', iso(began + PASS_MS), 'digest'])
  assert.ok(read.includes(row.observedAt), 'checked when its chain state was read')
  // The pass that recorded it reports it with that market, and nothing else is recorded: both passes verify.
  assert.deepEqual(after.map(pass => ledgerAlerts([pass[0]])), [1, 0, 0])
  assert.deepEqual([...w.db.alerts.values()].filter(alert => alert.kind === LEDGER).length, 1)
  // It matches again: the row is marked cleared by the pass that found the match.
  w.found.reconcile = () => MATCH
  await passes(w, w.clock.at + PASS_MS)
  assert.equal(w.db.recorded('7:fees')[0].clearedAt, iso(w.clock.at))
})

test('holdMs is the monitor own hold: with none, a ledger is recorded on the pass that finds it', async () => {
  const w = world({ holdMs: 0 })
  w.found.reconcile = () => ahead
  const [pass] = await passes(w, w.clock.at + PASS_MS)
  assert.equal(ledgerAlerts(pass), 1)
})

test('a market whose pass keeps ending in review is recorded after the hold, in fixed words, and cleared when it verifies', async () => {
  const w = world({ markets: [marketOf(1), marketOf(2), marketOf(3)] }), began = w.clock.at
  w.found.state = market => {
    if (market.githubRepoId === '1') throw Error('RPC_UNAVAILABLE')
    if (market.githubRepoId === '2') throw Error('CONFIG_OR_POOL_MISMATCH')
    throw Error('Unexpected response from https://rpc.example/?api-key=secret')
  }
  const results = await passes(w, began + RECONCILE_HOLD_MS + 2 * PASS_MS)
  assert.deepEqual(results.at(-1).map(result => [result.status, result.code]), [['REVIEW', 'RPC_UNAVAILABLE'], ['REVIEW', 'CONFIG_OR_POOL_MISMATCH'], ['REVIEW', 'EVIDENCE_UNAVAILABLE']])
  const shape = row => [row.ledger, row.status, row.reason, row.lagging, row.kind, row.delivery.status]
  assert.deepEqual(w.db.recorded('1:market').map(shape), [['market', 'UNAVAILABLE', 'RPC_UNAVAILABLE', true, 'unchecked', 'digest']])
  assert.deepEqual(w.db.recorded('2:market').map(shape), [['market', 'ERROR', 'CONFIG_OR_POOL_MISMATCH', false, 'unchecked', 'digest']])
  assert.deepEqual(w.db.recorded('3:market').map(shape), [['market', 'ERROR', 'EVIDENCE_UNAVAILABLE', false, 'unchecked', 'digest']])
  assert.deepEqual([w.db.recorded('1:market')[0].fullName, w.db.recorded('1:market')[0].since], ['local/market-1', iso(began + PASS_MS)])
  // The ledgers were never read, so nothing is said about them.
  assert.deepEqual([1, 2, 3].flatMap(id => w.db.recorded(`${id}:fees`)), [])
  assert.doesNotMatch(JSON.stringify([...w.db.alerts.values()]), /secret|rpc\.example/)
  // The reads come back: each market verifies, and its row is cleared.
  w.found.state = market => stateOf(market)
  const recovered = await passes(w, w.clock.at + PASS_MS)
  assert.deepEqual(recovered.at(-1).map(result => result.status), ['VERIFIED', 'VERIFIED', 'VERIFIED'])
  assert.deepEqual([1, 2, 3].map(id => w.db.recorded(`${id}:market`)[0].clearedAt), Array(3).fill(iso(w.clock.at)))
  // Reads that come back before the hold never get that far.
  const brief = world(), start = brief.clock.at
  brief.found.state = () => { throw Error('RPC_RATE_LIMITED') }
  await passes(brief, start + RECONCILE_HOLD_MS - 2 * PASS_MS)
  brief.found.state = market => stateOf(market)
  await passes(brief, start + 3 * RECONCILE_HOLD_MS)
  assert.deepEqual([...brief.db.alerts.values()].filter(alert => alert.kind === LEDGER), [])
})

test('the ledger is settled as soon as it is read: a later step of the pass failing is recorded as the pass, not as the ledger', async () => {
  // The state is too old by the end of the pass (STALE_PROGRESS), every pass, while the ledger itself is only behind the chain.
  const w = world(), began = w.clock.at
  w.found.state = market => stateOf(market, { age: 3_600_000 })
  w.found.reconcile = () => behind
  const results = await passes(w, began + RECONCILE_HOLD_MS + 5 * PASS_MS)
  assert.deepEqual(results.at(-1).map(result => [result.status, result.code]), [['REVIEW', 'STALE_PROGRESS']])
  assert.deepEqual(w.db.recorded('7:market').map(row => [row.status, row.reason, row.lagging]), [['UNAVAILABLE', 'STALE_PROGRESS', true]])
  assert.deepEqual(w.db.recorded('7:fees'), [], 'only behind: the ledger keeps its hour')
  await passes(w, began + RECONCILE_BEHIND_HOLD_MS + 3 * PASS_MS)
  assert.deepEqual(w.db.recorded('7:fees').map(row => [row.status, row.reason, row.lagging, row.kind]), [['MISMATCH', null, true, 'behind']])
  // A step right after the ledger read fails (the verifier refuses the partner wallet's balance): the ledger's own finding
  // was already settled, and is recorded at its hold beside the failing pass.
  const refused = world(), start = refused.clock.at
  refused.found.state = market => stateOf(market, { partnerWallet: key() })
  refused.found.balance = () => { throw Error('RPC_UNAVAILABLE') }
  refused.found.reconcile = () => ahead
  const failing = await passes(refused, start + RECONCILE_HOLD_MS + 2 * PASS_MS)
  assert.deepEqual(failing.at(-1).map(result => [result.status, result.code]), [['REVIEW', 'RPC_UNAVAILABLE']])
  assert.deepEqual(refused.db.recorded('7:fees').map(row => [row.status, row.kind]), [['MISMATCH', 'difference']])
  assert.deepEqual(refused.db.recorded('7:market').map(row => [row.status, row.reason]), [['UNAVAILABLE', 'RPC_UNAVAILABLE']])
})

test('a market another pass holds is settled by that pass, not this one', async () => {
  const w = world(), began = w.clock.at
  w.found.reconcile = () => ahead
  w.db.busy.add('graduation:7')
  const results = await passes(w, began + 2 * RECONCILE_HOLD_MS)
  assert.deepEqual(results.at(-1).map(result => [result.repoId, result.status]), [['7', 'BUSY']])
  assert.deepEqual([...w.db.alerts.values()], [])
})

test('when the chain cannot be verified no market is read, and that is recorded by itself after the hold', async () => {
  const w = world({ markets: [marketOf(7), marketOf(8)] }), began = w.clock.at
  w.found.chain = 'RPC_UNAVAILABLE'
  const results = await passes(w, began + RECONCILE_HOLD_MS + 3 * PASS_MS)
  assert.deepEqual(results.at(-1).map(result => [result.repoId, result.status, result.code]), [[null, 'REVIEW', 'RPC_UNAVAILABLE']])
  const [row] = w.db.recorded('protocol:checks')
  assert.deepEqual([row.ledger, row.reason, row.kind, row.since, row.delivery.status], ['checks', 'RPC_UNAVAILABLE', 'unchecked', iso(began + PASS_MS), 'digest'])
  assert.deepEqual([...w.db.alerts.values()].filter(alert => alert.kind === LEDGER).length, 1, 'nothing about the markets themselves')
  assert.equal(results.filter(pass => ledgerAlerts(pass)).length, 1, 'reported by the pass that recorded it')
  // It verifies again: that episode is over and its row is cleared. A short failure later starts another, which is recorded
  // only if it lasts, with its own start.
  w.found.chain = null
  const recovered = await passes(w, w.clock.at + 2 * PASS_MS)
  assert.deepEqual(recovered.at(-1).map(result => result.status), ['VERIFIED', 'VERIFIED'])
  assert.equal(w.db.recorded('protocol:checks')[0].clearedAt, iso(w.clock.at - PASS_MS))
  const again = w.clock.at
  w.found.chain = 'RPC_RATE_LIMITED'
  await passes(w, again + 5 * PASS_MS)
  assert.equal(w.db.recorded('protocol:checks').length, 1)
  await passes(w, again + RECONCILE_HOLD_MS + 2 * PASS_MS)
  assert.deepEqual(w.db.recorded('protocol:checks').map(row => [row.reason, row.since]), [['RPC_UNAVAILABLE', iso(began + PASS_MS)], ['RPC_RATE_LIMITED', iso(again + PASS_MS)]])
})

test('when the monitor own ledger reads fail the pass still fails, and no market being checked is recorded after the hold', async () => {
  const w = world(), began = w.clock.at
  const unread = 'relation "platform_revenue_policies" does not exist'
  w.found.ledgers = unread
  const results = await passes(w, began + RECONCILE_HOLD_MS + 2 * PASS_MS)
  for (const result of results) assert.equal(result?.message, unread, 'the pass rejects with the read failure, as before')
  assert.deepEqual(w.db.recorded('protocol:checks').map(row => [row.ledger, row.reason, row.since]), [['checks', 'LEDGER_READS_FAILED', iso(began + PASS_MS)]])
  assert.doesNotMatch(JSON.stringify([...w.db.alerts.values()]), /relation|platform_revenue_policies/)
  assert.equal(results.at(-1).alertNotRecorded, undefined)
  // Recording it failing too never replaces the error the pass reports, and is carried on it by code.
  const down = world({ holdMs: 0 })
  down.found.ledgers = unread
  down.db.fault.on = sql => sql.startsWith('insert into graduation_alerts')
  const [failed] = await passes(down, down.clock.at + PASS_MS)
  assert.deepEqual([failed?.message, failed?.alertNotRecorded], [unread, 'Error'])
  // The reads work again: the markets are checked and the episode is over. Failing again is a new one.
  w.found.ledgers = null
  const recovered = await passes(w, w.clock.at + PASS_MS)
  assert.deepEqual(recovered.at(-1).map(result => result.status), ['VERIFIED'])
  const again = w.clock.at
  w.found.ledgers = unread
  await passes(w, again + 5 * PASS_MS)
  assert.equal(w.db.recorded('protocol:checks').length, 1)
  await passes(w, again + RECONCILE_HOLD_MS + 2 * PASS_MS)
  assert.deepEqual(w.db.recorded('protocol:checks').map(row => row.since), [iso(began + PASS_MS), iso(again + PASS_MS)])
})

test('a pass that dies between two markets leaves the rest unchecked, and that is recorded', async () => {
  // The pool has no connection for the second market, every pass: the first is processed, the third is never reached.
  const w = world({ markets: [marketOf(1), marketOf(2), marketOf(3)] }), began = w.clock.at
  let connects = 0
  w.db.fault.connect = () => ++connects % 2 === 0
  w.found.reconcile = repoId => repoId === '3' ? ahead : MATCH
  const results = await passes(w, began + RECONCILE_HOLD_MS + 2 * PASS_MS)
  for (const result of results) assert.equal(result?.message, 'remaining connection slots are reserved', 'the pass rejects with what stopped it')
  assert.deepEqual(w.db.recorded('protocol:checks').map(row => [row.reason, row.since]), [['MARKET_PASS_FAILED', iso(began + PASS_MS)]])
  assert.deepEqual(w.db.recorded('3:fees'), [], 'the market it never reached says nothing by itself')
  // The pass gets through again: the checks are running, and the third market's ledger starts its own hold.
  w.db.fault.connect = null
  const through = await passes(w, w.clock.at + PASS_MS)
  assert.deepEqual(through.at(-1).map(result => result.status), ['VERIFIED', 'VERIFIED', 'VERIFIED'])
  assert.equal(w.db.recorded('protocol:checks')[0].clearedAt, iso(w.clock.at))
})

test('a pass that takes longer than public progress lasts is recorded as too slow, though every market verified', async () => {
  const w = world(), began = w.clock.at
  // Reading the market takes twelve minutes of the monitor's clock: passes that far apart must still add up to one episode.
  w.found.state = market => { w.clock.at += 12 * 60_000; return stateOf(market) }
  const results = await passes(w, began + 3 * 3_600_000)
  assert.ok(results.every(pass => pass[0].status === 'VERIFIED'))
  assert.deepEqual(w.db.recorded('protocol:checks').map(row => [row.reason, row.kind]), [['PASS_TOO_SLOW', 'unchecked']])
  assert.deepEqual(w.db.recorded('7:market'), [])
  // At the limit exactly a pass is in time; back at its usual pace the row is cleared.
  const exact = world()
  exact.found.state = market => { exact.clock.at += PUBLIC_GRADUATION_MAX_AGE_MS; return stateOf(market) }
  await passes(exact, exact.clock.at + 3 * 3_600_000)
  assert.deepEqual(exact.db.recorded('protocol:checks'), [])
  w.found.state = market => stateOf(market)
  await passes(w, w.clock.at + PASS_MS)
  assert.equal(w.db.recorded('protocol:checks')[0].clearedAt, iso(w.clock.at))
})

test('a market lock that cannot be released costs its connection, not the pool: the connection is discarded', async () => {
  const w = world({ markets: [marketOf(1), marketOf(2)] })
  await passes(w, w.clock.at + PASS_MS)
  assert.deepEqual(w.db.released, [false, false], 'a connection whose unlock worked goes back to the pool')
  w.db.released.length = 0
  w.db.fault.on = sql => sql.includes('pg_advisory_unlock')
  const [failed] = await passes(w, w.clock.at + PASS_MS)
  assert.match(String(failed?.message), /ECONNREFUSED/)
  assert.deepEqual(w.db.released, [true], 'released as broken, so it cannot come back still holding the lock')
  // A market another pass holds was never locked here: nothing to unlock, and its connection is returned as it is.
  const busy = world()
  busy.db.busy.add('graduation:7')
  busy.db.fault.on = sql => sql.includes('pg_advisory_unlock')
  const [pass] = await passes(busy, busy.clock.at + PASS_MS)
  assert.deepEqual([pass[0].status, busy.db.released], ['BUSY', [false]])
})

test('the platform ledgers are checked every pass and recorded after the hold', async () => {
  const w = world(), began = w.clock.at
  w.found.revenue = { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] }
  const results = await passes(w, began + RECONCILE_HOLD_MS + 3 * PASS_MS)
  assert.deepEqual(w.db.recorded('protocol:platform').map(row => [row.ledger, row.revenue, row.liquidity, row.problems, row.kind, row.since, row.delivery.status]),
    [['platform', 'MISMATCH', 'MATCH', ['Allocations exceed claimed platform revenue'], 'difference', iso(began + PASS_MS), 'digest']])
  // Reported once, after the markets, by the pass that recorded it.
  const reported = results.filter(pass => pass.some(result => result.repoId === null))
  assert.equal(reported.length, 1)
  assert.deepEqual(reported[0].map(result => [result.repoId, result.status, result.alerts.length]), [['7', 'VERIFIED', 0], [null, 'REVIEW', 1]])
  // The market beside it matched and verified all along.
  assert.deepEqual([w.db.recorded('7:fees'), w.db.recorded('7:market'), w.db.recorded('protocol:checks')], [[], [], []])
})

test('a reserve move is recorded for the receiver only when reserve notifications are on', async () => {
  const moved = async env => {
    const w = world({ env })
    let slot = 10
    w.found.state = market => stateOf(market, { reserve: slot === 10 ? '1000000000' : '2000000000', slot: slot++ })
    await passes(w, w.clock.at + 2 * PASS_MS)
    return [...w.db.alerts.values()].filter(alert => alert.kind === 'RESERVE_MOVED').map(alert => alert.detail.delivery.status)
  }
  assert.deepEqual(await moved({}), [], 'reserve alerts off: nothing recorded')
  assert.deepEqual(await moved({ RESERVE_ALERTS_ENABLED: 'true' }), ['off'])
  assert.deepEqual(await moved({ RESERVE_ALERTS_ENABLED: 'true', RESERVE_MOVE_NOTIFICATIONS: 'false' }), ['off'])
  assert.deepEqual(await moved({ RESERVE_ALERTS_ENABLED: 'true', RESERVE_MOVE_NOTIFICATIONS: 'true' }), ['pending'])
})
