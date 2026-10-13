import { calendar } from '../../../lib/launch-calendar.mjs'
import { apiHeaders, apiJson, apiNoStore, apiOptions } from '../../../lib/public-api.mjs'
import { withServerTiming } from '../../../lib/server-timing.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The launch calendar as JSON (docs/MARKET_DATA_API.md#launch-calendar): scheduled launches still ahead or open (time, window,
// announced launcher wallet and maximum initial buy), Group launch raises still raising, and the last week's launches with their
// Launch Quality summary.
export const OPTIONS = apiOptions
export const GET = withServerTiming(async () => {
  const result = await calendar()
  if (result.unavailable) return apiJson({ error: result.unavailable }, { status: 503, headers: apiNoStore })
  return apiJson(result, { headers: apiHeaders(30, 60) })
})
