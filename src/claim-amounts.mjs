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

// A contributor early access payout (docs/EARLY_ACCESS.md, step 7c) cannot carry its curve claim (claim_creator_trading_fee2) and its
// DAMM v2 claim together: they need more than a transaction's 1,232 bytes. When both are owed, this payout claims the curve part
// alone; the DAMM v2 fees stay in the ledger for the next claim, which then claims them alone.
export function earlyAccessClaimAmounts(amounts) {
  return amounts.dbcPayout > 0n && amounts.dammFee > 0n ? { ...amounts, payoutAmount: amounts.dbcPayout, dammFee: 0n } : amounts
}

// What the next builder claim pays, from a fee status (src/reconcile.mjs) that MATCHes: all of it, except for an early access market
// owed both curve and DAMM v2 fees, whose next claim pays the curve part (earlyAccessClaimAmounts); the DAMM v2 part follows.
export function nextClaimAmount(fees) {
  if (fees?.status !== 'MATCH' || fees.onchainCreatorFee == null) return null
  const total = BigInt(fees.onchainCreatorFee), graduated = BigInt(fees.graduatedCreatorFee ?? 0n)
  return fees.earlyAccess && graduated > 0n && total > graduated ? total - graduated : total
}

// The receiver must get at least the proven payout plus refunded rent. More is tolerated: a third
// party can only add lamports (e.g. front-running a temporary account), never take them.
export function receiverPaid(receiverDelta, provenAmount, rentRefund) {
  return receiverDelta >= provenAmount + rentRefund
}
