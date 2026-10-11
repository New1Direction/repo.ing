import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import { BUILDER_SHARE_BPS, builderShareTarget, builderSharesSettings, cachedShareTotals, claimPackShares, readShareTotals, shareMicro } from '../src/builder-pack-shares.mjs'

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

// A cached read asks the credit service once a minute per repository. The cache is shared by the whole process, so each case uses its own repository ids.
const totalsAnswer = id => ({ repo_id: String(id), packs: 1, paid_micro: 1_000_000, claimed_micro: 0 })
const counting = () => {
  const calls = []
  return { calls, fetchImpl: async address => { calls.push(address); return { ok: true, status: 200, json: async () => totalsAnswer(address.split('/').pop()) } } }
}
const ONE_PACK = { packs: 1, paidMicro: '1000000', claimedMicro: '0', unclaimedMicro: '1000000' }

test('cached totals: one read per repository within 60 seconds, another after', async () => {
  const { calls, fetchImpl } = counting()
  let at = 5_000_000
  const read = repoId => cachedShareTotals(SETTINGS, repoId, { fetchImpl, now: () => at })
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

test('cached totals: a failed read is not kept, and callers waiting on the same read share it', async () => {
  let fail = true
  const calls = []
  const fetchImpl = async address => { calls.push(address); if (fail) throw new TypeError('fetch failed'); return { ok: true, status: 200, json: async () => totalsAnswer(7003) } }
  const read = () => cachedShareTotals(SETTINGS, '7003', { fetchImpl, now: () => 9_000_000 })
  await assert.rejects(read(), error => error.status === 503)
  await assert.rejects(read(), error => error.status === 503)
  assert.equal(calls.length, 2, 'every failure is asked for again')
  fail = false
  assert.deepEqual(await read(), ONE_PACK)
  assert.equal(calls.length, 3)

  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = []
  const slowFetch = async address => { slow.push(address); await gate; return { ok: true, status: 200, json: async () => totalsAnswer(7004) } }
  const pending = [cachedShareTotals(SETTINGS, '7004', { fetchImpl: slowFetch }), cachedShareTotals(SETTINGS, '7004', { fetchImpl: slowFetch })]
  release()
  assert.deepEqual(await Promise.all(pending), [ONE_PACK, ONE_PACK])
  assert.equal(slow.length, 1, 'concurrent callers share one request')

  const lost = []
  const refusing = async address => { lost.push(address); await Promise.resolve(); throw new TypeError('fetch failed') }
  const both = await Promise.allSettled([cachedShareTotals(SETTINGS, '7005', { fetchImpl: refusing }), cachedShareTotals(SETTINGS, '7005', { fetchImpl: refusing })])
  assert.deepEqual(both.map(result => result.status), ['rejected', 'rejected'])
  assert.equal(lost.length, 1)
  await assert.rejects(cachedShareTotals(SETTINGS, '7005', { fetchImpl: refusing }))
  assert.equal(lost.length, 2, 'a shared failure is not kept either')
})

test('cached totals: at most 500 repositories; the oldest entry goes first', async () => {
  const { calls, fetchImpl } = counting()
  const read = repoId => cachedShareTotals(SETTINGS, String(repoId), { fetchImpl, now: () => 20_000_000 })
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
  const make = (cookie, { origin = 'https://repo.ing', body = { action: 'claim' } } = {}) => ({ url: 'https://repo.ing/api/credits/shares/1296269',
    headers: new Headers({ origin }), cookies: { get: name => cookie && name.includes('github') ? { value: cookie } : undefined }, json: async () => body })
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

  // A session for another repository is a 403 that says so; any other failure never shows its text.
  process.env.GITHUB_APP_CLIENT_ID = 'Iv1.test'
  const other = await route.POST(make(session), params('42'))
  assert.deepEqual([other.status, (await other.json()).error], [403, 'Sign in with GitHub as an admin of this repository first.'])
  assert.equal(other.headers.get('set-cookie'), null)
  delete process.env.GITHUB_APP_CLIENT_ID
  const broken = await post(make(session))
  assert.deepEqual([broken.status, await broken.json()], [409, { error: 'The claim could not be completed. Try again.' }])
})
