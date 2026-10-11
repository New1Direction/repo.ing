import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import { BACKED_REPO_TTL_MS, captureBackedRepo, clearBackedRepo, storedBackedRepo } from '../app/lib/backed-repo.mjs'
import { BUILDER_SHARE_BPS, UPSTREAM_BUDGET, builderShareTarget, builderSharesSettings, cachedShareTotals, claimPackShares, confirmedSolMarket, forgetShareTotals, logShareProblem, readShareTotals, shareMicro, shareRepository } from '../src/builder-pack-shares.mjs'

// The route imports next/server the way Next resolves it (tests/fixtures/jsx-hooks.mjs).
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))
const route = await import('../app/api/credits/shares/[repo]/route.js')

// Every pack pays a builder (src/builder-pack-shares.mjs): the switch, and which repositories a pack may be opened for.
const ON = { REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'c'.repeat(40), HANDOFF_ASSERTION_SECRET: 'a'.repeat(40),
  CREDITS_WEB_PACKS_ENABLED: 'true', REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing', CREDITS_TREASURY_ADDRESS: '11111111111111111111111111111111',
  CREDITS_WEB_BUILDER_SHARES_ENABLED: 'true' }

test('dark unless switched on, with packs and the handoff on', () => {
  assert.deepEqual(builderSharesSettings(ON), { secret: 'a'.repeat(40), shareBps: BUILDER_SHARE_BPS })
  assert.equal(Number.isInteger(builderSharesSettings(ON).shareBps), true, 'the credit service takes an integer')
  assert.equal(builderSharesSettings({ ...ON, CREDITS_WEB_BUILDER_SHARES_ENABLED: '1' }), null)
  assert.equal(builderSharesSettings({ ...ON, CREDITS_WEB_PACKS_ENABLED: 'false' }), null)
  assert.equal(builderSharesSettings({ ...ON, REPO_INFERENCE_HANDOFF_ENABLED: 'false' }), null)
  assert.equal(builderSharesSettings({}), null)
})

test('10% of a pack, rounded down to a micro-USD', () => {
  assert.equal(BUILDER_SHARE_BPS, 1000)
  assert.deepEqual([10_000_000, 25_000_000, 50_000_000, 100_000_000].map(pack => shareMicro(pack, BUILDER_SHARE_BPS)), [1_000_000, 2_500_000, 5_000_000, 10_000_000])
  assert.equal(shareMicro('25000000', 1000), 2_500_000)
  assert.equal(shareMicro(10_000_001, 1000), 1_000_000)
})

// One read decides; the fake pool answers it.
const pool = row => ({ query: async () => ({ rows: row ? [row] : [] }) })
const market = (extra = {}) => ({ repoId: '1296269', fullName: 'octo/hello', source: 'github', status: 'confirmed', indexed: true,
  launchFinality: 'finalized', quoteAssetId: null, quoteMint: null, holder: '900', declined: false, ...extra })

test('only a GitHub repository with a live SOL market, no opt-out, and a buyer who does not hold its payout wallet', async () => {
  assert.deepEqual(await builderShareTarget(pool(market()), { repoId: '1296269', buyerGithubUserId: '583231' }), { repoId: '1296269', fullName: 'octo/hello' })
  assert.deepEqual(await builderShareTarget(pool(market({ holder: null })), { repoId: '1296269', buyerGithubUserId: '583231' }),
    { repoId: '1296269', fullName: 'octo/hello' }, 'no maintainer yet: shares wait for one')
  const refused = async (row, pattern, repoId = '1296269') => assert.rejects(builderShareTarget(pool(row), { repoId, buyerGithubUserId: '583231' }),
    error => error.status === 400 && pattern.test(error.message))
  await refused(null, /no market on repo\.ing/)
  await refused(market({ status: 'submitted' }), /no market on repo\.ing/)
  await refused(market({ indexed: false }), /no market on repo\.ing/)
  await refused(market({ launchFinality: 'confirmed' }), /no market on repo\.ing/)
  await refused(market({ quoteAssetId: 'METAx' }), /stock pair/i)
  await refused(market({ quoteMint: 'Mint111' }), /stock pair/i)
  await refused(market({ declined: true }), /opted out/)
  await refused(market({ holder: '583231' }), /your own packs/)
  await refused(market(), /GitHub repositories/, '4503599627370497')
  await refused(market(), /GitHub repositories/, 'abc')
})

