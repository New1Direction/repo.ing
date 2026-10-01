import test from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCHABLE_TRENDS_SQL, freshLaunchable, launchExclusion, launcherRewardTerms, readLaunchableTrends, searchListCandidates,
  selectLaunchableTrends } from '../src/trend-launchable.mjs'
import { createTrendSources } from '../src/trend-sources.mjs'
import { promotionExcludedRepoIds } from '../app/lib/promotion-exclusions.mjs'
import { ageLabel, compactCount, rewardLimits, rewardShort, starGrowth, trendSignals } from '../app/lib/trend-launch-display.mjs'

const now = Date.parse('2026-09-30T12:00:00Z'), HOUR = 3600000, DAY = 24 * HOUR
const iso = time => new Date(time).toISOString()
const CONFIG = 'DbcConfig1111111111111111111111111111111111'

const observation = (stars, ageHours, { forks = 10, releaseAt = null, repo = {} } = {}) => JSON.stringify({
  repo: { id: '101', fullName: 'acme/rocket', description: 'A fast rocket', stars, forks, language: 'Rust',
    avatarUrl: 'https://avatars.githubusercontent.com/u/9?v=4', ...repo },
  observedAt: iso(now - ageHours * HOUR), stars, forks, releaseAt, activity: { complete: false }, sources: {} })
const signal = (source, url, { occurred = now - HOUR, expires = now + 5 * HOUR } = {}) => ({ source, url, occurredAt: iso(occurred), expiresAt: iso(expires) })
// A row as LAUNCHABLE_TRENDS_SQL returns it: fresh, unlaunched, +120 stars over the 4h between two observations.
const row = (overrides = {}) => ({ repoId: '101', fullName: 'acme/rocket', description: 'A fast rocket', state: 'detected',
  observedAt: new Date(now - HOUR), error: null, approvedConfig: null, storedAvatarUrl: null, archived: null, marketStatus: null,
  participationEnabled: null, invitesDismissedAt: null, observations: [observation(1120, 1), observation(1000, 5)], signals: [], ...overrides })
const ids = items => items.map(item => item.repoId)

test('lists a fresh, unlaunched trend with its measured evidence and a direct launch link', () => {
  assert.deepEqual(selectLaunchableTrends([row()], { now }), [{ repoId: '101', fullName: 'acme/rocket', owner: 'acme', name: 'rocket',
    description: 'A fast rocket', avatarUrl: 'https://avatars.githubusercontent.com/u/9?v=4', language: 'Rust', stars: 1120,
    starsGained: { delta: 120, hours: 4, perDay: 720 }, onGithubTrending: false, hnStories: 0, releasedAt: null,
    observedAt: iso(now - HOUR), score: 25, reviewed: false, launchHref: '/launch/101' }])
})

test('never suggests a repo with a market, an archived or opted-out repo, or one the pipeline set aside', () => {
  const excluded = [
    [{ state: 'duplicate' }, 'NOT_LAUNCHABLE_STATE'], [{ state: 'rejected' }, 'NOT_LAUNCHABLE_STATE'],
    [{ state: 'launched' }, 'NOT_LAUNCHABLE_STATE'], [{ state: 'active' }, 'NOT_LAUNCHABLE_STATE'],
    [{ marketStatus: 'confirmed' }, 'MARKET_EXISTS'], [{ marketStatus: 'reserved' }, 'MARKET_EXISTS'],
    [{ marketStatus: 'prepared' }, 'MARKET_EXISTS'], [{ marketStatus: 'submitted' }, 'MARKET_EXISTS'], [{ marketStatus: 'ambiguous' }, 'MARKET_EXISTS'],
    [{ archived: true }, 'ARCHIVED'],
    [{ participationEnabled: false }, 'MAINTAINER_OPTED_OUT'],
    [{ invitesDismissedAt: new Date(now - DAY) }, 'MAINTAINER_DECLINED_CONTACT'],
    // The latest refresh failed identity checks (archived, private, renamed) or the evidence is old or from the future.
    [{ error: 'REPO_NOT_VERIFIED' }, 'STALE_OR_UNVERIFIED'], [{ observedAt: new Date(now - 7 * HOUR) }, 'STALE_OR_UNVERIFIED'],
    [{ observedAt: iso(now + 5 * 60000) }, 'STALE_OR_UNVERIFIED'], [{ observedAt: null }, 'STALE_OR_UNVERIFIED'],
    [{ repoId: '0' }, 'INVALID_REPOSITORY'], [{ repoId: '12a' }, 'INVALID_REPOSITORY'],
    [{ fullName: 'acme/rocket/extra' }, 'INVALID_REPOSITORY'], [{ fullName: '<b>/x' }, 'INVALID_REPOSITORY'],
  ]
  for (const [overrides, code] of excluded) {
    assert.equal(launchExclusion(row(overrides), now), code, JSON.stringify(overrides))
    assert.deepEqual(selectLaunchableTrends([row(overrides)], { now }), [], JSON.stringify(overrides))
  }
  // A failed launch released the repository; an opt-in or a never-asked maintainer does not block a launch.
  for (const overrides of [{ marketStatus: 'failed' }, { participationEnabled: true }, { archived: false }, { state: 'reviewed' }, { state: 'approved' }]) {
    assert.equal(launchExclusion(row(overrides), now), null, JSON.stringify(overrides))
    assert.equal(selectLaunchableTrends([row(overrides)], { now }).length, 1, JSON.stringify(overrides))
  }
})

