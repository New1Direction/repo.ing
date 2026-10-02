import test from 'node:test'
import assert from 'node:assert/strict'
import { NEW_REPO_DAYS, NEW_REPO_MIN_STARS, NEW_REPO_NOTE, PROMOTION_MIN_PERCENT, REPO_SCORE_MAX, featuredMarkets, featuredRacers,
  featuredTicker, hasEarnedPromotion, isNewRepo, repoAgeLabel, repoFactsView, repoScore } from '../app/lib/repo-quality.mjs'
import { OFFICIAL_LAUNCH_LIMIT, isOfficialLaunch, officialLaunches } from '../app/lib/official-launch.mjs'
import { orderMarkets } from '../app/lib/market-order.mjs'
import { LAUNCH_ALERT_DEFAULTS, createLaunchAlerts, launchAlertEarned } from '../src/launch-alerts.mjs'
import { GRADUATED_MILESTONE, MILESTONES } from '../src/milestone-alerts-message.mjs'
import { createDevPulseCollector } from '../src/dev-pulse.mjs'
import { resolvePublicRepositoryById } from '../src/github.mjs'
import { persistLaunchRepository } from '../src/repository-store.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'

const DAY = 86_400_000, HOUR = 3_600_000
const NOW = Date.parse('2026-10-01T12:00:00Z')
const created = days => new Date(NOW - days * DAY)

test('new repo: created less than 30 days ago or under 10 stars; an unknown age leaves it to stars', () => {
  assert.deepEqual([NEW_REPO_DAYS, NEW_REPO_MIN_STARS, PROMOTION_MIN_PERCENT], [30, 10, 10])
  assert.equal(isNewRepo({ stars: 500, githubCreatedAt: created(29.9) }, NOW), true)
  assert.equal(isNewRepo({ stars: 500, githubCreatedAt: created(30) }, NOW), false)
  assert.equal(isNewRepo({ stars: 9, githubCreatedAt: created(3000) }, NOW), true)
  assert.equal(isNewRepo({ stars: 10, githubCreatedAt: created(3000) }, NOW), false)
  assert.equal(isNewRepo({ stars: 10, githubCreatedAt: null }, NOW), false, 'unknown age: stars decide')
  assert.equal(isNewRepo({ stars: 9 }, NOW), true)
  assert.equal(isNewRepo({ stars: 500, githubCreatedAt: created(40).toISOString() }, NOW), false, 'ISO strings (client props) work too')
  assert.equal(isNewRepo({ stars: 500, githubCreatedAt: 'not a date' }, NOW), false)
  assert.equal(isNewRepo({ stars: 500, githubCreatedAt: created(-2) }, NOW), true, 'a future creation time never reads as established')
  for (const stars of [undefined, null, '500', 1.5, Number.NaN]) assert.equal(isNewRepo({ stars, githubCreatedAt: created(400) }, NOW), true, `stars ${stars}`)
  assert.equal(isNewRepo(null, NOW), true)
})

test('promotion: established repos always; new repos at 10% of their graduation target or once graduated', () => {
  const fresh = { stars: 3, githubCreatedAt: created(2) }
  assert.equal(hasEarnedPromotion({ stars: 50, githubCreatedAt: created(90), bondingPercent: 0 }, NOW), true)
  assert.equal(hasEarnedPromotion({ ...fresh, bondingPercent: 9.99 }, NOW), false)
  assert.equal(hasEarnedPromotion({ ...fresh, bondingPercent: 10 }, NOW), true)
  assert.equal(hasEarnedPromotion({ ...fresh, bondingPercent: null, graduated: true }, NOW), true)
  for (const bondingPercent of [null, undefined, Number.NaN, '50']) assert.equal(hasEarnedPromotion({ ...fresh, bondingPercent }, NOW), false)
  // Milestone posts start at 25% (and 100 once graduated), past the promotion bar: a new repository's milestone post is
  // always for a market that earned promotion, so milestone alerts need no filter of their own. This pins that.
  for (const percent of MILESTONES) assert.equal(hasEarnedPromotion({ ...fresh, bondingPercent: percent }, NOW), true, `${percent}%`)
  assert.ok(Math.min(...MILESTONES) >= PROMOTION_MIN_PERCENT)
  assert.equal(GRADUATED_MILESTONE, 100)
})

