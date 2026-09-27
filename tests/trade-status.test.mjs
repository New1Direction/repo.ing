import test from 'node:test'
import assert from 'node:assert/strict'
import { tradeStatus } from '../app/lib/trade-status.mjs'

const signature = 'signed-trade'
const connection = (found, blockHeight = 120) => ({
  getSignatureStatuses: async () => ({ value: [found] }),
  getBlockHeight: async () => blockHeight,
})

test('only a verified swap gets the detailed confirmed result', async () => {
  const session = { signature, prepared: { lastValidBlockHeight: 100 },
    engine: { verifyTrade: async () => ({ tokenDelta: 12_345_678n, solDelta: -10_000_000n }) } }
  assert.deepEqual(await tradeStatus(connection({ confirmationStatus: 'confirmed', err: null }), signature, session), {
    state: 'confirmed', signature, tokenDelta: '12345678', solDelta: '-10000000', feeIndexing: 'pending',
  })
  session.engine.verifyTrade = async () => { throw new Error('transaction details unavailable') }
  assert.deepEqual(await tradeStatus(connection({ confirmationStatus: 'confirmed', err: null }), signature, session),
    { state: 'chainConfirmed', signature })
})

test('a chain error is a failure; an unseen signed trade stays pending until expiry', async () => {
  assert.deepEqual(await tradeStatus(connection({ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }), signature),
    { state: 'failed', signature })
  assert.deepEqual(await tradeStatus(connection(null, 120), signature, null, 110), { state: 'pending', signature })
  assert.deepEqual(await tradeStatus(connection(null, 131), signature, null, 110), { state: 'expired', signature })
})

test('a completed submit result survives a temporary RPC read failure', async () => {
  const result = { state: 'confirmed', signature, tokenDelta: '42', solDelta: '-1000', feeIndexing: 'recorded' }
  const unavailable = { getSignatureStatuses: async () => { throw new Error('RPC unavailable') } }
  assert.equal(await tradeStatus(unavailable, signature, { signature, result }), result)
})