test('only measured attention counts as trending; manual operator evidence is never used or shown', () => {
  const single = { observations: [observation(500, 1)] }
  assert.deepEqual(selectLaunchableTrends([row(single)], { now }), [], 'one observation and no signal: still warming up')
  assert.deepEqual(selectLaunchableTrends([row({ ...single, signals: [signal('manual', 'https://x.com/a/status/1')] })], { now }), [])
  assert.deepEqual(selectLaunchableTrends([row({ ...single, signals: [signal('github_trending', 'https://github.com/trending', { expires: now - 1 })] })], { now }), [])
  assert.deepEqual(selectLaunchableTrends([row({ observations: [observation(900, 1), observation(1000, 5)] })], { now }), [], 'losing stars is not growth')

  const [trending] = selectLaunchableTrends([row({ ...single, signals: [signal('github_trending', 'https://github.com/trending')] })], { now })
  assert.equal(trending.onGithubTrending, true)
  assert.equal(trending.starsGained, null)
  assert.equal(trending.score, 10)
  const [discussed] = selectLaunchableTrends([row({ ...single, signals: [signal('hn', 'https://news.ycombinator.com/item?id=1'),
    signal('hn', 'https://news.ycombinator.com/item?id=1'), signal('hn', 'https://news.ycombinator.com/item?id=2')] })], { now })
  assert.equal(discussed.hnStories, 2, 'one story per Hacker News item')
  const [released] = selectLaunchableTrends([row({ observations: [observation(500, 1, { releaseAt: iso(now - 2 * DAY) })] })], { now })
  assert.equal(released.releasedAt, iso(now - 2 * DAY))
  assert.deepEqual(selectLaunchableTrends([row({ observations: [observation(500, 1, { releaseAt: iso(now - 8 * DAY) })] })], { now }), [])

  const [parsed] = selectLaunchableTrends([row({ observations: ['{broken', observation(1120, 1), null, observation(1000, 5)] })], { now })
  assert.equal(parsed.starsGained.delta, 120, 'unreadable evidence rows are skipped, not fatal')
  assert.deepEqual(selectLaunchableTrends([row({ observations: [] })], { now }), [])
})

test('orders reviewed launches first, then trend score, star velocity, stars and repository id', () => {
  const trendingOnly = (repoId, stars) => row({ repoId, fullName: `acme/r${repoId}`, signals: [signal('github_trending', 'https://github.com/trending')],
    observations: [observation(stars, 1)] })
  const rows = [
    trendingOnly('3', 400), trendingOnly('20', 400), trendingOnly('9', 5000),
    row({ repoId: '7', fullName: 'acme/slower', observations: [observation(1050, 1), observation(1000, 5)] }), // +50 in 4h: 300/day, 25 points
    row({ repoId: '8', fullName: 'acme/faster' }), // +120 in 4h: 720/day, 25 points
    row({ repoId: '5', fullName: 'acme/reviewed', state: 'approved', approvedConfig: CONFIG, observations: [observation(10, 1)],
      signals: [signal('github_trending', 'https://github.com/trending')] }),
  ]
  const items = selectLaunchableTrends(rows, { now, config: CONFIG, discoveryEnabled: true })
  assert.deepEqual(ids(items), ['5', '8', '7', '9', '3', '20'])
  assert.deepEqual(ids(selectLaunchableTrends(rows.toReversed(), { now, config: CONFIG, discoveryEnabled: true })), ids(items), 'input order does not matter')
  assert.deepEqual(ids(selectLaunchableTrends(rows, { now, config: CONFIG, discoveryEnabled: true, limit: 2 })), ['5', '8'])
  const many = Array.from({ length: 30 }, (_, index) => row({ repoId: String(30 - index), fullName: `acme/r${index}` }))
  assert.deepEqual(ids(selectLaunchableTrends(many, { now })), Array.from({ length: 30 }, (_, index) => String(index + 1)), 'whole list, ties by numeric id')
})

