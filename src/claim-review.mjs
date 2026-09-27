// A settled payout increases `paid`. The same review can therefore never authorize another payout,
// even if new trading later recreates exactly the same available amount.
export function assertClaimSnapshot(review, { repoId, beneficiary, paid }) {
  if (!Number.isFinite(review.expiresAt) || review.expiresAt <= Date.now()) throw new Error('Claim review expired. Refresh and review again.')
  if (review.repoId !== String(repoId) || review.wallet !== beneficiary.wallet ||
      review.boundAt !== new Date(beneficiary.boundAt).toISOString() || review.paid !== String(paid)) {
    throw new Error('Payout details changed or this review was already used. Refresh and review again.')
  }
}

export function reviewedClaimAmount(review, currentAmount) {
  if (!review) return currentAmount
  if (!/^[1-9]\d*$/.test(review.amount || '')) throw new Error('Invalid claim review amount')
  const amount = BigInt(review.amount)
  // A dashboard queue may take time. Pay only the explicitly reviewed amount;
  // fees arriving after review stay available for the next claim.
  if (amount > currentAmount || (review.purpose !== 'builder-claim-review' && amount !== currentAmount)) {
    throw new Error('Claim amount changed. Refresh and review the updated fees.')
  }
  return amount
}
