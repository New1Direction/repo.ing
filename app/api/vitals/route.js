import { database } from '../../lib/server.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { readLimitedText } from '../../lib/csp-report.mjs'
import { clientKey } from '../../lib/holder-notes.mjs'
import { VITALS_MAX_BYTES, deviceClass, parseVitalsBeacon } from '../../lib/web-vitals.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { createVitalsStore } from '../../../src/web-vitals-store.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store' }
const reply = status => new Response(null, { status, headers })
// Shared across every web replica (agent_request_limits): one beacon per sampled page view is normal; these bound abuse.
const QUOTA = { global: [3000, 60], client: [30, 60] }
const store = pool => globalThis.__repoingVitalsStore ??= createVitalsStore(pool, { onPruneError: () => console.warn('web_vitals_prune_failed') })

// Real-user Core Web Vitals beacons (app/components/web-vitals.jsx). No cookies are read and nothing identifying is
// stored: the client key is a keyed hash used only for the rate limit, and the User-Agent only picks mobile/desktop.
export async function POST(request) {
  const pool = database()
  if (!pool) return reply(204)
  const origin = request.headers.get('origin')
  try { if (origin && origin !== publicOrigin(request.url)) return reply(403) } catch { return reply(403) }
  const text = await readLimitedText(request, VITALS_MAX_BYTES)
  if (text === null) return reply(413)
  let beacon
  try { beacon = parseVitalsBeacon(text) } catch { return reply(400) }
  try {
    if (!await takeQuota(pool, [['vitals:global', ...QUOTA.global], [`vitals:client:${clientKey(request)}`, ...QUOTA.client]])) return reply(429)
    await store(pool).record({ ...beacon, device: deviceClass(request.headers.get('user-agent')) })
    return reply(204)
  } catch { return reply(503) }
}
