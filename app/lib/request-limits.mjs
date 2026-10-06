import { clientAddress } from '../../src/client-address.mjs'
import { createRequestLimiter } from '../../src/request-limiter.mjs'

// Per-address allowances on the public trade, launch and repository-lookup routes, held in each web process
// (docs/PRODUCTION.md, "Request limits"). They keep one address from spending the RPC and GitHub budgets that every other
// request and the worker share. Nothing is counted across addresses and there is no site-wide total, so one visitor's
// requests can never get another visitor refused.
// - burst: what one address may ask at once. Several times the heaviest honest use by one visitor in a minute (the trade
//   panel refreshes a typed quote and its costs every 15 s and after each edit, and polls a signed trade every 3 s; the
//   launch form asks for a fresh review every 20 s while one is read), because many people can share an address: an
//   office, a VPN exit, a mobile carrier.
// - perMinute: the rate after that. Above one heavy visitor's for every action. The two that read GitHub refill slowest:
//   its budget is 5,000 calls an hour for the web and the worker together.
// - Bundle raises (app/lib/bundle-api.mjs): the raise page reads its bundle every 15 s (bundle:read, three chain reads); a
//   deposit, refund or claim is simulated and priced before the wallet signs it (bundle:prepare). Opening one is a launch review.
// Never limited: a signed trade, launch or bundle transaction (submit, send), releasing a review (cancel), and reading a launch's
// status.
export const REQUEST_LIMITS = Object.freeze({
  'trade:quote': { burst: 120, perMinute: 120 },
  'trade:costs': { burst: 120, perMinute: 60 },
  'trade:depth': { burst: 30, perMinute: 30 },
  'trade:prepare': { burst: 20, perMinute: 20 },
  'trade:status': { burst: 120, perMinute: 120 },
  'launch:quote': { burst: 40, perMinute: 40 },
  'launch:prepare': { burst: 30, perMinute: 6 },
  resolve: { burst: 30, perMinute: 8 },
  'bundle:read': { burst: 30, perMinute: 30 },
  'bundle:prepare': { burst: 20, perMinute: 20 },
})

export { clientAddress }

const LOG_EVERY_MS = 60_000
const MAX_COUNTED_CLIENTS = 1000
const disabled = env => /^(true|1|yes|on)$/i.test(String(env.REQUEST_LIMITS_DISABLED ?? '').trim())

// One line a minute per action while it refuses: how many requests, from how many addresses, since the last line.
function noteRefusal(state, action, client, at, log) {
  const seen = state.refused.get(action) ?? { count: 0, clients: new Set(), loggedAt: -Infinity }
  state.refused.set(action, seen)
  seen.count += 1
  if (seen.clients.size < MAX_COUNTED_CLIENTS) seen.clients.add(client)
  if (at - seen.loggedAt < LOG_EVERY_MS) return
  log(JSON.stringify({ requestLimited: { action, refused: seen.count, addresses: seen.clients.size } }))
  state.refused.set(action, { count: 0, clients: new Set(), loggedAt: at })
}

// null when the request may proceed, else the 429 to return. extra: fields the route's clients read beside the error.
// - REQUEST_LIMITS_DISABLED=true turns every limit off.
// - A request with no address at all (src/client-address.mjs) is not limited: everyone would share its allowance.
// - A fault in here never stops a request. It is logged, at most once a minute.
export function refuseOverLimit(request, action, extra = {}, { env = process.env, log = line => console.warn(line), now = Date.now } = {}) {
  let state
  try {
    if (disabled(env)) return null
    const client = clientAddress(request)
    if (client === null) return null
    state = globalThis.__repoingRequestLimiter ??= { take: createRequestLimiter({ limits: REQUEST_LIMITS }), refused: new Map(), faultAt: -Infinity }
    const verdict = state.take(action, client)
    if (verdict.allowed) return null
    // The log is not part of the verdict.
    try { noteRefusal(state, action, client, now(), log) } catch { /* refused all the same */ }
    const seconds = verdict.retryAfterSeconds
    return Response.json({ error: `Too many requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`, code: 'RATE_LIMITED', ...extra },
      { status: 429, headers: { 'Retry-After': String(seconds), 'Cache-Control': 'no-store' } })
  } catch (error) {
    try {
      const at = now()
      if (!state || at - (state.faultAt ?? -Infinity) >= LOG_EVERY_MS) {
        if (state) state.faultAt = at
        log(JSON.stringify({ requestLimiterFault: error?.name ?? 'error' }))
      }
    } catch { /* The request proceeds whatever happened in here. */ }
    return null
  }
}
