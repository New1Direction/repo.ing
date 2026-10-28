const COMPACT_UNITS = [[1e3, 'k'], [1e6, 'm'], [1e9, 'b'], [1e12, 't']]

// A non-negative figure, plain below 1,000 (smallDigits decimals at most), else one decimal and a suffix up to `largest`. The
// suffix is chosen after rounding: 999,960 is "1m", never "1000k".
export function compactFigure(value, smallDigits, largest = 't') {
  if (Number(value.toFixed(smallDigits)) < 1000) return value.toLocaleString('en-US', { maximumFractionDigits: smallDigits })
  const units = COMPACT_UNITS.slice(0, COMPACT_UNITS.findIndex(([, suffix]) => suffix === largest) + 1)
  const scaled = index => Number((value / units[index][0]).toFixed(1))
  let index = Math.max(0, units.findLastIndex(([threshold]) => value >= threshold))
  if (scaled(index) >= 1000 && index < units.length - 1) index++
  return `${scaled(index)}${units[index][1]}`
}

export function formatUsdMarketCap(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${compactFigure(value, value < 10 ? 2 : 0)}`
}

// Whole tokens in a mint's on-chain supply ({ baseUnits, decimals } from mint_facts: market rows' and the chart's `supply`,
// or the metrics route's supplyBaseUnits/supplyDecimals); null until the mint has been read. Every market cap uses it.
export function supplyTokens(supply) {
  const baseUnits = supply?.baseUnits ?? supply?.supplyBaseUnits, decimals = supply?.decimals ?? supply?.supplyDecimals
  if (!/^\d+$/.test(String(baseUnits ?? '')) || !Number.isInteger(decimals) || decimals < 0) return null
  return Number(baseUnits) / 10 ** decimals
}

export function formatSolMarketCap(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.01) return '<0.01 SOL'
  return `${compactFigure(value, value < 10 ? 2 : 1, 'b')} SOL`
}

// USD when a SOL/USD price is available, otherwise the SOL cap. Null when the market has no recorded price or its supply is
// not read yet. supply: the row's mint supply (supplyTokens).
export function marketCapDisplay(priceSol, supply, usdPerSol = null) {
  const tokens = supplyTokens(supply)
  if (typeof priceSol !== 'number' || !Number.isFinite(priceSol) || priceSol <= 0 || !tokens) return null
  const capSol = priceSol * tokens
  const sol = formatSolMarketCap(capSol)
  if (typeof usdPerSol === 'number' && Number.isFinite(usdPerSol) && usdPerSol > 0) {
    const usd = formatUsdMarketCap(capSol * usdPerSol)
    if (usd !== '—') return { value: usd, title: `Market cap ≈ ${sol} (last trade price × on-chain supply). USD estimate at the current SOL price.` }
  }
  return { value: sol, title: 'Market cap: last trade price × on-chain supply.' }
}

// Graduated markets read 100%. Unknown or invalid progress returns null so no line is drawn.
export function bondingProgress({ bondingPercent = null, graduated = false } = {}) {
  if (graduated) return { percent: 100, label: 'Graduated' }
  if (typeof bondingPercent !== 'number' || !Number.isFinite(bondingPercent)) return null
  const percent = Math.min(100, Math.max(0, bondingPercent))
  return { percent, label: `${Math.floor(percent)}% to graduation` }
}
