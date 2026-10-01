import assert from 'node:assert/strict'
import test from 'node:test'
import { commitEvents, createDevPulseCollector, hnEvents, mergeEvents, milestoneEvents, nextCheckDelay, releaseEvents, starSpikeEvent } from '../src/dev-pulse.mjs'
import { selectTicker, summarizePulse } from '../app/lib/dev-pulse.mjs'
import { pulseAgo, pulseStatusLabel, starsToday } from '../app/lib/pulse-format.mjs'

const HOUR = 3_600_000, DAY = 86_400_000
const NOW = Date.parse('2026-10-01T20:30:00Z')
const iso = ms => new Date(ms).toISOString()
const sha = n => n.toString(16).padStart(40, '0')

test('commits become events with the first message line, author and GitHub link; malformed ones are skipped', () => {
  const events = commitEvents([
    { sha: sha(1), html_url: 'https://github.com/o/r/commit/1', author: { login: 'alice' }, commit: { message: 'fix: route 404s\n\nbody', committer: { date: '2026-10-01T19:00:00Z' } } },
    { sha: 'not-a-sha', commit: { message: 'x', committer: { date: '2026-10-01T19:00:00Z' } } },
    { sha: sha(2), html_url: 'https://evil.example/x', commit: { message: 'y', author: { name: 'Bob' }, committer: { date: 'never' } } },
  ])
  assert.deepEqual(events, [{ kind: 'commit', sourceId: sha(1), occurredAt: '2026-10-01T19:00:00.000Z', title: 'fix: route 404s', detail: 'alice', url: 'https://github.com/o/r/commit/1', amount: null }])
})

test('releases skip drafts and show the tag when the name differs; merges keep only merged pull requests in the window', () => {
  const releases = releaseEvents([
    { id: 7, name: 'Route yes', tag_name: 'v0.3.0', prerelease: true, published_at: '2026-10-01T18:00:00Z', html_url: 'https://github.com/o/r/releases/tag/v0.3.0' },
    { id: 8, draft: true, tag_name: 'v0.4.0', published_at: '2026-10-01T19:00:00Z' },
  ])
  assert.deepEqual(releases.map(event => [event.title, event.detail]), [['Route yes', 'v0.3.0 · pre-release']])
  const since = Date.parse('2026-09-18T00:00:00Z')
  const merges = mergeEvents([
    { number: 42, title: 'Add Clef-flash', merged_at: '2026-10-01T17:00:00Z', user: { login: 'bob' }, html_url: 'https://github.com/o/r/pull/42' },
    { number: 43, title: 'Closed, not merged', merged_at: null },
    { number: 12, title: 'Old', merged_at: '2026-09-01T00:00:00Z' },
  ], since)
  assert.deepEqual(merges.map(event => event.title), ['#42 Add Clef-flash'])
})

test('a star spike needs 10 new stars since an earlier hour, and half a percent of the total for big repositories', () => {
  assert.equal(starSpikeEvent(undefined, 120, NOW), null)
  assert.equal(starSpikeEvent(115, 120, NOW), null)
  assert.deepEqual(starSpikeEvent(108, 120, NOW), { kind: 'stars', sourceId: 'hour:2026-10-01T20:00:00.000Z', occurredAt: '2026-10-01T20:00:00.000Z',
    title: '+12 stars', detail: 'Star spike', url: null, amount: 12 })
  assert.equal(starSpikeEvent(111_067, 111_167, NOW), null)
  assert.equal(starSpikeEvent(110_500, 111_167, NOW).title, '+667 stars')
})

test('star milestones fire only when a watched total crosses them, never back-filled on the first reading', () => {
  assert.deepEqual(milestoneEvents(null, 5000, iso(NOW), 'o/r'), [])
  assert.deepEqual(milestoneEvents(240, 1003, iso(NOW), 'o/r').map(event => event.title), ['250 stars', '500 stars', '1,000 stars'])
  assert.deepEqual(milestoneEvents(1003, 1003, iso(NOW), 'o/r'), [])
})

