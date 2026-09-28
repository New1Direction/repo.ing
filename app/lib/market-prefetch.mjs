// Short-lived, public chart previews only. Trade preparation never reads this cache.
export function createMarketPrefetch({ fetcher = (...args) => fetch(...args), now = Date.now, limit = 12, ttl = 8000 } = {}) {
  const entries = new Map()
  let running = 0
  function warm(mint) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return Promise.resolve()
    const previous = entries.get(mint)
    if (previous && now() - previous.started < ttl) return previous.pending
    if (running >= 2) return Promise.resolve()
    if (entries.size >= limit) entries.delete(entries.keys().next().value)
    const entry = { started: now(), value: null }
    entries.set(mint, entry)
    running++
    entry.pending = fetcher(`/api/market/${encodeURIComponent(mint)}/trades?range=all`, { cache: 'no-store', signal: AbortSignal.timeout(6000) })
      .then(async response => {
        if (!response.ok) return
        const value = await response.json()
        if (value.range === 'all' && Array.isArray(value.candles) && Number.isFinite(Date.parse(value.fetchedAt)) && now() - Date.parse(value.fetchedAt) < ttl) entry.value = value
      }).catch(() => {}).finally(() => { running-- })
    return entry.pending
  }
  function take(mint) {
    const entry = entries.get(mint)
    entries.delete(mint)
    return entry && now() - entry.started < ttl ? entry.value : null
  }
  return { warm, take }
}
export const marketPrefetch = createMarketPrefetch()
