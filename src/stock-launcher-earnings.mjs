import { quoteAssetById } from './quote-assets.mjs'
import { stockMultiplier } from './quote-asset-info.mjs'
import { parseMultiplier } from './scaled-ui-amount.mjs'

// What the launcher of a stock-paired market has earned, in raw units of the stock (docs/STOCK_QUOTES.md, "Fee policy";
// src/stock-fee-policy.mjs): 0.30% of every trade, forever, paid in the stock. Read from the stock ledgers only (migration
// 0054); no SOL table is involved.
//
//   earned       launcher_amount of the market's curve fee events (its canonical DBC pool) + launcher_credit of the creator
//                position's checkpoints in its recorded graduated pool
//   collected    launcher_amount of settled fee collections: the launcher's part of fees claimed into custody
//   paid         settled launcher payouts
//   pending      payouts signed and not yet settled (counted once: never payable again while pending)
//   payable      collected - paid - pending: held in custody for the launcher now
//   uncollected  earned - collected: still in the pool, until the next collection
//
// Display amounts apply the stock's ScaledUiAmount multiplier (raw × multiplier, truncated, as Token-2022 shows balances);
// every ledger and comparison stays in raw units.
export const LAUNCHER_FIELDS = Object.freeze(['earned', 'collected', 'paid', 'pending', 'payable', 'uncollected'])

export class StockLauncherBalanceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StockLauncherBalanceError'
    this.code = 'STOCK_LAUNCHER_BALANCE_REVIEW'
  }
}

const raw = (value, name) => {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '')
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new StockLauncherBalanceError(`Launcher ${name} is not a raw amount`)
  return BigInt(text)
}

// One market's ledger sums (strings, as PostgreSQL returns numeric) → BigInt earnings. An impossible balance (more collected
// than earned, more paid than collected) is never shown or paid: it needs review.
export function launcherEarnings(row) {
  const earned = raw(row.curveEarned, 'curve earnings') + raw(row.graduatedEarned, 'graduated earnings')
  const collected = raw(row.collected, 'collected'), paid = raw(row.paid, 'paid'), pending = raw(row.pending ?? '0', 'pending')
  if (collected > earned) throw new StockLauncherBalanceError('Launcher collections exceed launcher earnings')
  if (paid + pending > collected) throw new StockLauncherBalanceError('Launcher payouts exceed launcher collections')
  return { earned, collected, paid, pending, payable: collected - paid - pending, uncollected: earned - collected }
}

// What the market's fees have routed so far, in raw units: the launcher's 0.30% and everything that went to the stock's
// accumulator (the rest of the creator fee and the whole partner fee, curve and graduated pool).
export function feeRoutingTotals(row) {
  return { launcher: raw(row.curveEarned, 'curve earnings') + raw(row.graduatedEarned, 'graduated earnings'),
    accumulator: raw(row.curveAccumulated, 'curve accumulation') + raw(row.graduatedAccumulated, 'graduated accumulation') }
}

// Raw units → the base units a wallet shows for them: raw × multiplier, truncated. multiplier is exact decimal text.
export function shownStockUnits(amount, multiplier) {
  const scale = parseMultiplier(multiplier)
  return BigInt(amount) * scale.num / scale.den
}

const strings = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toString()]))

// The JSON a page or API hands out for one market: raw amounts, and shown amounts when the multiplier is known (null when it
// could not be read; the UI then says the units are unavailable rather than showing raw units as if they were scaled).
export function launcherEarningsView(row, { multiplier = null } = {}) {
  const asset = quoteAssetById(row.assetId)
  if (!asset || asset.type !== 'TOKENIZED_EQUITY' || asset.mint !== row.quoteMint) throw new StockLauncherBalanceError('Market quote asset is not in the registry')
  const earnings = launcherEarnings(row)
  const shown = multiplier === null ? null : strings(Object.fromEntries(LAUNCHER_FIELDS.map(key => [key, shownStockUnits(earnings[key], multiplier)])))
  return { repoId: row.repoId, mint: row.mint, symbol: row.symbol, launcherWallet: row.launcherWallet,
    asset: { assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals }, multiplier, raw: strings(earnings), shown }
}

