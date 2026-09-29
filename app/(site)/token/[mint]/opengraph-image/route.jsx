import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { chain, database, marketByMint } from '../../../../lib/server.mjs'
import { solUsdPrice } from '../../../../lib/sol-usd.mjs'
import { ogMarketStats, ogText, settleWithin } from '../../../../lib/og-card.mjs'
import { Frame, MarketLogo, SOURCE_MS, cardCache, colors, fallback, marketLogo, renderPng } from '../../../../lib/og-image'
import { readMarketChart } from '../../../../../src/market-chart.mjs'
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
    if (!market) return fallback()
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

function MarketCard({ market, logo, stats }) {
  const symbol = ogText(market.symbol, 14), name = ogText(market.fullName, 48)
  return <Frame>
    <div style={{ display: 'flex', alignItems: 'center', gap: 36, marginTop: 44 }}>
      <MarketLogo logo={logo} symbol={symbol}/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 860 }}>
        <span style={{ fontSize: 34, color: colors.muted }}>{name}</span>
        <strong style={{ fontSize: 76, letterSpacing: '-2px' }}>${symbol}</strong>
      </div>
    </div>
    {stats.length ? <div style={{ display: 'flex', gap: 72, marginTop: 42 }}>{stats.map(stat => <div key={stat.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 22, color: colors.muted, textTransform: 'uppercase', letterSpacing: '3px' }}>{stat.label}</span>
      <strong style={{ fontSize: 52, color: colors.green, letterSpacing: '-1px' }}>{stat.value}</strong>
    </div>)}</div>
      : <span style={{ fontSize: 28, lineHeight: 1.4, color: colors.muted, marginTop: 42 }}>{ogText(market.description || 'Trade this open source repository market on repo.ing.', 120)}</span>}
  </Frame>
}
