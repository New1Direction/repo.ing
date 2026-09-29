import { ImageResponse } from 'next/og'
import sharp from 'sharp'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { chain, database, marketByMint } from '../../../../lib/server.mjs'
import { solUsdPrice } from '../../../../lib/sol-usd.mjs'
import { ogMarketStats, ogText, settleWithin } from '../../../../lib/og-card.mjs'
import { readMarketChart } from '../../../../../src/market-chart.mjs'
import { GET as repositoryLogo } from '../../../../api/repo-logo/[repo]/route'
export const runtime = 'nodejs'
// A plain route, not the opengraph-image file convention: inside a route group that convention
// appends a hash to the URL, and existing share links point at /token/<mint>/opengraph-image.
const size = { width: 1200, height: 630 }
const LOGO = 156, LOGO_BYTES = 2_000_000, SOURCE_MS = 3500
const CARD_TTL_MS = 5 * 60_000, CARD_LIMIT = 200
const CACHE = 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600'
const FALLBACK_CACHE = 'public, max-age=60, s-maxage=60'
const colors = { bg: '#101213', surface: '#17191b', border: '#32373a', text: '#f4f6fa', muted: '#aeb6c1', green: '#81e6ad' }
const cards = new Map()

export async function GET(_request, { params }) {
  const { mint } = await params
  try {
    if (typeof mint !== 'string' || mint.length > 44 || bs58.decode(mint).length !== 32) return fallback()
    const cached = cards.get(mint)
    if (cached && Date.now() < cached.expiresAt) return png(cached.body, cached.cacheControl)
    const { market } = await marketByMint(mint)
    if (!market) return fallback()
    const [logo, priceSol, supply, usdPerSol] = await Promise.all([
      settleWithin(marketLogo(market), SOURCE_MS),
      settleWithin(readMarketChart(database(), market, '1h').then(chart => chart.latest?.priceSol ?? null), SOURCE_MS),
      settleWithin((async () => (await chain().getTokenSupply(new PublicKey(market.mint), 'finalized')).value)(), SOURCE_MS),
      settleWithin(solUsdPrice(), SOURCE_MS),
    ])
    const stats = ogMarketStats({ priceSol, supplyBaseUnits: supply?.amount, supplyDecimals: supply?.decimals, usdPerSol })
    // Materialize before responding so a renderer failure falls back instead of sending a broken PNG.
    const body = await new ImageResponse(<MarketCard market={market} logo={logo} stats={stats}/>, size).arrayBuffer()
    // A card missing its figures (slow RPC or price feed) is retried sooner.
    const complete = stats.length > 0
    if (cards.size >= CARD_LIMIT) cards.delete(cards.keys().next().value)
    const cacheControl = complete ? CACHE : FALLBACK_CACHE
    cards.set(mint, { body, cacheControl, expiresAt: Date.now() + (complete ? CARD_TTL_MS : 60_000) })
    return png(body, cacheControl)
  } catch {
    return fallback()
  }
}

function png(body, cacheControl) {
  return new Response(body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': cacheControl } })
}

async function fallback() {
  try { return png(await new ImageResponse(<FallbackCard/>, size).arrayBuffer(), FALLBACK_CACHE) }
  catch { return Response.redirect(new URL('/opengraph-image.png', 'https://repo.ing'), 302) }
}

async function marketLogo(market) {
  try {
    const { rows } = await database().query('select token_image from markets where mint=$1', [market.mint])
    if (rows[0]?.token_image) return rows[0].token_image
  } catch { /* Legacy markets can still resolve their repository artwork below. */ }
  const result = await repositoryLogo(null, { params: Promise.resolve({ repo: market.repoId }) })
  const location = result.headers.get('location')
  if (!location) return null
  const response = await fetch(location, { signal: AbortSignal.timeout(SOURCE_MS) })
  if (!response.ok || Number(response.headers.get('content-length')) > LOGO_BYTES) return null
  const reader = response.body.getReader(), parts = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    bytes += value.byteLength
    if (bytes > LOGO_BYTES) { await reader.cancel(); return null }
    parts.push(Buffer.from(value))
  }
  const image = await sharp(Buffer.concat(parts), { limitInputPixels: 10_000_000 })
    .resize(LOGO, LOGO, { fit: 'contain', background: colors.surface }).png().toBuffer()
  return `data:image/png;base64,${image.toString('base64')}`
}

function Wordmark() {
  return <span style={{ display: 'flex', fontSize: 34, fontWeight: 700, letterSpacing: '-1px' }}>repo<span style={{ color: colors.green }}>.ing</span></span>
}

function Frame({ children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: colors.bg, color: colors.text, padding: '48px 64px', fontFamily: 'sans-serif' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 26, borderBottom: `1px solid ${colors.border}` }}><Wordmark/><span style={{ fontSize: 22, color: colors.muted }}>Open source markets</span></div>
    {children}
    <div style={{ display: 'flex', marginTop: 'auto', paddingTop: 22, borderTop: `1px solid ${colors.border}`, fontSize: 24, color: colors.green }}>Every trade pays the repo’s builders in SOL.</div>
  </div>
}

function MarketCard({ market, logo, stats }) {
  const symbol = ogText(market.symbol, 14), name = ogText(market.fullName, 48)
  return <Frame>
    <div style={{ display: 'flex', alignItems: 'center', gap: 36, marginTop: 44 }}>
      {logo ? <img src={logo} width={LOGO} height={LOGO} style={{ width: LOGO, height: LOGO, flexShrink: 0, borderRadius: 24 }}/>
        : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: LOGO, height: LOGO, flexShrink: 0, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 24, fontSize: 64, color: colors.green }}>{symbol.slice(0, 1) || '$'}</div>}
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

function FallbackCard() {
  return <Frame>
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 70, gap: 18 }}>
      <strong style={{ fontSize: 76, letterSpacing: '-2px' }}>Launch open source markets.</strong>
      <span style={{ fontSize: 34, color: colors.muted }}>Tokenize any public GitHub repo on Solana.</span>
    </div>
  </Frame>
}
