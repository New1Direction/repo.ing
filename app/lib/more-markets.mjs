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
      volume24hLamports: String(market.volume24hLamports ?? '0'), isNew: age >= 0 && age < NEW_MARKET_MS }
  })
}
