import { MARKET_TOKEN_SUPPLY } from './market-display.mjs'
import { stockDisplayUnits } from './stock-display.mjs'

// A row's market cap for ranking: the figure the market table shows (last trade price × the 1B supply), in USD so SOL rows and
// stock pairs compare (SOL at usdPerSol, a stock pair at its stock's USD price). Without usdPerSol, SOL rows rank in SOL and
// stock pairs, which then have no comparable figure, go last. null without a trade.
export function marketCapRank(market, usdPerSol = null) {
  if (market?.stock) {
    const units = stockDisplayUnits(market.stock), price = market.stock.price
    return units?.usdPrice && typeof price === 'number' && price > 0 && usdPerSol > 0 ? price * MARKET_TOKEN_SUPPLY * units.usdPrice : null
  }
  const price = market?.priceSol
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null
  return price * MARKET_TOKEN_SUPPLY * (usdPerSol > 0 ? usdPerSol : 1)
}

// Trending: markets that earned promotion (app/lib/repo-quality.mjs; rows without the flag count as promoted) before new
// repositories still under their 10% mark, then by 24h volume. Market cap: the same promotion rule, then by market cap
// (marketCapRank; rows without a trade last). Ties and the New tab go newest first. promotedFirst: false (the home lists)
// drops the promotion rule, so a new repository sits in its real place (its row still carries the "New repo" label).
export function orderMarkets(markets, tab = 'Trending', { usdPerSol = null, promotedFirst = true } = {}) {
  const caps = tab === 'Market cap' ? new Map(markets.map(market => [market, marketCapRank(market, usdPerSol)])) : null
  return [...markets].sort((a, b) => {
    if (promotedFirst && (tab === 'Trending' || tab === 'Market cap')) {
      const ap = a.promoted !== false, bp = b.promoted !== false
      if (ap !== bp) return ap ? -1 : 1
    }
    if (tab === 'Trending') {
      const av = BigInt(a.volume24hLamports ?? '0'), bv = BigInt(b.volume24hLamports ?? '0')
      if (av !== bv) return av > bv ? -1 : 1
    }
    if (caps) {
      const ac = caps.get(a), bc = caps.get(b)
      if (ac !== bc) return ac === null ? 1 : bc === null ? -1 : bc - ac
    }
    return new Date(b.indexedAt) - new Date(a.indexedAt) || a.mint.localeCompare(b.mint)
  })
}

export const HOME_MARKET_TABS = ['Trending', 'Market cap', 'New']
export const HOME_MARKET_LIMIT = 5
// Trending lists only markets that traded in the last 24 hours: a "0 SOL" row reads as a dead market. New lists them all.
export const tradedToday = market => BigInt(market.volume24hLamports ?? '0') > 0n
// Only the fields MarketTable, RepoAvatar and WatchButton read, so the home page ships no unused rows. A model market's
// display-only likes (app/lib/hf-markets.mjs withModelFacts) ride along only when known; GitHub rows never carry them. A
// stock pair's figures (`stock`, app/lib/stock-market-stats.mjs) ride along the same way; SOL rows never carry them.
const HOME_MARKET_FIELDS = ['repoId', 'mint', 'fullName', 'description', 'symbol', 'tokenName', 'wasVerified', 'volume24hLamports', 'earned', 'claimed', 'remaining', 'stars', 'priceSol', 'bondingPercent', 'graduated', 'pulse', 'newRepo', 'officialLaunch']
// usdPerSol: ranks the Market cap tab across SOL rows and stock pairs (orderMarkets); that tab lists only markets with a trade.
// New repositories are in their real place on every home tab (owner, 2026-10-06), labeled on their rows.
export function homeMarketTabs(markets, { usdPerSol = null } = {}) {
  const rowsFor = tab => tab === 'Trending' ? markets.filter(tradedToday) : tab === 'Market cap' ? markets.filter(market => marketCapRank(market, usdPerSol) !== null) : markets
  return Object.fromEntries(HOME_MARKET_TABS.map(tab => [tab, orderMarkets(rowsFor(tab), tab, { usdPerSol, promotedFirst: false }).slice(0, HOME_MARKET_LIMIT)
    .map(market => ({ ...Object.fromEntries(HOME_MARKET_FIELDS.map(key => [key, market[key]])), ...(market.likes !== undefined && { likes: market.likes }),
      ...(market.stock !== undefined && { stock: market.stock }) }))]))
}
