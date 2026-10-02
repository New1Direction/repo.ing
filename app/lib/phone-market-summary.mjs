import { formatSolDisplay } from './format.mjs'
import { chartPriceLabel } from './chart-display.mjs'
import { formatSolMarketCap, formatUsdMarketCap, MARKET_TOKEN_SUPPLY } from './market-display.mjs'

// The phone token page's market summary, computed only from what the page already has: the server market row (last
// price, curve volume) and the chart's own trades + metrics reads (published through market-snapshot.mjs).
const DAY_SECONDS = 86_400
export const SPARKLINE_POINTS = 48

const priced = candles => (candles ?? []).filter(bar => !bar.orderingPending && bar.close > 0 && bar.open > 0)
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0

// Change against the last close at or before 24h ago; a younger market (or a window starting inside the last 24h)
// compares with its first recorded price instead. Bars withheld for ordering evidence never count.
export function change24h(candles, interval, latestPrice, nowSeconds) {
  const bars = priced(candles)
  if (!bars.length || !positive(latestPrice)) return null
  const before = bars.findLast(bar => bar.time + interval <= nowSeconds - DAY_SECONDS)
  const reference = before ? before.close : bars[0].open
  return (latestPrice / reference - 1) * 100
}

// Closes across the last 24h, starting from the close just before it, evenly thinned to at most `max` points. A market
// with no trade in 24h draws a flat line at its last price.
export function sparklinePoints(candles, interval, nowSeconds, max = SPARKLINE_POINTS) {
  const bars = priced(candles)
  if (!bars.length) return []
  const anchor = bars.findLastIndex(bar => bar.time + interval <= nowSeconds - DAY_SECONDS)
  const closes = bars.slice(Math.max(0, anchor)).map(bar => bar.close)
  if (closes.length === 1) return [closes[0], closes[0]]
  const step = Math.ceil(closes.length / max)
  return closes.filter((_, index) => index % step === 0 || index === closes.length - 1)
}

export function sparklinePath(points, width, height, pad = 2) {
  if (points.length < 2) return ''
  const low = Math.min(...points), high = Math.max(...points)
  const y = value => high === low ? height / 2 : height - pad - (value - low) / (high - low) * (height - 2 * pad)
  return points.map((value, index) => `${index ? 'L' : 'M'}${(pad + index * (width - 2 * pad) / (points.length - 1)).toFixed(1)} ${y(value).toFixed(1)}`).join(' ')
}

export function formatUsdPrice(value) {
  if (!positive(value)) return '—'
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`
}

export function phoneMarketSummary({ priceSol = null, volume24hLamports = null, chart = null, metrics = null, now = Date.now() }) {
  const price = positive(chart?.latest?.priceSol) ? chart.latest.priceSol : positive(priceSol) ? priceSol : null
  const solUsd = positive(metrics?.solUsd) ? metrics.solUsd : null
  const supply = /^\d+$/.test(metrics?.supplyBaseUnits ?? '') && Number.isInteger(metrics.supplyDecimals)
    ? Number(metrics.supplyBaseUnits) / 10 ** metrics.supplyDecimals : MARKET_TOKEN_SUPPLY
  const volume = /^\d+$/.test(String(chart?.volume24hLamports ?? '')) ? chart.volume24hLamports
    : /^\d+$/.test(String(volume24hLamports ?? '')) ? String(volume24hLamports) : null
  const nowSeconds = Math.floor(now / 1000), candles = chart?.candles ?? [], interval = chart?.interval ?? 0
  return {
    price: !price ? '—' : solUsd ? formatUsdPrice(price * solUsd) : `${chartPriceLabel(price)} SOL`,
    change: chart ? change24h(candles, interval, price, nowSeconds) : null,
    marketCap: !price ? '—' : solUsd ? formatUsdMarketCap(price * supply * solUsd) : formatSolMarketCap(price * supply),
    volume: volume === null ? '—' : solUsd ? formatUsdMarketCap(Number(volume) / 1e9 * solUsd) : `${formatSolDisplay(volume)} SOL`,
    spark: chart ? sparklinePoints(candles, interval, nowSeconds) : [],
  }
}
