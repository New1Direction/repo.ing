export function formatUsdMarketCap(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.01) return '<$0.01'
  if (value < 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: value < 10 ? 2 : 0 })}`
  for (const [threshold, suffix] of [[1e12, 't'], [1e9, 'b'], [1e6, 'm'], [1e3, 'k']]) {
    if (value >= threshold) return `$${(value / threshold).toFixed(1).replace(/\.0$/, '')}${suffix}`
  }
  return '—'
}

// Every market launches from the fixed DBC config: 1,000,000,000 tokens, immutable mint authority.
// List rows use it instead of a per-market supply RPC read, so this is the fully diluted cap.
export const MARKET_TOKEN_SUPPLY = 1_000_000_000

export function formatSolMarketCap(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.01) return '<0.01 SOL'
  if (value < 1000) return `${value.toLocaleString('en-US', { maximumFractionDigits: value < 10 ? 2 : 1 })} SOL`
  for (const [threshold, suffix] of [[1e9, 'b'], [1e6, 'm'], [1e3, 'k']]) {
    if (value >= threshold) return `${(value / threshold).toFixed(1).replace(/\.0$/, '')}${suffix} SOL`
  }
  return '—'
}

// USD when a SOL/USD price is available, otherwise the SOL cap. Null when the market has no recorded price.
export function marketCapDisplay(priceSol, usdPerSol = null) {
  if (typeof priceSol !== 'number' || !Number.isFinite(priceSol) || priceSol <= 0) return null
  const capSol = priceSol * MARKET_TOKEN_SUPPLY
  const sol = formatSolMarketCap(capSol)
  if (typeof usdPerSol === 'number' && Number.isFinite(usdPerSol) && usdPerSol > 0) {
    const usd = formatUsdMarketCap(capSol * usdPerSol)
    if (usd !== '—') return { value: usd, title: `Market cap ≈ ${sol} (last trade price × 1B supply). USD estimate at the current SOL price.` }
  }
  return { value: sol, title: 'Market cap: last trade price × 1B supply.' }
}

// Graduated markets read 100%. Unknown or invalid progress returns null so no line is drawn.
export function bondingProgress({ bondingPercent = null, graduated = false } = {}) {
  if (graduated) return { percent: 100, label: 'Graduated' }
  if (typeof bondingPercent !== 'number' || !Number.isFinite(bondingPercent)) return null
  const percent = Math.min(100, Math.max(0, bondingPercent))
  return { percent, label: `${Math.floor(percent)}% to graduation` }
}
