import { orderMarkets } from './market-order.mjs'
import { chartTradeAge } from './chart-display.mjs'

// Official: the repository's own maintainer launched the market. A GitHub admin verified on repo.ing bound a payout wallet,
// and it is the wallet that launched the market (markets.launcher_wallet). Read from the market row alone (server and
// client safe); distinct from Verified, which only says an admin has verified since.
export function isOfficialLaunch(market) {
  return Boolean(market?.wasVerified && market.beneficiaryWallet && market.launcherWallet && market.beneficiaryWallet === market.launcherWallet)
}

export const OFFICIAL_LAUNCH_LIMIT = 4

// Home "Official launches": newest first. Only markets that earned promotion (an admin can verify a repository made just
// to launch a coin) and never a do-not-promote or maintainer-declined repository. excluded: that whole set
// (promotionExcluded() in maintainer-opt-outs.mjs); without it nothing is shown.
export function officialLaunches(markets, { excluded, limit = OFFICIAL_LAUNCH_LIMIT, now = Date.now() } = {}) {
  if (!(excluded instanceof Set)) return []
  const shown = market => market.officialLaunch === true && market.promoted === true && !excluded.has(String(market.repoId))
  return orderMarkets(markets.filter(shown), 'New').slice(0, limit).map(market => {
    const at = new Date(market.indexedAt)
    return { repoId: market.repoId, mint: market.mint, fullName: market.fullName, symbol: market.symbol,
      volume24hLamports: String(market.volume24hLamports ?? '0'), launched: Number.isFinite(at.getTime()) ? chartTradeAge(at.toISOString(), now) : null }
  })
}
