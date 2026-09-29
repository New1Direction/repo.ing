export const CLAIM_STEPS = ['Verify GitHub', 'Set payout wallet', 'Claim']

// Presentation only: every step is re-checked server-side before any payout.
export function claimStepStates(current) {
  return CLAIM_STEPS.map((label, index) => ({ label, state: index + 1 < current ? 'done' : index + 1 === current ? 'current' : 'upcoming' }))
}

export function claimPageStep({ githubReady, appReady, walletMatches }) {
  return !githubReady || !appReady ? 1 : !walletMatches ? 2 : 3
}

const hasFees = repo => repo.available !== '0'

// Zero-fee repositories without a wallet don't block claiming the others.
export function builderClaimStep({ needsLogin, repositories }) {
  if (needsLogin) return 1
  if (!repositories) return 2
  if (!repositories.length) return 1
  return repositories.some(repo => !repo.wallet && hasFees(repo)) ? 2 : 3
}
