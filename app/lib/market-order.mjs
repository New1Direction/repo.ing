export function orderMarkets(markets, tab = 'Trending') {
  return [...markets].sort((a, b) => {
    if (tab === 'Trending') {
      const av = BigInt(a.volume24hLamports ?? '0'), bv = BigInt(b.volume24hLamports ?? '0')
      if (av !== bv) return av > bv ? -1 : 1
    }
    return new Date(b.indexedAt) - new Date(a.indexedAt) || a.mint.localeCompare(b.mint)
  })
}
