import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { markets, repositories } from '../src/db/schema.mjs'
import { createLaunchCoordinator, IncompleteLaunchError } from '../src/launch-coordinator.mjs'
import { parseRepositoryUrl, RepositoryResolutionError } from '../src/github.mjs'
import { DefinitiveLaunchError } from '../src/meteora-launch.mjs'
import sharp from 'sharp'
import { normalizeTokenImage, validateTokenImage } from '../src/token-image.mjs'
import { createLaunchSessionStore, launchSessionKey } from '../src/launch-sessions.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch'
const testDatabase = new URL(databaseUrl)
if (!['127.0.0.1', 'localhost'].includes(testDatabase.hostname) || !['/gitfun_launch', '/repoing_images_test'].includes(testDatabase.pathname)) throw Error('Use a disposable local launch-test database')
const pool = new pg.Pool({ connectionString: databaseUrl })
const creator = Keypair.generate().publicKey.toBase58()
const launcherWallet = Keypair.generate().publicKey.toBase58()
const url = 'https://github.com/old/repo'
const repo = (fullName = 'old/repo') => ({
  id: 123, name: fullName.split('/')[1], full_name: fullName,
  owner: { login: fullName.split('/')[0], avatar_url: 'https://example.test/avatar.png' },
  description: 'test', stargazers_count: 10, forks_count: 2, archived: false,
  private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z',
})
const fakeFetch = async requestUrl => ({
  ok: true, status: 200,
  json: async () => repo(requestUrl.includes('/new/') ? 'new/repo' : 'old/repo'),
})
const request = (repositoryUrl = url) => ({ repositoryUrl, tokenName: 'Repo', tokenSymbol: 'REPO', launcherWallet, signTransaction: async tx => tx })
let serial = 0
const fakeLauncher = (overrides = {}) => ({
  creatorWallet: creator,
  prepare: async () => {
    serial++
    return { mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(),
      blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100n,
      sign: async () => ({ raw: Buffer.from([1]), signature: Keypair.generate().publicKey.toBase58() }),
    }
  },
  submit: async () => {}, inspect: async () => true, ...overrides,
})

const replicaPool = new pg.Pool({ connectionString: databaseUrl })
test.before(async () => { await pool.query('select 1') })
test.beforeEach(async () => { await pool.query('truncate markets, repositories restart identity cascade'); serial = 0 })
test.after(async () => { await pool.end(); await replicaPool.end() })

test('public repo resolves and URL parser rejects unsupported forms', async () => {
  const coordinator = createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: fakeFetch })
  assert.equal((await coordinator.resolveRepository('https://github.com/old/repo.git/')).githubRepoId, 123n)
  assert.equal(parseRepositoryUrl('https://github.com/old/repo.git/').normalizedUrl, url)
  for (const bad of ['http://github.com/old/repo', 'https://evil.test/old/repo', 'https://github.com/old/repo/tree/main', 'https://github.com/old/repo?x=1']) {
    await assert.rejects(() => coordinator.resolveRepository(bad), RepositoryResolutionError)
  }
  await assert.rejects(() => createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: async () => ({ status: 404 }) }).resolveRepository(url), RepositoryResolutionError)
  await assert.rejects(() => createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: async () => ({ ok: true, json: async () => ({ ...repo(), archived: true }) }) }).resolveRepository(url), RepositoryResolutionError)
  await assert.rejects(() => createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: async () => ({ ok: true, json: async () => ({ ...repo(), private: true }) }) }).resolveRepository(url), RepositoryResolutionError)
})

test('confirmed market is unique across duplicate requests and a renamed URL', async () => {
  const coordinator = createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: fakeFetch })
  const first = await coordinator.launch(request())
  const second = await coordinator.launch(request())
  const renamed = await coordinator.launch(request('https://github.com/new/repo'))
  assert.equal(first.id, second.id)
  assert.equal(first.id, renamed.id)
  assert.equal(first.status, 'confirmed')
  assert.equal(first.githubRepoId, 123n)
  assert.ok(first.mint && first.pool && first.launchSignature)
  assert.equal(serial, 1)
  assert.equal((await drizzle(pool).select().from(markets)).length, 1)
  assert.equal((await drizzle(pool).select().from(repositories))[0].fullName, 'new/repo')
  assert.notEqual(first.launcherWallet, first.creatorWallet)
  await assert.rejects(() => pool.query(`insert into markets
    (github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol)
    values (123,'reserved','other','other','Other','OTHER')`), error => error.code === '23505')
})

