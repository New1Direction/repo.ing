// Server-configured read-only transport. Constructing it performs no network I/O.
// URLs may contain provider credentials: never serialize/log connections or settings.
import { Connection } from '@solana/web3.js'
const evidenceMethods = ['getGenesisHash', 'getTransaction', 'getBlock', 'getMultipleAccounts']
const planningMethods = ['getGenesisHash','getMultipleAccounts','getMinimumBalanceForRentExemption','getLatestBlockhash','isBlockhashValid','getBlockHeight','getFeeForMessage']
const fail = () => Error('Preparation RPC read unavailable')
function connectionsWithMethods(settings, allowedMethods, { fetchImpl = fetch, timeoutMs = 5000, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
  const allowed=new Set(allowedMethods)
  if (!Array.isArray(settings) || settings.length !== 2 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 4 * 1024 * 1024) throw fail()
  const configs = settings.map(value => {
    if (!value || Object.keys(value).some(k => !['provider', 'url'].includes(k)) || !/^[a-z][a-z0-9-]{0,63}$/.test(value.provider)) throw fail()
    const url = new URL(value.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail()
    return { provider: value.provider, url: url.toString(), origin: url.origin }
  })
  if (new Set(configs.map(v => v.provider)).size !== 2 || new Set(configs.map(v => v.origin)).size !== 2) throw fail()
  return Object.freeze(configs.map(({ provider, url }) => {
    const boundedFetch = async (destination, init) => {
      try {
        if (String(destination) !== url || init?.method !== 'POST' || typeof init.body !== 'string' || Buffer.byteLength(init.body) > 131072) throw fail()
        const body = JSON.parse(init.body)
        if (Array.isArray(body) || body.jsonrpc !== '2.0' || !allowed.has(body.method)) throw fail()
        const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
        if (!response.ok || response.redirected || !response.body || Number(response.headers.get('content-length')) > maxResponseBytes) { await response.body?.cancel(); throw fail() }
        const reader = response.body.getReader(), chunks = []; let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maxResponseBytes) { await reader.cancel(); throw fail() }
            chunks.push(Buffer.from(value))
          }
        } finally { reader.releaseLock() }
        return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'Content-Type': 'application/json' } })
      } catch { throw fail() }
    }
    const connection = new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: boundedFetch })
    return Object.freeze({ provider, connection })
  }))
}

export const preparationReadConnections=(settings,options)=>connectionsWithMethods(settings,evidenceMethods,options)
// Separate fixed read allowlist. This cannot send, simulate or request signatures.
export const maxWalletPlanningReadConnections=(settings,options)=>connectionsWithMethods(settings,planningMethods,options)
