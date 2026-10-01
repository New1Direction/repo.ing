// Launch-fee copy and number formatting. Dependency-free so client components can import it; the fee math lives
// in src/launch-fee.mjs. Every sentence is built from a config's real schedule (launchFeeTerms) or a live quote.

const DENOMINATOR_PER_HUNDREDTH_PERCENT = 100_000n

// Two-decimal percent of a fee numerator (parts of 1e9), rounded half up: 504409597 -> '50.44%', 17500000 -> '1.75%'.
export function feePercentLabel(numerator) {
  const value = BigInt(String(numerator))
  if (value < 0n) throw Error('Invalid fee numerator')
  const hundredths = (value + DENOMINATOR_PER_HUNDREDTH_PERCENT / 2n) / DENOMINATOR_PER_HUNDREDTH_PERCENT
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`
}

// The fee taken by a launch-fee config is distributed exactly like the regular fee.
export const LAUNCH_FEE_SPLIT = 'It is split like the regular fee: shares to the repo’s builders and repo.ing, and Meteora’s 20% protocol share.'

export function launchFeeSentence(terms) {
  return `Trades in the first ${terms.durationLabel} after launch pay a higher fee that starts at ${terms.startPercent} and falls every second to ${terms.endPercent}.`
}

export function launcherBuySentence(terms) {
  return terms.launcherBuyPercent ? `The launcher’s initial buy is part of the launch transaction and pays ${terms.launcherBuyPercent}.` : null
}

const liveWindow = launchFee => launchFee?.active && /^\d+$/.test(String(launchFee.feeNumerator)) &&
  /^\d+$/.test(String(launchFee.endFeeNumerator)) ? Math.max(0, Math.ceil(Number(launchFee.remainingSeconds) || 0)) : null

// One line for a trade quoted while a market's launch fee is still falling (launchFeeJson shape); null otherwise.
export function launchFeeNotice(launchFee) {
  const seconds = liveWindow(launchFee)
  if (seconds === null) return null
  return `Launch fee: ${feePercentLabel(launchFee.feeNumerator)} at quote time, falling every second to ` +
    `${feePercentLabel(launchFee.endFeeNumerator)} within ${seconds} s. It is split like the regular fee.`
}

// Trade panel note for the same window.
export function launchFeeTradeNote(launchFee) {
  const seconds = liveWindow(launchFee)
  if (seconds === null) return null
  return `This market is in its launch-fee window: trades pay ${feePercentLabel(launchFee.feeNumerator)} at this quote. ` +
    `The fee falls every second and reaches the regular ${feePercentLabel(launchFee.endFeeNumerator)} within ${seconds} s. ${LAUNCH_FEE_SPLIT}`
}
