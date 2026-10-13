import { liquidityBoard } from '../../../lib/launch-calendar.mjs'
import { apiHeaders, apiJson, apiNoStore, apiOptions } from '../../../lib/public-api.mjs'
import { withServerTiming } from '../../../lib/server-timing.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The market-maker board (docs/MARKET_DATA_API.md#liquidity-board): each SOL market's latest hourly liquidity sample (depth within 2%
// on each side, quoted spread at 0.1 SOL, fee, reserve), its 30-day sustained liquidity (uptime, medians), and for graduated pools the
// LP incentive preview. Previews pay nothing.
export const OPTIONS = apiOptions
export const GET = withServerTiming(async () => {
  const result = await liquidityBoard()
  if (result.unavailable) return apiJson({ error: result.unavailable }, { status: 503, headers: apiNoStore })
  return apiJson({ ...result, impactPercent: 2, spreadSizeLamports: '100000000',
    incentives: { status: 'preview', paid: false, qualifies: 'DAMM v2 LP positions only; trading volume never qualifies' } }, { headers: apiHeaders(60, 120) })
})
