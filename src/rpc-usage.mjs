import { AsyncLocalStorage } from 'node:async_hooks'

// Solana JSON-RPC usage metering and provider-level rate-limit backoff, shared by every Connection and raw fetch() a
// process makes to one provider. Counts are logged as one compact JSON line per period so usage is visible in logs.

// Helius credits per call (https://www.helius.dev/docs/billing/credits, read 2026-09-30): every standard and
// historical method (getTransaction, getSignaturesForAddress, getBlock, getBlockTime, getTokenLargestAccounts…)
// costs 1; getProgramAccounts costs 10. A public provider has no credits; the weights still show relative cost.
export const HELIUS_CREDITS = Object.freeze({ getProgramAccounts: 10, getTransactionsForAddress: 10 })
export const creditsFor = method => HELIUS_CREDITS[method] ?? 1

export const RPC_RATE_LIMITED = 'RPC_RATE_LIMITED'
// Thrown without a network request while a provider is backing off for longer than callers should wait.
export class RpcLimitedError extends Error {
  constructor(provider, retryInMs) {
    super(RPC_RATE_LIMITED)
    this.code = RPC_RATE_LIMITED
    this.provider = provider
    this.retryInMs = retryInMs
  }
}

// Exponential backoff with jitter: half the step is fixed, half random, so the step never collapses to zero and
// several processes limited at once do not retry in lockstep.
export function backoffDelay(failures, { baseMs = 1000, maxMs = 300_000, random = Math.random } = {}) {
  const step = Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1))
  return Math.round(step / 2 + random() * step / 2)
}

// Retry-After is seconds or an HTTP date; anything else is ignored.
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

// JSON-RPC method names in a request body (one call or a batch). Unparseable bodies count as 'unknown'.
export function rpcMethods(body) {
  try {
    const text = typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body).toString() : null
    const parsed = JSON.parse(text)
    const calls = Array.isArray(parsed) ? parsed : [parsed]
    return calls.map(call => typeof call?.method === 'string' ? call.method : 'unknown')
  } catch { return ['unknown'] }
}

const emptyPeriod = startedAt => ({ startedAt, calls: {}, jobs: {}, limited: {}, rejected: {} })
const bump = (table, a, b, n = 1) => { (table[a] ??= {})[b] = (table[a][b] ?? 0) + n }

export function createRpcMeter({ now = Date.now, random = Math.random, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = line => console.log(line), baseFetch = globalThis.fetch, maxWaitMs = 10_000, baseBackoffMs = 1000, maxBackoffMs = 300_000,
  limitLogEveryMs = 60_000 } = {}) {
  const jobs = new AsyncLocalStorage()
  const providers = new Map()
  let period = emptyPeriod(now())
  const stateOf = provider => {
    if (!providers.has(provider)) providers.set(provider, { failures: 0, until: 0, loggedAt: -Infinity, suppressed: 0 })
    return providers.get(provider)
  }

  function limited(provider, status, retryAfter) {
    const state = stateOf(provider), at = now()
    // Concurrent requests already in flight when the window opened do not escalate it again.
    if (at >= state.until) state.failures++
    const delay = Math.max(backoffDelay(state.failures, { baseMs: baseBackoffMs, maxMs: maxBackoffMs, random }),
      Math.min(retryAfter ?? 0, maxBackoffMs))
    state.until = Math.max(state.until, at + delay)
    bump(period, 'limited', provider)
    if (at - state.loggedAt >= limitLogEveryMs) {
      log(JSON.stringify({ rpcLimited: { provider, status, failures: state.failures, backoffMs: state.until - at, suppressed: state.suppressed } }))
      state.loggedAt = at; state.suppressed = 0
    } else state.suppressed++
  }

  // A fetch for one provider: counts each JSON-RPC call by method and current job, waits out a short backoff, and
  // fails fast (no request) during a long one. HTTP 429 (Helius also uses it for exhausted credits) opens or extends
  // the provider's backoff; the response is still returned so callers keep their own handling.
  function fetchFor(provider, fetchImpl = baseFetch) {
    return async function meteredFetch(input, init = {}) {
      const state = stateOf(provider)
      const wait = state.until - now()
      if (wait > maxWaitMs) {
        bump(period, 'rejected', provider)
        throw new RpcLimitedError(provider, wait)
      }
      if (wait > 0) await sleep(wait)
      const job = jobs.getStore() ?? 'other'
      for (const method of rpcMethods(init.body)) {
        bump(period.calls, provider, method)
        bump(period.jobs, job, provider)
      }
      const response = await fetchImpl(input, init)
      if (response.status === 429) limited(provider, 429, retryAfterMs(response.headers?.get?.('retry-after'), now()))
      else if (response.ok) state.failures = 0
      return response
    }
  }

  // Usage since the last flush, then reset. null when nothing happened.
  function flush() {
    const current = period, at = now()
    period = emptyPeriod(at)
    const total = Object.values(current.calls).reduce((sum, methods) => sum + Object.values(methods).reduce((a, b) => a + b, 0), 0)
    const idle = !total && !Object.keys(current.limited).length && !Object.keys(current.rejected).length
    if (idle) return null
    const credits = Object.fromEntries(Object.entries(current.calls).map(([provider, methods]) =>
      [provider, Object.entries(methods).reduce((sum, [method, n]) => sum + creditsFor(method) * n, 0)]))
    return { rpcUsage: { seconds: Math.round((at - current.startedAt) / 1000), calls: total, credits, byMethod: current.calls,
      byJob: current.jobs, ...(Object.keys(current.limited).length ? { limited: current.limited } : {}),
      ...(Object.keys(current.rejected).length ? { rejected: current.rejected } : {}) } }
  }

  // One compact line per period while there is traffic. The timer never keeps the process alive.
  function report(everyMs = 60_000) {
    const timer = setInterval(() => { const usage = flush(); if (usage) log(JSON.stringify(usage)) }, everyMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  return { fetchFor, flush, report, track: (job, fn) => jobs.run(job, fn),
    backoff: provider => Math.max(0, stateOf(provider).until - now()) }
}

// A provider's genesis hash names its cluster and never changes, so network checks re-read it hourly per
// connection object (concurrent checks share one request) instead of once per market per pass.
const GENESIS_TTL_MS = 3_600_000
const genesisHashes = new WeakMap()
export function readGenesisHash(connection, { now = Date.now, ttlMs = GENESIS_TTL_MS } = {}) {
  const hit = genesisHashes.get(connection)
  if (hit?.pending) return hit.pending
  if (hit && now() < hit.expiresAt) return Promise.resolve(hit.value)
  const pending = connection.getGenesisHash().then(value => {
    genesisHashes.set(connection, { value, expiresAt: now() + ttlMs })
    return value
  }, error => { genesisHashes.delete(connection); throw error })
  genesisHashes.set(connection, { pending })
  return pending
}

// Raw JSON-RPC fetches (finalized-transaction.mjs) find their provider's metered fetch by endpoint URL. Kept on
// globalThis so bundlers that load this module more than once in a process still share one registry.
const endpointFetches = globalThis.__repoingRpcEndpoints ??= new Map()
const endpointKey = url => String(url).replace(/\/+$/, '')
export function registerRpcEndpoint(url, fetchImpl) { endpointFetches.set(endpointKey(url), fetchImpl) }
export function rpcFetch(url) { return endpointFetches.get(endpointKey(url)) ?? globalThis.fetch }
