import test from 'node:test'
import assert from 'node:assert/strict'
import { builderEarningsHeadline } from '../app/lib/builder-earnings.mjs'

const market = { repoId: '42', earned: '12500000000', claimed: '2000000000', beneficiaryWallet: null }
const match = fee => ({ status: 'MATCH', onchainCreatorFee: fee })

test('nothing is shown unless the reconciler MATCHes', () => {
  for (const status of ['UNAVAILABLE', 'MISMATCH', 'PENDING_REVIEW']) assert.equal(builderEarningsHeadline(market, { status, onchainCreatorFee: 5n }, 150), null)
  assert.equal(builderEarningsHeadline(market, null, 150), null)
})

test('USD first, then SOL earned and paid out from lamport strings', () => {
  const view = builderEarningsHeadline(market, match(0n), 150)
  assert.equal(view.value, '$1,875.00')
  assert.equal(view.detail, '≈ 12.5 SOL · 2 SOL paid out')
})

test('falls back to SOL when no USD price is known', () => {
  const view = builderEarningsHeadline({ ...market, earned: '1234000000000' }, match(0n), null)
  assert.equal(view.value, '1,234 SOL')
  assert.equal(view.detail, '2 SOL paid out')
})

test('verified payout wallet with claimable fees gets the claim action', () => {
  const view = builderEarningsHeadline({ ...market, beneficiaryWallet: 'W' }, match(1500000000n), 150)
  assert.deepEqual(view.action, { kind: 'claim', href: '/claim/42', label: 'Claim 1.5 SOL' })
})

test('claimable fees without a payout wallet invite the maintainer to verify', () => {
  assert.deepEqual(builderEarningsHeadline(market, match('1500000000'), 150).action, { kind: 'verify', href: '/claim/42', label: 'Maintainer? Verify to claim $225.00' })
  assert.equal(builderEarningsHeadline(market, match(1500000000n), null).action.label, 'Maintainer? Verify to claim 1.5 SOL')
})

test('nothing claimable shows a muted note', () => {
  assert.equal(builderEarningsHeadline({ ...market, beneficiaryWallet: 'W' }, match(0n), 150).action.label, 'Paid to the verified maintainer')
  assert.equal(builderEarningsHeadline({ ...market, claimed: '0', earned: '0' }, match(null), 150).action.label, 'Builders earn from every trade')
})
