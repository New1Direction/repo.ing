// Standalone graduation recording run (owner 2026-10-29: "do the graduation recording job"). The main worker
// (scripts/run-worker.mjs) carried this pass and is not running, so curve progress, graduation proof and the graduation
// alerts stopped being recorded after 2026-10-22. This runs only that pass (src/graduation-readiness.mjs): every SOL market's
// curve is read from two independent providers that must agree, and the result goes to graduation_observations,
// graduation_events and graduation_alerts. It signs nothing and spends nothing. It runs as a long-lived service, a pass
// every PASS_GAP_MS after the last one ends, as the worker did: the monitor's alerts are held in memory across passes, and a
// market's public progress expires PUBLIC_GRADUATION_MAX_AGE_MS after its last verified pass. Env: GRADUATION_DATABASE_URL, else RECOVERY_CHART_DATABASE_URL; SOLANA_RPC_URL; DBC_CONFIG; the verification
// side is GRADUATION_VERIFICATION_RPC_URL, else SOLANA_VERIFICATION_RPC_URL, with GRADUATION_VERIFICATION_FALLBACK_RPC_URLS,
// else CHART_SOLANA_VERIFICATION_RPC_URL, as its fallback. --once: one pass, then exit. --dry-run (one pass): reads go
// through, nothing is written, and the run lists the tables it read and would have written (and any it may not read).
import { Connection } from '@solana/web3.js'
import { createDatabasePool } from '../src/database-pool.mjs'
import { createFailoverFetch, verificationRpcUrls } from '../src/rpc-failover.mjs'
import { createGraduationMonitor } from '../src/graduation-readiness.mjs'
import { tradingEarlyAccessConfig } from '../src/early-access.mjs'

const dryRun = process.argv.includes('--dry-run')
const report = o => process.stdout.write(`${JSON.stringify({ lane: 'graduation', at: new Date().toISOString(), ...o })}\n`)
const env = {
  ...process.env,
  GRADUATION_VERIFICATION_RPC_URL: process.env.GRADUATION_VERIFICATION_RPC_URL || process.env.SOLANA_VERIFICATION_RPC_URL,
  GRADUATION_VERIFICATION_FALLBACK_RPC_URLS: process.env.GRADUATION_VERIFICATION_FALLBACK_RPC_URLS || process.env.CHART_SOLANA_VERIFICATION_RPC_URL,
}
const databaseUrl = env.GRADUATION_DATABASE_URL || env.RECOVERY_CHART_DATABASE_URL, rpcUrl = env.SOLANA_RPC_URL, config = env.DBC_CONFIG
const verificationUrls = verificationRpcUrls(env)
if (!databaseUrl || !rpcUrl || !config || !verificationUrls.length) {
  report({ status: 'CONFIG_MISSING', database: Boolean(databaseUrl), rpc: Boolean(rpcUrl), dbcConfig: Boolean(config), verification: verificationUrls.length })
  process.exit(1)
}

// A provider that answers with an error status is a failed read (the worker's graduationRPC), never a body to parse.
const strict = fetchImpl => async (url, options) => {
  const response = await fetchImpl(url, options)
  if (!response.ok) { await response.body?.cancel(); throw Error(response.status === 429 ? 'RPC_RATE_LIMITED' : 'RPC_UNAVAILABLE') }
  return response
}
const rpcConnection = (url, fetchImpl) => new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: strict(fetchImpl) })
const connection = rpcConnection(rpcUrl, fetch)
const verification = rpcConnection(verificationUrls[0], createFailoverFetch(verificationUrls.map(url => ({ url, fetch }))))

// Dry run: each statement's tables are noted; writes are skipped (answered with no rows) and a read the role may not make is
// noted and answered with no rows, so one run lists everything the pass needs.
const WRITE = /^\s*(insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-z_]+)/i
const TABLES = /\b(?:from|join)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi
const NOT_TABLES = new Set(['jsonb_array_elements', 'jsonb_each', 'unnest', 'generate_series', 'lateral'])
function recorder(pool) {
  const reads = new Set(), writes = new Set(), denied = new Set()
  const query = run => async (text, params) => {
    const sql = typeof text === 'string' ? text : text?.text ?? ''
    const write = sql.match(WRITE)
    if (write) { writes.add(write[2].toLowerCase()); return { rows: [], rowCount: 0 } }
    for (const [, table] of sql.matchAll(TABLES)) if (!NOT_TABLES.has(table.toLowerCase())) reads.add(table.toLowerCase())
    try { return await run(text, params) } catch (error) {
      if (error?.code !== '42501') throw error
      denied.add(String(error.message).match(/(?:table|relation|view) "?([a-z_]+)"?/i)?.[1] ?? 'unknown')
      return { rows: [], rowCount: 0 }
    }
  }
  const db = {
    query: query((text, params) => pool.query(text, params)),
    async connect() {
      const client = await pool.connect()
      return { query: query((text, params) => client.query(text, params)), release: (...args) => client.release(...args) }
    },
  }
  return { db, tables: () => ({ reads: [...reads].sort(), writes: [...writes].sort(), denied: [...denied].sort() }) }
}

const PASS_GAP_MS = 30_000
const once = dryRun || process.argv.includes('--once')
const pool = createDatabasePool({ connectionString: databaseUrl, max: 3, statement_timeout: 15_000 })
const recording = dryRun ? recorder(pool) : null
const graduation = createGraduationMonitor({ pool: recording?.db ?? pool, connection, verification, config, env, earlyAccess: tradingEarlyAccessConfig(env) })
const tables = () => recording ? { tables: recording.tables() } : {}

// One pass, reported as one line; true when it verified every market.
async function pass() {
  const started = Date.now()
  try {
    const results = await graduation.runOnce()
    const counts = results.reduce((all, r) => ({ ...all, [r.status]: (all[r.status] ?? 0) + 1 }), {})
    const review = results.filter(r => r.status === 'REVIEW').map(r => ({ repoId: r.repoId, code: r.code ?? null }))
    const alerts = results.flatMap(r => r.alerts ?? []).map(a => a?.kind).filter(Boolean)
    report({ status: dryRun ? 'DRY_RUN_COMPLETED' : 'COMPLETED', ms: Date.now() - started, counts, review, alerts, ...tables() })
    return !review.length
  } catch (error) {
    // Never print the raw error: it can carry an RPC URL with its key.
    report({ status: 'FAILED', ms: Date.now() - started, code: error?.code ?? null, reason: String(error?.message ?? error).replace(/https?:\/\/\S+/g, '<url>').slice(0, 160), ...tables() })
    return false
  }
}

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true })
try {
  if (once) process.exitCode = await pass() ? 0 : 1
  else while (!stopping) {
    await pass()
    for (const end = Date.now() + PASS_GAP_MS; !stopping && Date.now() < end;) await new Promise(r => setTimeout(r, 1000))
  }
} finally { await pool.end() }
