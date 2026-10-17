import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCustomPreparationReadHandler, parseCustomPreparationReadQuery,
  customPreparationReadConfiguration } from '../app/lib/hooklab-custom-preparation-reads.mjs'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import { POST } from '../app/api/hook-lab/production/preparations/route.js'

const config = () => ({ schema: 'repoing/custom-preparation-read/1', expectedProfileSha256: 'a'.repeat(64),
  expectedProviders: ['fixture-a', 'fixture-b'], evidenceMode: 'synthetic-fixture' })
const id = '32ef2efa-7f56-44ba-9893-209b0c20d1c7'

test('preparation read query is bounded, canonical and rejects all authority/provider/body selectors', () => {
  assert.deepEqual(parseCustomPreparationReadQuery(new URLSearchParams()), { id: null, limit: 25 })
  assert.deepEqual(parseCustomPreparationReadQuery(new URLSearchParams('limit=50')), { id: null, limit: 50 })
  assert.deepEqual(parseCustomPreparationReadQuery(new URLSearchParams({ id })), { id, limit: 25 })
  for (const q of ['limit=0', 'limit=51', 'limit=01', 'limit=+1', 'limit=-1', 'limit=1&limit=2',
    'id=x', `id=${id}&id=${id}`, `id=${id}&limit=1`, `id=${id.toUpperCase()}`, 'profile=abc',
    'rpc=https://untrusted.invalid', 'owner=123', 'finalized=true', 'cursor=unbound']) {
    assert.throws(() => parseCustomPreparationReadQuery(new URLSearchParams(q)), undefined, q)
  }
})

test('preparation route authenticates existing session, stays off by default and never mutates', async t => {
  const keys = ['GITHUB_APP_CLIENT_SECRET', 'HOOK_CUSTOM_PREPARATION_READ_ENABLED']
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  t.after(() => { for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k] } })
  process.env.GITHUB_APP_CLIENT_SECRET = randomBytes(32).toString('hex')
  delete process.env.HOOK_CUSTOM_PREPARATION_READ_ENABLED
  const request = (owner = '123', query = '') => ({ url: 'https://repo.ing/api/hook-lab/production/preparations' + query,
    cookies: { get: () => owner ? { value: encryptGithubSession({ scope: 'builders', permission: 'identity', repoId: null,
      githubUserId: owner, githubLogin: 'test-owner', accessToken: 'ghu_test_only', sessionId: 'a'.repeat(48), expiresAt: Date.now() + 60000 }) } : undefined } })
  let configurations = 0, closed = 0, reads = 0
  const handler = createCustomPreparationReadHandler({ configuration: async () => { configurations++; return config() },
    database: () => ({ end: async () => { closed++ } }), summarize: row => ({ id: row.id, canSubmit: false }),
    read: async ({ owner, query }) => { reads++; assert.equal(owner, '123'); return { entries: [], entry: query.id === id ? { id } : null } } })
  assert.equal((await handler(request(null))).status, 401)
  assert.equal((await (await handler(request())).json()).status, 'disabled')
  assert.equal(configurations, 0); assert.equal(reads, 0)
  assert.equal(POST({ get body() { assert.fail('cannot consume POST body') } }).status, 423)
  process.env.HOOK_CUSTOM_PREPARATION_READ_ENABLED = '1'
  assert.equal((await (await handler(request())).json()).status, 'disabled')
  process.env.HOOK_CUSTOM_PREPARATION_READ_ENABLED = 'true'
  assert.equal((await handler(request('123', '?owner=456'))).status, 400); assert.equal(configurations, 0)
  const response = await handler(request('123', `?id=${id}`)), body = await response.json()
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('vary'), 'Cookie'); assert.equal(body.entry.id, id)
  for (const k of ['canSign','canSubmit','canRetry','deploymentAdopted','productionPreparationReceiptAccepted','executionEnabled']) assert.equal(body[k], false)
  assert.equal(closed, 1); assert.doesNotMatch(JSON.stringify(body), /ghu_|accessToken|databaseUrl/)
  assert.equal((await handler(request('123', '?id=32ef2efa-7f56-44ba-9893-209b0c20d1c8'))).status, 404)
  const failed = createCustomPreparationReadHandler({ enabled: () => true, configuration: async () => { throw Error('sensitive-private-config') } })
  const outage = await failed(request()); assert.equal(outage.status, 503); assert.doesNotMatch(await outage.text(), /sensitive-private-config/)
  const oversize = createCustomPreparationReadHandler({ enabled: () => true, configuration: async () => config(),
    database: () => ({ end: async () => {} }), summarize: x => x,
    read: async () => ({ entries: Array.from({ length: 26 }, () => ({ id })), entry: null }) })
  assert.equal((await oversize(request())).status, 503)
})

test('preparation reads require exact trusted config file and dedicated database; never ambient credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'custom-preparation-read-'))
  try {
    const file = join(directory, 'config.json'), value = config()
    const write = v => { const bytes = JSON.stringify(v); writeFileSync(file, bytes); return createHash('sha256').update(bytes).digest('hex') }
    const env = { HOOK_CUSTOM_PREPARATION_READ_CONFIG_FILE: file, HOOK_CUSTOM_PREPARATION_READ_CONFIG_SHA256: write(value),
      HOOK_CUSTOM_PREPARATION_DATABASE_URL: 'postgres://isolated-test-only' }
    assert.deepEqual(await customPreparationReadConfiguration(env), { ...value, databaseUrl: env.HOOK_CUSTOM_PREPARATION_DATABASE_URL })
    await assert.rejects(customPreparationReadConfiguration({ ...env, HOOK_CUSTOM_PREPARATION_DATABASE_URL: undefined, DATABASE_URL: 'postgres://must-not-use' }))
    await assert.rejects(customPreparationReadConfiguration({ ...env, HOOK_CUSTOM_PREPARATION_READ_CONFIG_SHA256: '0'.repeat(64) }))
    for (const mutation of [{ ...value, accepted: true }, { ...value, expectedProviders: ['fixture-a','fixture-a'] },
      { ...value, evidenceMode: 'live-approved' }, { ...value, expectedProfileSha256: 'x' }, { ...value, rpc: 'https://untrusted.invalid' }]) {
      await assert.rejects(customPreparationReadConfiguration({ ...env, HOOK_CUSTOM_PREPARATION_READ_CONFIG_SHA256: write(mutation) }))
    }
    writeFileSync(file, ' '.repeat(8193)); await assert.rejects(customPreparationReadConfiguration(env))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
