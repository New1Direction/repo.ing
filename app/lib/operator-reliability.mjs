import { createDatabasePool } from '../../src/database-pool.mjs'
import { loadOperatorReliability } from '../../src/operator-reliability.mjs'
import { ttlMemo } from './ttl-memo.mjs'

// Separate, small, read-only pool; dashboard reads cannot occupy the application pool.
function reliabilityDatabase() {
  if (!process.env.DATABASE_URL) return null
  return globalThis.__reliabilityPool ??= createDatabasePool({ connectionString: process.env.DATABASE_URL, max: 3,
    connectionTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 2500,
    options: '-c default_transaction_read_only=on' }, { log: () => {} })
}

// One bounded, read-only request per snapshot. No retries or arbitrary endpoint input.
async function probeRpc() {
  const response = await fetch(process.env.SOLANA_RPC_URL, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(2500),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }) })
  if (!response.ok) throw new Error('RPC probe unavailable')
  const body = await response.json()
  if (body.error) throw new Error('RPC probe failed')
  return body.result
}

export const operatorReliability = ttlMemo(async () => {
  const pool = reliabilityDatabase()
  return loadOperatorReliability({ query: pool ? (sql, values) => pool.query(sql, values) : null,
    probeRpc: process.env.SOLANA_RPC_URL ? probeRpc : null })
}, 30_000)