test('a repository on the do-not-promote list (PROMOTION_EXCLUDED_REPO_IDS) cannot be backed; a maintainer\'s opt-out keeps its own message', async () => {
  const old = process.env.PROMOTION_EXCLUDED_REPO_IDS
  try {
    process.env.PROMOTION_EXCLUDED_REPO_IDS = '42, 1296269'
    const buyer = { repoId: '1296269', buyerGithubUserId: '583231' }
    await assert.rejects(builderShareTarget(pool(market()), buyer), error => error.status === 400 && error.message === 'repo.ing does not promote this repository.')
    await assert.rejects(builderShareTarget(pool(market({ declined: true })), buyer), error => /opted out/.test(error.message), 'the maintainer\'s own word first')
    assert.deepEqual(await builderShareTarget(pool(market({ repoId: '77' })), { repoId: '77', buyerGithubUserId: '583231' }), { repoId: '77', fullName: 'octo/hello' }, 'others are not affected')
    process.env.PROMOTION_EXCLUDED_REPO_IDS = ''
    assert.deepEqual(await builderShareTarget(pool(market()), buyer), { repoId: '1296269', fullName: 'octo/hello' })
  } finally { old === undefined ? delete process.env.PROMOTION_EXCLUDED_REPO_IDS : process.env.PROMOTION_EXCLUDED_REPO_IDS = old }
})

test('a bad repository id is refused before any read', async () => {
  const reads = []
  const counted = { query: async (...args) => { reads.push(args); return { rows: [market()] } } }
  for (const repoId of [undefined, null, '', '0', '012', '1.5', '-1', 1296269.5, '1'.repeat(20)]) {
    await assert.rejects(builderShareTarget(counted, { repoId, buyerGithubUserId: '1' }), error => error.status === 400 && /GitHub repositories/.test(error.message), String(repoId))
  }
  assert.deepEqual(reads, [])
  await builderShareTarget(counted, { repoId: 1296269, buyerGithubUserId: 1 })
  assert.equal(reads.length, 1, 'one read for a good id')
  assert.deepEqual(reads[0][1], ['1296269'])
})

test('totals are asked of the credit service only for a confirmed, finalized, indexed GitHub market in SOL; the holder\'s and a declined repository count', () => {
  assert.equal(confirmedSolMarket(market()), true)
  assert.equal(confirmedSolMarket(market({ holder: '583231', declined: true })), true)
  assert.equal(confirmedSolMarket(market({ holder: null })), true)
  for (const extra of [{ status: 'submitted' }, { status: 'reserved' }, { indexed: false }, { launchFinality: 'confirmed' }, { launchFinality: null }, { quoteAssetId: 'METAx' },
    { quoteMint: 'Mint111' }, { source: 'huggingface' }]) assert.equal(confirmedSolMarket(market(extra)), false, JSON.stringify(extra))
  assert.equal(confirmedSolMarket(null), false)
  assert.equal(confirmedSolMarket(undefined), false)
})

test('one read gives the repository\'s row, or null; an id that is not a GitHub repository id is refused before any read', async () => {
  const reads = []
  const counted = row => ({ query: async (...args) => { reads.push(args); return { rows: row ? [row] : [] } } })
  assert.deepEqual(await shareRepository(counted(market()), '1296269'), market())
  assert.equal(await shareRepository(counted(null), '1296269'), null)
  assert.equal(reads.length, 2)
  for (const repoId of [undefined, '', '0', '012', 'abc', '4503599627370497', '1'.repeat(20)]) {
    await assert.rejects(shareRepository(counted(market()), repoId), error => error.status === 400 && /GitHub repositories/.test(error.message), String(repoId))
  }
  assert.equal(reads.length, 2)
})

