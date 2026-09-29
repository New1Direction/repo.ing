import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { settlePlatformClaim } from '../src/platform-fees.mjs'

const receiver = Keypair.generate().publicKey
const connection = (pre, post, fee = 5000) => ({ getTransaction: async () => ({ meta: { err: null, fee, preBalances: [pre], postBalances: [post] },
  transaction: { message: { accountKeys: [receiver] } } }) })
const db = () => { const calls = []; return { calls, query: async (sql, params) => { calls.push(params); return { rows: [{ status: 'settled', signature: params[0], wallet: receiver.toBase58(), amount: params[1] }] } } } }
const intent = { signature: 'sig', wallet: receiver.toBase58(), amount: '400000000' }

test('an active pool settling more than reviewed records the actual claimed amount', async () => {
  const d = db()
  const settled = await settlePlatformClaim(d, connection(50_000_000, 50_000_000 + 440_467_145 - 5000), intent)
  assert.equal(settled.amount, '440467145')
})

test('settling within rent tolerance below the review keeps the reviewed amount; far off is refused', async () => {
  assert.equal((await settlePlatformClaim(db(), connection(0, 399_000_000 - 5000), intent)).amount, '400000000')
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 300_000_000), intent), /differs/)
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 5_000_000_000), intent), /differs/)
})
