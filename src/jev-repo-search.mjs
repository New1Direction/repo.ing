import { createHash } from 'node:crypto'
import { normalizeSearch, simpleSearch, searchQuestions, interpretSearchResponse, SEARCH_LIMIT } from './repo-search.mjs'

export async function readSearchJson(message, limit = 2048) {
  if (Number(message.headers.get('content-length')) > limit || !message.body) throw Error('Invalid search request')
  const reader = message.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw Error('Search request is too large') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// Bounded per-process cost/concurrency, shared requests, short-lived interpretation
// cache. No query text is logged; cache keys are hashes. Results always rebind to
// today's public evidence. Disable with REPO_SMART_SEARCH_ENABLED=false.
export function createRepoSearch({ fetchImpl = fetch, now = () => Date.now(), env = process.env,
  minuteLimit = 12, dayLimit = 500 } = {}) {
  const cache = new Map(), pending = new Map()
  let minute = -1, day = -1, minuteCalls = 0, dayCalls = 0, cooldown = 0
  return async function search(value, input) {
    const query = normalizeSearch(value), candidates = input.slice(0, SEARCH_LIMIT)
    const fallback = simpleSearch(query, candidates)
    if (fallback.mode === 'filters' || !candidates.length) return fallback
    const unavailable = () => ({ ...fallback, notice: 'Showing keyword matches. You can also use the market and activity filters.' })
    if (env.REPO_SMART_SEARCH_ENABLED !== 'true' || !env.TYPESAFE_API_KEY) return unavailable()
    const request = searchQuestions(query, candidates)
    const key = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const cached = cache.get(key)
    if (cached && cached.until > now()) return cached.result
    if (pending.has(key)) return pending.get(key)
    if (minute !== Math.floor(now()/60000)) { minute = Math.floor(now()/60000); minuteCalls = 0 }
    if (day !== Math.floor(now()/86400000)) { day = Math.floor(now()/86400000); dayCalls = 0 }
    if (pending.size >= 2 || minuteCalls >= minuteLimit || dayCalls >= dayLimit || cooldown > now()) return unavailable()
    minuteCalls++; dayCalls++
    const job = (async () => {
      try {
        const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000),
          headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
        if (!response.ok) { await response.body?.cancel(); throw Error('Search provider unavailable') }
        const result = interpretSearchResponse(await readSearchJson(response, 128 * 1024), candidates)
        if (cache.size >= 128) cache.delete(cache.keys().next().value)
        cache.set(key, { result, until: now() + 300000 })
        return result
      } catch {
        cooldown = now() + 60000
        return unavailable()
      } finally { pending.delete(key) }
    })()
    pending.set(key, job)
    return job
  }
}
