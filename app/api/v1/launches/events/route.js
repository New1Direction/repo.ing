import { feedEvents } from '../../../../lib/launch-calendar.mjs'
import { apiHeaders, apiJson, apiNoStore, apiOptions } from '../../../../lib/public-api.mjs'
import { withServerTiming } from '../../../../lib/server-timing.mjs'
import { FEED_KINDS, FeedQueryError } from '../../../../../src/launch-feed.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The launch feed's events (docs/MARKET_DATA_API.md#launch-feed). Newest first by default; ?after=<id> returns the following events in
// order, for polling without missing any. Filters: ?kind=a,b and ?repo=<GitHub repository ids>; ?limit=1..200 (default 50).
export const OPTIONS = apiOptions
export const GET = withServerTiming(async request => {
  try {
    const events = await feedEvents(new URL(request.url).searchParams)
    return apiJson({ events, kinds: FEED_KINDS, next: events.length ? `?after=${events.reduce((max, e) => (BigInt(e.id) > BigInt(max) ? e.id : max), events[0].id)}` : null },
      { headers: apiHeaders(15, 30) })
  } catch (error) {
    if (error instanceof FeedQueryError) return apiJson({ error: error.message }, { status: 400, headers: apiNoStore })
    return apiJson({ error: 'The launch feed is temporarily unavailable' }, { status: 503, headers: apiNoStore })
  }
})
