import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Keypair } from '@solana/web3.js'
import { createLaunchSessionStore, expireLaunchSessions, launchSessionKey } from '../src/launch-sessions.mjs'
import { takeQuota } from '../src/request-quota.mjs'

// State that every web replica must share, against real PostgreSQL. Two pools stand in for two replicas.
const url = process.env.LAUNCH_SESSIONS_TEST_DATABASE_URL
if (!url) throw Error('LAUNCH_SESSIONS_TEST_DATABASE_URL is required (a disposable local database; see scripts/ci/test-matrix.mjs)')
const target = new URL(url)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/repoing_launch_sessions_test') throw Error('Use the disposable local launch-sessions test database')
const replicaA = new pg.Pool({ connectionString: url }), replicaB = new pg.Pool({ connectionString: url })
const creator = Keypair.generate(), key = launchSessionKey(creator.secretKey)
const storeA = createLaunchSessionStore({ pool: replicaA, key }), storeB = createLaunchSessionStore({ pool: replicaB, key })
const REPO = 7_001n

test.before(async () => { await migrate(drizzle(replicaA), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname }) })
test.beforeEach(async () => {
  await replicaA.query('truncate markets, repositories, agent_request_limits restart identity cascade')
})
test.after(async () => { await replicaA.end(); await replicaB.end() })

