import { readStockMigration, stockQuoteOf, stockTradeScope, stockTradeScopeParams } from '../../src/stock-market-chart.mjs'
import { stockUnits } from './stock-units.mjs'

// A stock-paired market's Activity tab and recent traders (docs/STOCK_QUOTES.md), from the stock ledger: its curve and
// graduated-pool trades (bound as its chart binds them), each curve swap's fee split, and settled launcher payouts. A trade's
// stock amount is quote_amount: a buy's fee-excluded input, a sell's stock received (the amounts SOL trades record). Amounts
// stay raw; the response carries the stock's units (today's display multiplier) so the page shows them as wallets do. A
// stock pair has no builder claims (owner claims are refused on stock pairs), so none are read.
const TRADES = `select t.signature, t.event_index as "eventIndex", t.direction, t.traded_at as "occurredAt",
    (case when t.direction='buy' then t.quote_amount else t.base_amount end)::text as "inputBaseUnits",
    (case when t.direction='buy' then t.base_amount else t.quote_amount end)::text as "outputBaseUnits", t.trader
  from stock_trade_events t where ${stockTradeScope('t', 1)} order by t.slot desc, t.event_index desc limit 60`
// Every curve swap has exactly one fee row, its own (signature, event_index); a zero-fee swap's zero row is not shown.
const FEES = `select f.signature, f.event_index as "eventIndex", f.launcher_amount::text as "launcherBaseUnits",
    f.accumulator_amount::text as "accumulatorBaseUnits", coalesce(t.traded_at, f.created_at) as "occurredAt"
  from stock_fee_events f left join stock_trade_events t on t.signature = f.signature and t.event_index = f.event_index
  where f.github_repo_id=$1 and f.asset_id=$2 and f.quote_mint=$3 and f.pool=$4 and f.creator_amount + f.partner_amount > 0
  order by f.slot desc, f.event_index desc limit 30`
const PAYOUTS = `select signature, amount::text as "amountBaseUnits", settled_at as "occurredAt" from stock_launcher_payouts
  where github_repo_id=$1 and asset_id=$2 and quote_mint=$3 and status='settled' and settled_at is not null
  order by settled_at desc, id desc limit 15`

// { trades, fees, payouts, quote: { assetId, symbol, decimals, uiMultiplier } }. The multiplier is the one in force now (the
// units cache, app/lib/stock-units.mjs: at most UNITS_WAIT_MS when nothing is cached). Without it, uiMultiplier is null and
// the feed shows its stock amounts as "—" (never with a stale or missing multiplier) while every row, time and market-token
// amount still shows.
export async function readStockActivity(db, market, { connection, units = stockUnits } = {}) {
  const quote = stockQuoteOf(market)
  const scope = stockTradeScopeParams(market, quote, await readStockMigration(db, market, quote))
  const [trades, fees, payouts, info] = await Promise.all([db.query(TRADES, scope), db.query(FEES, scope.slice(0, 4)),
    db.query(PAYOUTS, scope.slice(0, 3)), units.within(quote.assetId, connection)])
  const uiMultiplier = info?.uiMultiplier ?? null
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
