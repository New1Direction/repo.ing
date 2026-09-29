import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { UnparseableTradeError } from '../src/trade-evidence.mjs'

const market = { repoId: '42', mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(),
  launchSignature: 'launch', creatorWallet: Keypair.generate().publicKey.toBase58() }

// Just enough of Postgres for the indexer's statements: cursors, alerts, fee rows.
function fakeDatabase() {
  const state = { cursor: null, alerts: [], fees: new Map() }
  const query = async (sql, params = []) => {
    if (/advisory/.test(sql)) return { rows: [{ locked: true }] }
    if (/^select github_repo_id::text as "repoId"/.test(sql)) return { rows: [market] }
    if (/from fee_events f/.test(sql)) return { rows: [] }
    if (/^select last_signature/.test(sql)) return { rows: state.cursor ? [state.cursor] : [] }
    if (/^insert into pool_fee_cursors/.test(sql)) { state.cursor = { last_signature: params[1], last_slot: params[2] }; return { rows: [] } }
    if (/^insert into graduation_alerts/.test(sql)) {
      if (state.alerts.some(alert => alert.eventKey === params[0])) return { rows: [], rowCount: 0 }
      state.alerts.push({ id: state.alerts.length + 1, eventKey: params[0], repoId: params[1], kind: params[2], detail: params[3], acknowledgedBy: null })
      return { rows: [], rowCount: 1 }
    }
    if (/^select id, detail from graduation_alerts/.test(sql)) return { rows: state.alerts
      .filter(alert => alert.kind === params[0] && alert.repoId === params[1] && !alert.acknowledgedBy) }
    if (/^update graduation_alerts/.test(sql)) {
      const alert = state.alerts.find(alert => alert.id === params[0]); if (alert) alert.acknowledgedBy = 'external-fee-indexer'
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected SQL in fake database: ${sql}`)
  }
  return { state, query, connect: async () => ({ query, release() {} }) }
}

function harness(history) {
  const db = fakeDatabase()
  let fixed = false
  const accrual = { recordTradeFees: async ({ signatures: [signature] }) => {
    if (signature === 'bad' && !fixed) throw new UnparseableTradeError('Trade bad has no canonical DBC creator-fee event')
    if (signature === 'rpc-down') throw new Error('Solana RPC transaction read returned HTTP 503')
    const key = `${signature}:0:dbc_creator_quote`, fresh = !db.state.fees.has(key)
    db.state.fees.set(key, 10n)
    return { creditedBaseUnits: fresh ? 10n : 0n, eventKeys: [key] }
  } }
  const connection = { getSignaturesForAddress: async () => history }
  const indexer = createExternalFeeIndexer({ pool: db, connection, config: {}, accrual,
    recordTrade: async () => 1, graduatedFees: { read: async () => null } })
  return { db, indexer, fix: () => { fixed = true } }
}
const item = (signature, slot) => ({ signature, slot, err: null })

test('an unparseable trade is quarantined for review and later trades keep being credited', async t => {
  const logged = t.mock.method(console, 'error', () => {})
  const { db, indexer, fix } = harness([item('good-2', 4), item('bad', 3), item('good-1', 2), item('launch', 1)])
  const [first] = await indexer.runOnce()
  assert.equal(first.status, 'OK')
  assert.equal(first.creditedBaseUnits, 30n)
  assert.deepEqual(first.quarantined, ['bad'])
  assert.equal(db.state.cursor.last_signature, 'good-2')
  assert.deepEqual([...db.state.fees.keys()].sort(), ['good-1:0:dbc_creator_quote', 'good-2:0:dbc_creator_quote', 'launch:0:dbc_creator_quote'])
  assert.equal(db.state.alerts.length, 1)
  assert.equal(db.state.alerts[0].kind, 'FEE_EVIDENCE_QUARANTINED')
  assert.deepEqual(JSON.parse(db.state.alerts[0].detail), { code: 'FEE_EVIDENCE_UNPARSEABLE', pool: market.pool, signature: 'bad',
    slot: '3', reason: 'Trade bad has no canonical DBC creator-fee event' })
  assert.equal(logged.mock.callCount(), 1)
  assert.match(logged.mock.calls[0].arguments[0], /bad .*no canonical DBC creator-fee event/)

  // Re-running is idempotent: nothing is credited twice, the alert is not duplicated or re-logged.
  const [second] = await indexer.runOnce()
  assert.deepEqual([second.creditedBaseUnits, second.quarantined, db.state.alerts.length, logged.mock.callCount()], [0n, ['bad'], 1, 1])

  // Once the parser can read it, the quarantined trade is credited once and its alert is closed.
  fix()
  const [third] = await indexer.runOnce()
  assert.deepEqual([third.creditedBaseUnits, third.quarantined, db.state.alerts[0].acknowledgedBy], [10n, [], 'external-fee-indexer'])
  const [fourth] = await indexer.runOnce()
  assert.equal(fourth.creditedBaseUnits, 0n)
})

test('transient failures still stop the pool without moving its cursor or quarantining', async () => {
  const { db, indexer } = harness([item('rpc-down', 2), item('launch', 1)])
  const [result] = await indexer.runOnce()
  assert.equal(result.status, 'ERROR')
  assert.match(result.error, /HTTP 503/)
  assert.equal(db.state.cursor.last_signature, 'launch')
  assert.equal(db.state.alerts.length, 0)
})
