import { PublicKey } from '@solana/web3.js'
import { backerLabels } from './backers.mjs'
import { signedPayoutWallet } from './official-launch.mjs'
import { bundleAddress, vaultAddress } from '../../src/bundle-vault.mjs'

// Labeled wallets for one market's transparency report (src/market-transparency.mjs): the Backers labels (the signed payout
// wallet as Builder; repo.ing's team, buyback, fee, signer, partner and tip wallets; the pool), plus a Group launch market's vault
// and the signer that made its launch buy. Labeled wallets are disclosed by name and never counted as organic traders, holders
// or incentive-eligible liquidity providers.
export function transparencyLabels(market) {
  const labels = backerLabels({ beneficiaryWallet: signedPayoutWallet(market), pool: market.pool })
  if (market.bundleId !== null && market.bundleId !== undefined) {
    try { labels.set(vaultAddress(bundleAddress(BigInt(market.bundleId))).toBase58(), { kind: 'vault', label: 'Group launch vault' }) } catch { /* malformed id */ }
    if (market.launcherWallet) labels.set(new PublicKey(market.launcherWallet).toBase58(), { kind: 'platform', label: 'repo.ing Group launch signer' })
  }
  return labels
}
