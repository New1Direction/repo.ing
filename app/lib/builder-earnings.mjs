import { formatSolDisplay, formatSolRounded, formatUsdEstimate } from './format.mjs'

// Token-page hero headline. Same gate as the Details → Earnings tab: nothing is shown as earned or
// claimable unless the reconciler MATCHes recorded fees against chain state. Amounts stay lamport strings.
export function builderEarningsHeadline(market, fees, usdPerSol) {
  if (fees?.status !== 'MATCH') return null
  const earned = BigInt(market.earned ?? 0), claimed = BigInt(market.claimed ?? 0)
  const claimable = BigInt(fees.onchainCreatorFee ?? 0)
  const usd = formatUsdEstimate(earned, usdPerSol)
  const value = usd ?? `${formatSolDisplay(earned)} SOL`
  const detail = [usd && `≈ ${formatSolRounded(earned)} SOL`, `${formatSolDisplay(claimed)} SOL paid out`].filter(Boolean).join(' · ')
  const href = `/claim/${market.repoId}`
  let action
  if (claimable > 0n && market.beneficiaryWallet) action = { kind: 'claim', href, label: `Claim ${formatSolDisplay(claimable)} SOL` }
  else if (claimable > 0n) action = { kind: 'verify', href, label: `Maintainer? Verify to claim ${formatUsdEstimate(claimable, usdPerSol) ?? `${formatSolDisplay(claimable)} SOL`}` }
  else action = { kind: 'note', label: claimed > 0n && market.beneficiaryWallet ? 'Paid to the verified maintainer' : 'Builders earn from every trade' }
  return { value, detail, action }
}
