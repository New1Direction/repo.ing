import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { X_MAX_WEIGHT, xWeight } from '../src/launch-alerts-message.mjs'
import { LaunchAlertConfigError } from '../src/launch-alerts.mjs'
import { buildTrendMessage, launchUrl, TREND_ALERT_MIN_STARS_GAINED, trendAlertCandidates, trendAlertExclusion } from '../src/trend-alerts-message.mjs'
import { createTrendAlerts, planTrendAlerts, TREND_ALERT_DEFAULTS, trendAlertsConfig } from '../src/trend-alerts.mjs'

const NOW = Date.parse('2026-10-11T12:00:00Z')
const SINCE = new Date('2026-10-11T00:00:00Z')
const ORIGIN = 'https://repo.ing'
const TELEGRAM = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '@repoing_launches' }
const X = { X_BOT_API_KEY: 'k', X_BOT_API_SECRET: 's', X_BOT_ACCESS_TOKEN: 't', X_BOT_ACCESS_SECRET: 'a' }
const ON = { TREND_ALERTS_ENABLED: 'true', TREND_ALERTS_SINCE: SINCE.toISOString(), ...TELEGRAM }

// A launchable trend as selectLaunchableTrends returns it.
const trend = (repoId, overrides = {}) => ({ repoId: String(repoId), fullName: `acme/repo-${repoId}`, owner: 'acme', name: `repo-${repoId}`,
  description: 'A fast thing', stars: 4200, starsGained: { delta: 340, hours: 5, perDay: 1632 }, observedAt: new Date(NOW - 600_000).toISOString(),
  detectedAt: new Date(NOW - 3_600_000).toISOString(), score: 40, reviewed: false, launchHref: `/launch/${repoId}`, ...overrides })

// ---------- config ----------
test('trend alerts are off unless switched on with a channel, and need a cutoff', () => {
  assert.equal(trendAlertsConfig({}), null)
  assert.equal(trendAlertsConfig({ TREND_ALERTS_ENABLED: 'yes', ...TELEGRAM }), null, 'only exactly "true"')
  assert.equal(trendAlertsConfig({ TREND_ALERTS_ENABLED: 'true', TREND_ALERTS_SINCE: SINCE.toISOString() }), null, 'no channel: nothing to post to')
  assert.throws(() => trendAlertsConfig({ TREND_ALERTS_ENABLED: 'true', ...TELEGRAM }), LaunchAlertConfigError)
  assert.throws(() => trendAlertsConfig({ ...ON, X_BOT_API_KEY: 'k' }), LaunchAlertConfigError, 'a half-configured channel stops the job')
  const config = trendAlertsConfig({ ...ON, ...X })
  assert.deepEqual(config.channels, ['telegram', 'x'])
  assert.deepEqual([config.maxPerRun, config.maxPerDay, config.minStarsPerDay, config.reward], [1, 4, 200, false])
  assert.equal(config.since.toISOString(), SINCE.toISOString())
})

test('the daily cap, the star threshold and the reward line are settings', () => {
  const config = trendAlertsConfig({ ...ON, TREND_ALERTS_MAX_PER_DAY: '2', TREND_ALERTS_MIN_STARS_PER_DAY: '500', DISCOVERY_REWARDS_ENABLED: 'true' })
  assert.deepEqual([config.maxPerDay, config.minStarsPerDay, config.reward], [2, 500, true])
  for (const value of ['0', '24', '1.5', 'many', '1000001']) {
    assert.throws(() => trendAlertsConfig({ ...ON, TREND_ALERTS_MIN_STARS_PER_DAY: value }), /TREND_ALERTS_MIN_STARS_PER_DAY must be an integer from 25 to 1000000/)
  }
  assert.throws(() => trendAlertsConfig({ ...ON, TREND_ALERTS_MAX_PER_DAY: '0' }), /TREND_ALERTS_MAX_PER_DAY must be an integer from 1 to 500/)
  assert.deepEqual([...trendAlertsConfig({ ...ON, PROMOTION_EXCLUDED_REPO_IDS: '42' }).excluded], ['42'])
})

