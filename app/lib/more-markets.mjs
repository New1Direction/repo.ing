import { STOCK_FEE_SPLIT, stockFeeLine } from '../../src/stock-pair-copy.mjs'

export const MORE_MARKETS_LIMIT = 8
export const NEW_MARKET_MS = 7 * 24 * 60 * 60 * 1000

// Token-page strip: other markets from the same memoized listMarkets() rows the home tabs use
// (already confirmed + finalized only). Traded in the last 24h first by volume, then newest.
export function selectMoreMarkets(markets, { excludeMints = [], now = Date.now() } = {}) {
  const excluded = new Set(excludeMints)
  const volume = market => BigInt(market.volume24hLamports ?? '0')
  const launched = market => new Date(market.indexedAt).getTime() || 0
  return markets.filter(market => !excluded.has(market.mint)).sort((a, b) => {
    const av = volume(a), bv = volume(b)
    if (av !== bv) return av > bv ? -1 : 1
    return launched(b) - launched(a) || a.mint.localeCompare(b.mint)
  }).slice(0, MORE_MARKETS_LIMIT).map(market => {
    const age = now - launched(market)
    return { repoId: market.repoId, mint: market.mint, fullName: market.fullName, symbol: market.symbol,
      volume24hLamports: String(market.volume24hLamports ?? '0'), isNew: age >= 0 && age < NEW_MARKET_MS,
      newRepo: market.newRepo === true, officialLaunch: market.officialLaunch === true, ...(market.stock !== undefined && { stock: market.stock }) }
  })
}

// The line under the strip's heading: what trades on the listed markets pay. SOL markets on a SOL market's page read exactly
// as before. A stock pair pays its fee in its stock, to its launcher and to permanent $REPOING liquidity, not to its repo's
// builders in SOL (docs/STOCK_QUOTES.md, "Fee policy"), so a strip that lists one, or sits on a stock pair's page, says that
// instead. markets: selectMoreMarkets rows (a stock pair's carries `stock`); models: a Hugging Face model is listed; quote: the
// page's own pair (marketQuoteView), null on a SOL market's page.
export function moreMarketsNote(markets, { models = false, quote = null } = {}) {
  const stocks = markets.filter(market => market.stock)
  if (!stocks.length && !quote) return models ? 'Every trade pays the builders in SOL.' : 'Every trade pays the repo\'s builders in SOL.'
  const symbols = new Set(stocks.map(market => market.stock.symbol ?? null))
  const [symbol] = symbols
  if (stocks.length === markets.length && symbols.size === 1 && symbol) return stockFeeLine(symbol)
  return `SOL pairs pay builders in SOL. Stock pairs pay ${STOCK_FEE_SPLIT.launcher} to the launcher, ${STOCK_FEE_SPLIT.accumulator} to $REPOING liquidity.`
}