test('migration 0069 only adds the pack builder columns and their check, comes after every earlier migration, and is declared in the schema', () => {
  const sql = readFileSync('drizzle/0069_pack_builder_shares.sql', 'utf8')
  assert.match(sql, /ALTER TABLE "credit_pack_purchases" ADD COLUMN IF NOT EXISTS "builder_repo_id" bigint;/)
  assert.match(sql, /ALTER TABLE "credit_pack_purchases" ADD COLUMN IF NOT EXISTS "builder_share_bps" integer;/)
  assert.match(sql, /CHECK \(\("builder_repo_id" IS NULL\) = \("builder_share_bps" IS NULL\)/)
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP|CREATE TABLE)\b|NOT NULL/i, 'expand-only: nothing is rewritten, no old row is refused')
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const last = entries.at(-1)
  assert.equal(last.tag, '0069_pack_builder_shares')
  assert.equal(last.idx, entries.at(-2).idx + 1)
  assert.ok(entries.slice(0, -1).every(entry => entry.when < last.when))
  const schema = readFileSync('src/db/schema.mjs', 'utf8')
  for (const name of ['builder_repo_id', 'builder_share_bps', 'credit_pack_purchases_builder_check']) assert.ok(schema.includes(`'${name}'`), name)
})

const SETTINGS = { origin: 'https://credits.repo.ing', treasury: '11111111111111111111111111111111', network: 'mainnet' }
const answer = value => async () => ({ ok: true, status: 200, json: async () => value })

test('totals are amounts only, checked', async () => {
  assert.deepEqual(await readShareTotals({ fetchImpl: answer({ repo_id: '1296269', packs: 3, paid_micro: 3_000_000, claimed_micro: 1_000_000 }), settings: SETTINGS, repoId: '1296269' }),
    { packs: 3, paidMicro: '3000000', claimedMicro: '1000000', unclaimedMicro: '2000000' })
  await assert.rejects(readShareTotals({ fetchImpl: answer({ repo_id: '42', packs: 3, paid_micro: 1, claimed_micro: 0 }), settings: SETTINGS, repoId: '1296269' }))
  await assert.rejects(readShareTotals({ fetchImpl: answer({ repo_id: '1296269', packs: -1, paid_micro: 1, claimed_micro: 0 }), settings: SETTINGS, repoId: '1296269' }))
})

test('totals that claim more than was paid, or are not whole numbers, are refused', async () => {
  for (const odd of [{ paid_micro: 1, claimed_micro: 2 }, { paid_micro: 1.5, claimed_micro: 0 }, { paid_micro: '1', claimed_micro: 0 }, { paid_micro: 1, claimed_micro: null }]) {
    await assert.rejects(readShareTotals({ fetchImpl: answer({ repo_id: '1296269', packs: 1, ...odd }), settings: SETTINGS, repoId: '1296269' }), error => error.status === 502, JSON.stringify(odd))
  }
})

// A cached read asks the credit service once a minute per repository, within a budget for all repositories (agent_request_limits;
// the real table is in tests/builder-pack-shares-db.test.mjs). The cache is shared by the whole process, so each case uses its own
// repository ids. openPool allows every read; countingPool counts hits per scope and refuses past the scope's limit, like takeQuota.
const openPool = { query: async () => ({ rows: [{ hits: 1 }] }) }
const countingPool = () => {
  const pool = { hits: new Map(), queries: 0, query: async (_sql, [scope, limit]) => {
    pool.queries++
    const hits = (pool.hits.get(scope) ?? 0) + 1
    if (hits > limit) return { rows: [] }
    pool.hits.set(scope, hits)
    return { rows: [{ hits }] }
  } }
  return pool
}
const totalsAnswer = id => ({ repo_id: String(id), packs: 1, paid_micro: 1_000_000, claimed_micro: 0 })
const counting = () => {
  const calls = []
  return { calls, fetchImpl: async address => { calls.push(address); return { ok: true, status: 200, json: async () => totalsAnswer(address.split('/').pop()) } } }
}
const ONE_PACK = { packs: 1, paidMicro: '1000000', claimedMicro: '0', unclaimedMicro: '1000000' }

