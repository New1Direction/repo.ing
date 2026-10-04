import { chain, marketByMint } from '../../../../lib/server.mjs'
import { solUsdPrice } from '../../../../lib/sol-usd.mjs'
import { marketTokenMetrics } from '../../../../lib/market-metrics.mjs'
import { MARKET_METRICS_CACHE, NO_STORE } from '../../../../lib/cache-headers.mjs'
import { timed, withServerTiming } from '../../../../lib/server-timing.mjs'
import { marketQuoteView } from '../../../../../src/quote-assets.mjs'
import { isStockMarket } from '../../../../../src/stock-market-chart.mjs'
import { stockUnits } from '../../../../lib/stock-units.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A stock pair's display facts (today's display multiplier and the stock's USD price, from the units cache: at most
// UNITS_WAIT_MS when nothing is cached), so its chart, market cap and phone summary show the stock as wallets do. null when
// they cannot be read, or for a stamp the registry no longer matches.
const unitsOf = async market => {
  const quote = marketQuoteView(market)
  if (!quote || quote.unavailable) return null
  return timed('stockUnits', () => stockUnits.within(quote.assetId, chain))
}

export const GET = withServerTiming(async (_request, { params }) => {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  if (!market) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
  const stock = isStockMarket(market)
  const [solUsd, metrics, quote] = await Promise.all([
    solUsdPrice(), timed('tokenMetrics', () => marketTokenMetrics(chain(), market.mint, market.pool)).catch(() => null),
    stock ? unitsOf(market) : null,
  ])
  // A response without chain metrics (RPC unavailable), or a stock pair's without its units, is never shared from the
  // edge, so the next poll retries the read. SOL markets answer exactly as before.
  return Response.json({ solUsd, ...(stock ? { quote } : {}), ...metrics, fetchedAt: new Date().toISOString() },
    { headers: metrics && (!stock || quote) ? MARKET_METRICS_CACHE : NO_STORE })
})
