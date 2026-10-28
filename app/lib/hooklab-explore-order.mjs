// Client-safe ordering for the Explore Hooks coin list and strip (rows from app/lib/hooklab-explore.mjs).
export const HOOK_COIN_VIEWS = Object.freeze(['trending', 'mcap', 'new'])

const volume = coin => BigInt(coin.stats?.volume24hLamports ?? 0)
const price = coin => coin.stats?.priceSol ?? -1
const byNumber = (a, b) => (a > b ? -1 : a < b ? 1 : 0)

// trending: 24h volume, then trade count; mcap: last price (unpriced coins last); new: as listed (newest first).
// Ties keep the listing's order (Array.prototype.sort is stable).
export function orderHookCoins(coins, view = 'trending') {
  if (view === 'new') return [...coins]
  if (view === 'mcap') return [...coins].sort((a, b) => byNumber(price(a), price(b)))
  return [...coins].sort((a, b) => byNumber(volume(a), volume(b)) || byNumber(a.stats?.totalTrades ?? 0, b.stats?.totalTrades ?? 0))
}

export const hookCoinView = value => HOOK_COIN_VIEWS.includes(value) ? value : 'trending'