test('cached totals: one read per repository within 60 seconds, another after', async () => {
  const { calls, fetchImpl } = counting()
  let at = 5_000_000
  const read = repoId => cachedShareTotals(SETTINGS, repoId, { pool: openPool, fetchImpl, now: () => at })
  assert.deepEqual(await read('7001'), ONE_PACK)
  at += 59_999
  assert.deepEqual(await read('7001'), ONE_PACK)
  assert.deepEqual(calls, ['https://credits.repo.ing/builder-shares/7001'])
  await read('7002')
  assert.equal(calls.length, 2, 'another repository has its own entry')
  at += 1
  await read('7001')
  assert.equal(calls.length, 3, 'asked again once 60 seconds have passed')
  await read('7001')
  assert.equal(calls.length, 3, 'and kept for another minute')
})

test('cached totals: a failed read is kept 30 seconds, and callers waiting on the same read share it', async () => {
  let fail = true, at = 9_000_000
  const calls = []
  const fetchImpl = async address => { calls.push(address); if (fail) throw new TypeError('fetch failed'); return { ok: true, status: 200, json: async () => totalsAnswer(7003) } }
  const read = () => cachedShareTotals(SETTINGS, '7003', { pool: openPool, fetchImpl, now: () => at, log: () => {} })
  await assert.rejects(read(), error => error.status === 503)
  at += 29_999
  await assert.rejects(read(), error => error.status === 503)
  assert.equal(calls.length, 1, 'a failure is not asked for again on every render')
  at += 1
  fail = false
  assert.deepEqual(await read(), ONE_PACK)
  assert.equal(calls.length, 2, 'asked again once 30 seconds have passed')
  assert.deepEqual(await read(), ONE_PACK)
  assert.equal(calls.length, 2, 'and a good answer is kept the full minute')

  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = []
  const slowFetch = async address => { slow.push(address); await gate; return { ok: true, status: 200, json: async () => totalsAnswer(7004) } }
  const pending = [cachedShareTotals(SETTINGS, '7004', { pool: openPool, fetchImpl: slowFetch }), cachedShareTotals(SETTINGS, '7004', { pool: openPool, fetchImpl: slowFetch })]
  release()
  assert.deepEqual(await Promise.all(pending), [ONE_PACK, ONE_PACK])
  assert.equal(slow.length, 1, 'concurrent callers share one request')

  const lost = []
  const refusing = async address => { lost.push(address); await Promise.resolve(); throw new TypeError('fetch failed') }
  const options = { pool: openPool, fetchImpl: refusing, log: () => {} }
  const both = await Promise.allSettled([cachedShareTotals(SETTINGS, '7005', options), cachedShareTotals(SETTINGS, '7005', options)])
  assert.deepEqual(both.map(result => result.status), ['rejected', 'rejected'])
  assert.equal(lost.length, 1)
  await assert.rejects(cachedShareTotals(SETTINGS, '7005', options))
  assert.equal(lost.length, 1, 'a shared failure is kept like any other')
  forgetShareTotals('7005')
  await assert.rejects(cachedShareTotals(SETTINGS, '7005', options))
  assert.equal(lost.length, 2, 'until it is dropped')
})

