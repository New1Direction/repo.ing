import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createDatabasePool } from '../../src/database-pool.mjs'
import { hookIndexManifestSchema } from '../../src/hooklab-native-indexer.mjs'
import { parseNativeReceiptQuery, readNativeReceiptPage } from '../../src/hooklab-native-reads.mjs'
import { githubSessionCookie, readGithubSession } from './auth.mjs'
import { requirePlatformOperator } from './platform-operator.mjs'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
const json = (body, status = 200) => Response.json(body, { status, headers })
export const nativeReceiptReadsEnabled = () => process.env.HOOK_NATIVE_RECEIPTS_READ_ENABLED === 'true'
export async function nativeReceiptReadConfiguration(env = process.env) {
  const file = env.HOOK_NATIVE_RECEIPTS_MANIFEST_FILE, expected = env.HOOK_NATIVE_RECEIPTS_MANIFEST_SHA256
  if (!file || !/^[a-f0-9]{64}$/.test(expected ?? '') || !env.HOOK_NATIVE_RECEIPTS_DATABASE_URL) throw Error('Explicit read configuration required')
  if ((await stat(file)).size > 16384) throw Error('Read manifest exceeds limit')
  const bytes = await readFile(file)
  if (bytes.length > 16384 || createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Read manifest drift')
  return { manifest: hookIndexManifestSchema.parse(JSON.parse(bytes)), databaseUrl: env.HOOK_NATIVE_RECEIPTS_DATABASE_URL }
}
export function nativeReceiptReadDatabase(configuration) {
  return createDatabasePool({ connectionString: configuration.databaseUrl, max: 1,
    connectionTimeoutMillis: 2000, statement_timeout: 3000, query_timeout: 4000,
    options: '-c default_transaction_read_only=on' }, { log() {} })
}
export function createNativeReceiptReadHandler({ enabled = nativeReceiptReadsEnabled,
  configuration = nativeReceiptReadConfiguration, database = nativeReceiptReadDatabase, read = readNativeReceiptPage } = {}) {
  return async function GET(request) {
    try { requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value)) }
    catch (error) { return json({ error: error.message }, error.status ?? 403) }
    if (!enabled()) return json({ status: 'disabled', readEnabled: false, executionEnabled: false,
      error: 'Native receipt reads await an approved isolated observer and read-service rollout.' })
    let query
    try { query = parseNativeReceiptQuery(new URL(request.url).searchParams) }
    catch { return json({ error: 'Invalid native receipt query.' }, 400) }
    let pool
    try {
      const config = await configuration()
      pool = database(config)
      return json(await read({ pool, manifest: config.manifest, query }))
    } catch { return json({ status: 'unavailable', executionEnabled: false,
      error: 'Retained native observations are unavailable or inconsistent. No trade or deployment acceptance is implied.' }, 503) }
    finally { if (pool) await pool.end().catch(() => {}) }
  }
}
