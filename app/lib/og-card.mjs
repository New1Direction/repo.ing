import { formatUsdMarketCap } from './market-display.mjs'
import { formatUsdPrice } from './phone-market-summary.mjs'

const positive = value => Number.isFinite(value) && value > 0
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// X (and other apps) keep the first copy of a link's card for days, so the card says when its figures were read, and
// the page points at a card URL that changes every CARD_VERSION_MS: a later fetch of the page gets a new image, not
// the copy saved under the old image URL. The card route ignores ?v.
export const CARD_VERSION_MS = 5 * 60_000
export function ogCardImageUrl(pageUrl, now = Date.now()) {
  return `${pageUrl}/opengraph-image?v=${Math.floor(now / CARD_VERSION_MS).toString(36)}`
}

// "8 Oct 2026, 23:40 UTC"; '' for no time or an invalid one.
export function ogStatsTime(at) {
  if (at === null || at === undefined) return ''
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = value => String(value).padStart(2, '0')
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

// Headline figures for a token's link preview. Any missing input drops that figure instead of
// guessing: USD cap needs price, supply and SOL/USD; without SOL/USD the price shows in SOL. Prices are plain
// decimals ($0.00004296), never exponents (5.159e-8), because people read these cards on X.
export function ogMarketStats({ priceSol, supplyBaseUnits, supplyDecimals, usdPerSol } = {}) {
  if (!positive(priceSol)) return []
  const stats = []
  const supply = /^\d+$/.test(String(supplyBaseUnits ?? '')) && Number.isInteger(supplyDecimals) && supplyDecimals >= 0
    ? Number(supplyBaseUnits) / 10 ** supplyDecimals : null
  if (positive(supply) && positive(usdPerSol)) {
    const cap = formatUsdMarketCap(priceSol * supply * usdPerSol)
    if (cap !== '—') stats.push({ label: 'Market cap', value: cap })
  }
  stats.push({ label: 'Price', value: positive(usdPerSol) ? formatUsdPrice(priceSol * usdPerSol)
    : `${priceSol.toLocaleString('en-US', { maximumSignificantDigits: 4 })} SOL` })
  return stats
}

export function ogText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

// Resolves to fallback when work is slow or fails, so one stalled source never stalls the card.
export function settleWithin(promise, ms, fallback = null) {
  let timer
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(resolve, ms, fallback) }),
  ]).finally(() => clearTimeout(timer))
}