test('cached totals: only a miss may read, within one budget for all repositories; a refusal answers null and is kept 30 seconds', async () => {
  const [scope, limit, seconds] = UPSTREAM_BUDGET
  assert.deepEqual([scope, limit, seconds], ['credits:shares:upstream', 120, 60])
  const { calls, fetchImpl } = counting()
  const pool = countingPool(), logged = []
  let at = 30_000_000
  const read = repoId => cachedShareTotals(SETTINGS, String(repoId), { pool, fetchImpl, now: () => at, log: (...line) => logged.push(line) })
  globalThis.__repoingShareTotals.logged.clear()
  const answers = []
  for (let id = 300_000; id < 300_000 + limit + 10; id++) answers.push(await read(id))
  assert.equal(calls.length, limit, 'no more upstream calls than the budget')
  assert.deepEqual(answers.slice(0, limit).filter(Boolean).length, limit)
  assert.deepEqual(answers.slice(limit), Array(10).fill(null), 'the repositories past the budget answer null')
  // A cached read (a hit) never asks for budget, and a refused repository is not asked about again within 30 seconds.
  assert.equal(pool.hits.get(scope), limit, 'the budget is used up, no more')
  const asked = pool.queries
  await read(300_000); await read(300_000 + limit)
  assert.equal(pool.queries, asked, 'a hit and a kept refusal ask for no budget')
  at += 29_999
  assert.equal(await read(300_000 + limit), null)
  assert.equal(pool.queries, asked)
  at += 1
  assert.equal(await read(300_000 + limit), null, 'still refused while the minute is used up')
  assert.equal(pool.queries, asked + 1, 'asked again once 30 seconds have passed')
  assert.equal(calls.length, limit, 'and still no extra upstream call')
  assert.equal(logged.length, 1, 'one log line a minute, however many were refused')
  assert.deepEqual(logged[0], ['builder_share_totals_unavailable', { reason: 'budget' }])
})

test('cached totals: with no way to count the budget there is no read; the failure is logged once a minute, never with the credit service\'s text', async () => {
  const { calls, fetchImpl } = counting()
  const broken = { query: async () => { throw Object.assign(new Error('connection refused to db'), { code: 'ECONNREFUSED' }) } }
  const logged = []
  let at = 40_000_000
  const options = { pool: broken, fetchImpl, now: () => at, log: (...line) => logged.push(line) }
  globalThis.__repoingShareTotals.logged.clear()
  assert.equal(await cachedShareTotals(SETTINGS, '310001', options), null)
  assert.equal(await cachedShareTotals(SETTINGS, '310002', options), null)
  assert.equal(calls.length, 0, 'no count, no read')
  assert.deepEqual(logged, [['builder_share_totals_unavailable', { reason: 'budget', code: 'ECONNREFUSED' }]])
  at += 60_000
  assert.equal(await cachedShareTotals(SETTINGS, '310003', options), null)
  assert.equal(logged.length, 2, 'another line a minute later')
  // A clock that went backwards does not silence the log for ever.
  at = 1
  assert.equal(await cachedShareTotals(SETTINGS, '310004', options), null)
  assert.equal(logged.length, 3)

  const fails = []
  globalThis.__repoingShareTotals.logged.clear()
  const failing = async () => ({ ok: false, status: 500, json: async () => ({ error: 'secret internals' }) })
  await assert.rejects(cachedShareTotals(SETTINGS, '310005', { pool: openPool, fetchImpl: failing, now: () => 50_000_000, log: (...line) => fails.push(line) }))
  assert.equal(fails.length, 1)
  assert.equal(fails[0][0], 'builder_share_totals_unavailable')
  assert.equal(fails[0][1].reason, 'read')
  assert.ok(!JSON.stringify(fails).includes('secret internals'))
  assert.equal(logShareProblem('builder_share_totals_unavailable', {}, { log: () => fails.push('again'), now: () => 50_000_001 }), false, 'rate limited')
  assert.throws(() => cachedShareTotals(SETTINGS, '310006', { fetchImpl }), TypeError, 'the budget needs the database')
})

test('cached totals live on globalThis, so the route and the pages (separate module copies) share them', async () => {
  const { calls, fetchImpl } = counting()
  await cachedShareTotals(SETTINGS, '320001', { pool: openPool, fetchImpl })
  assert.ok(globalThis.__repoingShareTotals.cache.has('320001'))
  const copy = await import(`../src/builder-pack-shares.mjs?copy=${Date.now()}`)
  assert.notEqual(copy.cachedShareTotals, cachedShareTotals, 'a second copy of the module')
  assert.deepEqual(await copy.cachedShareTotals(SETTINGS, '320001', { pool: openPool, fetchImpl }), ONE_PACK)
  assert.equal(calls.length, 1, 'the second copy found the first copy\'s entry')
})

