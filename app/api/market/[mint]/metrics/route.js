import { chain, marketByMint } from '../../../../lib/server.mjs'
import { solUsdPrice } from '../../../../lib/sol-usd.mjs'
import { marketTokenMetrics } from '../../../../lib/market-metrics.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  const headers = { 'Cache-Control': 'no-store' }
  if (!market) return Response.json({ error: 'Market unavailable' }, { status: 404, headers })
  const [solUsd, metrics] = await Promise.all([
    solUsdPrice(), marketTokenMetrics(chain(), market.mint, market.pool).catch(() => null),
  ])
  return Response.json({ solUsd, ...metrics, fetchedAt: new Date().toISOString() }, { headers })
}
