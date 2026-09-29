import test from 'node:test'
import assert from 'node:assert/strict'
import { claimAmounts, receiverPaid } from '../src/claim-amounts.mjs'
import { provablyExpiredUnlanded } from '../src/expiry-proof.mjs'

const review = amount => ({ purpose: 'builder-claim-review', amount: String(amount) })

test('a missed swap (pool holds more than the ledger) pays the ledger amount instead of blocking', () => {
  const result = claimAmounts({ dbcFee: 1_050n, dammFee: 0n, outstanding: 1_000n })
  assert.deepEqual(result, { payoutAmount: 1_000n, dbcPayout: 1_000n, dammFee: 0n, surplus: 50n })
})

test('matching fees pay exactly, and a reviewed DBC cap is still honored', () => {
  assert.equal(claimAmounts({ dbcFee: 1_000n, dammFee: 0n, outstanding: 1_000n }).payoutAmount, 1_000n)
  assert.equal(claimAmounts({ dbcFee: 1_200n, dammFee: 0n, outstanding: 1_200n, review: review(900) }).payoutAmount, 900n)
  assert.throws(() => claimAmounts({ dbcFee: 1_000n, dammFee: 0n, outstanding: 1_000n, review: review(1_001) }), /changed/)
})

test('an over-credited ledger (pool holds less) still refuses to pay', () => {
  assert.throws(() => claimAmounts({ dbcFee: 900n, dammFee: 0n, outstanding: 1_000n }), /below the indexed unpaid accrual/)
  assert.throws(() => claimAmounts({ dbcFee: 0n, dammFee: 0n, outstanding: 1_000n }), /no creator fee/)
  assert.throws(() => claimAmounts({ dbcFee: 5n, dammFee: 0n, outstanding: 0n }), /No accrued/)
})

test('graduated claims take all DAMM fees and only the ledger-owed DBC remainder', () => {
  const result = claimAmounts({ dbcFee: 300n, dammFee: 700n, outstanding: 900n, review: { amount: '900', includeGraduatedFees: true } })
  assert.deepEqual(result, { payoutAmount: 900n, dbcPayout: 200n, dammFee: 700n, surplus: 100n })
  assert.throws(() => claimAmounts({ dbcFee: 0n, dammFee: 700n, outstanding: 500n }), /below|exceed/)
  assert.throws(() => claimAmounts({ dbcFee: 300n, dammFee: 700n, outstanding: 1_000n, review: review(1_000) }), /updated claim review/)
})

test('a receiver credited extra lamports (e.g. a front-run temporary account) still counts as paid', () => {
  assert.equal(receiverPaid(1_000n + 4_078n, 1_000n, 4_078n), true)
  assert.equal(receiverPaid(1_000n + 4_078n + 1n, 1_000n, 4_078n), true)
  assert.equal(receiverPaid(1_000n + 4_077n, 1_000n, 4_078n), false)
})

function fakeRpc({ slot = 500, height = 1_000, statusSlot = 500, status = null } = {}) {
  const calls = []
  return { calls,
    getSlot: async () => slot,
    getBlockHeight: async config => { calls.push(config); return height },
    getSignatureStatuses: async () => ({ context: { slot: statusSlot }, value: [status] }) }
}

test('expiry proof: expired and absent on a current node → abandon', async () => {
  const rpc = fakeRpc({ slot: 500, height: 1_000, statusSlot: 501 })
  assert.equal(await provablyExpiredUnlanded(rpc, 'sig', 900), true)
  assert.deepEqual(rpc.calls[0], { commitment: 'finalized', minContextSlot: 500 })
})

test('expiry proof: a lagging history node cannot abandon a payout that may have landed', async () => {
  assert.equal(await provablyExpiredUnlanded(fakeRpc({ slot: 500, height: 1_000, statusSlot: 499 }), 'sig', 900), false)
})

test('expiry proof: not yet expired, or any signature record, keeps the claim pending', async () => {
  assert.equal(await provablyExpiredUnlanded(fakeRpc({ height: 900 }), 'sig', 900), false)
  assert.equal(await provablyExpiredUnlanded(fakeRpc({ height: 1_000, statusSlot: 600, status: { slot: 450 } }), 'sig', 900), false)
})
