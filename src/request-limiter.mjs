// Per-client request allowances held in one process, per action: a token bucket for each (action, client).
// - limits: { action: { burst, perMinute } }. An action without an entry is never limited.
// - A client may make `burst` requests at once and `perMinute` a minute from then on. A refused request spends nothing
//   and is told how many seconds until one more would be allowed.
// - Clients are counted apart and nothing is counted across them, so one client's requests can never get another's refused.
// - At most maxClients allowances are kept. One that has refilled is forgotten. While the table is still full, a client
//   without an allowance is let through uncounted: made-up client names can neither grow memory nor get anyone refused.
// No database: a fault here can never stop a request path that works without one.
export function createRequestLimiter({ limits, maxClients = 10_000, sweepMs = 60_000, now = () => performance.now() } = {}) {
  const buckets = new Map()
  let swept = now()
  // A clock that steps back adds nothing and takes nothing away; the refill goes on from where the clock now stands.
  const level = (bucket, at) => Math.min(bucket.limit.burst, bucket.tokens + Math.max(0, at - bucket.at) * bucket.limit.perMinute / 60_000)
  const sweep = at => {
    swept = at
    for (const [key, bucket] of buckets) if (level(bucket, at) >= bucket.limit.burst) buckets.delete(key)
  }
  return function take(action, client) {
    const limit = limits[action]
    if (!limit) return { allowed: true }
    const at = now(), key = `${action}|${client}`
    if (at - swept >= sweepMs || at < swept) sweep(at)
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= maxClients && at - swept >= 1000) sweep(at)
      if (buckets.size >= maxClients) return { allowed: true }
      bucket = { limit, tokens: limit.burst, at }
      buckets.set(key, bucket)
    }
    const tokens = level(bucket, at)
    bucket.at = at
    bucket.tokens = tokens < 1 ? tokens : tokens - 1
    return tokens < 1 ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) * 60 / limit.perMinute)) } : { allowed: true }
  }
}
