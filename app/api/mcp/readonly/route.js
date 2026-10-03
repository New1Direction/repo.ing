import { allowedOrigin, boundedRead, createStatelessMcpHandler } from '../../../lib/mcp.mjs'
import { READ_ONLY_SERVER, readOnlyTools } from '../../../lib/mcp-read-tools.mjs'
import { database, displayFeeStatus, graduationRace, listMarkets } from '../../../lib/server.mjs'
import { maintainerDecision, promotionExcluded } from '../../../lib/maintainer-opt-outs.mjs'
import { platformTotals } from '../../../lib/platform-totals.mjs'
import { hfMarketsEnabled, shownMarkets } from '../../../lib/hf-markets.mjs'
import { solUsdPrice } from '../../../lib/sol-usd.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { clientKey } from '../../../lib/holder-notes.mjs'
import { createRateLimiter } from '../../../lib/csp-report.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Read-only MCP server for editors and agents (Cursor and Claude Code plugins/repo-ing). /api/mcp next door is the agent
// launch-review server; this one only reads what the site already shows, through its cached reads, and needs no secret.

// APP_ORIGIN in production; the request's own origin in development.
const siteOrigin = request => publicOrigin(new URL(request.url).origin)
const shown = read => async () => { const result = await read(); return { ...result, markets: shownMarkets(result.markets ?? []) } }
// A displayFeeStatus miss reconciles one market against the chain while it holds a pooled connection and that market's
// advisory lock. At most two run at once from here, each answered within eight seconds; past either the tool says the
// earnings are still being verified, and a late read still fills the cache token pages share.
const fees = boundedRead(displayFeeStatus, { max: 2, waitMs: 8000, busy: { status: 'UNAVAILABLE' } })
const sources = { origin: siteOrigin, markets: shown(listMarkets), race: shown(graduationRace), excluded: promotionExcluded,
  decision: maintainerDecision, fees, usdPerSol: () => solUsdPrice(), totals: platformTotals, modelsEnabled: () => hfMarketsEnabled() }

// Rate limits, counting every POST that passes the origin rule. First in this process (the CSP report limiter): callers
// choose their forwarded address, so this bounds what reaches the database however they rotate it. Then in
// agent_request_limits, shared by every replica: the global scope first, so a spent minute writes nothing more, then the
// client's (clientKey: an HMAC of the first forwarded address, as for /api/mcp and /api/vitals).
const QUOTA = { client: [60, 60], global: [600, 60] }
const local = createRateLimiter({ limit: QUOTA.client[0], globalLimit: QUOTA.global[0] })
// Expired windows only pile up (a row per client key ever seen): sweep them as /api/mcp does, at most every ten minutes.
const SWEEP_MS = 10 * 60_000
let sweptAt = 0
function sweep(pool) {
  if (Date.now() - sweptAt < SWEEP_MS) return
  sweptAt = Date.now()
  pool.query("delete from agent_request_limits where expires_at<now()-interval '1 hour'")
    .catch(error => console.warn('mcp quota sweep failed', { error: error?.code ?? 'error' }))
}
async function quota(request) {
  const key = clientKey(request)
  if (!local(key)) return false
  // Without a database every tool answers that it is unavailable; the limit above still applies.
  const pool = database()
  if (!pool) return true
  const allowed = await takeQuota(pool, [['mcp-read:global', ...QUOTA.global], [`mcp-read:client:${key}`, ...QUOTA.client]])
  sweep(pool)
  return allowed
}
// Browsers only from the configured site (or localhost outside production): an origin derived from the Host header
// would admit a DNS-rebinding page in development.
const allowOrigin = (origin, request) => { try { return allowedOrigin(origin, process.env.APP_ORIGIN ? siteOrigin(request) : null) } catch { return false } }

const handle = createStatelessMcpHandler({ server: READ_ONLY_SERVER, tools: readOnlyTools(sources), allowOrigin, quota })
export function POST(request) { return handle(request) }
// Stateless and JSON-only: no SSE stream to open with GET and no session to end with DELETE. Both answer 405.
export function GET(request) { return handle(request) }
export function DELETE(request) { return handle(request) }