test('Hacker News stories must link this repository and clear the points floor', () => {
  const events = hnEvents([
    { objectID: '1', url: 'https://github.com/Owner/Repo', title: 'Show HN: Repo', points: 230, num_comments: 81, created_at: '2026-09-30T12:00:00Z' },
    { objectID: '2', url: 'https://www.github.com/owner/repo/tree/main/docs', title: 'Docs', points: 12, created_at: '2026-09-30T13:00:00Z' },
    { objectID: '3', url: 'https://github.com/owner/repository', title: 'Other repo', points: 500, created_at: '2026-09-30T13:00:00Z' },
    { objectID: '4', url: 'https://github.com/owner/repo', title: 'Tiny', points: 3, created_at: '2026-09-30T13:00:00Z' },
  ], 'owner/repo')
  assert.deepEqual(events.map(event => [event.sourceId, event.detail, event.url]), [
    ['1', '230 points · 81 comments', 'https://news.ycombinator.com/item?id=1'],
    ['2', '12 points · 0 comments', 'https://news.ycombinator.com/item?id=2'],
  ])
})

test('busy repositories are checked every 10 minutes, quiet ones every 30 and dormant ones every 3 hours', () => {
  assert.equal(nextCheckDelay(iso(NOW - HOUR), NOW), 600_000)
  assert.equal(nextCheckDelay(iso(NOW - 10 * DAY), NOW), 1_800_000)
  assert.equal(nextCheckDelay(iso(NOW - 90 * DAY), NOW), 10_800_000)
  assert.equal(nextCheckDelay(null, NOW), 10_800_000)
})

function fakeGithub(routes) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {} })
    const route = routes.find(([pattern]) => pattern.test(url))
    if (!route) throw Error(`unexpected ${url}`)
    const reply = typeof route[1] === 'function' ? route[1](url, options) : route[1]
    return new Response(reply.status === 304 ? null : JSON.stringify(reply.body ?? null), { status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.etag ? { etag: reply.etag } : {}), 'x-ratelimit-remaining': String(reply.remaining ?? 4000) } })
  }
  return { fetchImpl, calls }
}

function memoryStore(rows) {
  const saved = [], failed = []
  return { saved, failed, async due() { return rows }, async save(repoId, outcome) { saved.push({ repoId, outcome }) },
    async fail(repoId, error) { failed.push({ repoId, error }) }, async prune() {} }
}

const repoReply = { body: { full_name: 'owner/repo', default_branch: 'main', stargazers_count: 120, pushed_at: '2026-10-01T19:59:00Z' }, etag: 'W/"repo1"' }

