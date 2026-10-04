import BN from 'bn.js'
import { getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { blockJoins, blockPosition, chartWindow } from './market-chart.mjs'
import { SOL_QUOTE, quoteOfMarket } from './quote-assets.mjs'

// A stock-paired market's chart (docs/STOCK_QUOTES.md): the series src/market-chart.mjs builds for SOL markets, read from
// the stock ledger (stock_trade_events) in raw units of each token. Stock trades never enter the SOL tables, and nothing
// here is SOL: prices are in whole units of the stock's raw amount (before its ScaledUiAmount display multiplier) per
// whole market token, and volumes are raw stock base units. The page shows both as wallets show the stock, at today's
// multiplier, and in USD at the stock's own price (app/lib/stock-display.mjs).
export const MARKET_TOKEN_DECIMALS = 6

const DECIMALS = value => Number.isInteger(value) && value >= 0 && value <= 18

// True for a market stamped with a stock quote (migration 0053). Unstamped markets are SOL.
export const isStockMarket = market => Boolean(market?.quoteAssetId || market?.quoteMint)

// The stock a stamped market trades in, from the registry, or a throw: a stamp the registry no longer matches is never
// priced, and a SOL market is a caller bug (SOL markets have their own chart).
export function stockQuoteOf(market) {
  const quote = quoteOfMarket(market)
  if (quote === SOL_QUOTE) throw Error('NOT_A_STOCK_MARKET')
  return quote
}

// Spot price after a swap from its Q64.64 sqrt price (stock raw units per market raw unit), in whole units of each token.
// quoteDecimals comes from the stock asset and is required: a missing one must never fall back to SOL's 9.
export function stockSpotPrice(sqrtPrice, baseDecimals = MARKET_TOKEN_DECIMALS, quoteDecimals) {
  if (!DECIMALS(baseDecimals) || !DECIMALS(quoteDecimals)) throw Error('Invalid stock chart decimals')
  if (!/^\d+$/.test(String(sqrtPrice)) || BigInt(sqrtPrice) <= 0n) throw Error('Invalid chart price evidence')
  const price = Number(getPriceFromSqrtPrice(new BN(String(sqrtPrice)), baseDecimals, quoteDecimals).toString())
  if (!Number.isFinite(price) || price <= 0) throw Error('Invalid chart price')
  return price
}

export function stockChartBar(row, quoteDecimals) {
  const time = Number(row.time)
  const volumeQuote = String(row.volume)
  if (!Number.isSafeInteger(time) || !/^\d+$/.test(volumeQuote)) throw Error('Invalid chart bar evidence')
  const count = Number(row.count)
  if (!Number.isSafeInteger(count) || count < 1) throw Error('Invalid chart trade count')
  // Same rule as the SOL chart: open/close wait for finalized block evidence of the boundary slots' order.
  if (row.ambiguous || row.missing_price) return { time, volumeQuote, count, orderingPending: true, priceEvidenceMissing: Boolean(row.missing_price) }
  const price = raw => stockSpotPrice(raw, MARKET_TOKEN_DECIMALS, quoteDecimals)
  return { time, open: price(row.open), high: price(row.high), low: price(row.low), close: price(row.close), volumeQuote, count }
}

// The DAMM v2 pool a stock-paired market graduated into, from its recorded graduation (stock_graduation_events), or null
// before graduation. The record must name this market, its stamped stock and its own curve; anything else stops the chart
// rather than splice another pool's trades into it.
export function stockChartMigration(market, quote, row) {
  if (!row) return null
  if (String(row.github_repo_id) !== String(market.repoId) || row.asset_id !== quote.assetId || row.quote_mint !== quote.mint ||
      row.dbc_pool !== market.pool || !row.damm_pool || !row.migration_signature || !/^\d+$/.test(String(row.slot ?? ''))) {
    throw Error('CHART_MIGRATION_MISMATCH')
  }
  return { pool: row.damm_pool, slot: String(row.slot), signature: row.migration_signature }
}

export async function readStockMigration(db, market, quote) {
  const { rows: [row] } = await db.query('select * from stock_graduation_events where github_repo_id=$1', [market.repoId])
  return stockChartMigration(market, quote, row)
}

// One market's canonical stock trades, as a SQL predicate on alias `t` from parameter $at on (stockTradeScopeParams): its
// stamp, its curve, and after a recorded graduation the DAMM pool that graduation names, from the migration slot on. The
// binding /stats and the market list use too: trades recorded under any other pool never count.
export const stockTradeScope = (t, at) => `${t}.github_repo_id=$${at} and ${t}.asset_id=$${at + 1} and ${t}.quote_mint=$${at + 2}
    and ((${t}.venue='dbc' and ${t}.pool=$${at + 3}) or (${t}.venue='damm' and ${t}.pool=$${at + 4} and ${t}.slot>=$${at + 5}))`
export const stockTradeScopeParams = (market, quote, migration) =>
  [market.repoId, quote.assetId, quote.mint, market.pool, migration?.pool ?? null, migration?.slot ?? null]

// $1-$3: start/end/interval of the window, as in readMarketChart; $4 on: the market's scope.
const stockEvents = `with canonical_events as (
  select t.signature,t.event_index,t.slot,t.traded_at,t.direction,t.next_sqrt_price,t.quote_amount::numeric as quote_amount,
    t.base_amount::numeric as base_amount,upper(t.venue) as venue
  from stock_trade_events t where ${stockTradeScope('t', 4)}
)`

export async function readStockMarketChart(db, market, range = 'all', now = Date.now()) {
  const quote = stockQuoteOf(market)
  const migration = await readStockMigration(db, market, quote)
  const scope = stockTradeScopeParams(market, quote, migration)
  const params = (start, end, interval) => [start, end, interval, ...scope]
  const price = raw => stockSpotPrice(raw, MARKET_TOKEN_DECIMALS, quote.decimals)
  const { rows: [summary] } = await db.query(`${stockEvents} select min(traded_at) as first, max(traded_at) as last,
    count(*)::text as count, count(*) filter(where venue='DAMM')::int as damm_count,
    coalesce(sum(quote_amount) filter (where traded_at >= $1::timestamptz - interval '24 hours'),0)::text as volume
    from canonical_events where traded_at <= $1 and $2::text is null and $3::text is null`, params(new Date(now), null, null))
  const window = chartWindow(range, summary.first, now, summary.last)
  const [{ rows }, { rows: recent }] = await Promise.all([
    db.query(`${stockEvents}, events as (
      select t.*, ${blockPosition('t')} as transaction_index,
        floor(extract(epoch from traded_at)/$3)::bigint*$3 as bucket
      from canonical_events t ${blockJoins('t')}
      where traded_at >= $1 and traded_at <= $2
    ), bars as (
      select bucket as time, min(slot) as first_slot, max(slot) as last_slot,
        (array_agg(next_sqrt_price order by slot,transaction_index,signature,event_index))[1] as open,
        (array_agg(next_sqrt_price order by slot desc,transaction_index desc,signature desc,event_index desc))[1] as close,
        max(next_sqrt_price::numeric)::text as high, min(next_sqrt_price::numeric)::text as low,
        sum(quote_amount)::text as volume, bool_or(next_sqrt_price is null) as missing_price,
        count(*)::text as count
      from events group by bucket
    ), unordered_slots as materialized (
      select bucket, slot from events group by bucket, slot
      having count(distinct signature)>1 and bool_or(transaction_index is null)
    ) select bars.*, exists(select 1 from unordered_slots u where u.bucket=bars.time
      and u.slot in (bars.first_slot,bars.last_slot)) as ambiguous
      from bars order by time`, params(window.start, window.end, window.interval)),
    db.query(`${stockEvents} select t.signature,t.event_index as "eventIndex",t.slot::text,direction,traded_at as "tradedAt",venue,
      ${blockPosition('t')} as "transactionIndex",
      next_sqrt_price as "nextSqrtPrice",quote_amount::text as "quoteAmount",base_amount::text as "tokenBaseUnits"
      from canonical_events t ${blockJoins('t')}
      where traded_at <= $1 and $2::text is null and $3::text is null
      order by t.slot desc,"transactionIndex" desc,t.signature desc,t.event_index desc limit 120`, params(window.end, null, null)),
  ])
  const latestSlot = recent[0]?.slot
  const latestTrades = recent.filter(t => t.slot === latestSlot)
  const latestAmbiguous = latestTrades.some(t => t.transactionIndex === null) &&
    (new Set(latestTrades.map(t => t.signature)).size > 1 || (recent.length === 120 && latestTrades.length === 120))
  const trades = recent.reverse().map(row => ({ signature: row.signature, eventIndex: row.eventIndex,
    direction: row.direction, venue: row.venue, tradedAt: row.tradedAt.toISOString(),
    priceQuote: row.nextSqrtPrice ? price(row.nextSqrtPrice) : null,
    quoteAmount: row.quoteAmount ?? null, tokenBaseUnits: row.tokenBaseUnits ?? null }))
  return { ...window, quote: { assetId: quote.assetId, symbol: quote.symbol, decimals: quote.decimals },
    candles: rows.map(row => stockChartBar(row, quote.decimals)), trades, volume24hQuote: summary.volume,
    totalTrades: Number(summary.count), latest: latestAmbiguous || !trades.at(-1)?.priceQuote ? null : trades.at(-1),
    latestOrderingPending: latestAmbiguous, fetchedAt: new Date(now).toISOString(),
    source: migration ? 'finalized-dbc-and-damm-swaps' : 'finalized-dbc-swaps',
    graduation: migration ? { ...migration, indexedTrades: summary.damm_count } : null }
}
