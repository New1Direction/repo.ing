import { cache } from 'react'
import { quoteOfMarket } from '../../src/quote-assets.mjs'
import { feeRoutingTotals, readMarketLauncherLedger, shownStockUnits, stockMultipliers } from '../../src/stock-launcher-earnings.mjs'
import { chain, database } from './server.mjs'

// A stock pair's 1.75% trading fee at the regular rate, by share (0.30% to the launcher, 1.10% to the stock's accumulator):
// computed in src/stock-pair-copy.mjs, so client components can use the same figures.
export { STOCK_FEE_SPLIT } from '../../src/stock-pair-copy.mjs'

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
