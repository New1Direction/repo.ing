import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { buildInclusiveMaxWalletSwapReview, inclusiveMaxWalletSwapRequestSchema } from '../src/hooklab-inclusive-max-wallet-swap.mjs'
const k = new PublicKey(Buffer.alloc(32, 3)).toBase58()
const request = { schema: 'repoing/inclusive-max-wallet-swap-request/1', policyKind: 'max-wallet', policyVersion: 2,
  creatorFeeBps: 100, feeModel: 2, protocolShareBps: 2500, capBps: 100, side: 'buy', trader: k, recipient: k, feePayer: k,
  mint: k, selectedConfig: k, amountIn: '1', minAmountOut: '1', maxInput: '1', maxPriceImpactBps: 100 }
test('candidate swap requires explicit versioned economics with no inference from nonzero fees', () => {
  assert.deepEqual(inclusiveMaxWalletSwapRequestSchema.parse(request), request)
  for (const key of ['creatorFeeBps', 'feeModel', 'protocolShareBps', 'policyVersion']) {
    const candidate = { ...request }; delete candidate[key]; assert.throws(() => inclusiveMaxWalletSwapRequestSchema.parse(candidate))
  }
  for (const [key, value] of [['feeModel', 1], ['policyVersion', 1], ['protocolShareBps', 0], ['creatorFeeBps', 10000]])
    assert.throws(() => inclusiveMaxWalletSwapRequestSchema.parse({ ...request, [key]: value }))
})
test('new production route stays unavailable regardless of caller-supplied proof', () => {
  for (const value of [undefined, request, { sbfValidated: true }, { productionReceipt: { accepted: true } }])
    assert.throws(() => buildInclusiveMaxWalletSwapReview(value), error => error.code === 'INCLUSIVE_MAX_WALLET_SWAP_PROOF_UNAVAILABLE')
})
