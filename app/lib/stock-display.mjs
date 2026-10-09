import { compactFigure, formatUsdMarketCap, MARKET_TOKEN_SUPPLY } from './market-display.mjs'
import { shownUnits, stockUnits } from './trade-units.mjs'

// A stock pair's figures as pages show them (docs/STOCK_QUOTES.md). Ledgers, charts and market stats keep raw units of the
// stock; pages show them as wallets do: raw × the mint's ScaledUiAmount multiplier in force today, truncated as Token-2022
// truncates. History is shown at today's multiplier too, like a split-adjusted chart. USD uses the stock's own price per
// whole raw token (src/quote-asset-info.mjs), never SOL's. Pure: the server and the browser share it.
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0
const DIGITS = /^\d+$/

// The units to show a stock in, from its display facts ({ symbol, decimals, uiMultiplier, usdPrice }: GET
// /api/quote-assets/<id>, the metrics route's `quote`, or a market row's `stock`), or null when they are missing or unusable.
// multiplier is for prices (floats); amounts convert exactly through scale (BigInt).
export function stockDisplayUnits(info) {
  const units = info?.uiMultiplier ? stockUnits(info) : null
  if (!units) return null
  return Object.freeze({ ...units, multiplier: Number(info.uiMultiplier), usdPrice: positive(info.usdPrice) ? info.usdPrice : null })
}

// Base units with `decimals` places, readable: 2 places from one whole unit up, about 4 significant digits below, and never
// 0 for a nonzero amount (the rule formatSolDisplay applies to lamports).
export function formatQuoteAmount(raw, decimals) {
  if (raw === null || raw === undefined || !DIGITS.test(String(raw).replace(/^-/, ''))) return '—'
  const amount = BigInt(raw), floor = 10n ** BigInt(Math.max(0, decimals - 6))
  if (amount !== 0n && amount > -floor && amount < floor) return amount < 0n ? '-<0.000001' : '<0.000001'
  const value = Number(amount) / 10 ** decimals, size = Math.abs(value)
  const places = size >= 1 || size === 0 ? 2 : Math.min(6, 3 - Math.floor(Math.log10(size)))
  return value.toLocaleString('en-US', { maximumFractionDigits: places })
}

// "12.5 METAx" for a raw amount, as wallets show it; '—' without units.
export function stockAmountLabel(raw, units) {
  if (raw === null || raw === undefined || !units || !DIGITS.test(String(raw))) return '—'
  return `${formatQuoteAmount(shownUnits(raw, units), units.decimals)} ${units.symbol}`
}

// USD value of a raw amount at the stock's price, or null.
export function stockRawUsd(raw, units) {
  if (raw === null || raw === undefined || !units?.usdPrice || !DIGITS.test(String(raw))) return null
  return Number(BigInt(raw)) / 10 ** units.decimals * units.usdPrice
}

// Compact cap or volume in shown stock units: "12.3k METAx".
export function formatStockCompact(value, symbol) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.01) return `<0.01 ${symbol}`
  return `${compactFigure(value, value < 10 ? 2 : 1, 'b')} ${symbol}`
}

// A market row's stock figures (row.stock, app/lib/stock-market-stats.mjs) as the market table shows them, like SOL rows:
// the cap in USD at the stock's price when there is one (else in the stock), the 24h volume in the stock as wallets show
// it (USD in its title); '—' while the stock's units are unavailable. The cap is the fully diluted cap (last price × the
// fixed 1B supply), as SOL rows compute it.
export function stockRowDisplay(stock) {
  const units = stockDisplayUnits(stock)
  const price = positive(stock?.price) ? stock.price : null
  const volume = DIGITS.test(String(stock?.volume24h ?? '')) ? stock.volume24h : null
  if (!units) return { cap: null, capTitle: `${stock?.symbol ?? 'Stock'} prices are temporarily unavailable`, volume: '—' }
  const usdCap = price && units.usdPrice ? price * MARKET_TOKEN_SUPPLY * units.usdPrice : null
  const shownCap = price ? price * units.multiplier * MARKET_TOKEN_SUPPLY : null
  const capInStock = shownCap === null ? null : formatStockCompact(shownCap, units.symbol)
  const usdVolume = volume === null ? null : stockRawUsd(volume, units)
  return {
    cap: usdCap !== null ? formatUsdMarketCap(usdCap) : capInStock,
    capTitle: price ? `Market cap ≈ ${capInStock} (last trade price × 1B supply)${usdCap !== null ? `. USD estimate at the current ${units.symbol} price.` : '.'}` : 'No trades recorded yet',
    volume: volume === null ? '—' : stockAmountLabel(volume, units),
    volumeTitle: volume === null ? undefined : `${stockAmountLabel(volume, units)} traded in 24 hours${usdVolume !== null ? ` (≈ ${formatUsdMarketCap(usdVolume)} at the current ${units.symbol} price)` : ''}`,
  }
}
