import { cache } from 'react'
import { STANDARD_FEE_NUMERATOR, feePercentLabel } from '../../src/launch-fee.mjs'
import { quoteOfMarket } from '../../src/quote-assets.mjs'
import { LAUNCHER_DEN, LAUNCHER_NUM, STOCK_CREATOR_FEE_PERCENTAGE } from '../../src/stock-fee-policy.mjs'
import { feeRoutingTotals, readMarketLauncherLedger, shownStockUnits, stockMultipliers } from '../../src/stock-launcher-earnings.mjs'
import { chain, database } from './server.mjs'

// A stock pair's 1.75% trading fee at the regular rate (a launch-fee window scales every share alike): Meteora keeps its 20%
// protocol share, the creator's 71% of the rest is 0.994%, and the launcher gets 150/497 of that, 0.30%. Everything else, the
// builder share and repo.ing's share, is 1.10% to the stock's accumulator (src/stock-fee-policy.mjs).
const METEORA_PERCENT = 20n, CREATOR_PERCENT = BigInt(STOCK_CREATOR_FEE_PERCENTAGE)
const routed = STANDARD_FEE_NUMERATOR * (100n - METEORA_PERCENT) / 100n
const launcherNumerator = routed * CREATOR_PERCENT / 100n * LAUNCHER_NUM / LAUNCHER_DEN
export const STOCK_FEE_SPLIT = Object.freeze({ total: feePercentLabel(STANDARD_FEE_NUMERATOR), meteora: feePercentLabel(STANDARD_FEE_NUMERATOR - routed),
  launcher: feePercentLabel(launcherNumerator), accumulator: feePercentLabel(routed - launcherNumerator) })

const amounts = (value, multiplier) => ({ raw: value.toString(), shown: multiplier === null ? null : shownStockUnits(value, multiplier).toString() })

// What one stock-paired market's fees have routed so far, in the stock's raw units and as wallets show them (null while the
// mint's multiplier cannot be read). Read once per render: the hero and the Fee routing card share it.
export const stockFeeRouting = cache(async market => {
  let quote
  try { quote = quoteOfMarket(market) } catch { return { asset: null, unavailable: 'This market’s stock no longer matches the registry.' } }
  const asset = { assetId: quote.assetId, symbol: quote.symbol, decimals: quote.decimals }
  const pool = database()
  if (!pool) return { asset, unavailable: 'Fee routing is unavailable.' }
  try {
    const row = await readMarketLauncherLedger(pool, market.repoId)
    if (!row) return { asset, unavailable: 'Fee routing is unavailable.' }
    const totals = feeRoutingTotals(row)
    const multiplier = (await stockMultipliers(chain(), [quote.assetId])).get(quote.assetId) ?? null
    return { asset, multiplier, launcherWallet: market.launcherWallet,
      launcher: amounts(totals.launcher, multiplier), accumulator: amounts(totals.accumulator, multiplier) }
  } catch (error) {
    console.error('stock fee routing unavailable', { repoId: String(market.repoId), error: error.message })
    return { asset, unavailable: 'Fee routing is temporarily unavailable.' }
  }
})