test('repo score: four capped parts that add up to 0-100', () => {
  assert.deepEqual(REPO_SCORE_MAX, { stars: 40, forks: 15, age: 20, activity: 25 })
  assert.deepEqual(repoScore({ stars: 0, forks: 0 }, null, NOW), { score: 0, parts: { stars: 0, forks: 0, age: 0, activity: 0 } })
  assert.deepEqual(repoScore({ stars: 10_000, forks: 1_000, githubCreatedAt: created(730) }, { devs7d: 3, commits7d: 10 }, NOW).score, 100)
  assert.deepEqual(repoScore({ stars: 250_000, forks: 50_000, githubCreatedAt: created(5000) }, { devs7d: 40, commits7d: 900 }, NOW).score, 100, 'capped')
  const typical = repoScore({ stars: 100, forks: 10, githubCreatedAt: created(365) }, { devs7d: 1, commits7d: 4 }, NOW)
  assert.deepEqual(typical.parts, { stars: 20, forks: 5, age: 10, activity: 9 })
  assert.equal(typical.score, 44)
  assert.equal(repoScore({ stars: 100, forks: 10 }, { devs7d: -2, commits7d: 'x' }, NOW).parts.activity, 0, 'malformed pulse counts nothing')
})

test('repository facts read plainly: age, stars, forks and the score with its parts', () => {
  assert.deepEqual(['less than a day', '1 day', '45 days', '2 months', '23 months', '2 years'].map(String),
    [0.4, 1, 45.9, 61, 729, 800].map(repoAgeLabel))
  assert.equal(repoAgeLabel(null), null)
  const fresh = repoFactsView({ stars: 3, forks: 1, githubCreatedAt: created(12) }, null, NOW)
  assert.deepEqual([fresh.isNew, fresh.tone, fresh.title, fresh.counts, fresh.age], [true, 'warning', 'New repo · 12 days old', '3 stars · 1 fork', '12 days'])
  assert.match(fresh.scoreLabel, /^Repo score \d+\/100$/)
  assert.match(fresh.scoreDetail, /^Stars \d+\/40 · forks \d+\/15 · age \d+\/20 · activity \d+\/25$/)
  const known = repoFactsView({ stars: 1234, forks: 56, githubCreatedAt: created(1200) }, { devs7d: 2, commits7d: 30 }, NOW)
  assert.deepEqual([known.isNew, known.tone, known.title, known.counts], [false, 'neutral', 'Repo 3 years old', '1,234 stars · 56 forks'])
  assert.equal(repoFactsView({ stars: 1, forks: 0 }, null, NOW).title, 'New repo')
  assert.equal(repoFactsView({ stars: 40 }, null, NOW).title, 'Repo age unknown')
  assert.equal(NEW_REPO_NOTE, "New repo — it won't be featured until it reaches 10% of its graduation target.")
})

const row = (id, extra = {}) => ({ repoId: String(id), mint: `mint${id}`, fullName: `o/r${id}`, symbol: `S${id}`, volume24hLamports: '0',
  indexedAt: new Date(NOW - id * HOUR), promoted: true, officialLaunch: false, ...extra })

test('home featured lists keep promoted markets; race rows follow their market row', () => {
  const markets = [row(1), row(2, { promoted: false }), row(3)]
  assert.deepEqual(featuredMarkets(markets).map(m => m.mint), ['mint1', 'mint3'])
  assert.deepEqual(featuredMarkets([{ ...row(4), promoted: undefined }]), [], 'only rows the server marked count')
  assert.deepEqual(featuredRacers([{ mint: 'mint2' }, { mint: 'mint3' }, { mint: 'unknown' }], markets).map(r => r.mint), ['mint3'])
  assert.deepEqual(featuredRacers([{ mint: 'mint1' }], []), [], 'no market rows: nothing is featured')
  const items = ['mint2', 'mint1', 'unlisted', 'mint3', 'mint1'].map((mint, i) => ({ id: String(i), href: `/token/${mint}` }))
  assert.deepEqual(featuredTicker(items, markets).map(item => item.id), ['1', '3', '4'], 'ticker: promoted markets only, order kept')
  assert.deepEqual(featuredTicker(items, markets, 2).map(item => item.id), ['1', '3'])
})

test('Trending puts new repos still under 10% after promoted markets, then orders by 24h volume', () => {
  const markets = [row(1, { volume24hLamports: '900', promoted: false }), row(2, { volume24hLamports: '5' }), row(3, { volume24hLamports: '50' }),
    { ...row(4, { volume24hLamports: '7' }), promoted: undefined }]
  assert.deepEqual(orderMarkets(markets, 'Trending').map(m => m.mint), ['mint3', 'mint4', 'mint2', 'mint1'])
  assert.deepEqual(orderMarkets(markets, 'New').map(m => m.mint), ['mint1', 'mint2', 'mint3', 'mint4'], 'New is unchanged')
})

