import { stockMultiplier } from '../../src/quote-asset-info.mjs'
import { readStockMigration, stockQuoteOf, stockTradeScope, stockTradeScopeParams } from '../../src/stock-market-chart.mjs'

// A stock-paired market's Activity tab and recent traders (docs/STOCK_QUOTES.md), from the stock ledger: its curve and
// graduated-pool trades (bound as its chart binds them), each curve swap's fee split, and settled launcher payouts. Amounts
// stay raw; the response carries the stock's units (today's display multiplier) so the page shows them as wallets do. A
// stock pair has no builder claims (owner claims are refused on stock pairs), so none are read.
const TRADES = `select t.signature, t.event_index as "eventIndex", t.direction, t.traded_at as "occurredAt",
    (case when t.direction='buy' then t.quote_amount else t.base_amount end)::text as "inputBaseUnits",
    (case when t.direction='buy' then t.base_amount else t.quote_amount end)::text as "outputBaseUnits", t.trader
  from stock_trade_events t where ${stockTradeScope('t', 1)} order by t.slot desc, t.event_index desc limit 60`
const FEES = `select f.signature, f.event_index as "eventIndex", f.launcher_amount::text as "launcherBaseUnits",
    f.accumulator_amount::text as "accumulatorBaseUnits", coalesce(t.traded_at, f.created_at) as "occurredAt"
  from stock_fee_events f left join lateral (select traded_at from stock_trade_events t where t.github_repo_id = f.github_repo_id
    and t.signature = f.signature order by t.event_index limit 1) t on true
  where f.github_repo_id=$1 and f.asset_id=$2 and f.quote_mint=$3 and f.pool=$4 order by f.slot desc, f.event_index desc limit 30`
const PAYOUTS = `select signature, amount::text as "amountBaseUnits", settled_at as "occurredAt" from stock_launcher_payouts
  where github_repo_id=$1 and asset_id=$2 and quote_mint=$3 and status='settled' and settled_at is not null
  order by settled_at desc, id desc limit 15`

// { trades, fees, payouts, quote: { assetId, symbol, decimals, uiMultiplier } }. The multiplier is read now; a failed read
// fails the call, so amounts are never shown with a stale or missing multiplier.
export async function readStockActivity(db, market, { connection, multiplier = stockMultiplier } = {}) {
  const quote = stockQuoteOf(market)
  const scope = stockTradeScopeParams(market, quote, await readStockMigration(db, market, quote))
  const [trades, fees, payouts, uiMultiplier] = await Promise.all([db.query(TRADES, scope), db.query(FEES, scope.slice(0, 4)),
    db.query(PAYOUTS, scope.slice(0, 3)), multiplier(connection, quote)])
  return { trades: trades.rows, fees: fees.rows, payouts: payouts.rows,
    quote: { assetId: quote.assetId, symbol: quote.symbol, decimals: quote.decimals, uiMultiplier } }
}

// The newest trades' signatures and traders, for the X handles beside the chart's recent trades.
export async function readStockTraders(db, market, limit) {
  const quote = stockQuoteOf(market)
  const scope = stockTradeScopeParams(market, quote, await readStockMigration(db, market, quote))
  const { rows } = await db.query(`select t.signature, t.event_index as "eventIndex", t.trader from stock_trade_events t
    where ${stockTradeScope('t', 1)} order by t.slot desc, t.event_index desc limit $7`, [...scope, limit])
  return rows
}
