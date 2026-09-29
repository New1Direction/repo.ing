import { formatUsdMarketCap } from './market-display.mjs'
import { chartPriceLabel } from './chart-display.mjs'

const positive = value => Number.isFinite(value) && value > 0

// Headline figures for a token's link preview. Any missing input drops that figure instead of
// guessing: USD cap needs price, supply and SOL/USD; the SOL price alone still renders.
export function ogMarketStats({ priceSol, supplyBaseUnits, supplyDecimals, usdPerSol } = {}) {
  if (!positive(priceSol)) return []
  const stats = []
  const supply = /^\d+$/.test(String(supplyBaseUnits ?? '')) && Number.isInteger(supplyDecimals) && supplyDecimals >= 0
    ? Number(supplyBaseUnits) / 10 ** supplyDecimals : null
  if (positive(supply) && positive(usdPerSol)) {
    const cap = formatUsdMarketCap(priceSol * supply * usdPerSol)
    if (cap !== '—') stats.push({ label: 'Market cap', value: cap })
  }
  stats.push({ label: 'Price', value: `${chartPriceLabel(priceSol)} SOL` })
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
