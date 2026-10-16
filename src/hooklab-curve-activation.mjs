// Offline rollout review only. There is intentionally no accepted production policy or live switch.
import { z } from 'zod'
import { verifyCurvePlan, CURVE_PROFILE } from './hooklab-curve.mjs'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const amount = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const proposalSchema = z.object({ schema: z.literal('repoing/curve-trial-proposal/1'),
  profileSha256: z.literal(CURVE_PROFILE), policySha256: hash, deploymentEvidenceSha256: hash,
  provenanceEvidenceSha256: hash, custodyEvidenceSha256: hash, alertDrillSha256: hash,
  ownerApprovalSha256: hash, buyMessageSha256: hash, sellMessageSha256: hash,
  startsAtMs: integer, expiresAtMs: integer, maxQuoteInput: amount, maxBaseInput: amount,
  maxNetworkFeesLamports: amount, maxQuoteLoss: amount,
  maxBuys: z.literal(1), maxSells: z.literal(1), globalUnpauseAcknowledged: z.literal(true),
  rePauseNeedsSeparateApproval: z.literal(true), historicalReceiptsRequired: z.literal(true),
}).strict()

/** Validate bounds and exact message bindings, NOT the authenticity/approval of supplied hashes.
 * The sell plan must eventually be rebuilt/reviewed from the finalized buy's actual history.
 * This offline pair does not establish that sequential execution is possible or authorized.
 */
export function inspectCurveTrialProposal(input, buyPlan, sellPlan, nowMs) {
  const p = proposalSchema.parse(input)
  verifyCurvePlan(buyPlan); verifyCurvePlan(sellPlan); integer.parse(nowMs)
  const check = (ok, text) => { if (!ok) throw new Error(text) }
  check(p.startsAtMs <= nowMs && nowMs < p.expiresAtMs && p.expiresAtMs - p.startsAtMs <= 120000, 'Trial window expired or unbounded')
  const buy = buyPlan.intent, sell = sellPlan.intent
  check(buy.side === 'buy' && sell.side === 'sell' && buy.trader === sell.trader
    && buy.trader === buy.recipient && sell.trader === sell.recipient && buy.feePayer === sell.feePayer
    && buy.mint === sell.mint && buyPlan.addresses.pool === sellPlan.addresses.pool, 'Trial identities differ')
  check(p.buyMessageSha256 === buyPlan.review.messageSha256 && p.sellMessageSha256 === sellPlan.review.messageSha256, 'Trial messages differ')
  check(BigInt(buy.amountIn) <= BigInt(p.maxQuoteInput) && BigInt(sell.amountIn) <= BigInt(p.maxBaseInput)
    && BigInt(sell.amountIn) <= BigInt(buy.minAmountOut), 'Trial input exposure exceeds bounds')
  check(BigInt(buy.maxNetworkFeeLamports) + BigInt(sell.maxNetworkFeeLamports) <= BigInt(p.maxNetworkFeesLamports), 'Trial network fee exposure exceeds bounds')
  check(BigInt(buy.amountIn) - BigInt(sell.minAmountOut) <= BigInt(p.maxQuoteLoss), 'Trial loss exceeds bounds')
  return { status: 'proposal-bounds-matched', approved: false, canSign: false, canSubmit: false,
    boundedLiveEnabled: false, blockers: [
      'No accepted production trading policy; supplied hashes are references, not verified approval.',
      'Require authenticated build provenance and fresh two-provider deployed governance/dependency evidence.',
      'Require exact stage-specific owner approval, custody recovery and private alert delivery/restart drill.',
      'Require finalized buy history before sell review; unresolved outcomes never release a retry budget.',
      'Global unpause and re-pause are separate owner-authorized chain actions; web disable does neither.',
    ] }
}

export function curveActivationStatus() {
  return { mode: 'disabled', acceptedPolicySha256: null, sign: false, submit: false, boundedLive: false,
    stages: ['disabled', 'read-only-adoption', 'exact-owner-approved-bounded-trial', 're-paused-reconciliation'],
    publicTradingSupported: false, kitSupported: false, customHooksSupported: false }
}
