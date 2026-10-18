import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNativeReceiptQuery, readNativeReceiptPage } from '../src/hooklab-native-reads.mjs'
import { retainedNativeFixture } from './fixtures/hooklab-native-read.mjs'
import { createNativeReceiptReadHandler, nativeReceiptReadConfiguration } from '../app/lib/hooklab-native-reads.mjs'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import { POST } from '../app/api/hook-lab/production/receipts/route.js'

test('bounded read projection retains failed observations and chain/source identity without raw payloads or acceptance', async () => {
  const f = await retainedNativeFixture(), out = await readNativeReceiptPage(f)
  assert.equal(out.identity.stream, f.batch.stream)
  assert.equal(out.identity.sourceCommit, f.manifest.sourceCommit)
  assert.equal(out.identity.genesisHash, f.manifest.genesisHash)
  assert.deepEqual(out.entries.map(r => [r.slot, r.transactionIndex, r.receiptStatus]), [[100, 0, 'finalized-success'], [102, 0, 'finalized-failure']])
  assert.ok(out.entries.every(r => r.deploymentAdopted === false && r.economicPostconditions === false && r.acceptedTrade === false && r.executionEnabled === false))
  assert.equal(out.checkpoint.liveHeadChecked, false)
  assert.equal(out.nextCursor, null)
  assert.ok(!Object.hasOwn(out.entries[0], 'raw'))
  assert.equal(f.calls[0].sql, 'begin isolation level repeatable read read only')
  assert.equal(f.calls.at(-1).sql, 'commit')
  assert.ok(f.calls.every(c => !/insert|update|delete|create|alter|drop/i.test(c.sql)))
  assert.equal(f.releases.length, 1)
})

test('pagination binds a fixed checkpoint and refuses cross-stream cursors before database access', async () => {
  const f = await retainedNativeFixture()
  const first = await readNativeReceiptPage({ ...f, query: { limit: 1 } })
  assert.equal(first.entries.length, 1); assert.ok(first.nextCursor)
  f.state.next_slot = '105'
  const second = await readNativeReceiptPage({ ...f, query: { limit: 1, cursor: first.nextCursor } })
  assert.equal(second.checkpoint.throughSlot, 102)
  assert.deepEqual(second.entries.map(r => r.slot), [102]); assert.equal(second.nextCursor, null)
  const calls = f.calls.length
  await assert.rejects(readNativeReceiptPage({ ...f, manifest: { ...f.manifest, profileSha256: 'd'.repeat(64) }, query: { cursor: first.nextCursor } }), /different stream/)
  assert.equal(f.calls.length, calls)
  f.state.next_slot = '102'
  await assert.rejects(readNativeReceiptPage({ ...f, query: { cursor: first.nextCursor } }))
  assert.equal(f.calls.at(-1).sql, 'rollback')
})

test('strict query validation rejects duplicate, unknown, noncanonical and oversized pagination inputs', () => {
  assert.deepEqual(parseNativeReceiptQuery(new URLSearchParams()), { limit: 25 })
  assert.deepEqual(parseNativeReceiptQuery(new URLSearchParams('limit=50')), { limit: 50 })
  for (const value of ['limit=0', 'limit=51', 'limit=01', 'limit=1.1', 'limit=1&limit=2', 'stream=' + 'a'.repeat(64),
    'sourceCommit=' + 'b'.repeat(40), 'cursor=abc', 'cursor=' + 'a'.repeat(1025), 'ready=true']) {
    assert.throws(() => parseNativeReceiptQuery(new URLSearchParams(value)))
  }
})

test('corrupt state, identities, flags, receipt status and unknown evidence fields fail closed and release reads', async () => {
  for (const mutate of [f => { f.state.manifest.extra = true }, f => { f.state.next_slot = '9007199254740993' },
    f => { f.rows[0].evidence.signature = f.rows[1].signature }, f => { f.rows[0].evidence.economicPostconditions = true },
    f => { f.rows[0].evidence.deploymentAdopted = true }, f => { f.rows[0].evidence.clientReady = true },
    f => { f.rows[0].evidence.receiptStatus = 'finalized-failure' }, f => { f.rows[0].block_evidence.slot = 99 },
    f => { f.rows[0].evidence.events = [] }, f => { f.rows[0].evidence = null }]) {
    const f = await retainedNativeFixture(); mutate(f)
    await assert.rejects(readNativeReceiptPage(f))
    assert.equal(f.calls.at(-1).sql, 'rollback'); assert.equal(f.releases.length, 1)
  }
})

test('decoded rows are re-decoded under exact source/ABI pins and retain large integers without economic claims', async () => {
  const f = await retainedNativeFixture({ decoded: true }), out = await readNativeReceiptPage(f)
  assert.equal(out.entries[0].events[0].data.quote_amount, '9007199254740993')
  assert.equal(out.entries[0].eventStatus, 'decoded-self-cpi')
  assert.equal(out.entries[0].acceptedTrade, false)
  f.rows[0].evidence.events[0].data.quote_amount = '1'
  await assert.rejects(readNativeReceiptPage(f), /decoding differs/)
})

