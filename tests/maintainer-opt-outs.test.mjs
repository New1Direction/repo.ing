import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createPromotionExclusions, forgetPromotionExclusions, promotionExclusions, OPT_OUTS_RETRY_MS, OPT_OUTS_STALE_MS, OPT_OUTS_TTL_MS } from '../app/lib/promotion-exclusions.mjs'
import { activeDecision, activeDecisions, activeOptOutRepoIds, assertLaunchAllowed, createMaintainerDecisions, decisionNote, DecisionError, OPT_OUT_ERROR } from '../src/maintainer-opt-outs.mjs'
import { createAgentLaunchService } from '../src/agent-launch.mjs'
import { AgentLaunchError } from '../src/agent-launch-draft.mjs'
import { createGitHubAppVerifier } from '../src/github-verification.mjs'
import { createLaunchAlerts, LAUNCH_ALERT_DEFAULTS } from '../src/launch-alerts.mjs'
import { createMilestoneAlerts, MILESTONE_ALERT_DEFAULTS } from '../src/milestone-alerts.mjs'
import { createDevPulseCollector } from '../src/dev-pulse.mjs'

// No database: fakes answer the few SQL statements each path sends. tests/maintainer-opt-outs-db.test.mjs covers the
// real table, its constraints and the create/withdraw authorization.
const DECLINED_AT = new Date('2026-10-01T08:00:00Z')
const decisionRow = repoId => ({ repoId, kind: 'opt_out', note: 'Please do not launch this.', createdAt: DECLINED_AT })
// A pool whose maintainer_opt_outs holds `active` repository ids; other statements go to `other(sql, params)`.
function fakePool(active, other = () => ({ rows: [] })) {
  const statements = []
  return { statements, async query(sql, params = []) {
    statements.push(sql)
    if (/from maintainer_opt_outs/.test(sql)) {
      if (/any\(\$1::bigint\[\]\)/.test(sql)) return { rows: params[0].filter(id => active.includes(id)).map(decisionRow) }
      if (/github_repo_id = \$1/.test(sql)) return { rows: active.includes(params[0]) ? [decisionRow(params[0])] : [] }
      return { rows: active.map(repoId => ({ repoId })) }
    }
    return other(sql, params)
  } }
}

test('the do-not-promote set unions PROMOTION_EXCLUDED_REPO_IDS with active maintainer opt-outs, cached briefly', async () => {
  let clock = 1_000_000, reads = 0, optOuts = ['501']
  const env = { PROMOTION_EXCLUDED_REPO_IDS: ' 7, x,8' }
  const excluded = createPromotionExclusions({ pool: {}, env, now: () => clock, read: async () => { reads++; return optOuts } })
  assert.deepEqual([...await excluded()].sort(), ['501', '7', '8'])
  // Concurrent callers share one read; within the TTL nothing is re-read, but the env list always is.
  await Promise.all([excluded(), excluded()])
  env.PROMOTION_EXCLUDED_REPO_IDS = '9'
  optOuts = ['502']
  assert.deepEqual([...await excluded()].sort(), ['501', '9'])
  assert.equal(reads, 1)
  clock += OPT_OUTS_TTL_MS
  assert.deepEqual([...await excluded()].sort(), ['502', '9'], 'a withdrawn opt-out drops out after the TTL')
  assert.equal(reads, 2)
  // Without a database there are no opt-outs to read.
  assert.deepEqual([...await createPromotionExclusions({ pool: null, env, read: () => assert.fail('no read') })()], ['9'])
})

// console.warn is silenced (and counted) while fn runs.
async function quietly(fn) {
  const warn = console.warn, warnings = []
  console.warn = (...args) => { warnings.push(args) }
  try { await fn(warnings) } finally { console.warn = warn }
}