test('Official: the verified maintainer launched it from their bound payout wallet', () => {
  const market = { wasVerified: true, beneficiaryWallet: 'Wallet1', launcherWallet: 'Wallet1' }
  assert.equal(isOfficialLaunch(market), true)
  assert.equal(isOfficialLaunch({ ...market, launcherWallet: 'Other' }), false)
  assert.equal(isOfficialLaunch({ ...market, wasVerified: false }), false)
  assert.equal(isOfficialLaunch({ ...market, beneficiaryWallet: null, launcherWallet: null }), false)
  assert.equal(isOfficialLaunch(null), false)
  const markets = [row(1, { officialLaunch: true }), row(2, { officialLaunch: true, promoted: false }), row(3), row(4, { officialLaunch: true }),
    row(5, { officialLaunch: true }), row(6, { officialLaunch: true }), row(7, { officialLaunch: true }), row(8, { officialLaunch: true })]
  const strip = officialLaunches(markets, { excluded: new Set(['5']), now: NOW })
  assert.equal(OFFICIAL_LAUNCH_LIMIT, 4)
  assert.deepEqual(strip.map(m => m.mint), ['mint1', 'mint4', 'mint6', 'mint7'], 'newest first, promoted only, never excluded, four at most')
  assert.deepEqual(strip[0], { repoId: '1', mint: 'mint1', fullName: 'o/r1', symbol: 'S1', volume24hLamports: '0', launched: '1h ago' })
  assert.deepEqual(officialLaunches([row(1)], { excluded: new Set(), now: NOW }), [])
  assert.deepEqual(officialLaunches(markets, { now: NOW }), [], 'without the do-not-promote set nothing is shown')
})

// ---------- launch alerts: only markets that earned promotion are announced ----------
const progress = (percent, mint) => {
  const columns = graduationColumns({ mint, reserveLamports: 850_000_000n * BigInt(percent), now: NOW })
  return { graduationStatus: columns.status, observation: columns.observation, graduationError: columns.error_code, migrationEvidenceHash: columns.migration_evidence_hash }
}
const candidate = (id, extra = {}) => ({ githubRepoId: String(id), mint: `Mint${id}`, tokenSymbol: `T${id}`, fullName: `octo/repo-${id}`, description: null,
  stars: 500, githubCreatedAt: created(400), indexedAt: new Date(NOW - HOUR), ...extra })

function alertJob(candidates, config = {}) {
  const sent = [], scans = []
  let id = 0
  const store = { async withLock(fn) { return { locked: true, value: await fn() } }, async expireStale() { return [] }, async sentRecently() { return 0 },
    async candidates({ limit }) { scans.push(limit); return candidates.slice(0, limit) }, async claim() { return String(++id) }, async finish() {} }
  const job = createLaunchAlerts({ store, now: () => NOW, sleep: async () => {},
    senders: { telegram: async ({ text }) => { sent.push(text.match(/octo\/repo-\d+/)[0]); return { status: 'sent', messageId: String(sent.length) } } },
    config: { ...LAUNCH_ALERT_DEFAULTS, channels: ['telegram'], since: new Date(NOW - DAY), origin: 'https://repo.ing', ...config } })
  return { job, sent, scans }
}

test('launch alerts skip new repos until they earn promotion, without starving the run', async () => {
  const markets = [candidate(1, { stars: 2 }), candidate(2, { githubCreatedAt: created(3) }), candidate(3, { stars: 4, ...progress(9, 'Mint3') }),
    candidate(4), candidate(5, { stars: 1, ...progress(12, 'Mint5') }), candidate(6, { stars: 0, githubCreatedAt: created(1) })]
  const { job, sent, scans } = alertJob(markets, { maxPerRun: 2 })
  await job.runOnce()
  assert.deepEqual(sent, ['octo/repo-4', 'octo/repo-5'], 'the held-back new repos never take the run budget')
  assert.ok(scans[0] > 2, 'candidates are read past the run budget')
  assert.equal(launchAlertEarned(candidate(7, { stars: 1, ...progress(9, 'Mint7') }), NOW), false)
  assert.equal(launchAlertEarned(candidate(7, { stars: 1, ...progress(10, 'Mint7') }), NOW), true)
  assert.equal(launchAlertEarned(candidate(7, { stars: 1, ...progress(50, 'Mint7'), observation: '{"stale":true}' }), NOW), false, 'unverifiable progress never counts')
  assert.equal(launchAlertEarned(candidate(7, { stars: 1, migrationEvidenceHash: 'recorded-migration' }), NOW), true, 'a recorded migration counts as graduated')
  const excluded = alertJob([candidate(8), candidate(9)], { excluded: new Set(['8']) })
  await excluded.job.runOnce()
  assert.deepEqual(excluded.sent, ['octo/repo-9'], 'the do-not-promote list still applies')
})

