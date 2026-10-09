import { blockJoins, blockPosition, chartMigration, chartSpotPrice } from '../../src/market-chart.mjs'
import { isStockMarket } from '../../src/stock-market-chart.mjs'
import { latestSlotTrade } from './portfolio.mjs'

const PRICE_TTL_MS = 10_000
const MAX_CACHED = 2000
const cache = new Map()

// Latest finalized spot price per market, from the same canonical events as the market chart:
// DBC curve trades plus, once graduation is proven, DAMM trades from the migration slot on.
// Two batched queries for all requested markets; results are cached briefly per market. A stock-paired market has no SOL price
// (its trades are in stock_trade_events, in its stock): it is left out, and the wallet values it in its stock
// (app/lib/portfolio.mjs stockHoldingValue, from the market row's own stock figures).
export async function latestMarketPrices(db, markets, now = Date.now()) {
  const prices = new Map(), missing = []
  for (const market of markets) {
    if (isStockMarket(market)) continue
    const hit = cache.get(market.repoId)
    if (hit && now < hit.expiresAt) prices.set(market.repoId, hit.price)
    else missing.push(market)
  }
  if (!missing.length) return prices
  const { rows: graduations } = await db.query('select * from graduation_events where github_repo_id = any($1::bigint[])',
    [missing.map(m => m.repoId)])
  const byRepo = new Map(graduations.map(row => [String(row.github_repo_id), row]))
  const valid = [], migrations = []
  for (const market of missing) {
    // A graduation row that fails proof withholds the price, as the chart refuses to render it.
    try { migrations.push(chartMigration(market, byRepo.get(market.repoId))); valid.push(market) }
    catch { prices.set(market.repoId, null) }
  }
  const { rows } = valid.length ? await db.query(`with m as (
      select * from unnest($1::text[], $2::text[], $3::text[], $4::bigint[]) as m(repo_id, pool, damm_pool, damm_slot)
    ), ev as (
      select m.repo_id, t.slot, t.signature, t.event_index, t.next_sqrt_price::text as next_sqrt_price
        from trade_events t join m on t.pool = m.pool
      union all
      select m.repo_id, d.slot, d.signature, d.event_index, d.next_sqrt_price
        from damm_trade_events d join m on d.pool = m.damm_pool and d.github_repo_id = m.repo_id::bigint and d.slot >= m.damm_slot
    ), top as (select repo_id, max(slot) as slot from ev group by repo_id)
    select ev.repo_id as "repoId", ev.signature, ev.event_index as "eventIndex", ev.next_sqrt_price as "nextSqrtPrice",
      ${blockPosition('ev')} as "transactionIndex"
    from ev join top on top.repo_id = ev.repo_id and top.slot = ev.slot ${blockJoins('ev')}`,
  [valid.map(m => m.repoId), valid.map(m => m.pool), migrations.map(m => m?.pool ?? null),
    migrations.map(m => m?.slot ?? null)]) : { rows: [] }
  const grouped = new Map()
  for (const row of rows) grouped.set(row.repoId, [...(grouped.get(row.repoId) ?? []), row])
  for (const market of valid) {
    const trade = latestSlotTrade(grouped.get(market.repoId))
    let price = null
    try { price = trade?.nextSqrtPrice ? chartSpotPrice(trade.nextSqrtPrice) : null } catch { price = null }
    prices.set(market.repoId, price)
  }
  for (const market of missing) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value)
    cache.set(market.repoId, { price: prices.get(market.repoId), expiresAt: now + PRICE_TTL_MS })
  }
  return prices
}

export function clearPriceCache() { cache.clear() }
