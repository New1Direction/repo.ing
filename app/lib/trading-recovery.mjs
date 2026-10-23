import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { createCustodyRecovery } from '../../src/custody-recovery.mjs'
import { createDatabasePool } from '../../src/database-pool.mjs'
import { approvedConfigs, createMarketConfigResolver } from '../../src/market-config.mjs'
import { markets } from '../../src/db/schema.mjs'
import { database } from './server.mjs'

// The public pages keep their SELECT-only projection. Only the trade API/router
// receives this separate, table-limited credential; no owner or custody signer.
export function tradingDatabase() {
  if (process.env.EXISTING_MARKET_TRADING_ONLY !== 'true') return database()
  if (!process.env.TRADING_DATABASE_URL) throw Error('Trading database is not configured')
  return globalThis.__repoingTradingPool ??= createDatabasePool({ connectionString: process.env.TRADING_DATABASE_URL })
}

// Public accounting/provenance bindings only, never signing authority. The digest
// belongs in the reviewed deployment inputs, not in a browser request.
export function tradingCustodyRecovery() {
  const raw = process.env.TRADING_CUSTODY_RECOVERY_JSON
  const digest = process.env.TRADING_CUSTODY_RECOVERY_SHA256
  if (raw === undefined && digest === undefined && process.env.EXISTING_MARKET_TRADING_ONLY !== 'true') return null
  try {
    if (!raw || !/^[a-f0-9]{64}$/.test(digest ?? '') || createHash('sha256').update(raw).digest('hex') !== digest) throw Error()
    const manifest = JSON.parse(raw)
    if (manifest === null) throw Error()
    createCustodyRecovery(manifest)
    return manifest
  } catch { throw Error('Trading custody bindings are missing, changed or invalid; review required') }
}

// Recovery is not permission to trade every market in the operational database.
// Both engines, including restored-session verification, use this exact loader.
export function tradingMarketLoader(pool, config, manifest) {
  if (process.env.EXISTING_MARKET_TRADING_ONLY !== 'true') return undefined
  const rows = manifest.poolCreators
  const expected = [...new Set(rows.map(row => row.config))].sort()
  const configured = approvedConfigs(config).map(key => key.toBase58()).sort()
  if (!rows.length || JSON.stringify(expected) !== JSON.stringify(configured)) throw Error('Trading reviewed config allowlist changed')
  const allowed = new Map(rows.map(row => [row.repoId, Object.freeze({ ...row })]))
  if (allowed.size !== rows.length) throw Error('Trading reviewed existing-market allowlist is ambiguous')
  const resolveConfig = createMarketConfigResolver(config, expected, null)
  const db = drizzle(pool)
  return async repoId => {
    const binding = allowed.get(String(repoId))
    if (!binding) throw Error('Repository is outside the reviewed existing-market allowlist')
    const market = (await db.select().from(markets).where(eq(markets.githubRepoId, BigInt(repoId))).limit(1))[0]
    if (!market || market.status !== 'confirmed' || market.indexedAt == null || market.launchFinality !== 'finalized' ||
      String(market.githubRepoId) !== binding.repoId || market.mint !== binding.mint || market.pool !== binding.curve ||
      market.creatorWallet !== binding.previousOwner || market.quoteMint || market.quoteAssetId ||
      market.transferHookProgram || market.earlyAccessEnd || market.bundleId != null) {
      throw Error('Repository no longer matches the reviewed existing-market allowlist')
    }
    if (resolveConfig(market).toBase58() !== binding.config) throw Error('Trading reviewed config allowlist changed')
    return market
  }
}
