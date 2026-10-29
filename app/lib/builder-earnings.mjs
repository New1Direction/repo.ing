import { formatSolDisplay, formatSolRounded, formatUsdEstimate } from './format.mjs'
import { claimHref } from './claim-funnel.mjs'

const lamports = value => { try { return BigInt(value ?? 0) } catch { return 0n } }
// The note when nothing is claimable here: payouts already reached the verified maintainer, or builders earn from trades.
const earnNote = (claimed, market) => ({ kind: 'note', label: claimed > 0n && market.beneficiaryWallet ? 'Paid to the verified maintainer' : 'Builders earn from every trade' })

// Token-page hero headline. Same gate as the Details → Earnings tab: nothing is shown as claimable unless the reconciler
// MATCHes recorded fees against chain state (recordedEarningsHeadline covers the rest). Amounts stay lamport strings.
export function builderEarningsHeadline(market, fees, usdPerSol) {
  if (fees?.status !== 'MATCH') return null
  const earned = BigInt(fees.recordedEarned ?? market.earned ?? 0), claimed = BigInt(fees.recordedClaimed ?? market.claimed ?? 0)
  const claimable = BigInt(fees.onchainCreatorFee ?? 0)
  const balances = { accrued: earned, paid: claimed,
    // Direct historical payouts also withdrew pool fees; custody payouts are already in claimed.
    collected: claimed + BigInt(fees.platformCollected ?? market.platformCollected ?? 0) + BigInt(fees.custodyHeld ?? 0),
    custodyHeld: BigInt(fees.custodyHeld ?? 0), remaining: claimable,
    claimable: fees.payoutsEnabled === false || !market.beneficiaryWallet ? null : claimable }
  const usd = formatUsdEstimate(earned, usdPerSol)
  const value = usd ?? `${formatSolDisplay(earned)} SOL`
  const detail = [usd && `≈ ${formatSolRounded(earned)} SOL`, `${formatSolDisplay(claimed)} SOL paid out`].filter(Boolean).join(' · ')
  const href = claimHref(market.repoId, 'token')
  let action
  if (fees.payoutsEnabled === false) action = { kind: 'note', label: 'Claims paused · accrued fees are not payouts' }
  else if (claimable > 0n && market.beneficiaryWallet) action = { kind: 'claim', href, label: `Claim ${formatSolDisplay(claimable)} SOL` }
  else if (claimable > 0n) action = { kind: 'verify', href, label: `Maintainer? Verify to claim ${formatUsdEstimate(claimable, usdPerSol) ?? `${formatSolDisplay(claimable)} SOL`}` }
  else action = earnNote(claimed, market)
  return { value, detail, action, balances }
}

// While the reconciler has not MATCHed (accounting catching up, a single-RPC read, a pending review), the figures repo.ing
// recorded are still shown, as plain "X SOL earned · Y SOL paid": never a claimable amount or a claim action, which need
// the MATCH above. value is null when nothing is recorded yet (the box then only says builders earn from every trade).
export function recordedEarningsHeadline(market, fees) {
  const earned = lamports(fees?.recordedEarned ?? market?.earned), claimed = lamports(fees?.recordedClaimed ?? market?.claimed)
  if (earned <= 0n) return { value: null, detail: null, action: earnNote(0n, market ?? {}), recorded: { earned: 0n, paid: 0n } }
  return { value: `${formatSolDisplay(earned)} SOL`, detail: claimed > 0n ? `${formatSolDisplay(claimed)} SOL paid` : null,
    action: earnNote(claimed, market), recorded: { earned, paid: claimed } }
}