test('HTTP read gate authenticates existing operators, stays disabled by default, and never consumes POST input', async t => {
  const keys = ['GITHUB_APP_CLIENT_SECRET', 'PLATFORM_OPERATOR_GITHUB_IDS', 'HOOK_NATIVE_RECEIPTS_READ_ENABLED']
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  t.after(() => { for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k] } })
  process.env.GITHUB_APP_CLIENT_SECRET = randomBytes(32).toString('hex')
  process.env.PLATFORM_OPERATOR_GITHUB_IDS = '123'
  delete process.env.HOOK_NATIVE_RECEIPTS_READ_ENABLED
  const request = (user = '123', query = '') => ({ url: 'https://repo.ing/api/hook-lab/production/receipts' + query,
    cookies: { get: () => user ? { value: encryptGithubSession({ scope: 'builders', permission: 'identity', repoId: null,
      githubUserId: user, githubLogin: 'fixture', accessToken: 'ghu_test_only', sessionId: 'a'.repeat(48), expiresAt: Date.now() + 60000 }) } : undefined } })
  let configurations = 0, closed = 0
  const f = await retainedNativeFixture()
  const handler = createNativeReceiptReadHandler({ configuration: async () => { configurations++; return { manifest: f.manifest } },
    database: () => ({ ...f.pool, end: async () => { closed++ } }) })
  assert.equal((await handler(request(null))).status, 401)
  assert.equal((await handler(request('456'))).status, 403)
  assert.equal((await (await handler(request())).json()).status, 'disabled')
  assert.equal(configurations, 0)
  assert.equal(POST({ get body() { assert.fail('must not consume input') } }).status, 423)
  process.env.HOOK_NATIVE_RECEIPTS_READ_ENABLED = 'true'
  for (const query of ['?limit=100', '?rpc=https://untrusted.invalid', '?limit=1&limit=2', '?cursor=abc']) assert.equal((await handler(request('123', query))).status, 400)
  assert.equal(configurations, 0)
  const response = await handler(request('123', '?limit=1'))
  assert.equal(response.status, 200); assert.equal(response.headers.get('Vary'), 'Cookie')
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  const body = await response.json(); assert.equal(body.entries.length, 1); assert.equal(body.executionEnabled, false)
  assert.equal(closed, 1); assert.doesNotMatch(JSON.stringify(body), /ghu_|accessToken|databaseUrl/)
  const failed = createNativeReceiptReadHandler({ enabled: () => true, configuration: async () => { throw Error('secret-database-credential') } })
  const outage = await failed(request())
  assert.equal(outage.status, 503); assert.doesNotMatch(await outage.text(), /secret-database-credential/)
})

test('read configuration requires a separate database and exact manifest file hash; ambient app config is ignored', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hook-native-read-'))
  try {
    const f = await retainedNativeFixture(), file = join(directory, 'manifest.json'), bytes = JSON.stringify(f.manifest)
    writeFileSync(file, bytes)
    const env = { HOOK_NATIVE_RECEIPTS_MANIFEST_FILE: file,
      HOOK_NATIVE_RECEIPTS_MANIFEST_SHA256: createHash('sha256').update(bytes).digest('hex'),
      HOOK_NATIVE_RECEIPTS_DATABASE_URL: 'postgres://isolated-test-only' }
    assert.deepEqual((await nativeReceiptReadConfiguration(env)).manifest, f.manifest)
    await assert.rejects(nativeReceiptReadConfiguration({ ...env, HOOK_NATIVE_RECEIPTS_DATABASE_URL: undefined, DATABASE_URL: 'postgres://must-not-use' }))
    await assert.rejects(nativeReceiptReadConfiguration({ ...env, HOOK_NATIVE_RECEIPTS_MANIFEST_SHA256: '0'.repeat(64) }))
    writeFileSync(file, ' '.repeat(16385)); await assert.rejects(nativeReceiptReadConfiguration(env))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('same-ID max-wallet retained reads preserve patch identity and reject cross-profile records', async () => {
  const decoderOptions = { sourceCommit: 'a33957a3f4285351949852ce5fb49cb3616ef496', sourcePatchSha256: 'd1c5447d6e4c0400ad641679cb0e409425f2ce1ef9aaf6500611215f3491c13f' }
  const f = await retainedNativeFixture({ decoded: true, decoderOptions })
  const out = await readNativeReceiptPage({ ...f, query: { limit: 1 } })
  assert.equal(out.identity.sourcePatchSha256, decoderOptions.sourcePatchSha256)
  assert.equal(out.entries[0].events[0].data.quote_amount, '9007199254740993')
  assert.equal(out.entries[0].executionEnabled, false)
  await assert.rejects(readNativeReceiptPage({ ...f, manifest: { ...f.manifest, sourcePatchSha256: '0'.repeat(64) } }), /stream differs/)
})
