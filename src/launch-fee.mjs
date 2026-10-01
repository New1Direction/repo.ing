import BN from 'bn.js'
import {
  ActivationType, BaseFeeMode, getBaseFeeNumerator, getFeeSchedulerMinBaseFeeNumerator, validateFeeScheduler,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { feePercentLabel } from './launch-fee-copy.mjs'

export { feePercentLabel, launchFeeNotice } from './launch-fee-copy.mjs'

// Fee numerators are parts of 1e9 (DBC FEE_DENOMINATOR). 17,500,000 = 1.75%: the fee every approved
// config charges outside the launch window (0.994% builders / 0.406% repo.ing / 0.35% Meteora at 71%).
export const FEE_DENOMINATOR = 1_000_000_000n
export const STANDARD_FEE_NUMERATOR = 17_500_000n

// Anti-sniper launch fee: Meteora's exponential fee scheduler on timestamp activation. A pool's activation
// point is its creation time, so the fee starts at 50.44% the moment the pool exists, removes 1.85% of the
// current fee every second (half-life about 37 s), and is exactly 1.75% from 180 seconds on, for the life of
// the curve. The cliff is tuned so the program's own integer math ends on 17,500,000 exactly: post-window
// trades are byte-for-byte as expensive as on the flat configs. The launcher's initial buy, which runs in the
// pool-creation transaction, pays that minimum fee (enableFirstSwapWithMinFee), never the launch fee.
// Rate limiter (size-scaled fee) is not an option: the DBC program rejects it for new configs
// (DeprecatedBaseFeeMode since DBC 0.2.1). See docs/LAUNCH_FEE.md.
export const LAUNCH_FEE_SCHEDULE = Object.freeze({
  baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
  cliffFeeNumerator: 504_409_597n,
  numberOfPeriod: 180,
  periodFrequency: 1n,
  reductionFactor: 185n,
})

const big = value => BigInt(value?.toString?.() ?? value)

// The createConfig poolFees.baseFee for LAUNCH_FEE_SCHEDULE. Throws if the SDK no longer validates it or its
// minimum is not exactly the standard fee: the schedule must never change post-window economics.
export function launchFeeBaseFee(schedule = LAUNCH_FEE_SCHEDULE) {
  const baseFee = { cliffFeeNumerator: new BN(schedule.cliffFeeNumerator.toString()), firstFactor: schedule.numberOfPeriod,
    secondFactor: new BN(schedule.periodFrequency.toString()), thirdFactor: new BN(schedule.reductionFactor.toString()),
    baseFeeMode: schedule.baseFeeMode }
  if (!validateFeeScheduler(baseFee.firstFactor, baseFee.secondFactor, baseFee.thirdFactor, baseFee.cliffFeeNumerator, baseFee.baseFeeMode)) {
    throw Error('Launch fee schedule is outside Meteora fee scheduler limits')
  }
  const end = big(getFeeSchedulerMinBaseFeeNumerator(baseFee.cliffFeeNumerator, baseFee.firstFactor, baseFee.thirdFactor, baseFee.baseFeeMode))
  if (end !== STANDARD_FEE_NUMERATOR) throw Error('Launch fee schedule must end exactly at the standard 1.75% fee')
  return baseFee
}

// Normalized base fee of a decoded on-chain PoolConfig or of buildCurve ConfigParameters.
// kind 'flat': one fee for the life of the curve. kind 'scheduled': time-based fee scheduler.
export function readFeeSchedule(config) {
  const base = config?.poolFees?.baseFee
  if (!base) throw Error('DBC config has no base fee')
  const mode = Number(base.baseFeeMode)
  if (mode === BaseFeeMode.RateLimiter) throw Error('Rate-limiter DBC configs are not supported')
  if (mode !== BaseFeeMode.FeeSchedulerLinear && mode !== BaseFeeMode.FeeSchedulerExponential) throw Error('Unknown DBC base fee mode')
  const startNumerator = big(base.cliffFeeNumerator)
  const numberOfPeriod = Number(base.firstFactor), periodFrequency = big(base.secondFactor), reductionFactor = big(base.thirdFactor)
  const firstSwapMinFee = config.enableFirstSwapWithMinFee === true || Number(config.enableFirstSwapWithMinFee) === 1
  const activationType = config.activationType
  if (numberOfPeriod === 0 && periodFrequency === 0n && reductionFactor === 0n) {
    return Object.freeze({ kind: 'flat', mode, startNumerator, endNumerator: startNumerator, numberOfPeriod, periodFrequency,
      reductionFactor, durationPoints: 0n, firstSwapMinFee, activationType })
  }
  if (numberOfPeriod === 0 || periodFrequency === 0n || reductionFactor === 0n) throw Error('Invalid DBC fee scheduler')
  const endNumerator = big(getFeeSchedulerMinBaseFeeNumerator(new BN(startNumerator.toString()), numberOfPeriod,
    new BN(reductionFactor.toString()), mode))
  return Object.freeze({ kind: 'scheduled', mode, startNumerator, endNumerator, numberOfPeriod, periodFrequency, reductionFactor,
    durationPoints: BigInt(numberOfPeriod) * periodFrequency, firstSwapMinFee, activationType })
}

// The launch guard: only the proven flat 1.75% configs or exactly LAUNCH_FEE_SCHEDULE (timestamp activation,
// launcher's first buy at the minimum fee, 1.75% afterwards) may receive new launches.
export function isApprovedLaunchFee(config) {
  let schedule
  try { schedule = readFeeSchedule(config) } catch { return false }
  if (schedule.kind === 'flat') return schedule.startNumerator === STANDARD_FEE_NUMERATOR
  const approved = LAUNCH_FEE_SCHEDULE
  return schedule.mode === approved.baseFeeMode && schedule.startNumerator === approved.cliffFeeNumerator &&
    schedule.numberOfPeriod === approved.numberOfPeriod && schedule.periodFrequency === approved.periodFrequency &&
    schedule.reductionFactor === approved.reductionFactor && schedule.endNumerator === STANDARD_FEE_NUMERATOR &&
    schedule.firstSwapMinFee && schedule.activationType === ActivationType.Timestamp
}

// The DBC program charges no trade before a pool's activation point. A confirmed-commitment clock can trail
// the slot that created a brand-new pool, so quotes clamp to the activation point: the fee there is the
// highest the trade can be charged (the schedule only decreases), which keeps minimum outputs safe.
export function quotePoint(currentPoint, activationPoint) {
  const current = big(currentPoint), activation = big(activationPoint)
  return new BN((current > activation ? current : activation).toString())
}

// Exact base fee numerator the program charges at currentPoint (program and SDK share this integer math).
export function feeNumeratorAt(schedule, activationPoint, currentPoint) {
  if (schedule.kind === 'flat') return schedule.startNumerator
  return big(getBaseFeeNumerator(new BN(schedule.startNumerator.toString()), schedule.numberOfPeriod,
    new BN(schedule.periodFrequency.toString()), new BN(schedule.reductionFactor.toString()), schedule.mode,
    quotePoint(currentPoint, activationPoint), new BN(big(activationPoint).toString())))
}

// Live window state for a scheduled pool (null for flat configs). Points are unix seconds on timestamp configs.
export function launchFeeWindow(schedule, activationPoint, currentPoint) {
  if (schedule.kind !== 'scheduled') return null
  const activation = big(activationPoint), current = big(quotePoint(currentPoint, activationPoint))
  const endsAt = activation + schedule.durationPoints
  const feeNumerator = feeNumeratorAt(schedule, activation, current)
  return Object.freeze({ active: current < endsAt, feeNumerator,
    startNumerator: schedule.startNumerator, endNumerator: schedule.endNumerator, activationPoint: activation, endsAt,
    remaining: current < endsAt ? endsAt - current : 0n })
}

// Display-only fee facts for one pool: never throws, so an unexpected config can still be quoted and traded.
// feeNumerator is the base fee the program charges at currentPoint (dynamic fees are off on approved configs).
export function poolFeeFacts(config, activationPoint, currentPoint) {
  let schedule
  try { schedule = readFeeSchedule(config) } catch { return { feeNumerator: null, launchFee: null } }
  const window = launchFeeWindow(schedule, activationPoint, currentPoint)
  return { feeNumerator: window?.feeNumerator ?? schedule.startNumerator, launchFee: window }
}

// JSON form of a live launch-fee window for API responses and trade records.
export function launchFeeJson(window) {
  if (!window) return null
  return { active: window.active, feeNumerator: window.feeNumerator.toString(), endFeeNumerator: window.endNumerator.toString(),
    startFeeNumerator: window.startNumerator.toString(), endsAt: Number(window.endsAt), remainingSeconds: Number(window.remaining) }
}

// Static, factual copy inputs for a market or launch config (null when its fee is flat). Plain JSON values,
// safe to pass to client components.
export function launchFeeTerms(schedule) {
  if (schedule?.kind !== 'scheduled') return null
  const points = Number(schedule.durationPoints), seconds = schedule.activationType === ActivationType.Timestamp
  const durationLabel = !seconds ? `${points} slots` : points % 60 === 0 ? `${points / 60} minute${points === 60 ? '' : 's'}` : `${points} seconds`
  return Object.freeze({ startPercent: feePercentLabel(schedule.startNumerator), endPercent: feePercentLabel(schedule.endNumerator),
    durationSeconds: seconds ? points : null, durationLabel,
    launcherBuyPercent: schedule.firstSwapMinFee ? feePercentLabel(schedule.endNumerator) : null })
}
