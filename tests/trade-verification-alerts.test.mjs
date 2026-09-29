import test from 'node:test'
import assert from 'node:assert/strict'
import { settleConfirmedTrade } from '../app/lib/trade-settlement.mjs'
import { TRADE_VERIFICATION_FAILED } from '../src/trade-verification-alerts.mjs'

// graduation_alerts semantics: unique event_key, insert ... on conflict do nothing.
function fakeDatabase() {
  const alerts = []
  return { alerts, query: async (sql, params) => {
    if (!/^insert into graduation_alerts/.test(sql)) throw new Error(`Unexpected SQL: ${sql}`)
    if (alerts.some(alert => alert.eventKey === params[0])) return { rows: [], rowCount: 0 }
    alerts.push({ eventKey: params[0], repoId: params[1], kind: params[2], detail: JSON.parse(params[3]) })
    return { rows: [], rowCount: 1 }
  } }
}
const finalizedChain = { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'finalized' }] }),
  getTransaction: async () => ({ slot: 1 }) }
const graduated = { phase: 'graduated', githubRepoId: '42', mint: 'Mint111', pool: 'Pool111' }
const curve = { githubRepoId: '7', mint: 'Mint222', pool: 'Pool222' }
const quiet = async fn => { const error = console.error; console.error = () => {}; try { return await fn() } finally { console.error = error } }

test('failed finalized DAMM verification is recorded once per signature as an operator alert', async () => {
  const db = fakeDatabase()
  const engine = { verifyTrade: async () => { throw new Error('Trade balances did not match') } }
  const settle = () => settleConfirmedTrade({ connection: finalizedChain, db, engine, prepared: graduated, signature: 'sigA', sleep: async () => {} })
  assert.deepEqual(await quiet(settle), { feeIndexing: 'pending', creatorFee: null })
  await quiet(settle)
  assert.equal(db.alerts.length, 1)
  assert.deepEqual(db.alerts[0], { eventKey: 'trade-verification:sigA', repoId: '42', kind: TRADE_VERIFICATION_FAILED,
    detail: { code: 'FINALIZED_VERIFICATION', signature: 'sigA', phase: 'graduated', mint: 'Mint111', pool: 'Pool111', reason: 'Trade balances did not match' } })
})

test('failed curve fee indexing is recorded; successful settlement records nothing', async () => {
  const db = fakeDatabase()
  const failing = await quiet(() => settleConfirmedTrade({ connection: finalizedChain, db, prepared: curve, signature: 'sigB', sleep: async () => {},
    recordFees: async () => { throw new Error('Fee evidence missing') } }))
  assert.equal(failing.feeIndexing, 'pending')
  assert.equal(db.alerts.length, 1)
  assert.equal(db.alerts[0].detail.code, 'FEE_INDEXING')
  assert.equal(db.alerts[0].detail.phase, 'curve')

  const ok = await settleConfirmedTrade({ connection: finalizedChain, db, prepared: curve, signature: 'sigC', sleep: async () => {},
    recordFees: async ({ signatures }) => { assert.deepEqual(signatures, ['sigC']); return { creditedBaseUnits: 12n } } })
  assert.deepEqual(ok, { feeIndexing: 'recorded', creatorFee: '12' })
  await settleConfirmedTrade({ connection: finalizedChain, db, engine: { verifyTrade: async () => ({}) }, prepared: graduated, signature: 'sigD', sleep: async () => {} })
  assert.equal(db.alerts.length, 1)
})

test('an alert store failure never changes the trader-facing result', async () => {
  const db = { query: async () => { throw new Error('database down') } }
  const result = await quiet(() => settleConfirmedTrade({ connection: finalizedChain, db, prepared: curve, signature: 'sigE', sleep: async () => {},
    recordFees: async () => { throw new Error('boom') } }))
  assert.deepEqual(result, { feeIndexing: 'pending', creatorFee: null })
})
