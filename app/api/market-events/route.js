import { readLimitedText } from '../../lib/csp-report.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { trackingRefused } from '../../lib/launch-guide-funnel.mjs'
import { parseMarketEvent } from '../../lib/market-funnel.mjs'
import { createRequestLimiter } from '../../../src/request-limiter.mjs'

export const runtime = 'nodejs'
const take = createRequestLimiter({ limits: { events: { burst: 120, perMinute: 120 } } })
const reply = status => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })

export async function POST(request) {
  if (trackingRefused(request.headers)) return reply(204)
  try { if (request.headers.get('origin') !== publicOrigin(request.url)) return reply(403) } catch { return reply(403) }
  // One global bucket per process: no client address is read, hashed or retained.
  if (!take('events', 'all').allowed) return reply(429)
  const text = await readLimitedText(request, 128)
  if (text === null) return reply(413)
  let event
  try { event = parseMarketEvent(text) } catch { return reply(400) }
  console.info(JSON.stringify({ kind: 'public_market_funnel', ...event }))
  return reply(204)
}
