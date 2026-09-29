import { reviewedClaimAmount } from './claim-review.mjs'

// Pay what the ledger proves is owed, as long as the pools hold at least that much.
// Unindexed extra fees (a missed or unparsed swap) stay in the pool for reconciliation
// instead of blocking every future claim. A pool holding less than the ledger means the
// ledger over-credited, which needs review before anything is paid.
export function claimAmounts({ dbcFee, dammFee, outstanding, review }) {
  if (outstanding <= 0n) throw new Error('No accrued creator fees remain to claim')
  const onchain = dbcFee + dammFee
  if (onchain <= 0n) throw new Error('Meteora has no creator fee to claim')
  if (onchain < outstanding) throw new Error('Meteora creator fee is below the indexed unpaid accrual; reconcile before paying')
  // DAMM claims always take the position's full fee, which was just recorded into the ledger.
  if (dammFee > outstanding) throw new Error('Graduated fees exceed the indexed unpaid accrual; reconcile before paying')
  const graduated = dammFee > 0n
  if (graduated && review && (review.includeGraduatedFees !== true || BigInt(review.amount) > outstanding)) {
    throw Error('Graduated fees require an updated claim review')
  }
  // DAMM claims all accrued SOL; its review explicitly includes fees arriving before execution.
  // DBC-only reviews retain their exact cap, including queued claims.
  const payoutAmount = graduated ? outstanding : reviewedClaimAmount(review, outstanding)
  return { payoutAmount, dbcPayout: graduated ? outstanding - dammFee : payoutAmount, dammFee, surplus: onchain - outstanding }
}

// The receiver must get at least the proven payout plus refunded rent. More is tolerated: a third
// party can only add lamports (e.g. front-running a temporary account), never take them.
export function receiverPaid(receiverDelta, provenAmount, rentRefund) {
  return receiverDelta >= provenAmount + rentRefund
}
