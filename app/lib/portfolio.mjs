// Pure portfolio math, shared by the wallet API and page. Token balances use 6 decimals and
// prices are SOL per whole token (the chart's spot price), so value = base units × price × 1e3.
const LAMPORTS_PER_BASE_UNIT_AT_ONE_SOL = 1000
const MARKET_TOKEN_DECIMALS = 6

// Latest spot price among one market's trades in its newest slot, ordered exactly like the chart:
// block transaction order, then signature, then event. Same-slot trades without finalized block
// order across several transactions are ambiguous, so no price is claimed (the chart withholds it too).
export function latestSlotTrade(rows) {
  if (!rows?.length) return null
  const unordered = rows.some(row => row.transactionIndex === null || row.transactionIndex === undefined)
  if (unordered && new Set(rows.map(row => row.signature)).size > 1) return null
  const rank = row => row.transactionIndex ?? Infinity
  return [...rows].sort((a, b) => rank(b) - rank(a) || (a.signature < b.signature ? 1 : a.signature > b.signature ? -1 : 0) ||
    b.eventIndex - a.eventIndex)[0]
}

export function holdingValueLamports(balanceBaseUnits, priceSol) {
  if (balanceBaseUnits === null || balanceBaseUnits === undefined) return null
  if (!Number.isFinite(priceSol) || priceSol < 0) return null
  const balance = BigInt(balanceBaseUnits)
  if (balance <= 0n || priceSol === 0) return '0'
  const value = Math.round(Number(balance) * priceSol * LAMPORTS_PER_BASE_UNIT_AT_ONE_SOL)
  return Number.isFinite(value) ? BigInt(value).toString() : null
}

// A stock pair's holding, valued in its stock (docs/STOCK_QUOTES.md): a stock value never goes in a SOL field. stock: the
// market row's `stock` (app/lib/stock-market-stats.mjs): its last trade price in whole raw units of the stock per whole token,
// and the stock's display multiplier and USD price when they are cached. Returns the stock's display facts with valueRaw, the
// holding in raw base units of the stock (rounded down; null before the market's first trade), for the page to show as wallets
// show the stock (app/lib/stock-display.mjs); { assetId, symbol, unavailable: true } when the stock's figures could not be read.
export function stockHoldingValue(balanceBaseUnits, stock) {
  const { assetId = null, symbol = null, decimals } = stock ?? {}
  if (!stock || stock.unavailable || !symbol || !Number.isInteger(decimals) || decimals < 0) return { assetId, symbol, unavailable: true }
  const price = Number.isFinite(stock.price) && stock.price >= 0 ? stock.price : null
  let valueRaw = null
  if (price !== null && balanceBaseUnits !== null && balanceBaseUnits !== undefined) {
    const value = Math.floor(Number(BigInt(balanceBaseUnits)) * price * 10 ** (decimals - MARKET_TOKEN_DECIMALS))
    valueRaw = Number.isSafeInteger(value) && value >= 0 ? String(value) : null
  }
  return { assetId, symbol, decimals, price, valueRaw, uiMultiplier: stock.uiMultiplier ?? null, usdPrice: stock.usdPrice ?? null }
}

// Attach price/value to each market row; a held market without a price reports value null. stocks: repoId → the market row's
// `stock` for stock-paired markets, which get no SOL price or value and a stockValue (stockHoldingValue) instead. SOL rows are
// exactly as they were.
export function withHoldingValues(markets, prices, stocks = new Map()) {
  return markets.map(market => {
    if (stocks.has(market.repoId)) return { ...market, priceSol: null, valueLamports: null, stockValue: stockHoldingValue(market.balanceBaseUnits, stocks.get(market.repoId)) }
    const priceSol = prices.get(market.repoId) ?? null
    return { ...market, priceSol, valueLamports: holdingValueLamports(market.balanceBaseUnits, priceSol) }
  })
}

const held = market => BigInt(market.balanceBaseUnits ?? '0') > 0n

export function portfolioSummary(markets) {
  const holdings = markets.filter(held)
  const priced = holdings.filter(market => market.valueLamports !== null)
  return { valueLamports: priced.reduce((total, market) => total + BigInt(market.valueLamports), 0n).toString(),
    holdings: holdings.length, unpriced: holdings.length - priced.length }
}

// Highest value first; holdings awaiting a price keep their relative order at the end.
export function sortHoldingsByValue(markets) {
  const value = market => market.valueLamports === null || market.valueLamports === undefined ? -1n : BigInt(market.valueLamports)
  return [...markets].sort((a, b) => { const d = value(b) - value(a); return d > 0n ? 1 : d < 0n ? -1 : 0 })
}
