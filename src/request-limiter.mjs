// Fixed-window request caps held in one process: per client and in total, per action.
// - limits: { action: { perClient, global } }. An action without an entry is never limited.
// - A refused request spends nothing, and every count starts over each window.
// - Past maxClients distinct clients in one window, every further client shares one allowance, so made-up client names
//   cannot grow memory or buy more than that one allowance. Clients seen before the table filled keep their own.
// No database: a fault here can never stop a request path that works without one.
export function createRequestLimiter({ limits, windowMs = 60_000, maxClients = 10_000, now = Date.now } = {}) {
  let windowStart = now(), totals = new Map(), clients = new Map()
  return function take(action, client) {
    const limit = limits[action]
    if (!limit) return { allowed: true }
    const at = now()
    if (at - windowStart >= windowMs) { windowStart = at; totals = new Map(); clients = new Map() }
    const refused = scope => ({ allowed: false, scope, retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - at) / 1000)) })
    const total = totals.get(action) ?? 0
    if (total >= limit.global) return refused('global')
    const own = `${action}|${client}`, key = clients.has(own) || clients.size < maxClients ? own : `${action}|*`
    const count = clients.get(key) ?? 0
    if (count >= limit.perClient) return refused('client')
    clients.set(key, count + 1)
    totals.set(action, total + 1)
    return { allowed: true }
  }
}
