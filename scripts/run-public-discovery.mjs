// One public-data intake, then exit. Run with a NEW dedicated least-privilege database login;
// see public-discovery-role.sql. Never load .env, app/lib/server, run-worker, wallets, RPC, or alert jobs.
// Schedule at most once per 30 minutes. The shared intake lock/throttle also protects against overlap/restarts.
import { pathToFileURL } from 'node:url'
import { createDatabasePool } from '../src/database-pool.mjs'
import { createTrendIntake } from '../src/trend-intake.mjs'
import { createTrendSources } from '../src/trend-sources.mjs'

export function publicDiscoveryOptions(env) {
  try {
    const url = new URL(env.PUBLIC_DISCOVERY_DATABASE_URL)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
        !/^\/[^/]+$/.test(url.pathname) || url.hash) throw Error()
    // No libpq options, injected role/search_path, credential files or broad PG* environment fallbacks.
    if ([...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1) throw Error()
    const mode = url.searchParams.get('sslmode') ?? 'verify-full'
    if (!['require', 'verify-full', 'disable'].includes(mode) ||
        (mode === 'disable' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error()
    const excluded = new Set(String(env.PROMOTION_EXCLUDED_REPO_IDS ?? '').split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id)))
    return { excluded, options: {
      host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 5432), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
      ssl: mode === 'disable' ? false : { rejectUnauthorized: true },
      options: '-c role=repoing_public_discovery -c search_path=pg_catalog,public',
      application_name: 'repoing-public-discovery', max: 1, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, query_timeout: 6000, lock_timeout: 1000, idle_in_transaction_session_timeout: 10000,
    } }
  } catch { throw Error('PUBLIC_DISCOVERY_CONFIG_INVALID') }
}

export async function runPublicDiscovery({ env = process.env, createPool = createDatabasePool, sources = createTrendSources() } = {}) {
  const { options, excluded } = publicDiscoveryOptions(env)
  const pool = createPool(options, { log: () => {} })
  try {
    const { rows: [role] } = await pool.query(`select current_user as role`)
    if (role?.role !== 'repoing_public_discovery') throw Error('PUBLIC_DISCOVERY_ROLE_REQUIRED')
    return await createTrendIntake({ pool, sources, discoveryOnly: true, excluded }).runOnce()
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Includes connect, source reads, SQL, unlock AND pool shutdown. A killed connection rolls back its current
  // observation and releases the advisory lock; the persisted attempt retains the 30-minute API budget.
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ publicDiscoveryError: 'PUBLIC_DISCOVERY_DEADLINE' }))
    process.exit(1)
  }, 300000)
  try {
    if (process.argv.length !== 2) throw Error('PUBLIC_DISCOVERY_CONFIG_INVALID')
    const result = await runPublicDiscovery()
    console.log(JSON.stringify({ publicDiscovery: result }))
    if (result.results?.some(row => row.status === 'UNAVAILABLE') || result.sources?.some(row => row.status !== 'OK')) process.exitCode = 1
  } catch (error) {
    const code = ['PUBLIC_DISCOVERY_CONFIG_INVALID', 'PUBLIC_DISCOVERY_ROLE_REQUIRED'].includes(error?.message)
      ? error.message : 'PUBLIC_DISCOVERY_UNAVAILABLE'
    console.error(JSON.stringify({ publicDiscoveryError: code }))
    process.exitCode = 1
  } finally { clearTimeout(deadline) }
}
