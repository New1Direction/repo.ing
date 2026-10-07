import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { platformFeeRecord, settlePlatformClaim } from '../src/platform-fees.mjs'
import { claimPositionFeeEvent, dammClaimReceipt } from './fixtures/damm-claim-receipt.mjs'

// A settled DAMM platform claim records the claim event's amount (CP-AMM's EvtClaimPositionFee); the receiver's balance change,
// its network fee and what it put into accounts left holding more only bound it.
const receiver = Keypair.generate().publicKey, pool = Keypair.generate().publicKey
const event = (feeB, extra = {}) => claimPositionFeeEvent({ pool, owner: receiver, feeB, ...extra })
const connection = (pre, post, events, { fee = 5000, others = [] } = {}) => ({ getTransaction: async () => dammClaimReceipt({
  keys: [receiver, ...others.map(o => o.key)], pre: [pre, ...others.map(o => o.pre)], post: [post, ...others.map(o => o.post)], fee, events }) })
const db = () => { const calls = []; return { calls, query: async (sql, params) => { calls.push(params); return { rows: [{ status: 'settled', signature: params[0], wallet: receiver.toBase58(), amount: params[1] }] } } } }
const intent = { signature: 'sig', wallet: receiver.toBase58(), amount: '400000000', pool: pool.toBase58() }

test('an active pool settling more than reviewed records the claim event\'s amount', async () => {
  const settled = await settlePlatformClaim(db(), connection(50_000_000, 50_000_000 + 440_467_145 - 5000, [event(440_467_145n)]), intent)
  assert.equal(settled.amount, '440467145')
})

test('a claim a little below the review records exactly what was claimed; far off is refused', async () => {
  assert.equal((await settlePlatformClaim(db(), connection(0, 399_000_000 - 5000, [event(399_000_000n)]), intent)).amount, '399000000')
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 300_000_000 - 5000, [event(300_000_000n)]), intent), /differs from the reviewed amount/)
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 5_000_000_000, [event(5_000_000_000n)]), intent), /differs from the reviewed amount/)
})

test('rent put into an account the claim opened, pre-funded or not, is not lost from the record; a closed one-time account adds nothing', async () => {
  const opened = Keypair.generate().publicKey, temporary = Keypair.generate().publicKey, rent = 2_157_600
  // The first claim of an early access market's DAMM v2 partner fees opens the partner's Token-2022 account for the token
  // (docs/EARLY_ACCESS.md, step 7d); its one-time WSOL account opens and closes in the same transaction.
  for (const prefunded of [0, 890_880]) {
    const others = [{ key: opened, pre: prefunded, post: rent }, { key: temporary, pre: 0, post: 0 }]
    const settled = await settlePlatformClaim(db(), connection(50_000_000, 50_000_000 + 440_467_145 - 10_000 - (rent - prefunded),
      [event(440_467_145n)], { fee: 10_000, others }), intent)
    assert.equal(settled.amount, '440467145', `exactly the claimed fee (pre-funded with ${prefunded})`)
  }
})

test('no event, two events, another pool or owner, a token A fee, or a receiver short of the claim is refused', async () => {
  const paid = (amount = 400_000_000) => connection(0, amount - 5000, [event(BigInt(amount))])
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 400_000_000 - 5000, []), intent), /event differs/)
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 400_000_000 - 5000, [event(200_000_000n), event(200_000_000n)]), intent), /event differs/)
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 400_000_000 - 5000, [event(400_000_000n, { pool: Keypair.generate().publicKey })]), intent), /event differs/)
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 400_000_000 - 5000, [event(400_000_000n, { owner: Keypair.generate().publicKey })]), intent), /event differs/)
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 400_000_000 - 5000, [event(400_000_000n, { feeA: 1n })]), intent), /event differs/)
  await assert.rejects(() => settlePlatformClaim(db(), connection(0, 300_000_000, [event(400_000_000n)]), intent), /did not receive the claimed amount/)
  assert.equal((await settlePlatformClaim(db(), paid(), intent)).amount, '400000000')
})

test('the platform fee record takes an early access market only when asked', async () => {
  const asked = []
  const fakePool = { query: async (sql, params) => { asked.push([sql, params]); return { rows: [] } } }
  assert.equal(await platformFeeRecord(fakePool, '7'), null)
  assert.equal(await platformFeeRecord(fakePool, '7', { earlyAccess: true }), null)
  assert.deepEqual(asked.map(([, params]) => params), [['7', false], ['7', true]])
  assert.match(asked[0][0], /\(early_access_end is null or \$2::boolean\)/)
  assert.match(asked[0][0], /early_access_end as "earlyAccessEnd", transfer_hook_program as "transferHookProgram"/)
})