test('the do-not-promote set fails closed, keeps the last good list through a blip, and backs off after a failure', () => quietly(async warnings => {
  let clock = 0, fail = true, reads = 0
  const read = async () => { reads++; if (fail) throw Object.assign(Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }); return ['501'] }
  const excluded = createPromotionExclusions({ pool: {}, env: {}, now: () => clock, read })
  // No list yet: reject, and do not retry (or log) again until the backoff ends.
  await assert.rejects(excluded(), /opt-outs are unavailable/)
  await assert.rejects(Promise.all([excluded(), excluded()]), /opt-outs are unavailable/)
  assert.deepEqual([reads, warnings.length], [1, 1])
  fail = false
  clock += OPT_OUTS_RETRY_MS
  assert.deepEqual([...await excluded()], ['501'])
  // A blip after a good read keeps serving that list, reading again only once the backoff ends.
  fail = true
  clock += OPT_OUTS_TTL_MS
  assert.deepEqual([...await excluded()], ['501'])
  assert.deepEqual([...await excluded()], ['501'])
  assert.deepEqual([reads, warnings.length], [3, 2])
  clock += OPT_OUTS_RETRY_MS
  assert.deepEqual([...await excluded()], ['501'])
  assert.equal(reads, 4)
  // Past the stale window (measured from the last good read) it rejects again.
  clock += OPT_OUTS_STALE_MS
  await assert.rejects(excluded(), /unavailable/)
  // A malformed result counts as a failed read too.
  const odd = createPromotionExclusions({ pool: {}, env: {}, now: () => clock, read: async () => null })
  await assert.rejects(odd(), /unavailable/)
}))

test('one shared loader per pool; a maintainer decision forces a re-read but keeps the last good list', () => quietly(async () => {
  let down = false
  const pool = { statements: 0, async query() { this.statements++; if (down) throw Error('Connection terminated unexpectedly'); return { rows: [{ repoId: '601' }] } } }
  assert.deepEqual([...await promotionExclusions(pool)], ['601'])
  await promotionExclusions(pool)
  assert.equal(pool.statements, 1, 'cached per pool')
  forgetPromotionExclusions(pool)
  assert.deepEqual([...await promotionExclusions(pool)], ['601'])
  assert.equal(pool.statements, 2, 're-read after a decision')
  down = true
  forgetPromotionExclusions(pool)
  assert.deepEqual([...await promotionExclusions(pool)], ['601'], 'a failed re-read falls back to the last good list')
  await promotionExclusions(pool)
  assert.equal(pool.statements, 3, 'and backs off instead of retrying every call')
  const saved = process.env.PROMOTION_EXCLUDED_REPO_IDS
  process.env.PROMOTION_EXCLUDED_REPO_IDS = '42'
  try { assert.deepEqual([...await promotionExclusions(null)], ['42']) }
  finally { if (saved === undefined) delete process.env.PROMOTION_EXCLUDED_REPO_IDS; else process.env.PROMOTION_EXCLUDED_REPO_IDS = saved }
}))

test('a database without the maintainer_opt_outs table has no decisions; other errors still fail', async () => {
  const failing = code => ({ async query(sql) {
    assert.match(sql, /from maintainer_opt_outs/)
    throw Object.assign(Error(code === '42P01' ? 'relation "maintainer_opt_outs" does not exist' : 'terminating connection due to administrator command'), { code })
  } })
  const missing = failing('42P01')
  assert.deepEqual(await activeOptOutRepoIds(missing), [])
  assert.equal(await activeDecision(missing, '700'), null)
  assert.deepEqual([...(await activeDecisions(missing, ['700', '701'])).keys()], [])
  await assert.doesNotReject(assertLaunchAllowed(missing, '700'))
  assert.deepEqual([...await createPromotionExclusions({ pool: missing, env: { PROMOTION_EXCLUDED_REPO_IDS: '7' } })()], ['7'])
  const down = failing('57P01')
  for (const read of [() => activeOptOutRepoIds(down), () => activeDecision(down, '700'), () => activeDecisions(down, ['700']), () => assertLaunchAllowed(down, '700')]) {
    await assert.rejects(read(), error => error.code === '57P01')
  }
})