test('cached totals: at most 500 repositories; the oldest entry goes first', async () => {
  const { calls, fetchImpl } = counting()
  const read = repoId => cachedShareTotals(SETTINGS, String(repoId), { pool: openPool, fetchImpl, now: () => 20_000_000 })
  for (let id = 100_000; id < 100_500; id++) await read(id)
  assert.equal(calls.length, 500)
  await read(100_499)
  await read(100_000)
  assert.equal(calls.length, 500, 'all 500 are kept')
  await read(200_000)
  assert.equal(calls.length, 501)
  await read(100_001)
  assert.equal(calls.length, 501, 'the second oldest is still kept')
  await read(100_000)
  assert.equal(calls.length, 502, 'the oldest was dropped to make room')
})

test('a claim needs the repository\'s admin session, a live admin check and the payout wallet', async () => {
  const session = { repoId: '1296269', githubUserId: '900', githubLogin: 'holder', permission: 'admin' }
  const holderPool = holder => ({ query: async sql => /repo_beneficiaries/.test(sql) ? { rows: holder ? [{ holder }] : [] } : { rows: [{ ok: true }] } })
  const admin = { verifyCurrentAuthority: async () => ({ githubLogin: 'holder' }) }
  const shares = { secret: 'a'.repeat(40), shareBps: 1000 }
  const base = { settings: SETTINGS, shares, githubVerifier: admin, session, repoId: '1296269', now: () => Date.parse('2026-10-11T12:00:00Z') }
  await assert.rejects(claimPackShares({ ...base, pool: holderPool('900'), session: { ...session, repoId: '42' } }), e => e.status === 403)
  await assert.rejects(claimPackShares({ ...base, pool: holderPool('900'), session: { ...session, permission: 'identity' } }), e => e.status === 403)
  await assert.rejects(claimPackShares({ ...base, pool: holderPool('900'), session: null }), e => e.status === 403)
  await assert.rejects(claimPackShares({ ...base, pool: holderPool('901') }), e => e.status === 403 && /payout wallet/.test(e.message))
  await assert.rejects(claimPackShares({ ...base, pool: holderPool(null) }), e => e.status === 403)
  await assert.rejects(claimPackShares({ ...base, pool: holderPool('900'), githubVerifier: { verifyCurrentAuthority: async () => { throw Error('no') } } }), e => e.status === 403)
})

