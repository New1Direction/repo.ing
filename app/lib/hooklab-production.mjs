import { readFile } from 'node:fs/promises'
import { Connection } from '@solana/web3.js'
import { createDatabasePool } from '../../src/database-pool.mjs'

// This switch permits account recovery reads only, never production adoption or execution.
export const productionAccountEnabled = () => process.env.HOOKLAB_PRODUCTION_ACCOUNT_ENABLED === 'true'
export function productionAccountDatabase() {
  if (!process.env.DATABASE_URL) return null
  return globalThis.__hooklabAccountPool ??= createDatabasePool({ connectionString: process.env.DATABASE_URL,
    max: 2, connectionTimeoutMillis: 2000, statement_timeout: 3000, query_timeout: 4000 })
}

// Explicit operator bindings, never URLs/digests/provider identities from a public request.
// Creating these readers does not adopt their dossier. Each RPC has a deadline and no retries.
export async function productionReadConfiguration(env = process.env) {
  if (!env.HOOKLAB_PRODUCTION_DOSSIER_FILE || !env.HOOKLAB_PRODUCTION_DOSSIER_SHA256) return null
  const providers = ['PRIMARY', 'SECONDARY'].map(role => {
    const provider = env[`HOOKLAB_PRODUCTION_RPC_${role}_ID`], url = env[`HOOKLAB_PRODUCTION_RPC_${role}_URL`]
    if (!provider || !url || new URL(url).protocol !== 'https:') throw Error('Read configuration unavailable')
    const connection = new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) })
    return { provider, connection: {
      getGenesisHash: () => connection.getGenesisHash(),
      getMultipleAccountsInfoAndContext: (...args) => connection.getMultipleAccountsInfoAndContext(...args),
      getTransaction: (...args) => connection.getTransaction(...args),
    } }
  })
  if (env.HOOKLAB_PRODUCTION_RPC_PRIMARY_URL === env.HOOKLAB_PRODUCTION_RPC_SECONDARY_URL) throw Error('Read configuration unavailable')
  return { dossierJson: await readFile(env.HOOKLAB_PRODUCTION_DOSSIER_FILE, 'utf8'),
    expectedSha256: env.HOOKLAB_PRODUCTION_DOSSIER_SHA256, providers }
}
