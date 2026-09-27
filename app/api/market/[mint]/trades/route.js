import { database, marketByMint } from '../../../../lib/server.mjs'
import { readMarketChart } from '../../../../../src/market-chart.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  const pool = database()
  const headers = { 'Cache-Control': 'no-store' }
  if (!market || !pool) return Response.json({ error: 'Market unavailable' }, { status: 404, headers })
  try {
    return Response.json(await readMarketChart(pool, market, new URL(request.url).searchParams.get('range')), { headers })
  } catch {
    return Response.json({ error: 'Trade history is temporarily unavailable' }, { status: 503, headers })
  }
}
