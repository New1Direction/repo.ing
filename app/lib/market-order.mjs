// Trending: markets that earned promotion (app/lib/repo-quality.mjs; rows without the flag count as promoted) before new
// repositories still under their 10% mark, then by 24h volume; ties and the New tab go newest first.
export function orderMarkets(markets, tab = 'Trending') {
  return [...markets].sort((a, b) => {
    if (tab === 'Trending') {
      const ap = a.promoted !== false, bp = b.promoted !== false
      if (ap !== bp) return ap ? -1 : 1
      const av = BigInt(a.volume24hLamports ?? '0'), bv = BigInt(b.volume24hLamports ?? '0')
      if (av !== bv) return av > bv ? -1 : 1
    }
    return new Date(b.indexedAt) - new Date(a.indexedAt) || a.mint.localeCompare(b.mint)
  })
}

export const HOME_MARKET_TABS = ['Trending', 'New']
export const HOME_MARKET_LIMIT = 5
// Only the fields MarketTable, RepoAvatar and WatchButton read, so the home page ships no unused rows. A model market's
// display-only likes (app/lib/hf-markets.mjs withModelFacts) ride along only when known; GitHub rows never carry them.
const HOME_MARKET_FIELDS = ['repoId', 'mint', 'fullName', 'description', 'symbol', 'tokenName', 'wasVerified', 'volume24hLamports', 'earned', 'claimed', 'remaining', 'stars', 'priceSol', 'bondingPercent', 'graduated', 'pulse', 'newRepo', 'officialLaunch']
export function homeMarketTabs(markets) {
  return Object.fromEntries(HOME_MARKET_TABS.map(tab => [tab, orderMarkets(markets, tab).slice(0, HOME_MARKET_LIMIT)
    .map(market => ({ ...Object.fromEntries(HOME_MARKET_FIELDS.map(key => [key, market[key]])), ...(market.likes !== undefined && { likes: market.likes }) }))]))
}