test('a definitive preparation failure leaves no confirmed market and retry succeeds', async () => {
  const failed = createLaunchCoordinator({ pool, launcher: fakeLauncher({ prepare: async () => { throw Error('prepare failed') } }), fetchImpl: fakeFetch })
  await assert.rejects(() => failed.launch(request()), /prepare failed/)
  assert.equal((await drizzle(pool).select().from(markets))[0].status, 'failed')
  const retry = createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: fakeFetch })
  assert.equal((await retry.launch(request())).status, 'confirmed')
  assert.equal((await drizzle(pool).select().from(markets)).length, 1)
})

test('concurrent requests serialize before preparing and both return one market', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const launcher = fakeLauncher()
  const prepare = launcher.prepare
  launcher.prepare = async input => { await gate; return prepare(input) }
  const a = createLaunchCoordinator({ pool, launcher, fetchImpl: fakeFetch }).launch(request())
  const b = createLaunchCoordinator({ pool, launcher, fetchImpl: fakeFetch }).launch(request())
  await new Promise(resolve => setTimeout(resolve, 100))
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(first.id, second.id)
  assert.equal(serial, 1)
  assert.equal((await drizzle(pool).select().from(markets)).length, 1)
})

test('ambiguous submit does not become canonical or allow another launch', async () => {
  const ambiguous = createLaunchCoordinator({ pool, launcher: fakeLauncher({ submit: async () => { throw Error('RPC timeout') }, inspect: async () => false }), fetchImpl: fakeFetch })
  await assert.rejects(() => ambiguous.launch(request()), /RPC timeout/)
  assert.equal((await drizzle(pool).select().from(markets))[0].status, 'ambiguous')
  await assert.rejects(() => ambiguous.launch(request()), IncompleteLaunchError)
  assert.equal(serial, 1)
})

test('the worker releases an attempt proven expired, with its alert, and the repository launches again', async () => {
  const stuck = createLaunchCoordinator({ pool, launcher: fakeLauncher({ submit: async () => { throw Error('RPC timeout') }, inspect: async () => false }), fetchImpl: fakeFetch })
  await assert.rejects(() => stuck.launch(request()), /RPC timeout/)
  const [market] = await drizzle(pool).select().from(markets)
  assert.equal(market.status, 'ambiguous')
  await pool.query(`delete from graduation_alerts where kind = 'LAUNCH_EXPIRED'`)
  const unavailable = async () => ({ state: 'unavailable', reason: 'Finalized launch transaction is not available from this RPC' })
  const asked = []
  // Not proven yet, or the evidence contradicts the record: the attempt stays and still blocks a new launch.
  const waiting = createLaunchIndexer({ pool, verify: unavailable, expiredLaunch: async row => { asked.push(row); return null } })
  assert.equal((await waiting.runOnce())[0].state, 'unavailable')
  const mismatched = createLaunchIndexer({ pool, verify: async () => ({ state: 'mismatch', reason: 'Recorded pool is not derived' }),
    expiredLaunch: async () => { throw Error('a contradicted attempt is never released') } })
  assert.equal((await mismatched.runOnce())[0].state, 'mismatch')
  assert.equal((await drizzle(pool).select().from(markets))[0].status, 'ambiguous')
  await assert.rejects(() => stuck.launch(request()), IncompleteLaunchError)
  // Proven: released once, with the alert carrying its evidence.
  const proof = { status: 'EXPIRED_UNLANDED', evidenceHash: 'hash' }
  const releasing = createLaunchIndexer({ pool, verify: unavailable, expiredLaunch: async row => { asked.push(row); return { proof, evidence: { observations: [] } } } })
  const [released] = await releasing.runOnce()
  assert.deepEqual([released.state, released.evidenceHash], ['released', 'hash'])
  assert.deepEqual([asked.at(-1).launch_signature, asked.at(-1).last_valid_block_height, asked.at(-1).status], [market.launchSignature, '100', 'ambiguous'])
  assert.equal((await drizzle(pool).select().from(markets))[0].status, 'failed')
  const { rows: alerts } = await pool.query(`select event_key, github_repo_id::text, (detail::jsonb)->>'reviewedBy' as by from graduation_alerts where kind = 'LAUNCH_EXPIRED'`)
  assert.deepEqual(alerts, [{ event_key: `launch-expired:${market.launchSignature}`, github_repo_id: '123', by: 'worker' }])
  assert.deepEqual(await releasing.runOnce(), [])
  // The repository launches again, on the same market row.
  const retry = createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: fakeFetch })
  assert.equal((await retry.launch(request())).status, 'confirmed')
  assert.equal((await drizzle(pool).select().from(markets)).length, 1)
})

