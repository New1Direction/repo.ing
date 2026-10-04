import { feePercentLabel } from './launch-fee-copy.mjs'
import { LAUNCHER_DEN, LAUNCHER_NUM, STOCK_CREATOR_FEE_PERCENTAGE } from './stock-fee-policy.mjs'

// What a stock-paired market's trades pay, in the words its pages use where a SOL market's say "Every trade pays the repo's
// builders in SOL" (docs/STOCK_QUOTES.md, "Fee policy"). Dependency-free, so client components can import it.
//
// The 1.75% fee at the regular rate (a launch-fee window scales every share alike): Meteora keeps its 20% protocol share, the
// creator's 71% of the rest is 0.994%, and the launcher gets 150/497 of that, 0.30%. Everything else, the builder share and
// repo.ing's share, is 1.10% to the stock's accumulator, to become permanent $REPOING / <stock> liquidity
// (src/stock-fee-policy.mjs). REGULAR_FEE_NUMERATOR is STANDARD_FEE_NUMERATOR of src/launch-fee.mjs, which loads the DBC SDK;
// tests/stock-pair-copy.test.mjs keeps the two equal.
const REGULAR_FEE_NUMERATOR = 17_500_000n, METEORA_PERCENT = 20n
const routed = REGULAR_FEE_NUMERATOR * (100n - METEORA_PERCENT) / 100n
const launcherNumerator = routed * BigInt(STOCK_CREATOR_FEE_PERCENTAGE) / 100n * LAUNCHER_NUM / LAUNCHER_DEN
export const STOCK_FEE_SPLIT = Object.freeze({ total: feePercentLabel(REGULAR_FEE_NUMERATOR), meteora: feePercentLabel(REGULAR_FEE_NUMERATOR - routed),
  launcher: feePercentLabel(launcherNumerator), accumulator: feePercentLabel(routed - launcherNumerator) })

// "pays 1.75% in METAx: 0.30% to the launcher, 1.10% to permanent $REPOING / METAx liquidity". symbol: the stock's symbol, or
// null when it is not known (a market whose stamp no longer matches the registry).
export function stockFeeTerms(symbol = null) {
  const { total, launcher, accumulator } = STOCK_FEE_SPLIT
  return `pays ${total} in ${symbol ?? 'its stock'}: ${launcher} to the launcher, ${accumulator} to permanent $REPOING / ${symbol ?? 'stock'} liquidity`
}

// The sentence a stock pair's pages show where a SOL market's say "Every trade pays the repo's builders in SOL."
export const stockFeeLine = (symbol = null) => `Every trade ${stockFeeTerms(symbol)}.`
