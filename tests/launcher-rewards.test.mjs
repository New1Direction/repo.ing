import test from 'node:test'
import assert from 'node:assert/strict'
import { launcherRewardTotals, walletMarkets } from '../app/lib/wallet-overview.mjs'

const markets = [
  { repoId: '1', mint: 'A', launcherWallet: 'me' },
  { repoId: '2', mint: 'B', launcherWallet: 'me' },
  { repoId: '3', mint: 'C', launcherWallet: 'me' },
  { repoId: '4', mint: 'D', launcherWallet: 'someone' },
]
const rewards = [
  { repoId: '1', version: 2, partnerEarned: '200000000', paid: '40000000' },
  { repoId: '2', version: 1, partnerEarned: '10', paid: '5' },
]

test('launcher totals sum earned, paid and claimable across only this wallet’s enrolled launches', () => {
  const rows = walletMarkets(markets, new Map([['D', 5n]]), 'me', rewards)
  assert.deepEqual(launcherRewardTotals(rows), { markets: 2, earned: '100000005', paid: '40000005',
    claimable: '60000000', claimableMarkets: 1 })
})

test('launcher totals are zero, not missing, for wallets without enrolled launches', () => {
  assert.deepEqual(launcherRewardTotals(walletMarkets(markets, new Map(), 'nobody', rewards)),
    { markets: 0, earned: '0', paid: '0', claimable: '0', claimableMarkets: 0 })
  assert.deepEqual(launcherRewardTotals([]), { markets: 0, earned: '0', paid: '0', claimable: '0', claimableMarkets: 0 })
})

test('launcher totals refuse inconsistent rows instead of overstating what can be claimed', () => {
  assert.throws(() => launcherRewardTotals([{ discovery: { earned: '5', paid: '6', remaining: '-1' } }]), /review/)
  assert.throws(() => launcherRewardTotals([{ discovery: { earned: '10', paid: '2', remaining: '9' } }]), /review/)
})
