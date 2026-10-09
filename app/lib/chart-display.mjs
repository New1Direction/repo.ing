export const CHART_PERIODS = [['1h', '1H'], ['24h', '24H'], ['7d', '7D'], ['all', 'All']]

// Plain decimals, never exponent notation ("0.0000004338", not "4.338e-7"). Below 0.000001, 4 significant digits (as many as
// the old exponent form showed) keep the price axis, which uses this too, as narrow as it can be.
export function chartPriceLabel(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value === 0) return '0'
  return value.toLocaleString('en-US', { maximumSignificantDigits: value < 0.000001 ? 4 : 5 })
}

export function chartScaleRange(original) {
  if (!original?.priceRange) return original
  const { minValue, maxValue } = original.priceRange
  const pad = Math.max((maxValue - minValue) * 0.08, Math.abs(maxValue) * 0.02)
  return { ...original, priceRange: { minValue: Math.max(0, minValue - pad), maxValue: maxValue + pad } }
}

// volumeOf: a bar's volume as the histogram plots it (SOL by default; a stock pair's in its shown units, app/lib/chart-quote.mjs).
export function chartSeries(data, multiplier = 1, volumeOf = bar => Number(bar.volumeLamports) / 1e9) {
  if (!data || !Number.isFinite(multiplier) || multiplier <= 0) return { prices: [], volumes: [] }
  const byTime = new Map(data.candles.map(bar => [bar.time, bar]))
  const first = data.candles[0]?.time
  const last = data.candles.at(-1)?.time
  const prices = [], volumes = []
  // Whitespace preserves elapsed time without manufacturing flat candles or trades.
  for (let time = first; time <= last; time += data.interval) {
    const bar = byTime.get(time)
    if (!bar || bar.orderingPending) prices.push({ time })
    else prices.push({ time, open: bar.open * multiplier, high: bar.high * multiplier,
      low: bar.low * multiplier, close: bar.close * multiplier, value: bar.close * multiplier })
    volumes.push(bar ? { time, value: volumeOf(bar),
      color: bar.orderingPending ? '#7f889266' : bar.close >= bar.open ? '#81e6ad66' : '#f2848566' } : { time })
  }
  return { prices, volumes }
}

// Only the tail can use update(). Corrections, rolling windows and a change of
// denomination must replace history, including bars whose evidence was revoked.
export function chartUpdatePlan(previous, next) {
  if (!previous || next.length < previous.length) return { reset: true, bars: next }
  let first = 0
  while (first < previous.length && JSON.stringify(previous[first]) === JSON.stringify(next[first])) first++
  if (first < previous.length - 1 || (first < previous.length && previous[first].time !== next[first]?.time)) return { reset: true, bars: next }
  return { reset: false, bars: next.slice(first) }
}

export function chartInitialRange(count, style) {
  // Blank space is a viewport choice, never synthetic prices. Keep sparse candle
  // bodies readable instead of stretching one trade across half the canvas.
  const visible = Math.max(count, style === 'candles' ? 40 : 12)
  const padding = Math.max(1, Math.min(3, visible * 0.04))
  return { from: count - visible - padding, to: count - 1 + padding }
}

export function chartTradeAge(tradedAt, now) {
  const elapsed = now - Date.parse(tradedAt)
  if (!Number.isFinite(elapsed)) return null
  const minutes = Math.max(0, Math.floor(elapsed / 60000))
  if (!minutes) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}
