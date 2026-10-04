import { stockPairStamps } from '../../src/stock-owner-claims.mjs'
import { launcherTotalsByAsset, walletStockLauncherEarnings } from '../../src/stock-launcher-earnings.mjs'

// /wallet for stock-paired markets (src/stock-owner-claims.mjs). rows: app/lib/wallet-overview.mjs walletMarkets rows.
// - A wallet with no stock-pair row gets its rows back exactly as they came and no extra field, so a SOL wallet's response is
//   the same as it was before stock pairs. Unreadable stamps read the same way (the claim page still refuses a stock pair).
// - Its stock-pair rows are marked stockPair and never offer "Builder fees available" or a builder claim: there is no owner
//   claim on a stock pair.
// - A wallet that launched a stock pair gets stockLauncher: its earnings in each stock (src/stock-launcher-earnings.mjs), null
//   when they cannot be read; each launched row carries its own. connection: returns the RPC connection, called only then.
export async function walletStockPairs(db, connection, wallet, rows, { earnings = walletStockLauncherEarnings } = {}) {
  const candidates = rows.filter(row => row.builderWallet || row.launchedByYou).map(row => String(row.repoId))
  const stock = candidates.length ? await stockPairStamps(db, candidates).catch(() => new Map()) : new Map()
  if (!stock.size) return { rows, fields: {} }
  const launcher = rows.some(row => row.launchedByYou && stock.has(String(row.repoId)))
  const launches = launcher ? await earnings(db, connection(), wallet).catch(() => null) : null
  const byRepo = new Map((launches ?? []).map(view => [String(view.repoId), view]))
  const marked = rows.map(row => {
    const repoId = String(row.repoId)
    if (!stock.has(repoId)) return row
    const view = row.launchedByYou ? byRepo.get(repoId) : null
    return { ...row, stockPair: true, ...view ? { stockLauncher: view } : {}, builderWallet: false, builderAvailable: null }
  })
  const stockLauncher = launches === null ? null : { markets: launches, totals: launcherTotalsByAsset(launches) }
  return { rows: marked, fields: launcher ? { stockLauncher } : {} }
}
