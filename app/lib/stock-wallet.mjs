import { stockPairStamps } from '../../src/stock-owner-claims.mjs'

// /wallet rows (app/lib/wallet-overview.mjs walletMarkets) for stock-paired markets, marked stockPair: true:
// - one this wallet launched carries its launcher earnings in the stock (stockLauncher, one view from
//   src/stock-launcher-earnings.mjs walletStockLauncherEarnings; absent when they could not be read);
// - a stock pair has no owner claim (src/stock-owner-claims.mjs), so a payout wallet bound to one is never offered
//   "Builder fees available" or a builder claim there.
// SOL rows are returned exactly as they came. Unreadable stamps leave every row as it came (the claim page still refuses).
export async function withStockPairRows(db, rows, launches) {
  const byRepo = new Map((launches ?? []).map(view => [String(view.repoId), view]))
  const candidates = rows.filter(row => row.builderWallet || row.launchedByYou).map(row => row.repoId)
  const stock = candidates.length ? await stockPairStamps(db, candidates).catch(() => new Map()) : new Map()
  return rows.map(row => {
    const repoId = String(row.repoId)
    if (!stock.has(repoId)) return row
    const launched = row.launchedByYou ? byRepo.get(repoId) : null
    return { ...row, stockPair: true, ...launched ? { stockLauncher: launched } : {}, builderWallet: false, builderAvailable: null }
  })
}
