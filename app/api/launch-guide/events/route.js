import { database } from '../../../lib/server.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { readLimitedText } from '../../../lib/csp-report.mjs'
import { clientKey } from '../../../lib/holder-notes.mjs'
import { GUIDE_EVENTS_MAX_BYTES, parseGuideBeacon, trackingRefused } from '../../../lib/launch-guide-funnel.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { guideEvents } from '../../../../src/launch-guide-events.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store' }
const reply = status => new Response(null, { status, headers })
// Shared across every web replica (agent_request_limits). A visit sends one page view and one event per step shown.
const QUOTA = { global: [2000, 60], client: [30, 60] }

// Guided launch page and step views (app/components/launch-guide.jsx). No cookies are read and nothing identifying is stored: the
// client key is a keyed hash used only for the rate limit. Global Privacy Control or Do Not Track: accepted and dropped.
export async function POST(request) {
  const pool = database()
  if (!pool || trackingRefused(request.headers)) return reply(204)
  const origin = request.headers.get('origin')
  try { if (origin && origin !== publicOrigin(request.url)) return reply(403) } catch { return reply(403) }
  const text = await readLimitedText(request, GUIDE_EVENTS_MAX_BYTES)
  if (text === null) return reply(413)
  let event
  try { event = parseGuideBeacon(text) } catch { return reply(400) }
  try {
    if (!await takeQuota(pool, [['launch-guide-events:global', ...QUOTA.global], [`launch-guide-events:client:${clientKey(request)}`, ...QUOTA.client]])) return reply(429)
    await guideEvents(pool).record(event)
    return reply(204)
  } catch { return reply(503) }
}
