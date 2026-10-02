import { ImageResponse } from 'next/og'
import sharp from 'sharp'
import { database } from './server.mjs'
import { GET as repositoryLogo } from '../api/repo-logo/[repo]/route'
import { isModelMarket } from './hf-model-display.mjs'

// Shared pieces of repo.ing's 1200×630 link-preview cards: frame, logo loading, PNG caching, fallback.
export const size = { width: 1200, height: 630 }
export const LOGO = 156, SOURCE_MS = 3500
const LOGO_BYTES = 2_000_000, CARD_TTL_MS = 5 * 60_000, RETRY_TTL_MS = 60_000, CARD_LIMIT = 200
export const CACHE = 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600'
export const FALLBACK_CACHE = 'public, max-age=60, s-maxage=60'
export const colors = { bg: '#101213', surface: '#17191b', border: '#32373a', text: '#f4f6fa', muted: '#aeb6c1', green: '#81e6ad', red: '#f28485' }

export function png(body, cacheControl) {
  return new Response(body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': cacheControl } })
}

// Materialize before responding so a renderer failure falls back instead of sending a broken PNG.
export const renderPng = element => new ImageResponse(element, size).arrayBuffer()

export async function fallback() {
  try { return png(await renderPng(<FallbackCard/>), FALLBACK_CACHE) }
  catch { return Response.redirect(new URL('/opengraph-image.png', 'https://repo.ing'), 302) }
}

// Small in-process card cache. An incomplete card (slow RPC, price feed or logo) is retried sooner.
export function cardCache() {
  const cards = new Map()
  return {
    get(key) {
      const cached = cards.get(key)
      return cached && Date.now() < cached.expiresAt ? png(cached.body, cached.cacheControl) : null
    },
    put(key, body, complete) {
      if (cards.size >= CARD_LIMIT) cards.delete(cards.keys().next().value)
      const cacheControl = complete ? CACHE : FALLBACK_CACHE
      cards.set(key, { body, cacheControl, expiresAt: Date.now() + (complete ? CARD_TTL_MS : RETRY_TTL_MS) })
      return png(body, cacheControl)
    },
  }
}

export async function marketLogo(market) {
  try {
    const { rows } = await database().query('select token_image from markets where mint=$1', [market.mint])
    if (rows[0]?.token_image) return rows[0].token_image
  } catch { /* Legacy markets can still resolve their repository artwork below. */ }
  if (isModelMarket(market)) return modelLogo(market)
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

// A model owner's avatar only as the logo route's resized raster (its Hub host allowlist checks every hop; SVGs and
// failures come back as a redirect, and the card then shows the ticker letter instead).
async function modelLogo(market) {
  const response = await repositoryLogo(new Request(`https://repo.ing/api/repo-logo/${market.repoId}?w=256`), { params: Promise.resolve({ repo: String(market.repoId) }) })
  if (response.status !== 200 || response.headers.get('content-type') !== 'image/webp') return null
  const image = await sharp(Buffer.from(await response.arrayBuffer()), { limitInputPixels: 10_000_000 })
    .resize(LOGO, LOGO, { fit: 'contain', background: colors.surface }).png().toBuffer()
  return `data:image/png;base64,${image.toString('base64')}`
}

function Wordmark() {
  return <span style={{ display: 'flex', fontSize: 34, fontWeight: 700, letterSpacing: '-1px' }}>repo<span style={{ color: colors.green }}>.ing</span></span>
}

// tagline and footer: a model market's card names models and who they pay (app/(site)/token/[mint]/opengraph-image).
export function Frame({ children, tagline = 'Open source markets', footer = 'Every trade pays the repo’s builders in SOL.' }) {
  return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: colors.bg, color: colors.text, padding: '48px 64px', fontFamily: 'sans-serif' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 26, borderBottom: `1px solid ${colors.border}` }}><Wordmark/><span style={{ fontSize: 22, color: colors.muted }}>{tagline}</span></div>
    {children}
    <div style={{ display: 'flex', marginTop: 'auto', paddingTop: 22, borderTop: `1px solid ${colors.border}`, fontSize: 24, color: colors.green }}>{footer}</div>
  </div>
}

export function MarketLogo({ logo, symbol, size: side = LOGO }) {
  return logo ? <img src={logo} width={side} height={side} style={{ width: side, height: side, flexShrink: 0, borderRadius: 24 }}/>
    : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: side, height: side, flexShrink: 0, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 24, fontSize: Math.round(side * 0.41), color: colors.green }}>{symbol.slice(0, 1) || '$'}</div>
}

function FallbackCard() {
  return <Frame>
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 70, gap: 18 }}>
      <strong style={{ fontSize: 76, letterSpacing: '-2px' }}>Launch open source markets.</strong>
      <span style={{ fontSize: 34, color: colors.muted }}>Tokenize any public GitHub repo on Solana.</span>
    </div>
  </Frame>
}
