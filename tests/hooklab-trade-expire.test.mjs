// Closing a trade review that was never sent: the trade API's `expire` action (the lifecycle's expire(), as the launch API
// has it), the runtime's expiry proof wiring, and the panel's runner, which closes an expired never-sent review it finds
// pending instead of trying to send it. Nothing here signs or sends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInclusiveTradeHandler } from '../app/lib/hooklab-inclusive-trade.mjs'
import { tradeLifecycleSettings } from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
import { closeExpired, expiredUnsent, isFinal } from '../app/lib/hooklab-trade-runner.mjs'
import { provenFinalizedProgress } from '../src/hooklab-blockhash-proof.mjs'

const id = '11111111-1111-4111-8111-111111111111', owner = '11111111111111111111111111111111', genesisHash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const token = Buffer.alloc(32, 9).toString('base64url')
const env = { HOOK_INCLUSIVE_TRADING_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_TRADING_PUBLIC: 'true' }
const options = { configuration: () => ({ origin: 'https://repo.ing' }), database: () => ({ end: async () => {} }), quota: async () => true, principalStore: () => ({ resolve: async () => ({ wallet: owner }) }) }
const request = body => new Request('https://repo.ing/api/hook-lab/inclusive-trade', { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${token}` }, body: JSON.stringify(body) })
const operation = (status, extra = {}) => ({ id, owner, custodyOperationId: id, stage: 'native-buy', status, signature: null,
  review: { genesisHash, wallet: owner, payer: owner, requiredSigners: [owner], reviewExpiresAtMs: 1000, messageSha256: 'a'.repeat(64) }, ...extra })

test('the trade API expires a never-sent operation through the lifecycle, for this wallet and a trade stage only', async () => {
  const calls = []
  const handler = (op, opts = {}) => createInclusiveTradeHandler({ ...options, env, runtime: () => ({ origin: 'https://repo.ing', lifecycle: { expire: async (t, i) => { calls.push([t, i]); return op } }, ...opts }) })
  const ok = await (await handler(operation('expired'))(request({ action: 'expire', signingId: id }))).json()
  assert.equal(ok.status, 'available'); assert.equal(ok.operation.status, 'expired'); assert.deepEqual(calls, [[token, id]])
  // Another wallet's or a non-trade operation is never returned.
  assert.equal((await handler(operation('expired', { owner: 'So11111111111111111111111111111111111111112' }))(request({ action: 'expire', signingId: id }))).status, 409)
  assert.equal((await handler(operation('expired', { stage: 'launch' }))(request({ action: 'expire', signingId: id }))).status, 409)
  // A refused expiry (not provably past yet, or already sent) reads as unavailable, nothing changes.
  const refusing = createInclusiveTradeHandler({ ...options, env, runtime: () => ({ origin: 'https://repo.ing', lifecycle: { expire: async () => { throw Object.assign(Error('x'), { code: 'NATIVE_SIGNING_UNAVAILABLE' }) } } }) })
  assert.equal((await refusing(request({ action: 'expire', signingId: id }))).status, 409)
  // Expiry is cleanup: it is not blocked by the trading switches.
  const closed = createInclusiveTradeHandler({ ...options, env: { HOOK_INCLUSIVE_TRADING_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true' }, runtime: () => ({ origin: 'https://repo.ing', lifecycle: { expire: async () => operation('expired') } }) })
  assert.equal((await (await closed(request({ action: 'expire', signingId: id }))).json()).operation.status, 'expired')
})

test('the trade lifecycle proves expiry with the two-provider blockhash proof of the runtime’s own providers', async () => {
  assert.equal(tradeLifecycleSettings({ trade: {}, funding: {}, native: {}, nativeOpen: false }).expiryObserver, null, 'no providers, no expiry')
  const providers = [{ provider: 'a', connection: { getLatestBlockhashAndContext: async () => ({ context: { slot: 400 }, value: { blockhash: 'H', lastValidBlockHeight: 550 } }) } },
    { provider: 'b', connection: { getBlock: async slot => slot === 400 ? { blockhash: 'H', blockHeight: 400 } : null } }]
  const settings = tradeLifecycleSettings({ trade: {}, funding: {}, native: {}, nativeOpen: false, connections: providers })
  assert.deepEqual(await settings.expiryObserver(), { slot: 400, blockHeight: 400 })
  assert.deepEqual(await provenFinalizedProgress(providers), { slot: 400, blockHeight: 400 })
  providers[1].connection.getBlock = async () => ({ blockhash: 'other', blockHeight: 400 })
  await assert.rejects(settings.expiryObserver(), /not proven by the second provider/)
})

test('the panel closes an expired review it finds pending and never sent; anything sent, unexpired or final is left alone', async () => {
  const ids = { signingId: id, wallet: owner, genesisHash }, calls = []
  const call = async body => { calls.push(body.action); return { status: 'available', operation: operation('expired') } }
  for (const status of ['reviewed', 'partial', 'signed', 'signing-claimed', 'signing-unknown']) {
    assert.equal(expiredUnsent(operation(status), 1000), true, status); assert.equal(expiredUnsent(operation(status), 999), false, `${status} before its deadline`)
    calls.length = 0
    assert.equal((await closeExpired({ call, op: operation(status), ...ids, now: 1000 })).status, 'expired'); assert.deepEqual(calls, ['expire'])
  }
  for (const op of [operation('signed', { signature: 'sig' }), operation('submitted', { signature: 'sig' }), operation('outcome-unknown', { signature: 'sig' }), operation('finalized-success', { signature: 'sig' }), operation('expired')]) {
    calls.length = 0
    assert.equal(expiredUnsent(op, 5000), false, op.status); assert.equal(await closeExpired({ call, op, ...ids, now: 5000 }), op); assert.deepEqual(calls, [])
  }
  assert.equal(isFinal('expired'), true, 'a closed review is final for the panel')
  // The server's answer must still be this wallet's own operation.
  await assert.rejects(closeExpired({ call: async () => ({ status: 'available', operation: operation('expired', { id: '22222222-2222-4222-8222-222222222222' }) }), op: operation('signed'), ...ids, now: 1000 }))
})
