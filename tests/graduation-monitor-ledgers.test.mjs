import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createGraduationMonitor } from '../src/graduation-readiness.mjs'
import { RECONCILE_BEHIND_HOLD_MS, RECONCILE_HOLD_MS } from '../src/reconcile.mjs'

// The graduation monitor's ledger alerts, end to end through runOnce, with the chain and the database replaced by stand-ins:
// which step of a pass settles which ledger. tests/graduation-readiness.test.mjs runs the same monitor on a validator.
const PASS_MS = 80_000, LEDGER = 'RECONCILIATION_MISMATCH'
const MATCH = { status: 'MATCH', difference: 0n }, ahead = { status: 'MISMATCH', difference: -5n }, behind = { status: 'MISMATCH', difference: 5n }
const key = () => Keypair.generate().publicKey.toBase58()
const marketOf = id => ({ githubRepoId: String(id), mint: key(), pool: key(), creatorWallet: key(), fullName: `local/market-${id}` })
// A verified curve market far from graduation, read just now.
const stateOf = (market, age = 0) => ({ repoId: market.githubRepoId, mint: market.mint, curve: market.pool, config: 'config', phase: 'CURVE', status: 'bonding',
  reserveLamports: '1000000000', thresholdLamports: '85000000000', remainingLamports: '84000000000', progressPercent: 1.17, slots: [10, 10],
  checkedAt: new Date(Date.now() - age).toISOString(), chainTime: new Date(Date.now() - age).toISOString(), migration: null, partnerWallet: null, platform: null, destination: null })

// What the monitor asks of PostgreSQL: the market's advisory lock, its alert feed (one row per event key) and the reads of a
// curve market's pass. Everything else it writes is accepted.
function database() {
  const alerts = new Map(), busy = new Set(), fault = { on: null }
  const query = async (sql, params = []) => {
    if (fault.on?.(sql)) throw Error('connect ECONNREFUSED 10.0.0.5:5432')
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: !busy.has(params[0]) }] }
    if (sql.startsWith('insert into graduation_alerts')) {
      const [eventKey, repoId, kind, detail] = params
      if (alerts.has(eventKey)) return { rows: [] }
      alerts.set(eventKey, { repoId, kind, detail: JSON.parse(detail) })
      return { rows: [{ id: alerts.size, kind, repoId, createdAt: new Date() }] }
    }
    if (sql.includes('as lifetime')) return { rows: [{ lifetime: '0', damm24h: '0' }] }
    if (sql.includes('count(*)::int as count')) return { rows: [{ count: 0 }] }
    return { rows: [] }
  }
  const ledgerRows = prefix => [...alerts].filter(([eventKey, row]) => row.kind === LEDGER && eventKey.startsWith(`${prefix}:${LEDGER}:`)).map(([, row]) => row.detail)
  return { alerts, busy, fault, ledgerRows, query, connect: async () => ({ query, release() {} }) }
}

