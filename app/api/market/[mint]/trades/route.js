import { database } from '../../../../lib/server.mjs'
import { CHART_RANGES } from '../../../../../src/market-chart.mjs'
import { marketCharts } from '../../../../lib/market-charts.mjs'
import { MARKET_TRADES_CACHE, NO_STORE, marketCacheHeaders } from '../../../../lib/cache-headers.mjs'
import { withServerTiming } from '../../../../lib/server-timing.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const GET = withServerTiming(async (request, { params }) => {
  const { mint } = await params
  const requested = new URL(request.url).searchParams.get('range')
  const range = Object.hasOwn(CHART_RANGES, requested) ? requested : 'all'
  if (!MINT.test(mint) || !database()) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
  try {
    const body = await marketCharts().get(mint, range)
    if (body === null) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...marketCacheHeaders(request, MARKET_TRADES_CACHE) } })
  } catch {
    return Response.json({ error: 'Trade history is temporarily unavailable' }, { status: 503, headers: NO_STORE })
  }
})
