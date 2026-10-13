import { feedEvents } from '../lib/launch-calendar.mjs'
import { publicOrigin } from '../lib/origin.mjs'
import { publicCacheHeaders } from '../lib/cache-headers.mjs'
import { atomFeed } from '../../src/launch-feed-format.mjs'
import { FeedQueryError } from '../../src/launch-feed.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Atom feed of the launch feed's newest 50 events (docs/MARKET_DATA_API.md#launch-feed). ?kind= and ?repo= filter it like the JSON API.
export async function GET(request) {
  const url = new URL(request.url)
  const params = new URLSearchParams(url.searchParams)
  params.delete('after')
  params.set('limit', '50')
  let origin
  try { origin = publicOrigin(request.url) } catch { return new Response('The launch feed is temporarily unavailable.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }) }
  try {
    const body = atomFeed(await feedEvents(params), { origin })
    return new Response(body, { headers: { 'content-type': 'application/atom+xml; charset=utf-8', ...publicCacheHeaders(60, 120) } })
  } catch (error) {
    const known = error instanceof FeedQueryError
    return new Response(known ? error.message : 'The launch feed is temporarily unavailable.',
      { status: known ? 400 : 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
}
