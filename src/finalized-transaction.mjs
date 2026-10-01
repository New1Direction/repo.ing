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

export async function loadTransactionAt(connection, signature, commitment, fetchImpl = rpcFetch(connection.rpcEndpoint), delays = RATE_LIMIT_DELAYS_MS) {
  if (!['confirmed', 'finalized'].includes(commitment)) throw new Error('Unsupported transaction commitment')
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
  if (!response.ok) throw new Error(`Solana RPC transaction read returned HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.error) throw new Error(`Solana RPC transaction read failed with code ${payload.error.code ?? 'unknown'}`)
  return normalizeFinalizedTransaction(payload.result, signature)
}