test('the do-not-promote list keeps a repo out of the launch list, whatever its trend evidence', () => {
  const promotionExcluded = promotionExcludedRepoIds({ PROMOTION_EXCLUDED_REPO_IDS: ' 101, 9,abc' })
  assert.equal(launchExclusion(row(), now, { promotionExcluded }), 'DO_NOT_PROMOTE')
  assert.equal(launchExclusion(row({ state: 'approved', approvedConfig: CONFIG }), now, { promotionExcluded }), 'DO_NOT_PROMOTE')
  assert.deepEqual(ids(selectLaunchableTrends([row(), row({ repoId: '102', fullName: 'acme/other' })], { now, promotionExcluded })), ['102'])
  assert.deepEqual(ids(selectLaunchableTrends([row()], { now, promotionExcluded: promotionExcludedRepoIds({}) })), ['101'], 'empty list excludes nothing')
})

test('the search list drops do-not-promote repos and offers Launch only where the launch policy allows it', () => {
  const launchable = selectLaunchableTrends([row(), row({ repoId: '102', participationEnabled: false })], { now })
  const candidates = [{ repoId: '101', marketState: 'unlaunched' }, { repoId: '102', marketState: 'unlaunched' },
    { repoId: '103', marketState: 'live' }, { repoId: '104', marketState: 'live' }]
  assert.deepEqual(searchListCandidates(candidates, launchable, promotionExcludedRepoIds({ PROMOTION_EXCLUDED_REPO_IDS: '104' })), [
    { repoId: '101', marketState: 'unlaunched', launchable: true }, { repoId: '102', marketState: 'unlaunched', launchable: false },
    { repoId: '103', marketState: 'live', launchable: false }])
  assert.equal(candidates[0].launchable, undefined, 'inputs are not mutated')
  assert.deepEqual(searchListCandidates(candidates, []).map(c => c.launchable), [false, false, false, false], 'unavailable list: no Launch buttons')
})

test('operator-approved trends keep the attributed launch path only while the approval still applies', () => {
  const approved = row({ state: 'approved', approvedConfig: CONFIG })
  const [reviewed] = selectLaunchableTrends([approved], { now, config: CONFIG, discoveryEnabled: true })
  assert.equal(reviewed.reviewed, true)
  assert.equal(reviewed.launchHref, '/launch/101?from=trend')
  for (const options of [{ config: CONFIG, discoveryEnabled: false }, { config: 'OtherConfig', discoveryEnabled: true }, { config: null, discoveryEnabled: true }]) {
    const [item] = selectLaunchableTrends([approved], { now, ...options })
    assert.equal(item.launchHref, '/launch/101', JSON.stringify(options))
  }
  const [detected] = selectLaunchableTrends([row({ approvedConfig: CONFIG })], { now, config: CONFIG, discoveryEnabled: true })
  assert.equal(detected.launchHref, '/launch/101')
})