// ---------- which trends ----------
test('only strong measured star growth, observed after the cutoff, and never a fork', () => {
  const options = { since: SINCE, minStarsPerDay: 200 }
  assert.equal(trendAlertExclusion(trend(1), options), null)
  assert.equal(trendAlertExclusion(trend(2, { starsGained: null }), options), 'NO_STAR_GROWTH')
  assert.equal(trendAlertExclusion(trend(3, { starsGained: { delta: 300, hours: 24, perDay: 199 } }), options), 'BELOW_THRESHOLD')
  assert.equal(trendAlertExclusion(trend(4, { starsGained: { delta: TREND_ALERT_MIN_STARS_GAINED - 1, hours: 1, perDay: 576 } }), options), 'BELOW_THRESHOLD',
    'a short window never turns a handful of stars into an alert')
  assert.equal(trendAlertExclusion(trend(5, { forkOf: 'acme/upstream' }), options), 'FORK')
  assert.equal(trendAlertExclusion(trend(6, { detectedAt: '2026-10-10T23:59:59Z' }), options), 'BEFORE_SINCE',
    'detected before the cutoff, even though every refresh moves its observation time past it')
  assert.equal(trendAlertExclusion(trend(6, { detectedAt: null }), options), 'BEFORE_SINCE', 'no detection time: never')
  assert.deepEqual(trendAlertCandidates([trend(7), trend(8, { forkOf: 'a/b' }), trend(9)], options).map(item => item.repoId), ['7', '9'], 'pipeline order kept')
})