function world({ markets = [marketOf(7)], ...options } = {}) {
  const clock = { at: Date.parse('2026-10-05T08:00:00.000Z') }, db = database()
  // What each pass finds; a test changes these between passes.
  const found = { chain: null, ledgers: null, state: market => stateOf(market), reconcile: () => MATCH,
    revenue: { status: 'MATCH', problems: [] }, liquidity: { status: 'MATCH', problems: [] } }
  const rpc = () => ({ rpcEndpoint: 'http://127.0.0.1:8899', getGenesisHash: async () => 'genesis', getSlot: async () => { if (found.chain) throw Error(found.chain); return 1 } })
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

test('a market whose ledger stops matching is recorded after the hold, on the monitor clock; one that matches never is', async () => {
  const w = world({ markets: [marketOf(7), marketOf(8)] }), began = w.clock.at
  w.found.reconcile = repoId => repoId === '7' ? ahead : MATCH
  const read = []
  w.found.state = market => { const state = stateOf(market); read.push(state.checkedAt); return state }
  const before = await passes(w, began + RECONCILE_HOLD_MS)
  assert.deepEqual(before.at(-1).map(result => [result.repoId, result.status, result.reconciliation]), [['7', 'VERIFIED', 'MISMATCH'], ['8', 'VERIFIED', 'MATCH']])
  assert.deepEqual(w.db.ledgerRows('7'), [], 'held')
  const after = await passes(w, began + RECONCILE_HOLD_MS + 3 * PASS_MS)
  const [row] = w.db.ledgerRows('7')
  assert.deepEqual([row.ledger, row.status, row.lagging, row.fullName, row.since, row.delivery.status], ['fees', 'MISMATCH', false, 'local/market-7', iso(began + PASS_MS), 'digest'])
  assert.equal(w.db.ledgerRows('7').length, 1)
  assert.ok(read.includes(row.observedAt), 'checked when its chain state was read')
  assert.deepEqual(w.db.ledgerRows('8'), [])
  // The pass that recorded it reports it with that market.
  assert.deepEqual(after.map(pass => pass[0].alerts.filter(alert => alert.kind === LEDGER).length), [1, 0, 0])
  assert.deepEqual([...w.db.alerts.values()].filter(alert => alert.kind === LEDGER).length, 1, 'and nothing beside it')
})

test('holdMs is the monitor own hold: with none, a ledger is recorded on the pass that finds it', async () => {
  const w = world({ holdMs: 0 })
  w.found.reconcile = () => ahead
  const [pass] = await passes(w, w.clock.at + PASS_MS)
  assert.equal(pass[0].alerts.filter(alert => alert.kind === LEDGER).length, 1)
})

test('a market the pass cannot read is recorded as unchecked after the hold, in fixed words', async () => {
  const w = world({ markets: [marketOf(1), marketOf(2), marketOf(3)] }), began = w.clock.at
  w.found.state = market => {
    if (market.githubRepoId === '1') throw Error('RPC_UNAVAILABLE')
    if (market.githubRepoId === '2') throw Error('CONFIG_OR_POOL_MISMATCH')
    throw Error('Unexpected response from https://rpc.example/?api-key=secret')
  }
  const results = await passes(w, began + RECONCILE_HOLD_MS + 2 * PASS_MS)
  assert.deepEqual(results.at(-1).map(result => [result.status, result.code]), [['REVIEW', 'RPC_UNAVAILABLE'], ['REVIEW', 'CONFIG_OR_POOL_MISMATCH'], ['REVIEW', 'EVIDENCE_UNAVAILABLE']])
  assert.deepEqual(w.db.ledgerRows('1').map(row => [row.status, row.reason, row.lagging]), [['UNAVAILABLE', 'RPC_UNAVAILABLE', true]])
  assert.deepEqual(w.db.ledgerRows('2').map(row => [row.status, row.reason, row.lagging]), [['ERROR', 'CONFIG_OR_POOL_MISMATCH', false]])
  assert.deepEqual(w.db.ledgerRows('3').map(row => [row.status, row.reason, row.lagging]), [['ERROR', 'EVIDENCE_UNAVAILABLE', false]])
  assert.doesNotMatch(JSON.stringify([...w.db.alerts.values()]), /secret|rpc\.example/)
  // Reads that come back before the hold never get that far.
  const brief = world(), start = brief.clock.at
  brief.found.state = () => { throw Error('RPC_RATE_LIMITED') }
  await passes(brief, start + RECONCILE_HOLD_MS - 2 * PASS_MS)
  brief.found.state = market => stateOf(market)
  await passes(brief, start + 3 * RECONCILE_HOLD_MS)
  assert.deepEqual(brief.db.ledgerRows('7'), [])
})

test('the ledger is settled as soon as it is read: a later step of the pass failing does not make it unchecked', async () => {
  // The state is too old by the end of the pass (STALE_PROGRESS), every pass, while the ledger itself is only behind the chain.
  const w = world(), began = w.clock.at
  w.found.state = market => stateOf(market, 3_600_000)
  w.found.reconcile = () => behind
  const results = await passes(w, began + RECONCILE_HOLD_MS + 5 * PASS_MS)
  assert.deepEqual(results.at(-1).map(result => [result.status, result.code]), [['REVIEW', 'STALE_PROGRESS']])
  assert.deepEqual(w.db.ledgerRows('7'), [], 'only behind: held for the hour, not recorded as unchecked')
  await passes(w, began + RECONCILE_BEHIND_HOLD_MS + 3 * PASS_MS)
  assert.deepEqual(w.db.ledgerRows('7').map(row => [row.status, row.reason, row.lagging]), [['MISMATCH', null, true]])
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
  const [row] = w.db.ledgerRows('protocol')
  assert.deepEqual([row.ledger, row.reason, row.since, row.delivery.status], ['checks', 'RPC_UNAVAILABLE', iso(began + PASS_MS), 'digest'])
  assert.deepEqual([w.db.ledgerRows('protocol').length, w.db.ledgerRows('7').length, w.db.ledgerRows('8').length], [1, 0, 0])
  assert.equal(results.filter(pass => pass[0].alerts.some(alert => alert.kind === LEDGER)).length, 1, 'reported by the pass that recorded it')
  // It verifies again: that episode is over. A short failure later starts another, which is recorded only if it lasts, with
  // its own start.
  w.found.chain = null
  const recovered = await passes(w, w.clock.at + 2 * PASS_MS)
  assert.deepEqual(recovered.at(-1).map(result => result.status), ['VERIFIED', 'VERIFIED'])
  const again = w.clock.at
  w.found.chain = 'RPC_RATE_LIMITED'
  await passes(w, again + 5 * PASS_MS)
  assert.equal(w.db.ledgerRows('protocol').length, 1)
  await passes(w, again + RECONCILE_HOLD_MS + 2 * PASS_MS)
  assert.deepEqual(w.db.ledgerRows('protocol').map(row => [row.reason, row.since]), [['RPC_UNAVAILABLE', iso(began + PASS_MS)], ['RPC_RATE_LIMITED', iso(again + PASS_MS)]])
})

test('when the monitor own ledger reads fail the pass still fails, and no ledger being checked is recorded after the hold', async () => {
  const w = world(), began = w.clock.at
  const unread = 'relation "platform_revenue_policies" does not exist'
  w.found.ledgers = unread
  const results = await passes(w, began + RECONCILE_HOLD_MS + 2 * PASS_MS)
  for (const result of results) assert.equal(result?.message, unread, 'the pass rejects with the read failure, as before')
  assert.deepEqual(w.db.ledgerRows('protocol').map(row => [row.ledger, row.reason, row.since]), [['checks', 'LEDGER_READS_FAILED', iso(began + PASS_MS)]])
  assert.doesNotMatch(JSON.stringify([...w.db.alerts.values()]), /relation|platform_revenue_policies/)
  // Recording it failing too never replaces the error the pass reports.
  const down = world({ holdMs: 0 })
  down.found.ledgers = unread
  down.db.fault.on = sql => sql.startsWith('insert into graduation_alerts')
  const [failed] = await passes(down, down.clock.at + PASS_MS)
  assert.equal(failed?.message, unread)
  // The reads work again: the markets are checked and the episode is over. Failing again is a new one.
  w.found.ledgers = null
  const recovered = await passes(w, w.clock.at + PASS_MS)
  assert.deepEqual(recovered.at(-1).map(result => result.status), ['VERIFIED'])
  const again = w.clock.at
  w.found.ledgers = unread
  await passes(w, again + 5 * PASS_MS)
  assert.equal(w.db.ledgerRows('protocol').length, 1)
  await passes(w, again + RECONCILE_HOLD_MS + 2 * PASS_MS)
  assert.deepEqual(w.db.ledgerRows('protocol').map(row => row.since), [iso(began + PASS_MS), iso(again + PASS_MS)])
})

test('the platform ledgers are checked every pass and recorded after the hold', async () => {
  const w = world(), began = w.clock.at
  w.found.revenue = { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] }
  const results = await passes(w, began + RECONCILE_HOLD_MS + 3 * PASS_MS)
  assert.deepEqual(w.db.ledgerRows('protocol').map(row => [row.ledger, row.revenue, row.liquidity, row.problems, row.since, row.delivery.status]),
    [['platform', 'MISMATCH', 'MATCH', ['Allocations exceed claimed platform revenue'], iso(began + PASS_MS), 'digest']])
  // Reported once, after the markets, by the pass that recorded it.
  const reported = results.filter(pass => pass.some(result => result.repoId === null))
  assert.equal(reported.length, 1)
  assert.deepEqual(reported[0].map(result => [result.repoId, result.status, result.alerts.length]), [['7', 'VERIFIED', 0], [null, 'REVIEW', 1]])
  // The market beside it matched all along.
  assert.deepEqual(w.db.ledgerRows('7'), [])
})
