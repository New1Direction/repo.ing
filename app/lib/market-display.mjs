export function formatUsdMarketCap(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.01) return '<$0.01'
  if (value < 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: value < 10 ? 2 : 0 })}`
  for (const [threshold, suffix] of [[1e12, 't'], [1e9, 'b'], [1e6, 'm'], [1e3, 'k']]) {
    if (value >= threshold) return `$${(value / threshold).toFixed(1).replace(/\.0$/, '')}${suffix}`
  }
  return '—'
}