// ---------- text ----------
test('the X post states measured stars, the launcher reward with its limits, the disclaimer and the launch link', () => {
  const text = buildTrendMessage(trend(1001, { fullName: 'acme/rocket' }), { channel: 'x', origin: ORIGIN, reward: true })
  assert.equal(text, ['🔥 acme/rocket: +340 GitHub stars in 5h, no market yet.',
    'Launch it first: its launch wallet earns 50% of our trading fees until graduation, 30 days or 2.5 SOL.',
    'Community launch, not endorsed by the maintainers.', 'https://repo.ing/launch/1001'].join('\n'))
  assert.ok(xWeight(text) <= X_MAX_WEIGHT)
  const off = buildTrendMessage(trend(1001, { fullName: 'acme/rocket' }), { channel: 'x', origin: ORIGIN })
  assert.match(off, /^Launch it first\. Every trade pays the repo's builders\.$/m, 'no reward named while discovery rewards are off')
  assert.doesNotMatch(off, /launch wallet earns/)
  const telegram = buildTrendMessage(trend(1001, { fullName: 'acme/rocket' }), { channel: 'telegram', origin: ORIGIN, reward: true })
  assert.match(telegram, /\nLaunch it first: its launch wallet earns 50% of repo\.ing's trading fees until graduation, 30 days or 2\.5 SOL\.\n/)
})

test('an operator-approved trend keeps its attributed link; any other path falls back to the plain launch page', () => {
  assert.equal(launchUrl(ORIGIN, trend(1001)), 'https://repo.ing/launch/1001')
  assert.equal(launchUrl(ORIGIN, trend(1001, { launchHref: '/launch/1001?from=trend', reviewed: true })), 'https://repo.ing/launch/1001?from=trend')
  assert.equal(launchUrl(ORIGIN, trend(1001, { launchHref: '//evil.example/x' })), 'https://repo.ing/launch/1001')
  assert.match(buildTrendMessage(trend(5, { launchHref: '/launch/5?from=trend' }), { channel: 'x', origin: ORIGIN }), /\nhttps:\/\/repo\.ing\/launch\/5\?from=trend$/)
})

test('a long repository name is shortened visibly and keeps the reward limits; X never exceeds 280', () => {
  const long = `${'o'.repeat(39)}/${'n'.repeat(100)}`
  for (const reward of [true, false]) {
    const text = buildTrendMessage(trend(7, { fullName: long, starsGained: { delta: 123456, hours: 47.6, perDay: 62000 } }), { channel: 'x', origin: ORIGIN, reward })
    assert.ok(xWeight(text) <= X_MAX_WEIGHT, `weight ${xWeight(text)}`)
    assert.ok(text.endsWith('\nhttps://repo.ing/launch/7'))
    assert.match(text, /^🔥 o+\/?n*…: \+123,456 GitHub stars in 48h, no market yet\.\n/)
    assert.match(text, /Community launch, not endorsed by the maintainers\./)
    if (reward) assert.match(text, /until graduation, 30 days or 2\.5 SOL\.\n/, 'the limits always go with the share')
  }
  for (const length of [20, 33, 37, 45, 52]) {
    const name = `acme/${'x'.repeat(length - 5)}`
    const text = buildTrendMessage(trend(8, { fullName: name }), { channel: 'x', origin: ORIGIN, reward: true })
    assert.ok(text.includes(`${name}:`), `a ${length}-character name is kept whole`)
    assert.match(text, /until graduation, 30 days or 2\.5 SOL\./)
  }
})

test('repository text is untrusted: cleaned, escaped for Telegram, never tagging anyone', () => {
  const post = trend(9, { fullName: 'acme/<b>bad</b>', description: 'Use @someone #tag $COIN see https://evil.example now <script> or free-sol.xyz/claim' })
  const telegram = buildTrendMessage(post, { channel: 'telegram', origin: ORIGIN, reward: true })
  assert.match(telegram, /^🔥 acme\/bbad\/b: \+340 GitHub stars in 5h, no market yet\.\n/)
  assert.match(telegram, /\nUse someone tag COIN see now &lt;script&gt; or\n/)
  assert.doesNotMatch(telegram, /<script>|evil\.example|free-sol|@someone/, 'no link of any kind, bare domains included')
  assert.match(telegram, /\nhttps:\/\/repo\.ing\/launch\/9$/)
  assert.throws(() => buildTrendMessage(post, { channel: 'email', origin: ORIGIN }), /Unknown trend alert channel/)
})

// ---------- plan ----------
test('a repository is posted once per channel; only a failed post is retried, after its retry time', () => {
  const candidates = [trend(1), trend(2), trend(3), trend(4), trend(5)]
  const alerted = new Map([
    ['2', { id: '20', status: 'sent', attempts: 1 }],
    ['3', { id: '30', status: 'failed', attempts: 1, nextAttemptAt: new Date(NOW - 1) }],
    ['4', { id: '40', status: 'failed', attempts: 1, nextAttemptAt: new Date(NOW + 60_000) }],
    ['5', { id: '50', status: 'unknown', attempts: 1 }],
  ])
  const plan = planTrendAlerts({ candidates, alerted, now: NOW, maxAttempts: 3 })
  assert.deepEqual(plan.map(item => [item.repoId, item.alertId ?? null]), [['1', null], ['3', '30']])
  const spent = new Map([['3', { id: '30', status: 'failed', attempts: 3, nextAttemptAt: new Date(NOW - 1) }]])
  assert.deepEqual(planTrendAlerts({ candidates: [trend(3)], alerted: spent, now: NOW, maxAttempts: 3 }), [])
})

// ---------- job ----------
function fakeStore({ trends = [], sent = 0, alerted = new Map() } = {}) {
  const rows = new Map(alerted), calls = { trends: [], claims: [] }
  return { calls, rows,
    withLock: async fn => ({ locked: true, value: await fn() }),
    expireStale: async () => [],
    sentRecently: async () => sent,
    trends: async options => { calls.trends.push(options); return trends },
    // Rows are keyed channel:repo here; a channel's state is keyed by repository id, like the real store's.
    channelState: async channel => new Map([...rows].filter(([key]) => key.startsWith(`${channel}:`)).map(([key, row]) => [key.slice(channel.length + 1), row])),
    claim: async ({ channel, post }) => {
      calls.claims.push([channel, post.repoId, post.alertId ?? null])
      const key = `${channel}:${post.repoId}`
      if (rows.has(key) && !post.alertId) return null
      rows.set(key, { id: key, status: 'sending' })
      return key
    },
    finish: async (id, outcome) => { rows.set(id, { ...rows.get(id), ...outcome }) },
  }
}
const sender = (outcome = { status: 'sent', messageId: '99', messageUrl: 'https://t.me/repoing_launches/99' }) => {
  const sent = []
  return { sent, send: async message => { sent.push(message); return outcome } }
}
const CONFIG = trendAlertsConfig({ ...ON, DISCOVERY_REWARDS_ENABLED: 'true' })

test('a run posts the top candidate on each channel, passes the do-not-promote set, and never posts it again', async () => {
  const store = fakeStore({ trends: [trend(11), trend(12)] })
  const telegram = sender()
  const excluded = new Set(['77'])
  const job = createTrendAlerts({ store, config: CONFIG, senders: { telegram: telegram.send }, sleep: async () => {}, now: () => NOW, excluded: async () => excluded })
  const first = await job.runOnce()
  assert.deepEqual(first.posts, [{ channel: 'telegram', repo: 'acme/repo-11', starsGained: 340, status: 'sent', url: 'https://t.me/repoing_launches/99' }])
  assert.equal(store.calls.trends[0].promotionExcluded, excluded)
  assert.equal(telegram.sent[0].url, 'https://repo.ing/launch/11')
  assert.match(telegram.sent[0].text, /launch wallet earns 50%/)
  const second = await job.runOnce()
  assert.deepEqual(second.posts.map(post => post.repo), ['acme/repo-12'], 'the next run moves on; 11 is never posted twice')
})

test('nothing is posted before the cutoff, over the daily cap, or when the do-not-promote set cannot be read', async () => {
  const early = createTrendAlerts({ store: fakeStore({ trends: [trend(1)] }), config: CONFIG, senders: { telegram: sender().send }, now: () => SINCE.getTime() - 1 })
  assert.deepEqual(await early.runOnce(), { posts: [], interrupted: [], skipped: 'BEFORE_SINCE' })
  const capped = fakeStore({ trends: [trend(1)], sent: TREND_ALERT_DEFAULTS.maxPerDay })
  assert.deepEqual((await createTrendAlerts({ store: capped, config: CONFIG, senders: { telegram: sender().send }, now: () => NOW }).runOnce()).posts, [])
  assert.deepEqual(capped.calls.claims, [])
  const blind = createTrendAlerts({ store: fakeStore({ trends: [trend(1)] }), config: CONFIG, senders: { telegram: sender().send }, now: () => NOW,
    excluded: async () => { throw Error('opt-outs unreadable') } })
  await assert.rejects(blind.runOnce(), /opt-outs unreadable/)
})

test('a post that may have gone out is recorded unknown and not retried; a provider rejection waits for its retry time', async () => {
  const store = fakeStore({ trends: [trend(1), trend(2)] })
  const unsure = sender({ status: 'unknown', error: 'timeout' })
  const config = { ...CONFIG, maxPerRun: 2 }
  const result = await createTrendAlerts({ store, config, senders: { telegram: unsure.send }, sleep: async () => {}, now: () => NOW }).runOnce()
  assert.deepEqual(result.posts.map(post => [post.repo, post.status]), [['acme/repo-1', 'unknown']], 'any failure pauses the channel for this run')
  assert.equal(store.rows.get('telegram:1').nextAttemptAt, null)
  const rejecting = fakeStore({ trends: [trend(3)] })
  await createTrendAlerts({ store: rejecting, config: CONFIG, senders: { telegram: sender({ status: 'failed', error: '403' }).send }, now: () => NOW }).runOnce()
  assert.equal(rejecting.rows.get('telegram:3').nextAttemptAt.getTime(), NOW + CONFIG.retryDelayMs)
})

// ---------- migration ----------
test('migration 0068 adds only the trend_alerts table, after every earlier migration, and matches the schema', () => {
  const sql = readFileSync('drizzle/0068_trend_alerts.sql', 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "trend_alerts"/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS trend_alerts_repo_channel_unique ON trend_alerts\(github_repo_id, channel\)/)
  // Idempotent: tests/market-source-db.test.mjs runs every migration from 0049 a second time.
  assert.doesNotMatch(sql, /\bCREATE\b(?! (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS)/i)
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP|ALTER)\b/i)
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const index = entries.findIndex(entry => entry.tag === '0068_trend_alerts')
  assert.ok(index > 0)
  assert.ok(entries.slice(0, index).every(entry => entry.when < entries[index].when))
  const schema = readFileSync('src/db/schema.mjs', 'utf8')
  for (const name of ['trend_alerts_repo_channel_unique', 'trend_alerts_channel_recent', 'trend_alerts_sent_check', 'trend_alerts_stars_gained_check']) {
    assert.ok(schema.includes(`'${name}'`), name)
  }
})
