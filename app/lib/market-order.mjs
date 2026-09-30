export function orderMarkets(markets, tab = 'Trending') {
  return [...markets].sort((a, b) => {
    if (tab === 'Trending') {
      const av = BigInt(a.volume24hLamports ?? '0'), bv = BigInt(b.volume24hLamports ?? '0')
      if (av !== bv) return av > bv ? -1 : 1
    }
    return new Date(b.indexedAt) - new Date(a.indexedAt) || a.mint.localeCompare(b.mint)
  })
}

export const HOME_MARKET_TABS = ['Trending', 'New']
export const HOME_MARKET_LIMIT = 5
// Only the fields MarketTable, RepoAvatar and WatchButton read, so the home page ships no unused rows.
const HOME_MARKET_FIELDS = ['repoId', 'mint', 'fullName', 'description', 'symbol', 'tokenName', 'wasVerified', 'volume24hLamports', 'earned', 'claimed', 'remaining', 'stars', 'priceSol', 'bondingPercent', 'graduated']
export function homeMarketTabs(markets) {
  return Object.fromEntries(HOME_MARKET_TABS.map(tab => [tab, orderMarkets(markets, tab).slice(0, HOME_MARKET_LIMIT)
    .map(market => Object.fromEntries(HOME_MARKET_FIELDS.map(key => [key, market[key]])))]))
}