test('avatar and language come from stored evidence; unsafe or malformed values are dropped', () => {
  const pick = overrides => selectLaunchableTrends([row(overrides)], { now })[0]
  const unsafe = { observations: [observation(1120, 1, { repo: { avatarUrl: 'https://evil.example/a.png', language: 'x'.repeat(41) } }), observation(1000, 5)] }
  assert.equal(pick({ ...unsafe, storedAvatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4' }).avatarUrl, 'https://avatars.githubusercontent.com/u/7?v=4')
  assert.equal(pick(unsafe).avatarUrl, 'https://avatars.githubusercontent.com/acme', 'falls back to the owner avatar, no API call')
  assert.equal(pick(unsafe).language, null)
  assert.equal(pick({ observations: [observation(1120, 1, { repo: { language: '  Go ' } }), observation(1000, 5)] }).language, 'Go')
  assert.equal(pick({ observations: [observation(1120, 1, { repo: { language: 7, avatarUrl: undefined } }), observation(1000, 5)] }).language, null)
  assert.equal(pick({ description: '   ' }).description, null)
})

test('a cached list drops entries that pass the freshness window', () => {
  const items = [{ observedAt: iso(now - 5 * HOUR) }, { observedAt: iso(now - 7 * HOUR) }, { observedAt: iso(now + 5 * 60000) }]
  assert.deepEqual(freshLaunchable(items, now), [items[0]])
})

test('one bounded read: freshness window, observation lookback and launchable states are parameters', async () => {
  const calls = []
  const pool = { query: async config => { calls.push(config); return { rows: [row(), row({ repoId: '102', marketStatus: 'confirmed' })] } } }
  const items = await readLaunchableTrends(pool, { now })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, LAUNCHABLE_TRENDS_SQL)
  assert.deepEqual(calls[0].values, [new Date(now), new Date(now - 6 * HOUR), 24, ['detected', 'reviewed', 'approved']])
  assert.equal(calls[0].query_timeout, 5000)
  assert.deepEqual(ids(items), ['101'])
  // Public output never carries operator notes or manual evidence.
  assert.match(LAUNCHABLE_TRENDS_SQL, /source <> 'manual'/)
  assert.doesNotMatch(LAUNCHABLE_TRENDS_SQL, /\bnote\b|\boperator\b/)
})

test('reward copy is derived from the discovery policy, not restated', () => {
  const terms = launcherRewardTerms()
  assert.deepEqual(terms, { sharePercent: 50, windowDays: 30, capSol: '2.5' })
  assert.deepEqual(launcherRewardTerms(1), { sharePercent: 50, windowDays: 30, capSol: '1' })
  assert.equal(rewardShort(terms), 'Earn 50% of repo.ing’s trading fees')
  assert.equal(rewardLimits(terms), 'until graduation, 30 days, or 2.5 SOL earned—whichever comes first')
})

test('labels show measured windows and plain counts', () => {
  assert.deepEqual(starGrowth({ delta: 1234, hours: 4.02 }), { value: '+1,234', window: 'stars in 4h' })
  assert.deepEqual(starGrowth({ delta: 12, hours: 26.5 }), { value: '+12', window: 'stars in 27h' })
  assert.equal(ageLabel(iso(now - 30000), now), 'just now')
  assert.equal(ageLabel(iso(now + 30000), now), 'just now')
  assert.equal(ageLabel(iso(now - 5 * 60000), now), '5m ago')
  assert.equal(ageLabel(iso(now - 3 * HOUR - 1), now), '3h ago')
  assert.equal(ageLabel(iso(now - 49 * HOUR), now), '2d ago')
  assert.equal(compactCount(12345), '12.3K')
  assert.equal(compactCount(987), '987')
  assert.deepEqual(trendSignals({ onGithubTrending: true, hnStories: 1, releasedAt: iso(now - 2 * DAY) }, now).map(s => s.text),
    ['On GitHub Trending', 'On Hacker News', 'Released 2d ago'])
  assert.deepEqual(trendSignals({ onGithubTrending: false, hnStories: 3, releasedAt: null }, now).map(s => s.text), ['3 Hacker News stories'])
  assert.deepEqual(trendSignals({ onGithubTrending: false, hnStories: 0, releasedAt: null }, now), [])
})

test('observations keep the language and owner avatar from the identity response, with no extra request', async () => {
  const repo = { id: 123, full_name: 'owner/repo', owner: { login: 'owner', avatar_url: 'https://avatars.githubusercontent.com/u/5?v=4' }, name: 'repo',
    private: false, archived: false, stargazers_count: 500, forks_count: 10, language: 'Rust' }
  const observe = async identity => {
    const urls = []
    const sources = createTrendSources({ now: () => now, pause: async () => {}, fetchImpl: async url => {
      urls.push(url)
      return new Response(JSON.stringify(url.includes('/commits?') ? [] : url.endsWith('/releases/latest') ? {} : identity))
    } })
    return { observed: await sources.observe('https://github.com/owner/repo', '123'), urls }
  }
  const { observed, urls } = await observe(repo)
  assert.equal(observed.repo.language, 'Rust')
  assert.equal(observed.repo.avatarUrl, 'https://avatars.githubusercontent.com/u/5?v=4')
  assert.equal(urls.length, 4, 'two identity reads, latest release, recent commits')
  const { observed: odd } = await observe({ ...repo, language: null, owner: { login: 'owner', avatar_url: 'http://evil.example/a.png' } })
  assert.equal(odd.repo.language, null)
  assert.equal(odd.repo.avatarUrl, null)
})