test('a first check reads the repository, releases, commits, merges, a star snapshot and Hacker News into one save', async () => {
  const { fetchImpl, calls } = fakeGithub([
    [/\/repositories\/42$/, repoReply],
    [/\/releases\?/, { body: [{ id: 1, tag_name: 'v1.0.0', published_at: '2026-10-01T10:00:00Z', html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0' }], etag: '"rel"' }],
    [/\/commits\?sha=main&since=2026-09-18T00:00:00.000Z/, { body: [{ sha: sha(9), html_url: 'https://github.com/owner/repo/commit/9', commit: { message: 'feat: ship', committer: { date: '2026-10-01T19:58:00Z' } } }], etag: '"c"' }],
    [/\/pulls\?state=closed/, { body: [{ number: 5, title: 'Merge me', merged_at: '2026-10-01T19:00:00Z', html_url: 'https://github.com/owner/repo/pull/5' }], etag: '"p"' }],
    [/hn\.algolia\.com/, { body: { hits: [{ objectID: '77', url: 'https://github.com/owner/repo', title: 'Show HN: repo', points: 99, num_comments: 4, created_at: '2026-10-01T12:00:00Z' }] } }],
  ])
  const store = memoryStore([{ repoId: '42', fullName: 'owner/repo', etags: {}, stars: null }])
  const result = await createDevPulseCollector({ store, fetchImpl, now: () => NOW, headers: async () => ({ Authorization: 'Bearer t' }) }).runOnce()
  assert.deepEqual(result, { checked: 1, events: 4, errors: 0 })
  const { outcome } = store.saved[0]
  assert.deepEqual([...new Set(outcome.events.map(event => event.kind))].sort(), ['commit', 'hn', 'merge', 'release'])
  assert.deepEqual(outcome.starHours, [{ hour: '2026-10-01T20:00:00.000Z', starsTotal: 120 }])
  assert.equal(outcome.state.stars, 120)
  assert.equal(outcome.state.activityReadFor, '2026-10-01T19:59:00Z')
  assert.equal(outcome.state.etags.repo, 'W/"repo1"')
  assert.equal(outcome.state.nextCheckAt, iso(NOW + 600_000))
  assert.ok(!calls.some(call => call.url.includes('/stargazers')))
  assert.equal(calls[0].headers.Authorization, 'Bearer t')
})

test('a star spike is recorded against the last snapshot from an earlier hour', async () => {
  const { fetchImpl } = fakeGithub([[/\/repositories\/42$/, repoReply], [/\/releases\?/, { body: [] }], [/\/commits/, { body: [] }], [/\/pulls/, { body: [] }], [/hn\.algolia/, { body: { hits: [] } }]])
  const store = memoryStore([{ repoId: '42', fullName: 'owner/repo', etags: {}, stars: 101, starsBefore: 100 }])
  await createDevPulseCollector({ store, fetchImpl, now: () => NOW, headers: async () => ({}) }).runOnce()
  assert.deepEqual(store.saved[0].outcome.events.filter(event => event.kind === 'stars').map(event => event.title), ['+20 stars'])
  assert.deepEqual(store.saved[0].outcome.events.filter(event => event.sourceId?.startsWith('milestone:')).map(event => event.title), [])
})

test('an unchanged repository sends validators and skips commits and merges until pushed_at moves', async () => {
  const { fetchImpl, calls } = fakeGithub([
    [/\/repositories\/42$/, { status: 304 }],
    [/\/releases\?/, { status: 304 }],
    [/hn\.algolia\.com/, { body: { hits: [] } }],
  ])
  const store = memoryStore([{ repoId: '42', fullName: 'owner/repo', knownName: 'owner/repo', defaultBranch: 'main', stars: 120,
    pushedAt: '2026-10-01T19:59:00Z', activityReadFor: '2026-10-01T19:59:00Z', etags: { repo: 'W/"repo1"', releases: '"rel"' }, hnCheckedAt: iso(NOW - 31 * 60_000) }])
  await createDevPulseCollector({ store, fetchImpl, now: () => NOW, headers: async () => ({}) }).runOnce()
  assert.equal(calls[0].headers['If-None-Match'], 'W/"repo1"')
  assert.equal(calls[1].headers['If-None-Match'], '"rel"')
  assert.ok(!calls.some(call => /\/(commits|pulls|stargazers)/.test(call.url)))
  assert.deepEqual(store.saved[0].outcome.events, [])
  assert.deepEqual(store.saved[0].outcome.starHours, [{ hour: '2026-10-01T20:00:00.000Z', starsTotal: 120 }])
})

test('a low GitHub rate limit pauses the collector; a failing repository is recorded and retried later', async () => {
  const { fetchImpl } = fakeGithub([[/\/repositories\/1$/, { status: 500 }], [/\/repositories\/2$/, { ...repoReply, remaining: 10 }],
    [/\/releases\?/, { body: [] }], [/\/commits/, { body: [] }], [/\/pulls/, { body: [] }], [/stargazers/, { body: [] }], [/hn\.algolia/, { body: { hits: [] } }]])
  const store = memoryStore([{ repoId: '1', fullName: 'a/b', etags: {} }, { repoId: '2', fullName: 'owner/repo', etags: {} }, { repoId: '3', fullName: 'c/d', etags: {} }])
  const collector = createDevPulseCollector({ store, fetchImpl, now: () => NOW, headers: async () => ({}) })
  const result = await collector.runOnce()
  assert.equal(store.failed[0].repoId, '1')
  assert.equal(result.errors, 1)
  assert.ok(result.paused, 'stops before the third repository')
  assert.deepEqual(await collector.runOnce(), { paused: result.paused })
})

const state = { fullName: 'owner/repo', stars: 1200, checkedAt: iso(NOW - 4 * 60_000) }
const currentHour = Math.floor(NOW / HOUR) * HOUR
const commit = (minutesAgo, title = 'feat: thing') => ({ kind: 'commit', sourceId: sha(minutesAgo), at: iso(NOW - minutesAgo * 60_000), title, detail: 'alice', url: `https://github.com/owner/repo/commit/${minutesAgo}`, amount: null })

test('the summary says who is shipping, groups commits per hour and counts the last 14 days', () => {
  const pulse = summarizePulse({ now: NOW, state, repoId: '42',
    events: [commit(5, 'fix: newest'), commit(20), commit(70), commit(3 * 24 * 60),
      { kind: 'merge', sourceId: '5', at: iso(NOW - 2 * HOUR), title: '#5 Merge me', detail: 'bob', url: 'https://github.com/owner/repo/pull/5', amount: null },
      { kind: 'hn', sourceId: '77', at: iso(NOW - DAY), title: 'Show HN: repo', detail: '230 points · 81 comments', url: 'https://news.ycombinator.com/item?id=77', amount: 230 }],
    release: { title: 'v1.0.0', detail: null, url: 'https://github.com/owner/repo/releases/tag/v1.0.0', at: iso(NOW - 5 * HOUR) },
    starHours: [{ hour: iso(currentHour - 30 * HOUR), starsTotal: 1100 }, { hour: iso(currentHour - 24 * HOUR), starsTotal: 1170 }, { hour: iso(currentHour), starsTotal: 1200 }],
    boundAt: iso(NOW - 2 * DAY), payouts: [{ amount: '162700000', settledAt: iso(NOW - 3 * HOUR), signature: 'sig1' }] })
  assert.equal(pulse.status, 'shipping')
  assert.equal(pulse.commits24h, 3)
  assert.equal(pulse.commits7d, 4)
  assert.equal(pulse.days.length, 14)
  assert.equal(pulse.days.at(-1).commits, 3)
  assert.deepEqual(pulse.stars, { total: 1200, today: 30, partial: false })
  assert.equal(pulse.hn.points, 230)
  assert.deepEqual(pulse.maintainer, { verified: true, since: iso(NOW - 2 * DAY), claimHref: '/claim/42' })
  assert.equal(pulse.feed[0].title, '2 commits')
  assert.equal(pulse.feed[0].detail, 'fix: newest')
  assert.ok(pulse.feed.some(item => item.kind === 'paid' && item.title === 'Builder claimed 0.1627 SOL'))
  assert.deepEqual(pulse.events.map(event => event.time), [...pulse.events.map(event => event.time)].sort((a, b) => a - b))
  assert.ok(pulse.events.every(event => Number.isInteger(event.time)))
})

test('status falls back to active, quiet, none and pending', () => {
  assert.equal(summarizePulse({ now: NOW, state, events: [commit(3 * 24 * 60)] }).status, 'active')
  const quiet = summarizePulse({ now: NOW, state, release: { title: 'v0.1', at: iso(NOW - 40 * DAY) } })
  assert.equal(quiet.status, 'quiet')
  assert.equal(pulseStatusLabel(quiet, NOW), 'Quiet · last activity 40d ago')
  assert.equal(summarizePulse({ now: NOW, state }).status, 'none')
  assert.deepEqual(summarizePulse({ now: NOW, state: undefined }), { status: 'pending', checkedAt: null })
  assert.equal(starsToday({ total: 5, today: 4, partial: true }), '+4+')
  assert.equal(starsToday({ total: 5, today: 0, partial: true }), null)
  assert.deepEqual(summarizePulse({ now: NOW, state, starHours: [{ hour: iso(currentHour - 3 * HOUR), starsTotal: 1190 }] }).stars, { total: 1200, today: 10, partial: true })
  assert.equal(pulseAgo(iso(NOW - 90 * 60_000), NOW), '1h ago')
})

test('the ticker shows the newest items, at most two per repository, never a do-not-promote repository', () => {
  const item = (repoId, kind, minutesAgo, extra = {}) => ({ repoId, kind, at: iso(NOW - minutesAgo * 60_000), title: 'v2.0', amount: 4, mint: `mint${repoId}`, symbol: `S${repoId}`, fullName: `o/r${repoId}`, ...extra })
  const ticker = selectTicker([item('1', 'release', 1), item('1', 'merge', 2, { title: '#9 Fix' }), item('1', 'commits', 3), item('2', 'hn', 4, { amount: 230 }),
    item('3', 'stars', 5, { title: '1,000 stars' }), item('9', 'release', 0)], { excluded: new Set(['9']), limit: 10 })
  assert.deepEqual(ticker.map(entry => `${entry.fullName} ${entry.text}`), ['o/r1 released v2.0', 'o/r1 merged #9 Fix', 'o/r2 is on Hacker News · 230 points', 'o/r3 hit 1,000 stars'])
  assert.equal(ticker[0].href, '/token/mint1')
})

test('the first read of a day pages back through a busy repository; later reads use the validator and one page', async () => {
  const page = (from, count) => Array.from({ length: count }, (_, i) => ({ sha: sha(from + i), commit: { message: `c${from + i}`, committer: { date: iso(NOW - (from + i) * 60_000) } } }))
  const { fetchImpl, calls } = fakeGithub([[/\/repositories\/42$/, repoReply], [/\/releases\?/, { body: [] }],
    [/\/commits\?.*&page=2$/, { body: page(100, 100) }], [/\/commits\?.*&page=3$/, { body: page(200, 30) }], [/\/commits\?/, { body: page(0, 100), etag: '"c1"' }],
    [/\/pulls/, { body: [] }], [/hn\.algolia/, { body: { hits: [] } }]])
  const store = memoryStore([{ repoId: '42', fullName: 'owner/repo', etags: {}, stars: 120 }])
  await createDevPulseCollector({ store, fetchImpl, now: () => NOW, headers: async () => ({}) }).runOnce()
  assert.equal(store.saved[0].outcome.events.filter(event => event.kind === 'commit').length, 230)
  assert.equal(calls.filter(call => call.url.includes('/commits')).length, 3)
  const again = fakeGithub([[/\/repositories\/42$/, { ...repoReply, body: { ...repoReply.body, pushed_at: '2026-10-01T20:20:00Z' } }], [/\/releases\?/, { status: 304 }],
    [/\/commits\?/, { body: page(0, 100), etag: '"c2"' }], [/\/pulls/, { status: 304 }], [/hn\.algolia/, { body: { hits: [] } }]])
  const saved = store.saved[0].outcome.state
  const next = memoryStore([{ repoId: '42', fullName: 'owner/repo', knownName: 'owner/repo', defaultBranch: 'main', stars: 120, pushedAt: saved.pushedAt,
    activityReadFor: saved.activityReadFor, etags: saved.etags, hnCheckedAt: iso(NOW) }])
  await createDevPulseCollector({ store: next, fetchImpl: again.fetchImpl, now: () => NOW, headers: async () => ({}) }).runOnce()
  const commitCalls = again.calls.filter(call => call.url.includes('/commits'))
  assert.equal(commitCalls.length, 1)
  assert.equal(commitCalls[0].headers['If-None-Match'], '"c1"')
})

test('commits that a merged pull request brought in are counted but not repeated in the feed', () => {
  const pulse = summarizePulse({ now: NOW, state, events: [
    { kind: 'merge', sourceId: '119', at: iso(NOW - 2 * HOUR), title: '#119 feat: make $REPOING stand out', detail: 'New1Direction', url: 'https://github.com/o/r/pull/119', amount: null },
    { ...commit(2 * 60 - 1, 'feat: make $REPOING stand out (#119)') }, { ...commit(2 * 60 - 2, 'Merge pull request #119 from o/branch') }, commit(30, 'fix: something else')] })
  assert.equal(pulse.commits24h, 3)
  assert.deepEqual(pulse.feed.map(item => item.title), ['1 commit', '#119 feat: make $REPOING stand out'])
  assert.equal(pulse.feed[0].detail, 'fix: something else')
})
