export const CLAIM_STEPS = ['Verify GitHub', 'Set payout wallet', 'Claim']

// Presentation only: every step is re-checked server-side before any payout.
export function claimStepStates(current) {
  return CLAIM_STEPS.map((label, index) => ({ label, state: index + 1 < current ? 'done' : index + 1 === current ? 'current' : 'upcoming' }))
}

// pastedActive: the active payout address was pasted (src/payout-address.mjs) and its hold has passed. There is no
// wallet to connect for it, so it completes the payout step on its own; a signature-bound wallet still has to match.
export function claimPageStep({ githubReady, appReady, walletMatches, pastedActive = false }) {
  return !githubReady || !appReady ? 1 : !(walletMatches || pastedActive) ? 2 : 3
}

const hasFees = repo => repo.available !== '0'

// Zero-fee repositories without a wallet don't block claiming the others; neither does one whose pasted address is
// waiting out its hold.
export function builderClaimStep({ needsLogin, repositories }) {
  if (needsLogin) return 1
  if (!repositories) return 2
  if (!repositories.length) return 1
  return repositories.some(repo => !repo.wallet && !repo.pending && hasFees(repo)) ? 2 : 3
}
