import { createRequestLimiter } from '../../src/request-limiter.mjs'

// Caps on the public trade, launch and resolve routes: requests per minute, per web process (docs/PRODUCTION.md, "Request
// limits"). They keep one address, or a flood, from spending the RPC and GitHub budgets that every other request and the
// worker share.
// - perClient: one address. Several times the heaviest honest use by one visitor (the trade panel refreshes a typed quote
//   and its costs every 15 s and after each edit, and polls a signed trade every 3 s; the launch form refreshes an expired
//   review), because many people can share an address: an office, a VPN exit, a mobile carrier.
// - global: everyone together, by what the action costs. A costs preview is about 15 RPC calls, a trade review 16, a
//   launch review about 10 plus 3-4 GitHub calls, a repository lookup up to 3 GitHub calls.
// Never limited: a signed trade or launch (submit), releasing a review (cancel), and reading a launch's status.
export const REQUEST_LIMITS = Object.freeze({
  'trade:quote': { perClient: 120, global: 600 },
  'trade:costs': { perClient: 60, global: 180 },
  'trade:depth': { perClient: 30, global: 120 },
  'trade:prepare': { perClient: 20, global: 60 },
  'trade:status': { perClient: 120, global: 1200 },
  'launch:quote': { perClient: 40, global: 200 },
  'launch:prepare': { perClient: 12, global: 30 },
  resolve: { perClient: 20, global: 60 },
})

// The address a request came from: Cloudflare's own header when it proxied the request, else the first forwarded address.
// A grouping, not authentication: a request that reaches the origin directly can claim any address, which is why every
// action also has a total. Held in memory for one window, never stored or logged.
export function clientAddress(request) {
  const headers = request.headers
  const address = headers.get('cf-connecting-ip')?.trim() || headers.get('x-forwarded-for')?.split(',')[0].trim() || headers.get('x-real-ip')?.trim() || 'unknown'
  return address.slice(0, 64)
}

// null when the request may proceed, else the 429 to return. extra: fields the route's clients read beside the error.
// REQUEST_LIMITS_DISABLED=true turns every limit off. A refusal is logged once a minute per action and scope.
export function refuseOverLimit(request, action, extra = {}, { env = process.env, log = line => console.warn(line) } = {}) {
  if (env.REQUEST_LIMITS_DISABLED === 'true') return null
  const state = globalThis.__repoingRequestLimiter ??= { take: createRequestLimiter({ limits: REQUEST_LIMITS }), logged: new Map() }
  const verdict = state.take(action, clientAddress(request))
  if (verdict.allowed) return null
  const key = `${action}|${verdict.scope}`, at = Date.now()
  if (at - (state.logged.get(key) ?? -Infinity) >= 60_000) {
    state.logged.set(key, at)
    log(JSON.stringify({ requestLimited: { action, scope: verdict.scope } }))
  }
  return Response.json({ error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED', ...extra },
    { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds), 'Cache-Control': 'no-store' } })
}