test('the route: 404 while dark or for a bad repository; POST needs the repository\'s admin session, the same origin and exactly { action: "claim" }', async t => {
  const keys = [...Object.keys(ON), 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'APP_ORIGIN', 'DATABASE_URL']
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key] })
  process.env.GITHUB_APP_CLIENT_SECRET = randomBytes(32).toString('hex')
  process.env.APP_ORIGIN = 'https://repo.ing'
  // A pool that is never connected: every answer below comes before a query.
  process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none'
  const session = encryptGithubSession({ repoId: '1296269', permission: 'admin', githubUserId: '900', githubLogin: 'holder', accessToken: 'ghu_test_only',
    sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 })
  const params = repo => ({ params: Promise.resolve({ repo }) })
  const make = (cookie, { origin = 'https://repo.ing', body = { action: 'claim' }, length } = {}) => ({ url: 'https://repo.ing/api/credits/shares/1296269',
    headers: new Headers({ origin, ...length === undefined ? {} : { 'content-length': length } }), cookies: { get: name => cookie && name.includes('github') ? { value: cookie } : undefined }, json: async () => body })
  const refused = async (request, repo, status, error) => {
    for (const method of ['GET', 'POST']) {
      if (method === 'GET' && status !== 404) continue
      const response = await route[method](request, params(repo))
      assert.deepEqual([response.status, (await response.json()).error], [status, error], `${method} ${repo}`)
      assert.match(response.headers.get('cache-control'), /no-store/)
      assert.equal(response.headers.get('set-cookie'), null)
    }
  }

  // Dark: no switch, packs off, or no database.
  for (const key of Object.keys(ON)) delete process.env[key]
  await refused(make(session), '1296269', 404, 'Not found')
  Object.assign(process.env, ON)
  delete process.env.CREDITS_WEB_BUILDER_SHARES_ENABLED
  await refused(make(session), '1296269', 404, 'Not found')
  Object.assign(process.env, ON, { CREDITS_WEB_PACKS_ENABLED: 'false' })
  await refused(make(session), '1296269', 404, 'Not found')
  Object.assign(process.env, ON)
  const database = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  await refused(make(session), '1296269', 404, 'Not found')
  process.env.DATABASE_URL = database

  // On: a repository is a digits string, before any read.
  for (const bad of ['0', '012', 'abc', '1.5', '-1', '1'.repeat(20), '', undefined]) await refused(make(session), bad, 404, 'Not found')

  // POST: a session, the same origin, and only { action: 'claim' }.
  const invalid = 'Invalid or expired request. Refresh the page and sign in with GitHub again.'
  const post = async request => route.POST(request, params('1296269'))
  for (const request of [make(undefined), make(session, { origin: 'https://evil.invalid' }), make(session, { body: { action: 'claim', repoId: '42' } }),
    make(session, { body: { action: 'drain' } }), make(session, { body: {} }), make(session, { body: null }), make(session, { body: ['claim'] })]) {
    const response = await post(request)
    assert.deepEqual([response.status, (await response.json()).error], [403, invalid])
  }

  // The session is checked first, then the size (the same order as the packs route), both before the body is read.
  for (const [cookie, length] of [[session, '8001'], [session, '1000000'], [undefined, '8001']]) {
    let read = false
    const big = { ...make(cookie, { length }), json: async () => { read = true; return { action: 'claim' } } }
    const response = await post(big)
    assert.deepEqual([response.status, (await response.json()).error, read], [403, invalid, false], `${cookie ? 'session' : 'no session'} ${length}`)
  }

  // A session for another repository is a 403 that says so; any other failure never shows its text.
  process.env.GITHUB_APP_CLIENT_ID = 'Iv1.test'
  const other = await route.POST(make(session), params('42'))
  assert.deepEqual([other.status, (await other.json()).error], [403, 'Sign in with GitHub as an admin of this repository first.'])
  assert.equal(other.headers.get('set-cookie'), null)
  delete process.env.GITHUB_APP_CLIENT_ID
  const broken = await post(make(session))
  assert.deepEqual([broken.status, await broken.json()], [409, { error: 'The claim could not be completed. Try again.' }])

  // A GET is counted before anything is read: with no database to count in, it is not answered, and the server says so once a minute.
  const warned = t.mock.method(console, 'warn', () => {})
  globalThis.__repoingShareTotals.logged.clear()
  for (let i = 0; i < 3; i++) {
    const unavailable = await route.GET(make(session), params('1296269'))
    assert.deepEqual([unavailable.status, await unavailable.json()], [503, { error: 'Share totals are not available right now. Try again in a minute.' }])
  }
  assert.equal(warned.mock.callCount(), 1)
  assert.equal(warned.mock.calls[0].arguments[0], 'builder_share_quota_unavailable')
})

// The repository a buyer picked from a token page is kept 30 days in this browser (app/lib/backed-repo.mjs).
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) } }
test('the repository picked from ?repo= is kept 30 days in this browser; the last pick wins', () => {
  const s = memory(), t = Date.parse('2026-10-11T00:00:00Z')
  captureBackedRepo('?repo=1296269', s, t)
  assert.equal(storedBackedRepo(s, t + BACKED_REPO_TTL_MS - 1), '1296269')
  assert.equal(storedBackedRepo(s, t + BACKED_REPO_TTL_MS), null)
  captureBackedRepo('?repo=42', s, t); assert.equal(storedBackedRepo(s, t), '42')
  captureBackedRepo('?repo=abc', s, t); assert.equal(storedBackedRepo(s, t), '42', 'ignored')
  s.setItem('repoing:backed-repo', '{bad'); assert.equal(storedBackedRepo(s, t), null)
  captureBackedRepo('?repo=7', s, t); clearBackedRepo(s); assert.equal(storedBackedRepo(s, t), null)
})
