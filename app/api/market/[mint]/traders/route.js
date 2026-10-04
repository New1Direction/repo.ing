import { database, marketByMint } from '../../../../lib/server.mjs'
import { MARKET_ACTIVITY_CACHE, NO_STORE } from '../../../../lib/cache-headers.mjs'
import { withServerTiming } from '../../../../lib/server-timing.mjs'
import { xHandlesFor, xLinksEnabled } from '../../../../lib/x-links.mjs'
import { linkedTraders } from '../../../../lib/market-activity.mjs'
import { readStockTraders } from '../../../../lib/stock-market-activity.mjs'
import { isStockMarket } from '../../../../../src/stock-market-chart.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const NEWEST = 20

// Recent trades beside the chart: of this market's newest curve and graduated-pool trades, the ones whose trader linked
// X, as that account (handle, name, avatar) by trade. No wallet address is sent; with Connect X off nothing is read. A
// stock-paired market's trades come from the stock ledger (app/lib/stock-market-activity.mjs).
export const GET = withServerTiming(async (_request, { params }) => {
  const { mint } = await params
  if (!MINT.test(mint)) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
  if (!xLinksEnabled()) return Response.json({ traders: [] }, { headers: MARKET_ACTIVITY_CACHE })
  const { market } = await marketByMint(mint)
  const pool = database()
  if (!market || !pool) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
  try {
    const { rows } = isStockMarket(market) ? { rows: await readStockTraders(pool, market, NEWEST) } : await pool.query(`(select signature, event_index as "eventIndex", trader from trade_events
        where pool = $1 order by slot desc, event_index desc limit $3)
      union all
      (select d.signature, d.event_index, d.trader from damm_trade_events d
        join graduation_events g on g.github_repo_id = d.github_repo_id and g.pool = d.pool
        where d.github_repo_id = $2 and d.base_amount is not null order by d.slot desc, d.event_index desc limit $3)`,
    [market.pool, market.repoId, NEWEST])
    const handles = await xHandlesFor([...new Set(rows.map(row => row.trader).filter(Boolean))])
    return Response.json({ traders: linkedTraders(rows, handles) }, { headers: MARKET_ACTIVITY_CACHE })
  } catch {
    return Response.json({ error: 'Traders are temporarily unavailable' }, { status: 503, headers: NO_STORE })
  }
})
