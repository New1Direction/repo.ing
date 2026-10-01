import { database, marketByMint } from '../../../../lib/server.mjs'
import { CHART_RANGES, readMarketChart } from '../../../../../src/market-chart.mjs'
import { createChartCache } from '../../../../lib/chart-cache.mjs'
import { marketNotificationHub } from '../../../../lib/market-hub.mjs'
import { MARKET_TRADES_CACHE, NO_STORE, marketCacheHeaders } from '../../../../lib/cache-headers.mjs'
import { timed, withServerTiming } from '../../../../lib/server-timing.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const charts = globalThis.__repoingChartCache ??= createChartCache({
  async load(mint, range) {
    const { market, unavailable } = await marketByMint(mint)
    if (unavailable) throw Error(unavailable)
    if (!market) return null
    return JSON.stringify(await timed('chart', () => readMarketChart(database(), market, range)))
  },
  subscribe(mint, onChange) {
    const hub = marketNotificationHub()
    return hub ? hub.subscribe(mint, ({ kind }) => { if (kind !== 'curve') onChange() }) : null
  },
})

export const GET = withServerTiming(async (request, { params }) => {
  const { mint } = await params
  const requested = new URL(request.url).searchParams.get('range')
  const range = Object.hasOwn(CHART_RANGES, requested) ? requested : 'all'
  if (!MINT.test(mint) || !database()) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
  try {
    const body = await charts.get(mint, range)
    if (body === null) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...marketCacheHeaders(request, MARKET_TRADES_CACHE) } })
  } catch {
    return Response.json({ error: 'Trade history is temporarily unavailable' }, { status: 503, headers: NO_STORE })
  }
})
