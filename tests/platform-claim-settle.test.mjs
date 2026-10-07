import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { platformFeeRecord, settlePlatformClaim } from '../src/platform-fees.mjs'

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

test('rent the receiver put into an account the claim opened and left open is part of the claim; a closed one-time account is not', async () => {
  const opened = Keypair.generate().publicKey, temporary = Keypair.generate().publicKey, rent = 2_157_600
  // The first claim of an early access market's DAMM v2 partner fees opens the partner's Token-2022 account for the token
  // (docs/EARLY_ACCESS.md, step 7d); its one-time WSOL account opens and closes in the same transaction.
  const connection = { getTransaction: async () => ({ meta: { err: null, fee: 10_000, preBalances: [50_000_000, 0, 0],
    postBalances: [50_000_000 + 440_467_145 - 10_000 - rent, rent, 0] }, transaction: { message: { accountKeys: [receiver, opened, temporary] } } }) }
  const settled = await settlePlatformClaim(db(), connection, intent)
  assert.equal(settled.amount, '440467145', 'exactly the claimed fee')
})

test('the platform fee record takes an early access market only when asked', async () => {
  const asked = []
  const pool = { query: async (sql, params) => { asked.push([sql, params]); return { rows: [] } } }
  assert.equal(await platformFeeRecord(pool, '7'), null)
  assert.equal(await platformFeeRecord(pool, '7', { earlyAccess: true }), null)
  assert.deepEqual(asked.map(([, params]) => params), [['7', false], ['7', true]])
  assert.match(asked[0][0], /\(early_access_end is null or \$2::boolean\)/)
  assert.match(asked[0][0], /early_access_end as "earlyAccessEnd", transfer_hook_program as "transferHookProgram"/)
})