test('definitively failed transaction can retry; submitted chain evidence can be recovered', async () => {
  const failed = createLaunchCoordinator({ pool, launcher: fakeLauncher({ submit: async () => { throw new DefinitiveLaunchError('chain rejected') } }), fetchImpl: fakeFetch })
  await assert.rejects(() => failed.launch(request()), DefinitiveLaunchError)
  assert.equal((await drizzle(pool).select().from(markets))[0].status, 'failed')
  const retry = createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: fakeFetch })
  assert.equal((await retry.launch(request())).status, 'confirmed')
  assert.equal((await drizzle(pool).select().from(markets)).length, 1)
})

test('a prior ambiguous submission is promoted only when chain inspection verifies it', async () => {
  const failed = createLaunchCoordinator({ pool, launcher: fakeLauncher({ submit: async () => { throw Error('RPC timeout') }, inspect: async () => false }), fetchImpl: fakeFetch })
  await assert.rejects(() => failed.launch(request()), /RPC timeout/)
  const recovery = createLaunchCoordinator({ pool, launcher: fakeLauncher({ inspect: async () => true }), fetchImpl: fakeFetch })
  assert.equal((await recovery.launch(request())).status, 'confirmed')
  assert.equal(serial, 1)
})

test('confirmed submission waits for delayed pool evidence instead of reporting a failed launch', async () => {
  let inspections = 0
  const launcher = fakeLauncher({ inspect: async () => ++inspections >= 3 })
  const coordinator = createLaunchCoordinator({ pool, launcher, fetchImpl: fakeFetch,
    evidenceAttempts: 3, evidenceRetryMs: 0 })
  const market = await coordinator.launch(request())
  assert.equal(market.status, 'confirmed')
  assert.equal(inspections, 3)
  assert.equal(serial, 1)
})

test('unavailable pool evidence preserves the submitted transaction for worker recovery', async () => {
  const launcher = fakeLauncher({ inspect: async () => false })
  const coordinator = createLaunchCoordinator({ pool, launcher, fetchImpl: fakeFetch,
    evidenceAttempts: 2, evidenceRetryMs: 0 })
  await assert.rejects(() => coordinator.launch(request()), /Do not retry this launch/)
  const market = (await drizzle(pool).select().from(markets))[0]
  assert.equal(market.status, 'ambiguous')
  assert.ok(market.launchSignature)
  assert.equal(serial, 1)
})

test('selected image is durable before signing and cannot be replaced by a duplicate launch', async () => {
  const { image } = await normalizeTokenImage(await sharp({ create: { width: 300, height: 100, channels: 3, background: 'red' } }).png().toBuffer())
  const expected = await validateTokenImage(image)
  const launcher = fakeLauncher()
  const originalPrepare = launcher.prepare
  launcher.prepare = async () => {
    assert.equal((await pool.query('select token_image from markets where github_repo_id=123')).rows[0].token_image, expected)
    return originalPrepare()
  }
  const coordinator = createLaunchCoordinator({ pool, launcher, fetchImpl: fakeFetch })
  const market = await coordinator.launch({ ...request(), tokenImage: image })
  assert.equal(market.tokenImage, expected)
  const duplicate = await coordinator.launch({ ...request(), tokenImage: null })
  assert.equal(duplicate.mint, market.mint)
  assert.equal(duplicate.tokenImage, expected)
  assert.equal(serial, 1)
})

test('unvalidated image input cannot reserve a market or reach wallet signing', async () => {
  const coordinator = createLaunchCoordinator({ pool, launcher: fakeLauncher(), fetchImpl: fakeFetch })
  await assert.rejects(coordinator.launch({ ...request(), tokenImage: 'https://example.test/mutable.svg' }), /image/)
  assert.equal(serial, 0)
  assert.equal((await pool.query('select count(*) from markets')).rows[0].count, '0')
})

