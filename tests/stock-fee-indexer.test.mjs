import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createStockFeeIndexer, STOCK_QUARANTINE } from '../src/stock-fee-indexer.mjs'
import { StockFeeLockBusyError } from '../src/stock-fee-accrual.mjs'
import { StockCurveMigratedError, StockEvidenceUnmatchedError } from '../src/stock-trade-evidence.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'

// The worker's stock-pair curve indexer (docs/STOCK_QUOTES.md) with an in-memory database: nothing on the stock pool is ever
// skipped silently. Unmatched evidence is quarantined and retried; anything else stops the market with an ERROR.
const META = quoteAssetById('meta-xstock')
const market = { repoId: '94911145', mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(),
  launchSignature: 'launch', creatorWallet: Keypair.generate().publicKey.toBase58(), quoteAssetId: META.assetId, quoteMint: META.mint }

function fakeDatabase() {
  const state = { cursor: null, alerts: [], fees: new Map(), marketQueries: [], migration: null }
  const query = async (sql, params = []) => {
    if (/advisory/.test(sql)) return { rows: [{ locked: true }] }
    if (/^select github_repo_id::text as "repoId"/.test(sql)) { state.marketQueries.push(sql); return { rows: [market] } }
    if (/^select last_signature/.test(sql)) return { rows: state.cursor ? [state.cursor] : [] }
    // The graduation job's proof of the curve's migration (src/stock-graduation-monitor.mjs).
    if (/^select migration_signature as signature, slot::text as slot from stock_graduation_events/.test(sql)) {
      assert.deepEqual(params, [market.repoId])
      return { rows: state.migration ? [state.migration] : [] }
    }
    if (/^insert into stock_pool_cursors/.test(sql)) {
      assert.deepEqual([params[0], params[1]], [market.pool, market.repoId])
      state.cursor = { last_signature: params[2], last_slot: params[3] }
      return { rows: [] }
    }
    if (/^insert into graduation_alerts/.test(sql)) {
      if (state.alerts.some(alert => alert.eventKey === params[0])) return { rows: [], rowCount: 0 }
      state.alerts.push({ id: state.alerts.length + 1, eventKey: params[0], repoId: params[1], kind: params[2], detail: params[3], acknowledgedBy: null })
      return { rows: [], rowCount: 1 }
    }
    if (/^select id, detail from graduation_alerts/.test(sql)) return { rows: state.alerts
      .filter(alert => alert.kind === params[0] && alert.repoId === params[1] && !alert.acknowledgedBy) }
    if (/^update graduation_alerts/.test(sql)) {
      const alert = state.alerts.find(candidate => candidate.id === params[0]); if (alert) alert.acknowledgedBy = 'stock-fee-indexer'
      return { rows: [], rowCount: 1 }
    }
    throw Error(`Unexpected SQL in fake database: ${sql}`)
  }
  return { state, query, connect: async () => ({ query, release() {} }) }
}

function harness(history, { curve = async () => ({}) } = {}) {
  const db = fakeDatabase()
  let fixed = false, reads = 0
  const credited = []
  const accrual = { checkCurve: curve, recordTradeFees: async ({ githubRepoId, signatures: [signature], allowNonSwap, migration = null }) => {
    assert.deepEqual([githubRepoId, allowNonSwap], [market.repoId, true])
    credited.push({ signature, migration: migration?.signature ?? null })
    if (signature === 'unmatched' && !fixed) throw new StockEvidenceUnmatchedError(['instruction 3: an unknown DBC instruction names the pool'])
    if (signature === 'rpc-down') throw Error('Solana RPC transaction read returned HTTP 503')
    if (signature === 'busy') throw new StockFeeLockBusyError(githubRepoId)
    if (signature === 'migration' && !migration) throw new StockCurveMigratedError()
    const key = `${signature}:0`, fresh = !db.state.fees.has(key)
    db.state.fees.set(key, 10n)
    return { creditedBaseUnits: fresh ? 10n : 0n, creditedPartnerUnits: fresh ? 4n : 0n, eventKeys: [key] }
  } }
  const connection = { getSignaturesForAddress: async () => { reads++; return history } }
  const indexer = createStockFeeIndexer({ pool: db, connection, config: Keypair.generate().publicKey.toBase58(), accrual })
  return { db, indexer, fix: () => { fixed = true }, reads: () => reads, credited }
}
const item = (signature, slot, err = null) => ({ signature, slot, err })

test('only stock-paired markets are listed', async () => {
  const { db, indexer } = harness([item('launch', 1)])
  await indexer.runOnce()
  assert.match(db.state.marketQueries[0], /and quote_asset_id is not null order by github_repo_id/)
})

