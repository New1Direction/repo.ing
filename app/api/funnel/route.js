import { database } from '../../lib/server.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { readLimitedText } from '../../lib/csp-report.mjs'
import { clientKey } from '../../lib/holder-notes.mjs'
import { FUNNEL_MAX_BYTES, parseFunnelBeacon } from '../../lib/claim-funnel.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { funnelStore } from '../../../src/funnel-store.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store' }
const reply = status => new Response(null, { status, headers })
// Shared across every web replica (agent_request_limits): one beacon per claim, dashboard or waiting page view is normal.
const QUOTA = { global: [2000, 60], client: [20, 60] }

// Claim funnel page views (app/components/funnel-beacon.jsx). No cookies are read and nothing identifying is stored: the
// client key is a keyed hash used only for the rate limit.
export async function POST(request) {
  const pool = database()
  if (!pool) return reply(204)
  const origin = request.headers.get('origin')
  try { if (origin && origin !== publicOrigin(request.url)) return reply(403) } catch { return reply(403) }
  const text = await readLimitedText(request, FUNNEL_MAX_BYTES)
  if (text === null) return reply(413)
  let event
  try { event = parseFunnelBeacon(text) } catch { return reply(400) }
  try {
    if (!await takeQuota(pool, [['funnel:global', ...QUOTA.global], [`funnel:client:${clientKey(request)}`, ...QUOTA.client]])) return reply(429)
    await funnelStore(pool).record(event)
    return reply(204)
  } catch { return reply(503) }
}