// The canonical pools a market's ledger rows must name: the market's DBC pool, and the graduated pool its graduation
// recorded. Rows under any other pool are left out here; src/stock-reconcile.mjs flags them for review.
const LEDGER_COLUMNS = `m.github_repo_id::text as "repoId", m.mint, m.token_symbol as symbol, m.launcher_wallet as "launcherWallet",
  m.quote_asset_id as "assetId", m.quote_mint as "quoteMint",
  coalesce((select sum(e.launcher_amount) from stock_fee_events e where e.github_repo_id = m.github_repo_id and e.pool = m.pool), 0)::text as "curveEarned",
  coalesce((select sum(e.accumulator_amount) from stock_fee_events e where e.github_repo_id = m.github_repo_id and e.pool = m.pool), 0)::text as "curveAccumulated",
  coalesce((select sum(c.launcher_credit) from stock_damm_fee_checkpoints c join stock_graduation_events g
    on g.github_repo_id = c.github_repo_id and g.damm_pool = c.damm_pool where c.github_repo_id = m.github_repo_id and c.side = 'creator'), 0)::text as "graduatedEarned",
  coalesce((select sum(c.accumulator_credit) from stock_damm_fee_checkpoints c join stock_graduation_events g
    on g.github_repo_id = c.github_repo_id and g.damm_pool = c.damm_pool where c.github_repo_id = m.github_repo_id), 0)::text as "graduatedAccumulated",
  coalesce((select sum(f.launcher_amount) from stock_fee_collections f where f.github_repo_id = m.github_repo_id and f.status = 'settled'), 0)::text as collected,
  coalesce((select sum(p.amount) from stock_launcher_payouts p where p.github_repo_id = m.github_repo_id and p.status = 'settled'), 0)::text as paid,
  coalesce((select sum(p.amount) from stock_launcher_payouts p where p.github_repo_id = m.github_repo_id and p.status = 'pending'), 0)::text as pending`
const CANONICAL_STOCK = `m.quote_asset_id is not null and m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'`

// One indexed stock-paired market's ledger sums, or null (a SOL market, or none).
export async function readMarketLauncherLedger(db, repoId) {
  if (!/^[1-9]\d{0,18}$/.test(String(repoId ?? ''))) return null
  const { rows: [row] } = await db.query(`select ${LEDGER_COLUMNS} from markets m where m.github_repo_id = $1 and ${CANONICAL_STOCK}`, [String(repoId)])
  return row ?? null
}

// Every indexed stock-paired market this wallet launched (markets.launcher_wallet, the proven signer of the pool creation).
export async function readWalletLauncherLedgers(db, wallet) {
  const { rows } = await db.query(`select ${LEDGER_COLUMNS} from markets m where m.launcher_wallet = $1 and ${CANONICAL_STOCK}
    order by m.indexed_at desc, m.github_repo_id`, [wallet])
  return rows
}

// The multiplier in force for each asset, by asset id; null for one whose mint could not be read just now.
export async function stockMultipliers(connection, assetIds, { read = stockMultiplier } = {}) {
  const ids = [...new Set(assetIds)]
  const values = await Promise.all(ids.map(async assetId => {
    const asset = quoteAssetById(assetId)
    if (!asset || asset.type !== 'TOKENIZED_EQUITY') return null
    try { return await read(connection, asset) } catch { return null }
  }))
  return new Map(ids.map((assetId, index) => [assetId, values[index]]))
}

// Totals per stock across a wallet's markets: raw sums, then shown once from the sum (never a sum of truncated amounts).
// Markets under review are left out of the sums and counted.
export function launcherTotalsByAsset(views) {
  const totals = new Map()
  for (const view of views) {
    if (view.review) continue
    const total = totals.get(view.asset.assetId) ?? { asset: view.asset, multiplier: view.multiplier, markets: 0,
      raw: Object.fromEntries(LAUNCHER_FIELDS.map(key => [key, 0n])) }
    total.markets++
    for (const key of LAUNCHER_FIELDS) total.raw[key] += BigInt(view.raw[key])
    if (view.multiplier !== total.multiplier) total.multiplier = null
    totals.set(view.asset.assetId, total)
  }
  return [...totals.values()].map(total => ({ asset: total.asset, markets: total.markets, multiplier: total.multiplier, raw: strings(total.raw),
    shown: total.multiplier === null ? null : strings(Object.fromEntries(LAUNCHER_FIELDS.map(key => [key, shownStockUnits(total.raw[key], total.multiplier)]))) }))
}

// /wallet: the connected wallet's launcher earnings on stock pairs, one entry per market. A market whose balance needs review
// is listed with review: true and no amounts, rather than dropped or summed.
export async function walletStockLauncherEarnings(db, connection, wallet, options = {}) {
  const rows = await readWalletLauncherLedgers(db, wallet)
  if (!rows.length) return []
  const multipliers = await stockMultipliers(connection, rows.map(row => row.assetId), options)
  return rows.map(row => {
    try { return launcherEarningsView(row, { multiplier: multipliers.get(row.assetId) ?? null }) }
    catch (error) {
      if (!(error instanceof StockLauncherBalanceError)) throw error
      console.error('stock launcher balance needs review', { repoId: row.repoId, error: error.message })
      return { repoId: row.repoId, mint: row.mint, symbol: row.symbol, launcherWallet: row.launcherWallet, review: true }
    }
  })
}