test('unmatched evidence is quarantined for review, later trades keep being credited, and it is credited once fixed', async t => {
  const logged = t.mock.method(console, 'error', () => {})
  const { db, indexer, fix } = harness([item('good-2', 5), item('failed', 4, { InstructionError: [0, 'x'] }), item('unmatched', 3), item('good-1', 2), item('launch', 1)])
  const [first] = await indexer.runOnce()
  assert.deepEqual([first.status, first.discovered, first.creditedBaseUnits, first.creditedPartnerUnits, first.quarantined],
    ['OK', 4, 30n, 12n, ['unmatched']])
  assert.deepEqual(first.cursorAfter, { signature: 'good-2', slot: '5' })
  assert.deepEqual([...db.state.fees.keys()].sort(), ['good-1:0', 'good-2:0', 'launch:0'])
  assert.equal(db.state.alerts.length, 1)
  assert.deepEqual({ ...db.state.alerts[0], detail: JSON.parse(db.state.alerts[0].detail) }, { id: 1, eventKey: `stock-fee-quarantine:${market.pool}:unmatched`,
    repoId: market.repoId, kind: STOCK_QUARANTINE, acknowledgedBy: null, detail: { code: 'STOCK_FEE_EVIDENCE_UNPARSEABLE', pool: market.pool,
      quoteMint: META.mint, signature: 'unmatched', slot: '3',
      reason: 'Stock curve evidence is not fully matched: instruction 3: an unknown DBC instruction names the pool' } })
  assert.equal(STOCK_QUARANTINE, 'STOCK_FEE_EVIDENCE_QUARANTINED')
  assert.equal(logged.mock.callCount(), 1)
  // Re-running: nothing credited twice, the alert neither duplicated nor logged again.
  const [second] = await indexer.runOnce()
  assert.deepEqual([second.creditedBaseUnits, second.quarantined, db.state.alerts.length, logged.mock.callCount()], [0n, ['unmatched'], 1, 1])
  // Once the parser can match it, the quarantined trade is credited once and its alert closed.
  fix()
  const [third] = await indexer.runOnce()
  assert.deepEqual([third.creditedBaseUnits, third.quarantined, db.state.alerts[0].acknowledgedBy], [10n, [], 'stock-fee-indexer'])
  assert.equal((await indexer.runOnce())[0].creditedBaseUnits, 0n)
})

test('an RPC failure or a migration in the history stops the market with an ERROR; the cursor stays before it', async () => {
  for (const [signature, error] of [['rpc-down', /HTTP 503/], ['migration', /migrating or migrated/]]) {
    const { db, indexer } = harness([item('after', 4), item(signature, 3), item('good', 2), item('launch', 1)])
    const [result] = await indexer.runOnce()
    assert.equal(result.status, 'ERROR')
    assert.match(result.error, error)
    assert.deepEqual([db.state.cursor.last_signature, db.state.alerts.length, db.state.fees.has('after:0')], ['good', 0, false])
  }
})

test("the market's lock held past the accrual's bounded wait is BUSY, not an ERROR: the cursor stays after the last credited trade", async () => {
  const { db, indexer, credited } = harness([item('after', 4), item('busy', 3), item('good', 2), item('launch', 1)])
  const [result] = await indexer.runOnce()
  assert.deepEqual(result, { githubRepoId: market.repoId, pool: market.pool, quoteAssetId: market.quoteAssetId, status: 'BUSY' })
  assert.deepEqual([db.state.cursor.last_signature, db.state.alerts.length, db.state.fees.has('after:0')], ['good', 0, false])
  assert.deepEqual(credited.map(c => c.signature), ['launch', 'good', 'busy'])
})

test('a missing stock config or a changed or migrated curve is an ERROR before any history is read', async () => {
  for (const refusal of [Error('Stock-paired market has no registered config'), new StockCurveMigratedError(), Error('Canonical stock DBC pool state does not match market')]) {
    const { db, indexer, reads } = harness([item('good', 2), item('launch', 1)], { curve: async repoId => { assert.equal(repoId, market.repoId); throw refusal } })
    const [result] = await indexer.runOnce()
    assert.deepEqual([result.status, result.error, result.quoteAssetId, reads(), db.state.cursor, db.state.fees.size], ['ERROR', refusal.message, META.assetId, 0, null, 0])
  }
})

test('a cursor missing from the finalized history is an ERROR, never a skip', async () => {
  const { db, indexer } = harness([item('good', 2)])
  const [result] = await indexer.runOnce()
  assert.equal(result.status, 'ERROR')
  assert.match(result.error, /history does not contain cursor or launch signature/)
  assert.equal(db.state.fees.size, 0)
})

test('a migrated curve is finished once its migration is proven: the swaps up to and in it credited, the cursor stops on it, GRADUATED', async () => {
  const history = [item('claim', 6), item('migration', 5), item('good-2', 4), item('good-1', 3), item('launch', 1)]
  const checks = []
  const { db, indexer, reads, credited } = harness(history, { curve: async (repoId, _executor, migration = null) => {
    assert.equal(repoId, market.repoId)
    checks.push(migration?.signature ?? null)
    if (!migration) throw new StockCurveMigratedError()
  } })
  // Not proven yet by the graduation job: an ERROR before any history is read, as before.
  let [result] = await indexer.runOnce()
  assert.deepEqual([result.status, result.error, reads(), db.state.cursor], ['ERROR', new StockCurveMigratedError().message, 0, null])
  // Proven: every transaction up to the migration is credited with the proof, the migration itself too (a swap may be bundled
  // into it), never the curve's later fee claims.
  db.state.migration = { signature: 'migration', slot: '5' }
  ;[result] = await indexer.runOnce()
  assert.deepEqual([result.status, result.migration, result.creditedBaseUnits, result.cursorAfter], ['GRADUATED', 'migration', 40n, { signature: 'migration', slot: '5' }])
  assert.deepEqual(credited, ['launch', 'good-1', 'good-2', 'migration'].map(signature => ({ signature, migration: 'migration' })))
  assert.deepEqual(checks, [null, null, 'migration'])
  // From then on the market is GRADUATED here without reading its history again.
  const before = reads()
  ;[result] = await indexer.runOnce()
  assert.deepEqual([result.status, result.creditedBaseUnits, result.discovered, reads(), credited.length], ['GRADUATED', 0n, 0, before, 4])
})
