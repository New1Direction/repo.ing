import { transientRpcReason } from './rpc-usage.mjs'

const hostOf = url => { try { return new URL(url).host } catch { return null } }

// The independent second side of two-provider checks (graduation, migration and DAMM trade evidence):
// GRADUATION_VERIFICATION_RPC_URL, then GRADUATION_VERIFICATION_FALLBACK_RPC_URLS (comma-separated) in order. A fallback
// on the primary's host is dropped: its answer would not be independent of the primary's. [] without the first URL.
export function verificationRpcUrls(env = process.env) {
  const first = env.GRADUATION_VERIFICATION_RPC_URL?.trim()
  if (!first) return []
  const primaryHost = hostOf(env.SOLANA_RPC_URL)
  const fallbacks = String(env.GRADUATION_VERIFICATION_FALLBACK_RPC_URLS ?? '').split(',').map(url => url.trim())
    .filter(url => hostOf(url) && hostOf(url) !== primaryHost)
  return [...new Set([first, ...fallbacks])]
}

// One fetch over several providers, each asked the same JSON-RPC request at its own URL in order. A provider that
// refuses it (any non-2xx answer: a rate limit, a blocked request, an outage) or fails with a transient error
// (transientRpcReason: the meter's backoff refusal, a timeout, a dropped connection) passes it to the next; the last
// provider's own answer or error is returned unchanged, so a single provider behaves exactly as without failover.
// Free public providers each refuse different calls (one rate-limits address history from shared cloud IPs, another
// blocks batched account reads), so failover is per request. A caller's own abort is never failed over.
// providers: [{ url, fetch }], fetch(url, init) being that provider's (metered) fetch.
export function createFailoverFetch(providers) {
  if (!providers.length) throw new Error('At least one RPC provider is required')
  const last = providers.length - 1
  return async function failoverFetch(_url, init = {}) {
    for (const [index, { url, fetch }] of providers.entries()) {
      try {
        const response = await fetch(url, init)
        if (response.ok || index === last) return response
        await response.body?.cancel()
      } catch (error) {
        if (index === last || init.signal?.aborted || transientRpcReason(error) === null) throw error
      }
    }
  }
}
