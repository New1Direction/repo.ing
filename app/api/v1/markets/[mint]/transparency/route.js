import { marketByMint } from '../../../../../lib/server.mjs'
import { marketTransparency, transparencyJson } from '../../../../../lib/market-transparency.mjs'
import { apiHeaders, apiJson, apiNoStore, apiOptions } from '../../../../../lib/public-api.mjs'
import { withServerTiming } from '../../../../../lib/server-timing.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

// One market's transparency report (docs/MARKET_DATA_API.md#market-transparency): Launch Quality with evidence and unknowns,
// trading integrity, sustained health and the builder-reward preview, LP incentive preview, the latest liquidity sample, seeded
// liquidity with labels and lock states, and the staged launch mechanism. Reports are refreshed by the worker about hourly.
export const OPTIONS = apiOptions
export const GET = withServerTiming(async (_request, { params }) => {
  const { mint } = await params
  if (!MINT.test(mint)) return apiJson({ error: 'Market not found' }, { status: 404, headers: apiNoStore })
  const { market, unavailable } = await marketByMint(mint)
  if (!market) return apiJson({ error: unavailable ?? 'Market not found' }, { status: unavailable ? 503 : 404, headers: apiNoStore })
  const view = await marketTransparency(market)
  if (!view) return apiJson({ error: 'Transparency data is temporarily unavailable' }, { status: 503, headers: apiNoStore })
  return apiJson(transparencyJson(market, view), { headers: apiHeaders(60, 120) })
})
