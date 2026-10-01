import { chain, marketByMint } from '../../../../lib/server.mjs'
import { solUsdPrice } from '../../../../lib/sol-usd.mjs'
import { marketTokenMetrics } from '../../../../lib/market-metrics.mjs'
import { MARKET_METRICS_CACHE, NO_STORE } from '../../../../lib/cache-headers.mjs'
import { timed, withServerTiming } from '../../../../lib/server-timing.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withServerTiming(async (_request, { params }) => {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  if (!market) return Response.json({ error: 'Market unavailable' }, { status: 404, headers: NO_STORE })
  const [solUsd, metrics] = await Promise.all([
    solUsdPrice(), timed('tokenMetrics', () => marketTokenMetrics(chain(), market.mint, market.pool)).catch(() => null),
  ])
  // A response without chain metrics (RPC unavailable) is never shared from the edge, so the next poll retries the read.
  return Response.json({ solUsd, ...metrics, fetchedAt: new Date().toISOString() }, { headers: metrics ? MARKET_METRICS_CACHE : NO_STORE })
})
