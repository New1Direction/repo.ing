// Built chart payloads per (mint, range), shared by every viewer of this web process for a few seconds. Every open chart
// refetches right after an indexed trade (the SSE hint), so a busy market would otherwise rebuild the same series once
// per viewer. A trade hint for the mint (the same LISTEN channel the live stream uses) drops its entries first, so those
// refetches compute once and never get the pre-trade series; without hints the entries still expire after ttlMs.
export const CHART_CACHE_MS = 3_000
const MAX_MINTS = 64

// load(mint, range) resolves the serialized payload, or null for an unknown market (never kept or subscribed).
// subscribe(mint, onChange) returns an unsubscribe function; it may throw (hub full), which only disables invalidation.
export function createChartCache({ load, ttlMs = CHART_CACHE_MS, now = Date.now, subscribe = null, maxMints = MAX_MINTS } = {}) {
  const mints = new Map()
  function drop(mint, entry) {
    if (mints.get(mint) !== entry) return
    mints.delete(mint)
    try { entry.unsubscribe?.() } catch { /* The hub may already be closed. */ }
  }
  function entryFor(mint) {
    let entry = mints.get(mint)
    if (entry) { mints.delete(mint); mints.set(mint, entry); return entry }
    if (mints.size >= maxMints) { const [oldest, value] = mints.entries().next().value; drop(oldest, value) }
    entry = { ranges: new Map(), generation: 0, unsubscribe: null, subscribed: false }
    mints.set(mint, entry)
    return entry
  }
  function watch(mint, entry) {
    if (entry.subscribed || !subscribe || mints.get(mint) !== entry) return
    entry.subscribed = true
    try { entry.unsubscribe = subscribe(mint, () => { entry.generation++; entry.ranges.clear() }) } catch { entry.unsubscribe = null }
  }
  return {
    get(mint, range) {
      const entry = entryFor(mint), hit = entry.ranges.get(range)
      if (hit?.pending) return hit.pending
      if (hit && now() < hit.expiresAt) return Promise.resolve(hit.value)
      const generation = entry.generation
      const pending = Promise.resolve().then(() => load(mint, range)).then(value => {
        const current = entry.ranges.get(range)?.pending === pending
        if (value === null) { if (current) entry.ranges.delete(range); if (!entry.ranges.size && !entry.subscribed) drop(mint, entry); return null }
        // A trade hint that arrived while this was building may postdate the read: serve it to its waiters, keep nothing.
        if (current) { if (entry.generation === generation) entry.ranges.set(range, { value, expiresAt: now() + ttlMs }); else entry.ranges.delete(range) }
        watch(mint, entry)
        return value
      }, error => { if (entry.ranges.get(range)?.pending === pending) entry.ranges.delete(range); throw error })
      entry.ranges.set(range, { pending })
      return pending
    },
    size: () => mints.size,
  }
}
