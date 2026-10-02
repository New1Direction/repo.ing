import { PublicKey } from '@solana/web3.js'
import { rpcFetch } from './rpc-usage.mjs'

// web3.js 1.98 parses legacy and v0 transactions but rejects Solana v1 messages.
// The official JSON RPC shape has compiled instructions for all three versions.
export function normalizeFinalizedTransaction(raw, signature) {
  if (raw === null) return null
  if (!raw || !['legacy', 0, 1].includes(raw.version) ||
      raw.transaction?.signatures?.[0] !== signature ||
      !Array.isArray(raw.transaction?.message?.accountKeys) ||
      !Array.isArray(raw.transaction?.message?.instructions) || !raw.meta) {
    throw new Error('Finalized transaction has an unsupported or incomplete RPC shape')
  }
  const keys = [
    ...raw.transaction.message.accountKeys,
    ...(raw.meta.loadedAddresses?.writable ?? []),
    ...(raw.meta.loadedAddresses?.readonly ?? []),
  ].map(address => new PublicKey(address))
  return { ...raw, transaction: { ...raw.transaction,
    message: { ...raw.transaction.message, accountKeys: keys } } }
}

export function loadFinalizedTransaction(connection, signature, fetchImpl, delays) {
  return loadTransactionAt(connection, signature, 'finalized', fetchImpl, delays)
}

// Public verification RPCs rate-limit bursts (HTTP 429); back off briefly instead of failing a whole
// indexing pass. The total wait stays bounded so a sustained limit still surfaces as an error.
const RATE_LIMIT_DELAYS_MS = [500, 1_000, 2_000, 4_000]
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// A finalized transaction never changes, so each provider's answer is kept per process (bounded, oldest evicted).
// Keys include the endpoint: two-provider agreement still compares each provider's own answer. Only complete answers
// (found, with a block time) read through the default (metered) fetch are kept; an injected fetch always reads.
const FINALIZED_CACHE_MAX = 500
const finalizedCache = new Map()
const cacheKey = (connection, signature) => `${connection.rpcEndpoint}\n${signature}`
export function clearFinalizedTransactionCache() { finalizedCache.clear() }
// Drops one provider's kept answer, e.g. after two providers disagreed about it.
export function forgetFinalizedTransaction(connection, signature) { finalizedCache.delete(cacheKey(connection, signature)) }

export async function loadTransactionAt(connection, signature, commitment, fetchImpl, delays = RATE_LIMIT_DELAYS_MS) {
  if (!['confirmed', 'finalized'].includes(commitment)) throw new Error('Unsupported transaction commitment')
  const cacheable = commitment === 'finalized' && fetchImpl === undefined
  if (cacheable) {
    const cached = finalizedCache.get(cacheKey(connection, signature))
    if (cached) return cached
  }
  const transaction = await readTransactionAt(connection, signature, commitment, fetchImpl ?? rpcFetch(connection.rpcEndpoint), delays)
  if (cacheable && transaction && transaction.blockTime != null) {
    if (finalizedCache.size >= FINALIZED_CACHE_MAX) finalizedCache.delete(finalizedCache.keys().next().value)
    finalizedCache.set(cacheKey(connection, signature), transaction)
  }
  return transaction
}

async function readTransactionAt(connection, signature, commitment, fetchImpl, delays) {
  let response
  for (let attempt = 0; ; attempt++) {
    response = await fetchImpl(connection.rpcEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [signature, { commitment, encoding: 'json', maxSupportedTransactionVersion: 1 }] }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status !== 429 || attempt >= delays.length) break
    const retryAfter = Number(response.headers?.get?.('retry-after')) * 1000
    await wait(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : delays[attempt], 10_000))
  }
  // The status rides along so callers can tell a rate limit or outage (worth retrying) from other failures.
  if (!response.ok) throw Object.assign(new Error(`Solana RPC transaction read returned HTTP ${response.status}`), { status: response.status })
  const payload = await response.json()
  if (payload.error) throw new Error(`Solana RPC transaction read failed with code ${payload.error.code ?? 'unknown'}`)
  return normalizeFinalizedTransaction(payload.result, signature)
}
