import { analyticsWindow } from './protocol-analytics.mjs'
import { quoteAssetById } from './quote-assets.mjs'

// Platform totals of stock-paired markets, per stock asset (docs/STOCK_QUOTES.md), for /stats. The SOL totals
// (src/protocol-analytics.mjs) count SOL markets only, and a stock is never added to SOL or to another stock: every figure
// here is one asset's, in raw base units of that stock (pages convert them for display). Canonical markets only (confirmed,
// indexed, finalized), bound as their charts are: curve trades and fees in the market's own pool, graduated-pool trades
// and fees in the DAMM pool its recorded graduation names.
//   volume       the stock each trade exchanged (stock_trade_events.quote_amount: a buy's fee-excluded input, a sell's
//                stock received; the amounts SOL volume counts)
//   fees         trading fees credited past Meteora's share: curve creator + partner fees (stock_fee_events) and the
//                graduated pool's position fees (stock_damm_fee_checkpoints credits)
//   launcher     the launchers' share of those fees (src/stock-fee-policy.mjs)
//   accumulator  credited to the stock's accumulator: the rest
// Trades use chain time and fees indexing time, as on the SOL side; the period bounds each branch, so a short period reads
// only its own rows, and every ledger row is read once. `active`: the asset has any trade or fee at all (one row is enough),
// so /stats shows the section only once there is stock activity.
const SQL = `with canonical as (
  select m.github_repo_id, m.pool, m.quote_asset_id, m.quote_mint from markets m
  where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.quote_asset_id is not null
), migrations as (
  select g.github_repo_id, g.damm_pool, g.slot from stock_graduation_events g join canonical m on m.github_repo_id=g.github_repo_id
    and g.asset_id=m.quote_asset_id and g.quote_mint=m.quote_mint and g.dbc_pool=m.pool
), totals as (
  select asset_id, quote_mint, sum(trades)::int as trades, sum(volume) as volume, sum(fees) as fees, sum(launcher) as launcher,
    sum(accumulator) as accumulator
  from (
    select m.quote_asset_id as asset_id, m.quote_mint, 1 as trades, t.quote_amount::numeric as volume, 0::numeric as fees,
      0::numeric as launcher, 0::numeric as accumulator
      from stock_trade_events t join canonical m on m.github_repo_id=t.github_repo_id and t.asset_id=m.quote_asset_id and t.quote_mint=m.quote_mint
      left join migrations g on g.github_repo_id=m.github_repo_id
      where ((t.venue='dbc' and t.pool=m.pool) or (t.venue='damm' and t.pool=g.damm_pool and t.slot>=g.slot))
        and ($1::timestamptz is null or t.traded_at >= $1) and t.traded_at <= $2
    union all select m.quote_asset_id, m.quote_mint, 0, 0, f.creator_amount::numeric + f.partner_amount::numeric, f.launcher_amount,
      f.accumulator_amount
      from stock_fee_events f join canonical m on m.github_repo_id=f.github_repo_id and f.asset_id=m.quote_asset_id and f.quote_mint=m.quote_mint
        and f.pool=m.pool
      where ($1::timestamptz is null or f.created_at >= $1) and f.created_at <= $2
    union all select m.quote_asset_id, m.quote_mint, 0, 0, c.credit, c.launcher_credit, c.accumulator_credit
      from stock_damm_fee_checkpoints c join canonical m on m.github_repo_id=c.github_repo_id and c.asset_id=m.quote_asset_id
        and c.quote_mint=m.quote_mint join migrations g on g.github_repo_id=m.github_repo_id and g.damm_pool=c.damm_pool
      where ($1::timestamptz is null or c.created_at >= $1) and c.created_at <= $2
  ) events group by 1, 2
)
select a.asset_id as "assetId", a.quote_mint as "quoteMint", a.markets,
  coalesce(w.trades,0)::int as trades, coalesce(w.volume,0)::text as volume, coalesce(w.fees,0)::text as fees,
  coalesce(w.launcher,0)::text as launcher, coalesce(w.accumulator,0)::text as accumulator,
  (exists(select 1 from canonical m join stock_trade_events t on t.github_repo_id=m.github_repo_id and t.asset_id=m.quote_asset_id
      and t.quote_mint=m.quote_mint where m.quote_asset_id=a.asset_id and m.quote_mint=a.quote_mint)
    or exists(select 1 from canonical m join stock_fee_events f on f.github_repo_id=m.github_repo_id and f.asset_id=m.quote_asset_id
      and f.quote_mint=m.quote_mint where m.quote_asset_id=a.asset_id and m.quote_mint=a.quote_mint)
    or exists(select 1 from canonical m join stock_damm_fee_checkpoints c on c.github_repo_id=m.github_repo_id and c.asset_id=m.quote_asset_id
      and c.quote_mint=m.quote_mint where m.quote_asset_id=a.asset_id and m.quote_mint=a.quote_mint)) as active
from (select quote_asset_id as asset_id, quote_mint, count(*)::int as markets from canonical group by 1, 2) a
left join totals w using (asset_id, quote_mint)
order by a.asset_id, a.quote_mint`

// { range, since, until, hasActivity, assets: [{ assetId, symbol, decimals, mint, markets, trades, volume, fees, launcher,
// accumulator, active }] }. symbol and decimals come from the registry; an asset whose stamped mint is not the registry's
// keeps its raw totals with symbol null, so nothing converts it with another asset's units.
export async function readStockAnalytics(pool, { range = 'all', now = new Date() } = {}) {
  const window = analyticsWindow(range, now), db = await pool.connect()
  try {
    await db.query('begin isolation level repeatable read read only')
    await db.query("set local statement_timeout='5000ms'")
    const { rows } = await db.query(SQL, [window.since, window.until])
    await db.query('commit')
    const assets = rows.map(({ quoteMint, ...row }) => {
      const asset = quoteAssetById(row.assetId)
      const known = asset?.type === 'TOKENIZED_EQUITY' && asset.mint === quoteMint
      return { assetId: row.assetId, symbol: known ? asset.symbol : null, decimals: known ? asset.decimals : null, mint: quoteMint,
        markets: row.markets, trades: row.trades, volume: row.volume, fees: row.fees, launcher: row.launcher, accumulator: row.accumulator,
        active: row.active }
    })
    return { range: window.range, since: window.since, until: window.until, hasActivity: assets.some(asset => asset.active), assets }
  } catch (error) { await db.query('rollback').catch(() => {}); throw error } finally { db.release() }
}
