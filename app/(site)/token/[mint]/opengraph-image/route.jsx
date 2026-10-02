import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { chain, database, marketByMint } from '../../../../lib/server.mjs'
import { solUsdPrice } from '../../../../lib/sol-usd.mjs'
import { ogMarketStats, settleWithin } from '../../../../lib/og-card.mjs'
import { SOURCE_MS, cardCache, fallback, marketLogo, renderPng } from '../../../../lib/og-image'
import { MarketCard } from '../../../../lib/og-market-card'
import { readMarketChart } from '../../../../../src/market-chart.mjs'
import { isModelMarket } from '../../../../lib/hf-model-display.mjs'
import { hfMarketsEnabled } from '../../../../lib/hf-markets.mjs'
export const runtime = 'nodejs'
// A plain route, not the opengraph-image file convention: inside a route group that convention
// appends a hash to the URL, and existing share links point at /token/<mint>/opengraph-image.
const cards = cardCache()

export async function GET(_request, { params }) {
  const { mint } = await params
  try {
    if (typeof mint !== 'string' || mint.length > 44 || bs58.decode(mint).length !== 32) return fallback()
    const cached = cards.get(mint)
    if (cached) return cached
    const { market } = await marketByMint(mint)
    // A Hugging Face model market's card exists only with HF_MARKETS_ENABLED.
    if (!market || (isModelMarket(market) && !hfMarketsEnabled())) return fallback()
    const [logo, priceSol, supply, usdPerSol] = await Promise.all([
      settleWithin(marketLogo(market), SOURCE_MS),
      settleWithin(readMarketChart(database(), market, '1h').then(chart => chart.latest?.priceSol ?? null), SOURCE_MS),
      settleWithin((async () => (await chain().getTokenSupply(new PublicKey(market.mint), 'finalized')).value)(), SOURCE_MS),
      settleWithin(solUsdPrice(), SOURCE_MS),
    ])
    const stats = ogMarketStats({ priceSol, supplyBaseUnits: supply?.amount, supplyDecimals: supply?.decimals, usdPerSol })
    const body = await renderPng(<MarketCard market={market} logo={logo} stats={stats}/>)
    return cards.put(mint, body, stats.length > 0)
  } catch {
    return fallback()
  }
}