let nextRepo = REPO
async function preparedMarket() {
  const repo = nextRepo++
  await replicaA.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
    values($1, 'fixture', 'replica', 'fixture/replica', 1, 0, false, now())`, [repo])
  const mint = Keypair.generate(), launcher = Keypair.generate().publicKey.toBase58()
  const { rows: [row] } = await replicaA.query(`insert into markets(github_repo_id, status, mint, pool, launcher_wallet, creator_wallet, token_name, token_symbol)
    values($1, 'prepared', $2, $3, $4, $5, 'Replica', 'REP') returning id`,
  [repo, mint.publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), launcher, creator.publicKey.toBase58()])
  const market = { id: row.id, githubRepoId: repo, mint: mint.publicKey.toBase58(), launcherWallet: launcher }
  return { mint, market }
}
const review = (market, mint, extra = {}) => ({ id: randomUUID(), market, repoFullName: 'fixture/replica', config: Keypair.generate().publicKey.toBase58(),
  transaction: Buffer.from('unsigned launch transaction').toString('base64'), mintSecretKey: mint.secretKey,
  blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 345_678_901n, initialBuyLamports: '250000000', trendRevision: 3, ...extra })
const status = async id => (await replicaA.query('select status from markets where id=$1', [id])).rows[0].status
const backdate = (id, column) => replicaA.query(`update launch_sessions set ${column} = now() - interval '2 hours' where id = $1`, [id])

test('a review created on one replica is consumed once on another, with the secret erased on use', async () => {
  const { mint, market } = await preparedMarket(), input = review(market, mint)
  await storeA.create(input)
  const { rows: [stored] } = await replicaA.query('select mint_secret, expires_at - created_at as ttl from launch_sessions where id=$1', [input.id])
  assert.ok(stored.mint_secret.startsWith('v1.'))
  assert.ok(!stored.mint_secret.includes(bs58.encode(mint.secretKey)) && !stored.mint_secret.includes(Buffer.from(mint.secretKey).toString('base64')))
  assert.equal(stored.ttl.minutes, 2)
  assert.equal(await storeB.pending(market.id), true)

  const session = await storeB.consume(input.id)
  assert.deepEqual(session.mintSecretKey, mint.secretKey)
  assert.deepEqual({ ...session, mintSecretKey: undefined }, { id: input.id, marketId: market.id, githubRepoId: String(market.githubRepoId), repoFullName: 'fixture/replica',
    mint: market.mint, launcherWallet: market.launcherWallet, config: input.config, transaction: input.transaction, blockhash: input.blockhash,
    lastValidBlockHeight: '345678901', initialBuyLamports: '250000000', trendRevision: 3, mintSecretKey: undefined })
  assert.equal(await storeA.consume(input.id), null)
  assert.equal(await storeB.consume(input.id), null)
  assert.equal(await storeA.pending(market.id), false)
  const { rows: [after] } = await replicaA.query('select mint_secret, consumed_at from launch_sessions where id=$1', [input.id])
  assert.equal(after.mint_secret, null)
  assert.ok(after.consumed_at)
  assert.equal(await status(market.id), 'prepared', 'consuming alone does not touch the market; submit moves it on')
  for (const bad of [undefined, 42, 'not-a-uuid', randomUUID()]) assert.equal(await storeA.consume(bad), null)
})

test('concurrent submits on two replicas: exactly one consumes the review', async () => {
  const { mint, market } = await preparedMarket(), input = review(market, mint)
  await storeA.create(input)
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? storeA : storeB).consume(input.id)))
  assert.equal(results.filter(Boolean).length, 1)
  assert.deepEqual(results.find(Boolean).mintSecretKey, mint.secretKey)
})

test('expiry: an expired review cannot be used and its still-prepared market is released by any replica or the worker', async () => {
  const { mint, market } = await preparedMarket(), input = review(market, mint)
  await storeA.create(input)
  await backdate(input.id, 'expires_at')
  assert.equal(await storeB.pending(market.id), false)
  assert.equal(await storeB.consume(input.id), null)
  assert.equal(await storeB.cancel(input.id), false)
  assert.deepEqual(await expireLaunchSessions(replicaB), { removed: 1, released: 1 })
  assert.equal(await status(market.id), 'failed')
  assert.equal((await replicaA.query('select count(*)::int as n from launch_sessions')).rows[0].n, 0)

  // A market that a newer prepare (new mint) or a submit already moved on is never released by an old review.
  const next = await preparedMarket(), stale = review(next.market, next.mint)
  await storeA.create(stale)
  await backdate(stale.id, 'expires_at')
  await replicaA.query(`update markets set mint = $2 where id = $1`, [next.market.id, Keypair.generate().publicKey.toBase58()])
  const submitted = await preparedMarket(), done = review(submitted.market, submitted.mint)
  await storeA.create(done)
  await backdate(done.id, 'expires_at')
  await replicaA.query(`update markets set status = 'submitted' where id = $1`, [submitted.market.id])
  assert.deepEqual(await storeA.expire(), { removed: 2, released: 0 })
  assert.equal(await status(next.market.id), 'prepared')
  assert.equal(await status(submitted.market.id), 'submitted')
})

test('consumed reviews are kept for an hour; a submit that died mid-flight then releases its market', async () => {
  const { mint, market } = await preparedMarket(), input = review(market, mint)
  await storeA.create(input)
  await storeA.consume(input.id)
  assert.deepEqual(await expireLaunchSessions(replicaA), { removed: 0, released: 0 })
  await backdate(input.id, 'consumed_at')
  assert.deepEqual(await expireLaunchSessions(replicaA), { removed: 1, released: 1 })
  assert.equal(await status(market.id), 'failed')
})

test('cancel on another replica consumes the review and fails its market; repeat cancels are no-ops', async () => {
  const { mint, market } = await preparedMarket(), input = review(market, mint)
  await storeA.create(input)
  assert.equal(await storeB.cancel(input.id), true)
  assert.equal(await status(market.id), 'failed')
  assert.equal(await storeA.consume(input.id), null)
  assert.equal(await storeA.cancel(input.id), false)
  assert.equal(await storeA.cancel('nope'), false)
})

test('a replica with a different creator key cannot open the review; the review is spent and its market released', async () => {
  const { mint, market } = await preparedMarket(), input = review(market, mint)
  await storeA.create(input)
  const stranger = createLaunchSessionStore({ pool: replicaB, key: launchSessionKey(Keypair.generate().secretKey) })
  await assert.rejects(stranger.consume(input.id), /Prepared launch expired/)
  assert.equal(await status(market.id), 'failed')
  assert.equal(await storeA.consume(input.id), null)
})

test('database constraints: a consumed row cannot keep its secret, amounts and revisions are bounded', async () => {
  const { mint, market } = await preparedMarket(), input = review(market, mint)
  await storeA.create(input)
  await assert.rejects(replicaA.query('update launch_sessions set consumed_at = now() where id = $1', [input.id]), /launch_sessions_secret_check/)
  await assert.rejects(storeA.create(review(market, mint, { initialBuyLamports: '-1' })), /Invalid initial buy/)
  await assert.rejects(storeA.create(review(market, mint, { trendRevision: 0 })), /launch_sessions_trend_revision_check/)
  await assert.rejects(createLaunchSessionStore({ pool: replicaA }).create(review(market, mint)), /key required/)
})

test('request quotas are shared by every replica', async () => {
  const scopes = [['test:global', 5, 60], ['test:client:a', 3, 60]]
  const results = []
  for (let i = 0; i < 4; i++) results.push(await takeQuota(i % 2 ? replicaA : replicaB, scopes))
  assert.deepEqual(results, [true, true, true, false])
  assert.equal(await takeQuota(replicaA, [['test:global', 5, 60], ['test:client:b', 3, 60]]), true)
  assert.equal(await takeQuota(replicaB, [['test:global', 5, 60], ['test:client:c', 3, 60]]), false, 'global cap reached across replicas')
  await replicaA.query("update agent_request_limits set expires_at = now() - interval '1 second'")
  assert.equal(await takeQuota(replicaB, scopes), true, 'a new window starts once the old one expires')
})

test('the launch route cancels and refuses reviews through the shared table, whichever replica prepared them', async () => {
  const saved = { db: process.env.DATABASE_URL, creator: process.env.PLATFORM_CREATOR_SECRET_KEY }
  process.env.DATABASE_URL = url
  process.env.PLATFORM_CREATOR_SECRET_KEY = JSON.stringify(Array.from(creator.secretKey))
  try {
    const { POST } = await import('../app/api/launch/route.js')
    const post = async body => {
      const response = await POST(new Request('https://repo.ing/api/launch', { method: 'POST', body: JSON.stringify(body) }))
      return { status: response.status, body: await response.json() }
    }
    const cancelled = await preparedMarket(), cancelReview = review(cancelled.market, cancelled.mint)
    await storeA.create(cancelReview)
    assert.deepEqual(await post({ action: 'cancel', id: cancelReview.id }), { status: 200, body: { cancelled: true } })
    assert.equal(await status(cancelled.market.id), 'failed')
    assert.deepEqual(await post({ action: 'cancel', id: cancelReview.id }), { status: 200, body: { cancelled: true } })

    const used = await preparedMarket(), usedReview = review(used.market, used.mint)
    await storeA.create(usedReview)
    assert.ok(await storeB.consume(usedReview.id))
    for (const id of [usedReview.id, cancelReview.id, randomUUID(), 'nope']) {
      const { status: code, body } = await post({ action: 'submit', id, transaction: 'AA==' })
      assert.equal(code, 400)
      assert.equal(body.error, 'Prepared launch expired; reload before trying again')
      assert.equal(body.code, 'REVIEW_EXPIRED')
      assert.equal(body.canRetry, false)
    }
    assert.equal(await status(used.market.id), 'prepared')
  } finally {
    await globalThis.__gitfunPool?.end()
    delete globalThis.__gitfunPool
    for (const [name, value] of [['DATABASE_URL', saved.db], ['PLATFORM_CREATOR_SECRET_KEY', saved.creator]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