test('launch alerts page past a wave of held-back new repos to the markets that may be announced', async () => {
  const wave = Array.from({ length: 450 }, (_, i) => candidate(100 + i, { stars: 0, githubCreatedAt: created(1) }))
  const markets = [...wave, candidate(1000), candidate(1001)]
  const pages = [], sent = []
  let id = 0
  const store = { async withLock(fn) { return { locked: true, value: await fn() } }, async expireStale() { return [] }, async sentRecently() { return 0 },
    async candidates({ limit, offset }) { pages.push(offset); return markets.slice(offset, offset + limit) }, async claim() { return String(++id) }, async finish() {} }
  const job = createLaunchAlerts({ store, now: () => NOW, sleep: async () => {},
    senders: { telegram: async ({ text }) => { sent.push(text.match(/octo\/repo-\d+/)[0]); return { status: 'sent', messageId: String(sent.length) } } },
    config: { ...LAUNCH_ALERT_DEFAULTS, channels: ['telegram'], since: new Date(NOW - DAY), origin: 'https://repo.ing', maxPerRun: 2 } })
  await job.runOnce()
  assert.deepEqual(sent, ['octo/repo-1000', 'octo/repo-1001'])
  assert.deepEqual(pages, [0, 200, 400], 'reads stop once the run is filled or the candidates run out')
})

// ---------- creation time from GitHub ----------
const github = { id: 42, name: 'repo', full_name: 'owner/repo', owner: { login: 'owner', avatar_url: null }, private: false, visibility: 'public',
  archived: false, updated_at: '2026-09-28T00:00:00Z', created_at: '2026-09-20T08:00:00Z', stargazers_count: 3, forks_count: 1 }
const reply = body => async () => new Response(JSON.stringify(body), { status: 200 })

test('repository lookups keep GitHub creation times and never store a missing one over a known one', async () => {
  assert.equal((await resolvePublicRepositoryById('42', reply(github))).githubCreatedAt.toISOString(), '2026-09-20T08:00:00.000Z')
  for (const value of [undefined, null, 'garbage', 1790000000]) {
    const repo = await resolvePublicRepositoryById('42', reply({ ...github, created_at: value }))
    assert.equal('githubCreatedAt' in repo, false, `created_at ${value} is left out, never epoch or invalid`)
  }
  const queries = []
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] } } }
  await persistLaunchRepository(pool, await resolvePublicRepositoryById('42', reply(github)))
  await persistLaunchRepository(pool, await resolvePublicRepositoryById('42', reply({ ...github, created_at: null })))
  assert.match(queries[0].sql, /github_created_at=coalesce\(excluded\.github_created_at,repositories\.github_created_at\)/)
  assert.equal(queries[0].params.at(-1).toISOString(), '2026-09-20T08:00:00.000Z')
  assert.equal(queries[1].params.at(-1), null)
})

function pulseGithub(repoBody) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {} })
    if (/\/repositories\/42$/.test(url)) return options.headers['If-None-Match'] ? new Response(null, { status: 304 })
      : new Response(JSON.stringify(repoBody), { status: 200, headers: { etag: 'W/"repo2"', 'x-ratelimit-remaining': '4000' } })
    if (/hn\.algolia/.test(url)) return new Response(JSON.stringify({ hits: [] }), { status: 200 })
    return new Response('[]', { status: 200, headers: { 'x-ratelimit-remaining': '4000' } })
  }
  return { fetchImpl, calls }
}
const pulseRow = extra => ({ repoId: '42', fullName: 'owner/repo', knownName: 'owner/repo', defaultBranch: 'main', stars: 3, pushedAt: '2026-09-30T00:00:00Z',
  activityReadFor: '2026-09-30T00:00:00Z', etags: { repo: 'W/"repo1"' }, hnCheckedAt: new Date(NOW).toISOString(), ...extra })

test('Dev Pulse reads a repository once without its validator while the creation time is unknown, and reports it', async () => {
  const body = { ...github, default_branch: 'main', pushed_at: '2026-09-30T00:00:00Z', stargazers_count: 14, forks_count: 2 }
  const saved = []
  const store = rows => ({ async due() { return rows }, async save(repoId, outcome) { saved.push(outcome) }, async fail() {}, async prune() {} })
  const unknown = pulseGithub(body)
  await createDevPulseCollector({ store: store([pulseRow({ needsCreatedAt: true })]), fetchImpl: unknown.fetchImpl, now: () => NOW, headers: async () => ({}) }).runOnce()
  assert.equal(unknown.calls[0].headers['If-None-Match'], undefined, 'no validator, so GitHub answers in full')
  assert.deepEqual(saved[0].repository, { stars: 14, forks: 2, createdAt: '2026-09-20T08:00:00.000Z' })
  assert.equal(saved[0].state.etags.repo, 'W/"repo2"')
  const known = pulseGithub(body)
  await createDevPulseCollector({ store: store([pulseRow({ needsCreatedAt: false })]), fetchImpl: known.fetchImpl, now: () => NOW, headers: async () => ({}) }).runOnce()
  assert.equal(known.calls[0].headers['If-None-Match'], 'W/"repo1"', 'known: the conditional read costs nothing')
  assert.equal(saved[1].repository, null, 'a 304 changes nothing')
})
