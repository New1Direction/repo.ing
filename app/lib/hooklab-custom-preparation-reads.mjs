// Owner-scoped read projection only. No RPC, writes, migrations or preparation proof issuance.
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createDatabasePool } from '../../src/database-pool.mjs'
import { githubSessionCookie, readGithubSession } from './auth.mjs'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const provider = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const customPreparationReadConfigurationSchema = z.object({
  schema: z.literal('repoing/custom-preparation-read/1'), expectedProfileSha256: hash,
  expectedProviders: z.array(provider).length(2).refine(v => new Set(v).size === 2),
  evidenceMode: z.enum(['synthetic-fixture', 'configured-readonly-rpc']),
}).strict()
export function parseCustomPreparationReadQuery(query) {
  if (!(query instanceof URLSearchParams) || [...query.keys()].some(k => !['id', 'limit'].includes(k))
    || query.getAll('id').length > 1 || query.getAll('limit').length > 1
    || query.has('id') && query.has('limit')) throw Error('Invalid query')
  const id = query.get('id'), text = query.get('limit')
  if (id !== null && (!z.uuid().safeParse(id).success || id !== id.toLowerCase())) throw Error('Invalid id')
  if (text !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(text)) throw Error('Invalid limit')
  return { id, limit: text === null ? 25 : Number(text) }
}
export const customPreparationReadsEnabled = () => process.env.HOOK_CUSTOM_PREPARATION_READ_ENABLED === 'true'
export async function customPreparationReadConfiguration(env = process.env) {
  const file = env.HOOK_CUSTOM_PREPARATION_READ_CONFIG_FILE, expected = env.HOOK_CUSTOM_PREPARATION_READ_CONFIG_SHA256
  if (!file || !hash.safeParse(expected).success || !env.HOOK_CUSTOM_PREPARATION_DATABASE_URL) throw Error('Explicit read configuration required')
  if ((await stat(file)).size > 8192) throw Error('Read configuration too large')
  const bytes = await readFile(file)
  if (bytes.length > 8192 || createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Read configuration drift')
  return { ...customPreparationReadConfigurationSchema.parse(JSON.parse(bytes)), databaseUrl: env.HOOK_CUSTOM_PREPARATION_DATABASE_URL }
}
export function customPreparationReadDatabase(config) {
  return createDatabasePool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 2000,
    statement_timeout: 3000, query_timeout: 4000, options: '-c default_transaction_read_only=on' }, { log() {} })
}
const capabilities = Object.freeze({ canSign: false, canSubmit: false, canRetry: false, deploymentAdopted: false,
  productionPreparationReceiptAccepted: false, executionEnabled: false })
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
const json = (body, status = 200) => Response.json(body, { status, headers })
async function readJournal({ pool, config, owner, query }) {
  const { customPreparationJournal } = await import('../../src/hooklab-custom-preparation-journal.mjs')
  const journal = customPreparationJournal(pool, { expectedProfileSha256: config.expectedProfileSha256,
    expectedProviders: config.expectedProviders, evidenceMode: config.evidenceMode })
  return query.id ? { entries: [], entry: await journal.get(owner, query.id) }
    : { entries: await journal.list(owner, { limit: query.limit }), entry: null }
}
// Explicit projection is completed against the journal's exported summary, never raw record JSON.
export function createCustomPreparationReadHandler({ enabled = customPreparationReadsEnabled,
  configuration = customPreparationReadConfiguration, database = customPreparationReadDatabase,
  read = readJournal, summarize } = {}) {
  return async function GET(request) {
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    if (!session || !/^[1-9]\d{0,17}$/.test(session.githubUserId)) return json({ error: 'Sign in with GitHub to read your retained preparation.' }, 401)
    let query
    try { query = parseCustomPreparationReadQuery(new URL(request.url).searchParams) }
    catch { return json({ error: 'Invalid preparation read request.' }, 400) }
    if (!enabled()) return json({ status: 'disabled', readEnabled: false, entries: [], entry: null, ...capabilities })
    let pool
    try {
      const config = await configuration()
      pool = database(config)
      const result = await read({ pool, config, owner: session.githubUserId, query })
      if (query.id && !result.entry) return json({ error: 'Retained preparation not found.', ...capabilities }, 404)
      const summary = summarize ?? (await import('../../src/hooklab-custom-preparation-journal.mjs')).customPreparationSummary
      const body = { status: 'read-only', readEnabled: true, evidenceMode: config.evidenceMode,
        profileSha256: config.expectedProfileSha256, entries: result.entries, entry: result.entry ? summary(result.entry) : null,
        limit: query.id ? 1 : query.limit, ...capabilities }
      if (!Array.isArray(result.entries) || result.entries.length > query.limit || Buffer.byteLength(JSON.stringify(body)) > 262144) throw Error('Read result exceeds bound')
      return json(body)
    } catch { return json({ status: 'unavailable', ...capabilities,
      error: 'Retained preparation evidence is unavailable or inconsistent. Preserve the original mint, message and signature.' }, 503) }
    finally { if (pool) await pool.end().catch(() => {}) }
  }
}
