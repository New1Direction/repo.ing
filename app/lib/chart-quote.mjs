import { formatSolDisplay } from './format.mjs'
import { formatQuoteAmount, stockAmountLabel, stockDisplayUnits } from './stock-display.mjs'
import { shownUnits } from './trade-units.mjs'

const DIGITS = /^\d+$/

// What a market's chart, its readout, recent trades and phone summary are denominated in, as one set of accessors, so a SOL
// payload (src/market-chart.mjs) and a stock pair's (src/stock-market-chart.mjs) render through the same components without
// a stock value ever passing through a SOL field.
// - SOL (quote null): exactly what the chart always read: priceSol, volumeLamports, solLamports, SOL's USD price.
// - A stock pair (quote: marketQuoteView): raw-unit prices and volumes shown as wallets show the stock, at today's display
//   multiplier, and USD at the stock's own price, both from the metrics route's `quote` (src/quote-asset-info.mjs). Until
//   those units load (or when they fail) `ready` is false and prices and amounts read '—', never raw units.
// metrics: the metrics route's response (or null).
export function chartQuote(quote, metrics) {
  if (!quote) {
    return { symbol: 'SOL', stock: false, ready: true, priceScale: 1, usdPerUnit: metrics?.solUsd ?? null,
      price: trade => trade?.priceSol ?? null,
      volume24h: data => data?.volume24hLamports ?? null,
      barVolume: bar => Number(bar.volumeLamports) / 1e9,
      barVolumeAmount: bar => formatSolDisplay(bar.volumeLamports),
      amountLabel: raw => `${formatSolDisplay(raw)} SOL`,
      tradeAmount: trade => trade?.solLamports ?? null }
  }
  const info = metrics?.quote
  // Units for another asset or other decimals are never used (the trade panel checks the same).
  const units = !quote.unavailable && info?.assetId === quote.assetId && info?.decimals === quote.decimals ? stockDisplayUnits(info) : null
  const shown = raw => units && DIGITS.test(String(raw ?? '')) ? shownUnits(raw, units) : null
  // A stamp the registry no longer matches (marketQuoteView's { assetId, unavailable }) never gets units; it is named by its id.
  return { symbol: quote.symbol ?? quote.assetId, stock: true, ready: Boolean(units), priceScale: units?.multiplier ?? null, usdPerUnit: units?.usdPrice ?? null,
    units,
    price: trade => trade?.priceQuote ?? null,
    volume24h: data => data?.volume24hQuote ?? null,
    barVolume: bar => shown(bar.volumeQuote) === null ? 0 : Number(shown(bar.volumeQuote)) / 10 ** units.decimals,
    barVolumeAmount: bar => shown(bar.volumeQuote) === null ? '—' : formatQuoteAmount(shown(bar.volumeQuote), units.decimals),
    amountLabel: raw => stockAmountLabel(raw, units),
    tradeAmount: trade => trade?.quoteAmount ?? null }
}