test('launches are refused for an opted-out repository', async () => {
  await assert.doesNotReject(assertLaunchAllowed(fakePool([]), '700'))
  await assert.rejects(assertLaunchAllowed(fakePool(['700']), 700), error => error instanceof DecisionError && error.message === OPT_OUT_ERROR &&
    error.status === 403 && error.code === 'MAINTAINER_OPTED_OUT')
  await assert.rejects(assertLaunchAllowed(fakePool([]), '0'), /Invalid repository/)
  // A database error refuses the launch too.
  await assert.rejects(assertLaunchAllowed({ query: async () => { throw Error('connection refused') } }, '700'), /connection refused/)
})

// Route tests share one environment: a fake pool behind database() and a fake GitHub behind fetch.
async function withRoute(pool, run) {
  const saved = { db: process.env.DATABASE_URL, config: process.env.DBC_CONFIG, creator: process.env.PLATFORM_CREATOR_SECRET_KEY }
  const savedPool = globalThis.__gitfunPool, savedFetch = globalThis.fetch
  process.env.DATABASE_URL = 'postgres://test-only'
  process.env.DBC_CONFIG = Keypair.generate().publicKey.toBase58()
  process.env.PLATFORM_CREATOR_SECRET_KEY = JSON.stringify([...Keypair.generate().secretKey])
  globalThis.__gitfunPool = pool
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://api.github.com/repos/octo/declined', 'only the public repository lookup')
    return Response.json({ id: 700, full_name: 'octo/declined', name: 'declined', owner: { login: 'octo' }, private: false, archived: false, updated_at: '2026-09-30T00:00:00Z' })
  }
  try { return await run() } finally {
    globalThis.__gitfunPool = savedPool
    globalThis.fetch = savedFetch
    for (const [name, value] of [['DATABASE_URL', saved.db], ['DBC_CONFIG', saved.config], ['PLATFORM_CREATOR_SECRET_KEY', saved.creator]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
}

test('/api/resolve refuses an opted-out repository without a market and still opens markets', async () => {
  const { POST } = await import('../app/api/resolve/route.js')
  const resolve = () => POST(new Request('https://repo.ing/api/resolve', { method: 'POST', body: JSON.stringify({ url: 'github.com/octo/declined' }) }))
  const refused = await withRoute(fakePool(['700']), resolve)
  assert.equal(refused.status, 403)
  assert.deepEqual(await refused.json(), { error: OPT_OUT_ERROR, code: 'MAINTAINER_OPTED_OUT' })
  const allowed = await withRoute(fakePool([]), resolve)
  assert.deepEqual([allowed.status, await allowed.json()], [200, { repoId: '700', mint: null }])
  // A declined repository's existing market still opens: holders must be able to reach it.
  const withMarket = fakePool(['700'], sql => ({ rows: /select mint from markets/.test(sql) ? [{ mint: 'DeclinedMint111111111111111111111111111111' }] : [] }))
  const market = await withRoute(withMarket, resolve)
  assert.deepEqual(await market.json(), { repoId: '700', mint: 'DeclinedMint111111111111111111111111111111' })
})

test('/api/launch prepare refuses an opted-out repository before anything is reserved', async () => {
  const { POST } = await import('../app/api/launch/route.js')
  const pool = fakePool(['700'], sql => assert.fail(`no other statement: ${sql}`))
  const response = await withRoute(pool, () => POST(new Request('https://repo.ing/api/launch', { method: 'POST', body: JSON.stringify({
    action: 'prepare', repoId: '700', repositoryUrl: 'https://github.com/octo/declined', tokenImage: 'data:image/png;base64,AAAA',
    tokenName: 'Declined', tokenSymbol: 'NOPE', launcherWallet: Keypair.generate().publicKey.toBase58() }) })))
  const body = await response.json()
  assert.equal(response.status, 400)
  assert.equal(body.error, OPT_OUT_ERROR)
  assert.deepEqual(pool.statements.filter(sql => !/maintainer_opt_outs/.test(sql)), [])
})

test('Dev Pulse is hidden for a declined market and unavailable, never cached, while the decision cannot be read', async () => {
  const { GET } = await import('../app/api/market/[mint]/pulse/route.js')
  const mint = Keypair.generate().publicKey.toBase58()
  const market = { repoId: '700', mint, pool: 'Pool700', tokenName: 'Declined', symbol: 'NOPE', indexedAt: new Date(), allocationVersion: null,
    discoveryVersion: null, launcherWallet: 'w', owner: 'octo', name: 'declined', fullName: 'octo/declined', description: null, avatarUrl: null,
    stars: 1, forks: 0, updatedAt: new Date(), beneficiaryWallet: null, beneficiaryBoundAt: null, earned: '0', claimed: '0',
    volume24hLamports: '0', wasVerified: false, lastSqrtPrice: null, graduationStatus: null, observation: null, graduationError: null, migrationEvidenceHash: null }
  // decisions: what reading maintainer_opt_outs does; the market row and empty Dev Pulse tables answer everything else.
  const poolWith = decisions => ({ async query(sql, params) {
    if (/from markets m join repositories r/.test(sql)) return { rows: [market] }
    if (/maintainer_opt_outs/.test(sql)) return decisions(params)
    return { rows: [] }
  } })
  const pulse = async decisions => {
    const response = await withRoute(poolWith(decisions), () => GET(new Request(`https://repo.ing/api/market/${mint}/pulse`), { params: Promise.resolve({ mint }) }))
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() }
  }
  const error = console.error
  console.error = () => {}
  try {
    const unreadable = await pulse(() => { throw Error('Connection terminated unexpectedly') })
    assert.deepEqual(unreadable, { status: 503, cache: 'no-store', body: { error: 'Dev Pulse unavailable' } })
  } finally { console.error = error }
  const declined = await pulse(() => ({ rows: [decisionRow('700')] }))
  assert.deepEqual([declined.status, declined.body], [200, { status: 'hidden' }])
  assert.notEqual(declined.cache, 'no-store')
  const migrationPending = await pulse(() => { throw Object.assign(Error('relation "maintainer_opt_outs" does not exist'), { code: '42P01' }) })
  assert.deepEqual([migrationPending.status, migrationPending.body.status], [200, 'pending'], 'a missing table holds no decline')
})

test('agent drafts refuse an opted-out repository and report it from resolve_repo', async () => {
  const repo = { githubRepoId: 700n, owner: 'octo', name: 'declined', fullName: 'octo/declined', stars: 1, forks: 0, archived: false, githubUpdatedAt: new Date() }
  const service = active => createAgentLaunchService({ pool: fakePool(active), origin: 'https://repo.ing', secret: 'test-only-agent-draft-secret-at-least-32-bytes',
    config: '1'.repeat(32), discovery: false, allocation: false, candidates: async () => [], resolve: async () => repo })
  await assert.rejects(service(['700']).createDraft({ repository: 'octo/declined' }), error => error instanceof AgentLaunchError && error.message === OPT_OUT_ERROR)
  assert.equal((await service(['700']).resolveRepo({ repository: 'octo/declined' })).maintainerOptedOut, true)
  const draft = await service([]).createDraft({ repository: 'octo/declined' })
  assert.equal(draft.draftCreated, true)
  assert.equal(draft.maintainerOptedOut, false)
})

test('the public note is optional plain text: no HTML, links only to github.com, 280 characters', () => {
  for (const blank of [undefined, null, '', '   \n ']) assert.equal(decisionNote(blank), null)
  assert.equal(decisionNote('  We  never launched\na token.  '), 'We never launched a token.')
  assert.equal(decisionNote('Context: github.com/octo/repo/issues/1'), 'Context: github.com/octo/repo/issues/1')
  for (const [note, message] of [['<b>no</b>', /plain text/], ['Buy the real one at scam.xyz', /Links are not allowed/],
    ['x'.repeat(281), /280/], [42, /./]]) assert.throws(() => decisionNote(note), error => error instanceof DecisionError && message.test(error.message))
  assert.equal(decisionNote('é'.repeat(280)).length, 280)
})

test('decisions need a fresh admin check, match the market state the maintainer saw, and never trust the client', async () => {
  const live = new Set(['800'])
  const pool = { async query(sql, params) {
    if (/from markets/.test(sql)) return { rows: live.has(params[0]) ? [{}] : [] }
    assert.fail(`unexpected write: ${sql}`)
  } }
  const checks = []
  const decisions = createMaintainerDecisions({ pool, verifyAdmin: async request => { checks.push(request); throw Error('Current GitHub admin permission required') } })
  const warn = console.warn
  console.warn = () => {}
  try {
    await assert.rejects(decisions.create({ repoId: '800', kind: 'decline' }), error => error.status === 403 && /current GitHub admin/.test(error.message))
    await assert.rejects(decisions.withdraw({ repoId: '801' }), error => error.status === 403)
  } finally { console.warn = warn }
  assert.deepEqual(checks, [{ githubRepoId: '800', live: true }, { githubRepoId: '801', live: false }])
  const admin = createMaintainerDecisions({ pool, verifyAdmin: async () => ({ githubUserId: 42n }) })
  await assert.rejects(admin.create({ repoId: '800', kind: 'opt_out' }), error => error.status === 409 && /has a market/.test(error.message))
  await assert.rejects(admin.create({ repoId: '801', kind: 'decline' }), error => error.status === 409 && /no market/.test(error.message))
  await assert.rejects(admin.create({ repoId: '801', kind: 'delete' }), /decline the market or opt out/)
  await assert.rejects(admin.create({ repoId: '801;drop', kind: 'opt_out' }), /Invalid repository/)
  await assert.rejects(admin.create({ repoId: '801', kind: 'opt_out', note: '<script>' }), /plain text/)
  const anonymous = createMaintainerDecisions({ pool, verifyAdmin: async () => ({ githubUserId: '' }) })
  await assert.rejects(anonymous.create({ repoId: '801', kind: 'opt_out' }), error => error.status === 403)
})

const github = routes => async (url, options) => {
  const path = new URL(url).pathname + new URL(url).search
  assert.equal(options.headers.Authorization, 'Bearer ghu_fixture')
  for (const [pattern, status, body] of routes) if (pattern.test(path)) return { ok: status === 200, status, json: async () => body }
  throw Error(`Unexpected GitHub request ${path}`)
}
const verifierFor = fetchImpl => createGitHubAppVerifier({ pool: {}, clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'http://localhost/callback', fetchImpl })

test('repositories without a market get the same fresh admin check, with no verification record', async () => {
  const routes = permission => [[/^\/user$/, 200, { id: 42, login: 'maint' }],
    [/^\/repositories\/900$/, 200, { id: 900, owner: { login: 'octo' }, name: 'fresh', private: false, archived: false }],
    [/^\/repos\/octo\/fresh\/collaborators\/maint\/permission$/, permission ? 200 : 404, { permission, user: { id: 42, login: 'maint' } }]]
  // pool {} would throw on any database use: no market lookup, no repo_verifications row.
  const admin = await verifierFor(github(routes('admin'))).verifyRepositoryAdmin({ githubRepoId: '900', accessToken: 'ghu_fixture', expectedGithubUserId: '42' })
  assert.deepEqual([admin.admin, admin.githubUserId, admin.githubLogin], [true, 42n, 'maint'])
  assert.equal((await verifierFor(github(routes('write'))).verifyRepositoryAdmin({ githubRepoId: '900', accessToken: 'ghu_fixture', expectedGithubUserId: '42' })).admin, false)
  assert.equal((await verifierFor(github(routes(null))).verifyRepositoryAdmin({ githubRepoId: '900', accessToken: 'ghu_fixture', expectedGithubUserId: '42' })).admin, false)
  await assert.rejects(verifierFor(github(routes('admin'))).verifyRepositoryAdmin({ githubRepoId: '900', accessToken: 'ghu_fixture', expectedGithubUserId: '7' }), /identity changed/)
  await assert.rejects(verifierFor(github(routes('admin'))).verifyRepositoryAdmin({ githubRepoId: '900', accessToken: 'gho_classic', expectedGithubUserId: '42' }), /GitHub App user session/)
  const listed = await verifierFor(github([[/^\/user$/, 200, { id: 42, login: 'maint' }], [/^\/user\/repos\?/, 200, [
    { id: 900, full_name: 'octo/fresh', private: false, archived: false, permissions: { admin: true } },
    { id: 901, full_name: 'evil.com/../x', private: false, archived: false, permissions: { admin: true } },
    { id: 902, full_name: 'octo/push-only', private: false, archived: false, permissions: { push: true } }]]])).listAdminRepositories({ accessToken: 'ghu_fixture', expectedGithubUserId: '42' })
  assert.deepEqual(listed, [{ repoId: '900', fullName: 'octo/fresh' }, { repoId: '901', fullName: null }])
})

test('worker jobs read the do-not-promote set every run and do nothing when it cannot be read', async () => {
  const SINCE = new Date('2026-10-01T00:00:00Z'), NOW = Date.parse('2026-10-02T00:00:00Z')
  // Established repositories (500 stars), so only the do-not-promote set decides here, not the new-repo gate.
  const market = id => ({ githubRepoId: id, mint: `Mint${id}`, tokenSymbol: 'R', fullName: `octo/repo-${id}`, description: null, stars: 500, indexedAt: new Date(NOW - 3600_000) })
  const launchStore = { withLock: async fn => ({ locked: true, value: await fn() }), expireStale: async () => [], sentRecently: async () => 0,
    candidates: async () => [market('3'), market('4')], claim: async ({ market: m }) => m.githubRepoId, finish: async () => {} }
  const sent = []
  const senders = { telegram: async ({ text }) => { sent.push(text.match(/octo\/repo-(\d+)/)[1]); return { status: 'sent', messageId: '1' } } }
  const launchConfig = { ...LAUNCH_ALERT_DEFAULTS, channels: ['telegram'], since: SINCE, origin: 'https://repo.ing', excluded: new Set() }
  await createLaunchAlerts({ store: launchStore, config: launchConfig, senders, now: () => NOW, sleep: async () => {}, excluded: async () => new Set(['3']) }).runOnce()
  assert.deepEqual(sent, ['4'], 'a maintainer opt-out is never announced')
  const unreadable = async () => { throw Error('Maintainer opt-outs are unavailable') }
  await assert.rejects(createLaunchAlerts({ store: launchStore, config: launchConfig, senders, now: () => NOW, excluded: unreadable }).runOnce(), /unavailable/)
  assert.deepEqual(sent, ['4'], 'nothing posted without the list')

  const forgotten = []
  const milestoneStore = { withLock: async fn => ({ locked: true, value: await fn() }), expireStale: async () => [], forgetMarks: async ids => { forgotten.push(ids) },
    progressRows: async () => [], channelState: async () => ({ marks: new Map(), alerts: new Map() }), mark: async () => {}, sentRecently: async () => 0 }
  const milestoneConfig = { ...MILESTONE_ALERT_DEFAULTS, channels: ['telegram'], since: SINCE, origin: 'https://repo.ing', excluded: new Set(['5']) }
  await createMilestoneAlerts({ store: milestoneStore, config: milestoneConfig, senders, now: () => NOW, excluded: async () => new Set(['5', '501']) }).runOnce()
  assert.deepEqual(forgotten, [['5', '501']], 'declined repositories keep no milestone marks')
  await createMilestoneAlerts({ store: milestoneStore, config: milestoneConfig, senders, now: () => NOW }).runOnce()
  assert.deepEqual(forgotten.at(-1), ['5'], 'defaults to the env list in the config')
  await assert.rejects(createMilestoneAlerts({ store: milestoneStore, config: milestoneConfig, senders, now: () => NOW, excluded: unreadable }).runOnce(), /unavailable/)

  const asked = []
  const pulseStore = { due: async (limit, excluded) => { asked.push([...excluded]); return [] }, prune: async () => {} }
  await createDevPulseCollector({ store: pulseStore, now: () => NOW, headers: async () => ({}), excluded: async () => new Set(['501']) }).runOnce()
  assert.deepEqual(asked, [['501']])
  await assert.rejects(createDevPulseCollector({ store: pulseStore, now: () => NOW, headers: async () => ({}), excluded: unreadable }).runOnce(), /unavailable/)
  assert.equal(asked.length, 1, 'no repository is read without the list')
})
