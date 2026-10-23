import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestTradingHandler } from '../src/existing-market-test-trading.mjs'

test('submission defaults off even for a named test session', async () => {
  const handle = createTestTradingHandler({ run: { load() { throw Error('must not load') } } })
  await assert.rejects(handle({ action: 'submit', id: 'known', transaction: 'unsigned' }), /disabled/)
})

test('finalized accounting failure never advances a run; finalized exact-message and fee checks precede accounting', async () => {
  const message = Buffer.from('reviewed'), pending = { id: 'test', signature: 'sig', signedMessage: message.toString('base64'),
    record: { wallet: 'wallet', phase: 'graduated', githubRepoId: '1388219884' }, costs: { networkFee: '805000' }, gross: '3781880', before: { slot: '5' } }
  // Orchestration is exercised independently of the canonical receipt decoder.
  let receipt = null, records = 0, finishes = 0
  const run = { load: async () => ({ pending, state: { step: 2 } }), stop: async () => {},
    settle: async (_id, _evidence, account) => { const result = await account({}, pending); finishes++; return result } }
  const handle = createTestTradingHandler({ run, connection: { getTransaction: async (_sig, options) => {
    assert.equal(options.commitment, 'finalized'); return receipt
  } }, restore: () => ({ prepared: {}, engine: { verifyTrade: async () => ({ tokenDelta: 71n, solDelta: -15000n, slot: 10n }) } }),
  checkpoint: async () => ({ slot: '11' }), recordCheckpoint: async () => { records++; throw Error('ledger unavailable') } })
  const body = { action: 'status', id: 'test', signature: 'sig' }
  assert.equal((await handle(body)).state, 'pending')
  receipt = { slot: 10, transaction: { signatures: ['sig'], message: { serialize: () => message } }, meta: { err: null, fee: 805000, preBalances: [10000000], postBalances: [9985000] } }
  await assert.rejects(handle(body), /ledger unavailable/)
  assert.equal(records, 1); assert.equal(finishes, 0)
  receipt.meta.fee = 805001
  await assert.rejects(handle(body), /receipt/)
  assert.equal(records, 1)
  receipt.meta.fee = 805000
  receipt.transaction.message.serialize = () => Buffer.from('different')
  await assert.rejects(handle(body), /receipt/)
  assert.equal(records, 1)
  await assert.rejects(handle({ ...body, signature: 'other' }), /signature/)
})