// ---------- Split prepare/submit across replicas (the /api/launch route) ----------
// Two pools stand in for two web replicas; the review travels only through launch_sessions.
const sessionKey = launchSessionKey(Keypair.generate().secretKey)
function replica(db, launcher, options = {}) {
  const store = createLaunchSessionStore({ pool: db, key: sessionKey })
  return { store, coordinator: createLaunchCoordinator({ pool: db, launcher, fetchImpl: fakeFetch, pendingReview: market => store.pending(market.id), ...options }) }
}
function splitLauncher(overrides = {}) {
  const launcher = fakeLauncher(overrides)
  const prepare = launcher.prepare
  launcher.prepare = async input => { const mint = Keypair.generate(); return { ...await prepare(input), mint: mint.publicKey.toBase58(), mintSecretKey: mint.secretKey } }
  return launcher
}
async function prepareReview(side, extra = {}) {
  const id = crypto.randomUUID()
  const result = await side.coordinator.prepareLaunch({ ...request(), ...extra, onPrepared: async ({ market, prepared, repo }) => {
    assert.equal((await pool.query('select status from markets where id=$1', [market.id])).rows[0].status, 'prepared')
    await side.store.create({ id, market, repoFullName: repo.fullName, config: Keypair.generate().publicKey.toBase58(), transaction: 'dW5zaWduZWQ=',
      mintSecretKey: prepared.mintSecretKey, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight })
  } })
  return { id, ...result }
}
const restored = (session, sign = async signTransaction => { await signTransaction(); return { raw: Buffer.from([1]), signature: Keypair.generate().publicKey.toBase58() } }) =>
  ({ blockhash: session.blockhash, lastValidBlockHeight: BigInt(session.lastValidBlockHeight), sign })
const submitArgs = (session, prepared = restored(session)) => ({ marketId: session.marketId, githubRepoId: session.githubRepoId, mint: session.mint,
  repo: { githubRepoId: BigInt(session.githubRepoId), fullName: session.repoFullName }, prepared, signTransaction: async () => 'wallet-signed' })

test('a launch prepared on one replica is submitted from another; a second prepare waits for the open review', async () => {
  const launcher = splitLauncher(), a = replica(pool, launcher), b = replica(replicaPool, launcher)
  const { id, market, prepared } = await prepareReview(a)
  assert.equal(market.status, 'prepared')
  assert.equal(market.mint, prepared.mint)
  await assert.rejects(prepareReview(b), /awaiting wallet approval/)
  assert.equal(serial, 1)
  const session = await b.store.consume(id)
  const confirmed = await b.coordinator.submitPrepared(submitArgs(session))
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(confirmed.mint, market.mint)
  assert.equal((await a.coordinator.prepareLaunch(request())).market.id, confirmed.id, 'a launched market needs no new review')
  assert.equal(serial, 1)
  assert.equal((await pool.query('select count(*)::int as n from markets')).rows[0].n, 1)
})

test('a stale review cannot submit over a newer prepare of the same repository', async () => {
  const launcher = splitLauncher(), a = replica(pool, launcher), b = replica(replicaPool, launcher)
  const first = await prepareReview(a)
  const stale = await a.store.consume(first.id)
  const second = await prepareReview(b)
  assert.notEqual(second.market.mint, first.market.mint)
  await assert.rejects(a.coordinator.submitPrepared(submitArgs(stale)), /Prepared launch expired/)
  const market = (await drizzle(pool).select().from(markets))[0]
  assert.equal(market.status, 'prepared')
  assert.equal(market.mint, second.market.mint)
  assert.equal((await b.coordinator.submitPrepared(submitArgs(await b.store.consume(second.id)))).status, 'confirmed')
})

test('split launch failures release the market exactly like the one-call launch', async () => {
  const launcher = splitLauncher(), a = replica(pool, launcher)
  await assert.rejects(a.coordinator.prepareLaunch({ ...request(), onPrepared: async () => { throw Error('cost estimate failed') } }), /cost estimate failed/)
  assert.equal((await drizzle(pool).select().from(markets))[0].status, 'failed')
  assert.equal((await pool.query('select count(*)::int as n from launch_sessions')).rows[0].n, 0)

  const { id } = await prepareReview(a)
  const session = await a.store.consume(id)
  await assert.rejects(a.coordinator.submitPrepared(submitArgs(session, restored(session, async () => {
    throw new DefinitiveLaunchError('Your wallet changed the launch transaction.') }))), DefinitiveLaunchError)
  assert.equal((await drizzle(pool).select().from(markets))[0].status, 'failed')
  await assert.rejects(a.coordinator.submitPrepared(submitArgs(session)), /Prepared launch expired/)

  const ambiguous = replica(pool, splitLauncher({ submit: async () => { throw Error('RPC timeout') } }))
  const next = await prepareReview(ambiguous)
  await assert.rejects(ambiguous.coordinator.submitPrepared(submitArgs(await ambiguous.store.consume(next.id))), /RPC timeout/)
  assert.equal((await drizzle(pool).select().from(markets))[0].status, 'ambiguous')
})
