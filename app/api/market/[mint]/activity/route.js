import { chain, database, marketByMint } from '../../../../lib/server.mjs'
import { MARKET_ACTIVITY_CACHE, NO_STORE } from '../../../../lib/cache-headers.mjs'
import { withServerTiming } from '../../../../lib/server-timing.mjs'
import { xHandlesFor } from '../../../../lib/x-links.mjs'
import { activityEvents } from '../../../../lib/market-activity.mjs'
import { readStockActivity } from '../../../../lib/stock-market-activity.mjs'
import { isStockMarket } from '../../../../../src/stock-market-chart.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Parts fund: confirmed pledges and build updates (text only here; the card shows the photos).
// (Same SQL text as before it moved here.)
const partsActivity = (pool, repoId) => pool.query(`(select 'parts-pledge' as type, p.signature, p.id::text as ref, p.confirmed_at as "occurredAt", p.received_amount::text as "amountBaseUnits",
          p.symbol, p.decimals, p.usd_cents::int as "usdCents", null as body from parts_pledges p
          where p.github_repo_id=$1 and p.status in ('confirmed','paid','refunded') order by p.confirmed_at desc limit 15)
        union all
        (select 'parts-update', null, u.id::text, u.created_at, null, null, null, null, left(u.body, 160) from parts_updates u
          where u.github_repo_id=$1 order by u.created_at desc limit 10)`, [repoId]).catch(error => {
  if (error?.code === '42P01') return { rows: [] }
  throw error
})

// Traders who linked X are named by that account (one batched read); the lookup failing only drops the names.
const handlesFor = rows => xHandlesFor([...new Set(rows.map(row => row.trader).filter(Boolean))]).catch(() => new Map())

// A stock-paired market reads the stock ledger and answers with its stock's units (app/lib/stock-market-activity.mjs).
async function stockActivity(pool, market) {
  const [{ trades, fees, payouts, quote }, parts] = await Promise.all([readStockActivity(pool, market, { connection: chain() }), partsActivity(pool, market.repoId)])
  return { events: activityEvents({ trades, stockFees: fees, launcherPayouts: payouts, parts: parts.rows, handles: await handlesFor(trades) }), quote }
}

export const GET = withServerTiming(async (_request, { params }) => {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  const pool = database()
  if (!market || !pool) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
  try {
    if (isStockMarket(market)) return Response.json(await stockActivity(pool, market), { headers: MARKET_ACTIVITY_CACHE })
    const [trades, fees, claims, parts] = await Promise.all([
      // Curve trades, then (after graduation) the same repository's verified pool, with each trade's trader.
      pool.query(`(select signature, event_index as "eventIndex", direction, traded_at as "occurredAt",
          input_base_units::text as "inputBaseUnits", output_base_units::text as "outputBaseUnits", trader
          from trade_events where pool = $1 order by slot desc, event_index desc limit 30)
        union all
        (select d.signature, d.event_index, d.direction, d.traded_at,
          (case when d.direction = 'buy' then d.quote_amount else d.base_amount end)::text,
          (case when d.direction = 'buy' then d.base_amount else d.quote_amount end)::text, d.trader
          from damm_trade_events d join graduation_events g on g.github_repo_id = d.github_repo_id and g.pool = d.pool
          where d.github_repo_id = $2 and d.base_amount is not null order by d.slot desc, d.event_index desc limit 30)`, [market.pool, market.repoId]),
      pool.query(`select f.signature, f.event_index as "eventIndex", f.amount_base_units::text as "amountBaseUnits",
        coalesce(t.traded_at, f.created_at) as "occurredAt" from fee_events f
        left join lateral (select traded_at from trade_events t where t.pool = f.pool and t.signature = f.signature
          order by t.event_index limit 1) t on true
        where f.github_repo_id = $1 order by f.slot desc, f.event_index desc limit 30`, [market.repoId]),
      pool.query(`select claim_signature as signature, amount_base_units::text as "amountBaseUnits",
        settled_at as "occurredAt" from repo_claims where github_repo_id = $1 and status = 'settled'
        order by settled_at desc limit 15`, [market.repoId]),
      partsActivity(pool, market.repoId),
    ])
    const handles = await handlesFor(trades.rows)
    const events = activityEvents({ trades: trades.rows, fees: fees.rows, claims: claims.rows, parts: parts.rows, handles })
    return Response.json({ events }, { headers: MARKET_ACTIVITY_CACHE })
  } catch { return Response.json({ error: 'Activity is temporarily unavailable' }, { status: 503, headers: NO_STORE }) }
})
