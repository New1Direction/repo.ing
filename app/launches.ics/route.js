import { calendar } from '../lib/launch-calendar.mjs'
import { publicOrigin } from '../lib/origin.mjs'
import { publicCacheHeaders } from '../lib/cache-headers.mjs'
import { icsCalendar } from '../../src/launch-feed-format.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// iCalendar subscription of scheduled launch windows and Group launch deadlines (docs/MARKET_DATA_API.md#calendar-subscription).
// ?repos=<ids> keeps only those repositories (the watchlist's "Add to calendar"). Calendar apps poll it and remind 15 minutes ahead.
export async function GET(request) {
  const raw = new URL(request.url).searchParams.get('repos')
  const repos = raw ? raw.split(',').map(value => value.trim()).filter(Boolean) : null
  if (repos && (repos.length > 50 || repos.some(id => !/^[1-9]\d{0,15}$/.test(id)))) {
    return new Response('repos is up to 50 GitHub repository ids', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  let origin
  try { origin = publicOrigin(request.url) } catch { return new Response('The launch calendar is temporarily unavailable.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }) }
  const result = await calendar()
  if (result.unavailable) return new Response(result.unavailable, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  const keep = row => !repos || repos.includes(String(row.repoId))
  const body = icsCalendar({ scheduled: result.scheduled.filter(keep), groupLaunches: result.groupLaunches.filter(keep) }, { origin })
  return new Response(body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="repo-ing-launches.ics"',
    ...publicCacheHeaders(300, 600) } })
}
