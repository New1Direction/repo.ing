import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { createCustodyRecovery } from '../../src/custody-recovery.mjs'
import { createDatabasePool } from '../../src/database-pool.mjs'
import { approvedConfigs, createMarketConfigResolver } from '../../src/market-config.mjs'
import { RECOVERED_LAUNCH_CONFIG } from '../../src/launch-custody.mjs'
import { markets } from '../../src/db/schema.mjs'
import { Connection } from '@solana/web3.js'
import { createNewMarketAdmissionReview } from '../../src/new-market-admission.mjs'
import { assertNewMarketTrade, newMarketControls } from '../../src/new-market-trading.mjs'
import { chain, database } from './server.mjs'

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
  let raw = process.env.TRADING_CUSTODY_RECOVERY_JSON
  const digest = process.env.TRADING_CUSTODY_RECOVERY_SHA256
  if (raw === undefined && digest === undefined && process.env.EXISTING_MARKET_TRADING_ONLY !== 'true') return null
  try {
    // The pinned image carries the exact public file. Containers limit each
    // environment value to 16KB, so production passes only its reviewed digest.
    if (raw === undefined && process.env.EXISTING_MARKET_TRADING_ONLY === 'true') {
      raw = readFileSync(join(process.cwd(), 'config/existing-market-custody.json'), 'utf8')
    }
    if (!raw || !/^[a-f0-9]{64}$/.test(digest ?? '') || createHash('sha256').update(raw).digest('hex') !== digest) throw Error()
    const manifest = JSON.parse(raw)
    if (manifest === null) throw Error()
    createCustodyRecovery(manifest)
    return manifest
  } catch { throw Error('Trading custody bindings are missing, changed or invalid; review required') }
}

// Recovery is not permission to trade every market in the operational database.
// Both engines, including restored-session verification, use this exact loader.
export function tradingMarketLoader(pool, config, manifest, newMarkets = {}) {
  if (process.env.EXISTING_MARKET_TRADING_ONLY !== 'true') return undefined
  const rows = manifest.poolCreators
  const expected = [...new Set(rows.map(row => row.config))].sort()
  // The current config is the safe launch config (or, before it was, a manifest config); it adds no trading identity. The
  // reviewed manifest's configs must be exactly the other approved configs.
  const configured = approvedConfigs(config).map(key => key.toBase58()).filter(key => key !== RECOVERED_LAUNCH_CONFIG).sort()
  if (!rows.length || !(String(config) === RECOVERED_LAUNCH_CONFIG || expected.includes(String(config))) ||
    JSON.stringify(expected) !== JSON.stringify(configured)) throw Error('Trading reviewed config allowlist changed')
  const allowed = new Map(rows.map(row => [row.repoId, Object.freeze({ ...row })]))
  if (allowed.size !== rows.length) throw Error('Trading reviewed existing-market allowlist is ambiguous')
  const resolveConfig = createMarketConfigResolver(config, expected, null)
  const db = drizzle(pool)
  const admitNewMarket = newMarketLoader(pool, db, newMarkets)
  return async repoId => {
    const binding = allowed.get(String(repoId))
    if (!binding) return admitNewMarket(repoId)
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

// A market outside the reviewed allowlist trades only after the two-provider admission rule (safe config, vault creator,
// finalized launch handoff) admits it. Launch evidence is immutable, so an admission is reused for ADMISSION_TTL_MS.
// The owner's new_markets switch gates buys in the trade route (guardNewMarketTrade); sells of admitted markets stay open.
const ADMISSION_TTL_MS = 10 * 60_000
function newMarketLoader(pool, db, { review = defaultAdmissionReview(), now = Date.now } = {}) {
  const admitted = new Map()
  return async repoId => {
    if (!review) throw Error('New-market trading needs an independent verification RPC')
    const market = (await db.select().from(markets).where(eq(markets.githubRepoId, BigInt(repoId))).limit(1))[0]
    if (!market) throw Error('Repository has no indexed market')
    const cached = admitted.get(String(repoId))
    if (!cached || now() - cached.at >= ADMISSION_TTL_MS || cached.pool !== market.pool) {
      const result = await review(market)
      if (result.state !== 'eligible-for-review' || result.pool !== market.pool) throw Error('New-market trading refused: this market does not meet the admission rule')
      admitted.set(String(repoId), { at: now(), pool: market.pool })
    }
    return market
  }
}

function defaultAdmissionReview(env = process.env) {
  if (!env.GRADUATION_VERIFICATION_RPC_URL) return null
  try { return createNewMarketAdmissionReview({ connections: [chain(), new Connection(env.GRADUATION_VERIFICATION_RPC_URL, 'finalized')] }) }
  catch { return null }
}

// Route-side guard for buy quotes, costs, prepare and submit: the switch and the buy caps over every non-reviewed market.
export async function guardNewMarketTrade(manifest, { repoId, direction, amountLamports }) {
  if (process.env.EXISTING_MARKET_TRADING_ONLY !== 'true') return
  const reviewedRepoIds = manifest.poolCreators.map(row => row.repoId)
  if (reviewedRepoIds.includes(String(repoId))) return
  await assertNewMarketTrade(tradingDatabase(), { direction, amountLamports, reviewedRepoIds })
}

// Whether a recovery launch may include a first buy: the same owner switch that gates new-market buys.
export async function newMarketBuysOpen() {
  if (process.env.EXISTING_MARKET_TRADING_ONLY !== 'true') return false
  try { return (await newMarketControls(tradingDatabase())).enabled } catch { return false }
}
