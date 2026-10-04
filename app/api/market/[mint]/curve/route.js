import { database, marketByMint } from '../../../../lib/server.mjs'
import { publicGraduation, graduationError } from '../../../../../src/graduation-readiness.mjs'
import { MARKET_CURVE_CACHE, NO_STORE, marketCacheHeaders } from '../../../../lib/cache-headers.mjs'
import { withServerTiming } from '../../../../lib/server-timing.mjs'
import { readStockCurve } from '../../../../lib/stock-market-stats.mjs'
import { isStockMarket } from '../../../../../src/stock-market-chart.mjs'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const GET = withServerTiming(async (request, { params }) => {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  if (!market) return Response.json({ error: 'Market not found' }, { status: 404, headers: NO_STORE })
  try {
    // A stock-paired market's progress is in its stock, from its own observations (app/lib/stock-market-stats.mjs).
    if (isStockMarket(market)) return Response.json(await readStockCurve(database(), market), { headers: marketCacheHeaders(request, MARKET_CURVE_CACHE) })
    const {rows:[row]}=await database().query(`select o.*,e.evidence_hash as migration_evidence_hash from graduation_observations o
      left join graduation_events e on e.github_repo_id=o.github_repo_id where o.github_repo_id=$1`,[market.repoId])
    return Response.json(publicGraduation(row), { headers: marketCacheHeaders(request, MARKET_CURVE_CACHE) })
  } catch(error) { return Response.json({ error: 'Graduation progress is being verified.', code:graduationError(error) }, { status: 503,headers:NO_STORE }) }
})
