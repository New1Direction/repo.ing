// Fee routing for stock-paired markets (docs/STOCK_QUOTES.md, "Fee policy"). Pure BigInt arithmetic on raw units of the stock
// (its ScaledUiAmount multiplier is for display only); every share rounds down. Ledger rows record the version they were split
// under (stock_fee_events.policy_version, stock_damm_fee_checkpoints.policy_version, migration 0054).
//
// A stock's DBC config gives the creator 71% of each swap's fee after Meteora's protocol fee: 0.994% of volume of the 1.75%
// total, and the partner the remaining 0.406%. The launcher earns 0.30 / 0.994 = 150/497 of the creator fee (0.30% of volume),
// paid in the stock, for as long as the market trades: there is no end date, and a company admin who verifies changes nothing
// (an owner claim of builder fees on a stock pair is refused with STOCK_PAIR_NO_OWNER_CLAIM). Everything else, the rest of the
// creator fee and the whole partner fee, goes to that stock's accumulator, to become permanent REPOING/stock liquidity.
export const POLICY_VERSION = 1
export const LAUNCHER_NUM = 150n
export const LAUNCHER_DEN = 497n
// The creator share (creatorTradingFeePercentage) LAUNCHER_NUM / LAUNCHER_DEN is calibrated for.
export const STOCK_CREATOR_FEE_PERCENTAGE = 71

export const STOCK_POLICY_ERRORS = Object.freeze({
  STOCK_POLICY_CONFIG_MISMATCH: 'STOCK_POLICY_CONFIG_MISMATCH',
  STOCK_FEE_AMOUNT_INVALID: 'STOCK_FEE_AMOUNT_INVALID',
  STOCK_DAMM_SIDE_INVALID: 'STOCK_DAMM_SIDE_INVALID',
  STOCK_DAMM_CUMULATIVE_DECREASED: 'STOCK_DAMM_CUMULATIVE_DECREASED',
  STOCK_DAMM_PREVIOUS_MISMATCH: 'STOCK_DAMM_PREVIOUS_MISMATCH',
  STOCK_PAIR_NO_OWNER_CLAIM: 'STOCK_PAIR_NO_OWNER_CLAIM',
})

export class StockFeePolicyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StockFeePolicyError'
    this.code = code
  }
}

// The ledger columns are PostgreSQL bigint: nothing above this can be stored, so it is refused here rather than at insert.
const LEDGER_MAX = (1n << 63n) - 1n
const fail = (code, message) => { throw new StockFeePolicyError(code, message) }

// A raw amount as a BigInt. Also takes a safe-integer Number or a decimal string (as PostgreSQL returns bigint), converted
// exactly; anything negative, fractional, unsafe, malformed or beyond the ledger's range is refused.
function rawAmount(value, name) {
  const parsed = typeof value === 'bigint' ? value
    : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value)
      : typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) ? BigInt(value) : null
  if (parsed === null || parsed < 0n || parsed > LEDGER_MAX) {
    fail(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID, `${name} must be a whole number of raw units from 0 to 2^63-1`)
  }
  return parsed
}

const launcherShare = creatorAmount => creatorAmount * LAUNCHER_NUM / LAUNCHER_DEN

// The stock's DBC config (decoded PoolConfig or the built curve) must give the creator the share the policy assumes.
export function assertStockPolicyConfig(config) {
  if (config?.creatorTradingFeePercentage !== STOCK_CREATOR_FEE_PERCENTAGE) {
    fail(STOCK_POLICY_ERRORS.STOCK_POLICY_CONFIG_MISMATCH, `Stock fee policy ${POLICY_VERSION} needs a creator share of ` +
      `${STOCK_CREATOR_FEE_PERCENTAGE}%; the config has ${config?.creatorTradingFeePercentage}`)
  }
  return true
}

// One curve swap's fee: the launcher gets floor(creator * 150 / 497); the rest of the creator fee and the whole partner fee go
// to the stock's accumulator, so launcherAmount + accumulatorAmount = creatorAmount + partnerAmount.
export function splitCurveFee({ creatorAmount, partnerAmount } = {}) {
  const creator = rawAmount(creatorAmount, 'creatorAmount'), partner = rawAmount(partnerAmount, 'partnerAmount')
  if (creator + partner > LEDGER_MAX) fail(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID, 'Curve fee exceeds the ledger range')
  const launcherAmount = launcherShare(creator)
  return { launcherAmount, accumulatorAmount: creator - launcherAmount + partner }
}

// A cumulative fee checkpoint of the graduated pool's creator or partner position. cumulativeEarned is the position's total
// earned so far (unclaimed + claimed). previous is the last checkpoint of the same pool and side, or null for the first:
// { cumulativeEarned, launcherCumulative?, side?, policyVersion? } (a stored row as drizzle reads it). Each checkpoint credits
// the growth since previous. On the creator side the launcher's running total is floor(cumulativeEarned * 150 / 497) and its
// credit the growth of that total; the partner side never pays the launcher. A cumulative that went backwards, or a previous
// checkpoint from the other side or another policy, is refused: the position needs review, not a negative credit.
export function dammCheckpoint({ side, cumulativeEarned, previous = null } = {}) {
  if (side !== 'creator' && side !== 'partner') fail(STOCK_POLICY_ERRORS.STOCK_DAMM_SIDE_INVALID, 'DAMM fee side must be creator or partner')
  const share = earned => side === 'creator' ? launcherShare(earned) : 0n
  const earned = rawAmount(cumulativeEarned, 'cumulativeEarned')
  let earnedBefore = 0n, launcherBefore = 0n
  if (previous !== null && previous !== undefined) {
    earnedBefore = rawAmount(previous.cumulativeEarned, 'previous.cumulativeEarned')
    launcherBefore = share(earnedBefore)
    if ((previous.side !== undefined && previous.side !== side) ||
        (previous.policyVersion !== undefined && previous.policyVersion !== POLICY_VERSION) ||
        (previous.launcherCumulative !== undefined && rawAmount(previous.launcherCumulative, 'previous.launcherCumulative') !== launcherBefore)) {
      fail(STOCK_POLICY_ERRORS.STOCK_DAMM_PREVIOUS_MISMATCH, `Previous checkpoint is not a ${side} checkpoint recorded under stock fee policy ${POLICY_VERSION}`)
    }
    if (earned < earnedBefore) {
      fail(STOCK_POLICY_ERRORS.STOCK_DAMM_CUMULATIVE_DECREASED, `DAMM ${side} fees earned went from ${earnedBefore} down to ${earned}; review required`)
    }
  }
  const launcherCumulative = share(earned)
  const credit = earned - earnedBefore, launcherCredit = launcherCumulative - launcherBefore
  return { credit, launcherCumulative, launcherCredit, accumulatorCredit: credit - launcherCredit }
}
