import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLaunchMessage, cleanDescription, escapeHtml, formatStars, X_MAX_WEIGHT, xWeight } from '../src/launch-alerts-message.mjs'
import { createTelegramSender, createXSender, oauthHeader, oauthSignature, percentEncode, TELEGRAM_API, X_TWEETS_URL } from '../src/launch-alerts-senders.mjs'
import { createLaunchAlerts, createLaunchAlertStore, LAUNCH_ALERT_DEFAULTS, LaunchAlertConfigError, launchAlertsConfig } from '../src/launch-alerts.mjs'

const ORIGIN = 'https://repo.ing'
const MINT = 'So11111111111111111111111111111111111111112'
const MARKET = { githubRepoId: '42', fullName: 'octo/hello-world', tokenSymbol: 'HELLO', stars: 12_345, description: 'A friendly greeter.', mint: MINT }

// ---------- message ----------
test('messages are short, factual and link the token page', () => {
  const telegram = buildLaunchMessage(MARKET, { channel: 'telegram', origin: ORIGIN })
  assert.equal(telegram, `🚀 New on repo.ing: octo/hello-world — $HELLO\n⭐ 12.3k · A friendly greeter.\nEvery trade pays the repo's builders.\nhttps://repo.ing/token/${MINT}`)
  const x = buildLaunchMessage(MARKET, { channel: 'x', origin: ORIGIN })
  assert.equal(x, telegram)
  assert.equal(buildLaunchMessage({ ...MARKET, description: null, stars: 7 }, { channel: 'x', origin: ORIGIN }).split('\n')[1], '⭐ 7')
  assert.doesNotMatch(x, /price|moon|profit|guarantee|100x/i)
  assert.throws(() => buildLaunchMessage(MARKET, { channel: 'email', origin: ORIGIN }), /Unknown/)
})

test('stars are abbreviated without rounding up', () => {
  assert.deepEqual([0, 999, 1000, 1049, 12_345, 999_999, 1_000_000, 2_560_000, -5, 'x'].map(formatStars), ['0', '999', '1k', '1k', '12.3k', '999.9k', '1M', '2.5M', '0', '0'])
})

test('descriptions lose mentions, hashtags, cashtags, links and invisible characters', () => {
  assert.equal(cleanDescription('Ping @elonmusk and ＠jack #crypto #1 $SOL now'), 'Ping elonmusk and jack crypto 1 SOL now')
  assert.equal(cleanDescription('Docs: https://evil.example/path?x=1 and www.spam.io too'), 'Docs: and too')
  assert.equal(cleanDescription('safe‮txt.exe​\nnext\tline\u0007'), 'safe txt.exe next line')
  assert.equal(cleanDescription('email me a@b but keep c# and 100%'), 'email me ab but keep c# and 100%')
  for (const value of [null, undefined, 5, {}]) assert.equal(cleanDescription(value), '')
})

test('Telegram HTML escapes every piece of repository text', () => {
  const text = buildLaunchMessage({ ...MARKET, fullName: 'a/<b>', tokenSymbol: '<i>X', description: '<script>alert("x")</script> & <b>bold</b>' }, { channel: 'telegram', origin: ORIGIN })
  assert.doesNotMatch(text, /<(?!\/?a[ >])/)
  assert.match(text, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &lt;b&gt;bold&lt;\/b&gt;/)
  assert.match(text, /^🚀 New on repo\.ing: a\/b — \$iX$/m, 'repo names and symbols keep only safe characters')
  assert.equal(escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;')
  const long = buildLaunchMessage({ ...MARKET, description: 'word '.repeat(200) }, { channel: 'telegram', origin: ORIGIN })
  assert.ok([...long.split('\n')[1]].length <= 220 && long.split('\n')[1].endsWith('…'))
})

test('X posts stay within 280 weighted characters (links count 23, CJK and emoji count 2)', () => {
  assert.equal(xWeight('abc'), 3)
  assert.equal(xWeight('🚀⭐'), 4)
  assert.equal(xWeight('漢字'), 4)
  assert.equal(xWeight('see a.io'), 4 + 23)
  assert.equal(xWeight(`https://repo.ing/token/${MINT}`), 23)
  assert.equal(xWeight('a.b.c.d.e.f.g.h.i.j.k.l.mm'), 26, 'unlinked look-alikes are never undercounted')
  for (const description of ['long words '.repeat(60), '漢字'.repeat(200), '🚀'.repeat(300), 'x.io '.repeat(100), 'a'.repeat(1000)]) {
    const text = buildLaunchMessage({ ...MARKET, fullName: `${'o'.repeat(39)}/${'r'.repeat(100)}`, tokenSymbol: 'S'.repeat(16), stars: 999_999, description }, { channel: 'x', origin: ORIGIN })
    assert.ok(xWeight(text) <= X_MAX_WEIGHT, `${xWeight(text)} for ${description.slice(0, 10)}`)
    assert.ok(text.endsWith(`\nhttps://repo.ing/token/${MINT}`))
    assert.match(text.split('\n')[1], /…$|^⭐ 999\.9k$/)
    assert.equal(text.isWellFormed(), true, 'emoji are never split')
  }
})

// ---------- OAuth 1.0a ----------
test('OAuth 1.0a signature matches the X "Creating a signature" example', () => {
  const signature = oauthSignature({ method: 'post', url: 'https://api.twitter.com/1.1/statuses/update.json',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    params: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true', oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
      oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: '1318622958',
      oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', oauth_version: '1.0' } })
  assert.equal(signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=')
  assert.equal(percentEncode("Ladies + Gentlemen!*'()"), 'Ladies%20%2B%20Gentlemen%21%2A%27%28%29')
})

test('OAuth header carries every oauth_* field and a percent-encoded signature', () => {
  const credentials = { apiKey: 'xvz1evFS4wEEPTGEFPHBog', apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' }
  const header = oauthHeader({ method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json', credentials,
    params: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true' }, nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958 })
  assert.equal(header, 'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", ' +
    'oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", ' +
    'oauth_version="1.0", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"')
  assert.doesNotMatch(header, /kAcSOqF21|LswwdoUa/)
  assert.notEqual(oauthHeader({ method: 'POST', url: X_TWEETS_URL, credentials }), oauthHeader({ method: 'POST', url: X_TWEETS_URL, credentials }), 'fresh nonce')
})

// ---------- senders (fake fetch; never the real APIs) ----------
const reply = (status, body, headers = {}) => async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
const recorder = respond => { const calls = []; const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return respond(url, init) }; return { calls, fetchImpl } }
const TOKEN = '123456:SECRET-token'
const X_CREDS = { apiKey: 'key', apiSecret: 'api-secret-value', accessToken: '1-token', accessSecret: 'access-secret-value' }
const netError = code => async () => { throw new TypeError('fetch failed', { cause: Object.assign(Error(code), { code }) }) }

test('Telegram sender posts HTML with the link preview enabled and reports the message', async () => {
  const { calls, fetchImpl } = recorder(reply(200, { ok: true, result: { message_id: 77 } }))
  const send = createTelegramSender({ token: TOKEN, chatId: '@repoing_launches', fetchImpl })
  assert.deepEqual(await send({ text: 'hi', url: `${ORIGIN}/token/${MINT}` }), { status: 'sent', messageId: '77', messageUrl: 'https://t.me/repoing_launches/77' })
  assert.equal(calls[0].url, `${TELEGRAM_API}/bot${TOKEN}/sendMessage`)
  assert.equal(calls[0].init.redirect, 'error')
  assert.deepEqual(calls[0].body, { chat_id: '@repoing_launches', text: 'hi', parse_mode: 'HTML', link_preview_options: { is_disabled: false, url: `${ORIGIN}/token/${MINT}` } })
  const privateChat = createTelegramSender({ token: TOKEN, chatId: '-1001234', fetchImpl: reply(200, { ok: true, result: { message_id: 5 } }) })
  assert.deepEqual(await privateChat({ text: 'hi' }), { status: 'sent', messageId: '5', messageUrl: null })
})

test('senders only report "failed" when the provider proves nothing was posted', async () => {
  const telegram = fetchImpl => createTelegramSender({ token: TOKEN, chatId: '@repoing_launches', fetchImpl })({ text: 'hi' })
  const x = fetchImpl => createXSender({ credentials: X_CREDS, fetchImpl })({ text: 'hi' })
  for (const send of [telegram, x]) {
    assert.equal((await send(reply(400, { ok: false, description: 'Bad Request: chat not found', detail: 'bad' }))).status, 'failed')
    assert.equal((await send(reply(401, {}))).status, 'failed')
    const limited = await send(reply(429, { parameters: { retry_after: 30 } }, { 'retry-after': '30' }))
    assert.deepEqual([limited.status, limited.retryAfterMs], ['failed', 30_000])
    assert.equal((await send(netError('ECONNREFUSED'))).status, 'failed')
    assert.equal((await send(netError('ENOTFOUND'))).status, 'failed')
    // Maybe posted: never retried.
    assert.equal((await send(reply(500, {}))).status, 'unknown')
    assert.equal((await send(reply(502))).status, 'unknown')
    assert.equal((await send(netError('ECONNRESET'))).status, 'unknown')
    assert.equal((await send(async () => { throw new DOMException('timed out', 'TimeoutError') })).status, 'unknown')
    assert.equal((await send(reply(200, { ok: true }))).status, 'unknown')
    assert.equal((await send(async () => new Response('not json', { status: 201 }))).status, 'unknown')
  }
  const leaked = await telegram(reply(400, { ok: false, description: `bad token ${TOKEN}` }))
  assert.doesNotMatch(leaked.error, /SECRET-token/)
  const xLeak = await x(reply(403, { detail: 'api-secret-value access-secret-value' }))
  assert.doesNotMatch(xLeak.error, /secret-value/)
})

test('X sender posts to /2/tweets with an OAuth 1.0a user-context header', async () => {
  const { calls, fetchImpl } = recorder(reply(201, { data: { id: '1850000000000000001', text: 'hi' } }))
  const send = createXSender({ credentials: X_CREDS, fetchImpl, nonce: () => 'n0nce', timestamp: () => 1_700_000_000 })
  assert.deepEqual(await send({ text: 'hi' }), { status: 'sent', messageId: '1850000000000000001', messageUrl: 'https://x.com/i/status/1850000000000000001' })
  assert.equal(calls[0].url, 'https://api.x.com/2/tweets')
  assert.deepEqual(calls[0].body, { text: 'hi' })
  assert.equal(calls[0].init.headers.authorization, oauthHeader({ method: 'POST', url: X_TWEETS_URL, credentials: X_CREDS, nonce: 'n0nce', timestamp: 1_700_000_000 }))
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
})

// ---------- configuration ----------
const X_ENV = { X_BOT_API_KEY: 'k', X_BOT_API_SECRET: 's', X_BOT_ACCESS_TOKEN: 't', X_BOT_ACCESS_SECRET: 'a' }
const TG_ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '@repoing_launches' }
test('alerts are off unless enabled, a channel is fully configured and a cutoff is set', () => {
  assert.equal(launchAlertsConfig({}), null)
  assert.equal(launchAlertsConfig({ ...X_ENV, ...TG_ENV, LAUNCH_ALERTS_SINCE: '2026-10-01T00:00:00Z' }), null, 'master switch')
  assert.equal(launchAlertsConfig({ LAUNCH_ALERTS_ENABLED: 'true', LAUNCH_ALERTS_SINCE: '2026-10-01T00:00:00Z' }), null, 'no channel')
  assert.equal(launchAlertsConfig({ LAUNCH_ALERTS_ENABLED: 'true', X_CLIENT_ID: 'id', X_CLIENT_SECRET: 'secret', LAUNCH_ALERTS_SINCE: '2026-10-01T00:00:00Z' }), null, 'Connect X credentials are not bot credentials')
  const on = { LAUNCH_ALERTS_ENABLED: 'true', LAUNCH_ALERTS_SINCE: '2026-10-01T00:00:00Z' }
  assert.throws(() => launchAlertsConfig({ ...on, X_BOT_API_KEY: 'k' }), LaunchAlertConfigError)
  assert.throws(() => launchAlertsConfig({ ...on, TELEGRAM_BOT_TOKEN: TOKEN }), /TELEGRAM_CHAT_ID/)
  assert.throws(() => launchAlertsConfig({ ...TG_ENV, LAUNCH_ALERTS_ENABLED: 'true' }), /LAUNCH_ALERTS_SINCE/)
  assert.throws(() => launchAlertsConfig({ ...TG_ENV, ...on, LAUNCH_ALERTS_SINCE: 'yesterday' }), /LAUNCH_ALERTS_SINCE/)
  assert.throws(() => launchAlertsConfig({ ...TG_ENV, ...on, APP_ORIGIN: 'http://repo.ing' }), /HTTPS/)
  assert.throws(() => launchAlertsConfig({ ...TG_ENV, ...on, LAUNCH_ALERTS_MAX_PER_DAY: '0' }), /MAX_PER_DAY/)
  try { launchAlertsConfig({ ...on, TELEGRAM_BOT_TOKEN: TOKEN }) } catch (error) { assert.doesNotMatch(error.message, /SECRET/) }
  const config = launchAlertsConfig({ ...TG_ENV, ...X_ENV, ...on, APP_ORIGIN: 'https://repo.ing/' })
  assert.deepEqual([config.channels, config.since.toISOString(), config.origin, config.maxPerDay], [['telegram', 'x'], '2026-10-01T00:00:00.000Z', 'https://repo.ing', 15])
  assert.deepEqual(config.x, { apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'a' })
  assert.deepEqual(launchAlertsConfig({ ...X_ENV, ...on }).channels, ['x'])
})

// ---------- job (in-memory store that mirrors the SQL claim semantics) ----------
function memoryStore({ markets, now }) {
  const alerts = []
  let locked = false, nextId = 1
  const store = {
    alerts, calls: [],
    async withLock(fn) { if (locked) return { locked: false }; locked = true; try { return { locked: true, value: await fn() } } finally { locked = false } },
    async expireStale(ms) {
      const stale = alerts.filter(a => a.status === 'sending' && a.updatedAt < now() - ms)
      for (const a of stale) Object.assign(a, { status: 'unknown', error: 'interrupted while sending' })
      return stale
    },
    async sentRecently(channel) { return alerts.filter(a => a.channel === channel && ['sending', 'sent', 'unknown'].includes(a.status) && a.updatedAt > now() - 86_400_000).length },
    async candidates({ channel, since, maxAgeMs, maxAttempts, limit }) {
      return markets.filter(m => m.indexedAt >= since && m.indexedAt >= now() - maxAgeMs).flatMap(m => {
        const a = alerts.find(row => row.repo === m.githubRepoId && row.channel === channel)
        if (!a) return [{ ...m }]
        return a.status === 'failed' && a.attempts < maxAttempts && (a.nextAttemptAt ?? 0) <= now() ? [{ ...m, alertId: a.id }] : []
      }).slice(0, limit)
    },
    async claim({ channel, market, maxAttempts }) {
      store.calls.push(['claim', channel, market.githubRepoId])
      if (market.alertId) {
        const a = alerts.find(row => row.id === market.alertId && row.status === 'failed' && row.attempts < maxAttempts)
        if (!a) return null
        Object.assign(a, { status: 'sending', attempts: a.attempts + 1, updatedAt: now() })
        return a.id
      }
      if (alerts.some(row => row.repo === market.githubRepoId && row.channel === channel)) return null
      alerts.push({ id: nextId++, repo: market.githubRepoId, channel, status: 'sending', attempts: 1, updatedAt: now() })
      return nextId - 1
    },
    async finish(id, outcome) {
      const a = alerts.find(row => row.id === id && row.status === 'sending')
      if (a) Object.assign(a, { status: outcome.status, messageId: outcome.messageId, updatedAt: now(), nextAttemptAt: outcome.nextAttemptAt?.getTime() ?? null })
    },
  }
  return store
}

const NOW = Date.parse('2026-10-02T12:00:00Z')
const SINCE = new Date('2026-10-01T00:00:00Z')
const market = (id, hoursAgo) => ({ ...MARKET, githubRepoId: String(id), fullName: `octo/repo-${id}`, mint: `${MINT.slice(0, -2)}${String(id).padStart(2, '0')}`, indexedAt: new Date(NOW - hoursAgo * 3600_000) })
function setup({ markets, channels = ['telegram'], outcomes = {}, config = {} }) {
  let clock = NOW
  const now = () => clock
  const store = memoryStore({ markets, now })
  const sent = [], sleeps = []
  const senders = Object.fromEntries(channels.map(channel => [channel, async ({ text }) => {
    const repo = text.match(/octo\/repo-(\d+)/)[1]
    assert.equal(store.alerts.find(a => a.repo === repo && a.channel === channel).status, 'sending', 'claimed before sending')
    sent.push([channel, repo])
    const queue = outcomes[channel]
    return (Array.isArray(queue) ? queue.shift() : undefined) ?? { status: 'sent', messageId: String(sent.length), messageUrl: `https://example.test/${sent.length}` }
  }]))
  const job = createLaunchAlerts({ store, senders, now, sleep: async ms => { sleeps.push(ms) },
    config: { ...LAUNCH_ALERT_DEFAULTS, channels, since: SINCE, origin: ORIGIN, ...config } })
  return { job, store, sent, sleeps, tick: ms => { clock += ms } }
}

test('only markets indexed after the cutoff and within 24 hours are announced, once each, per channel', async () => {
  const markets = [market(1, 40), market(2, 30), market(3, 5), market(4, 1)]
  markets[1].indexedAt = new Date(SINCE.getTime() - 1) // before the cutoff
  const { job, sent, sleeps } = setup({ markets, channels: ['telegram', 'x'] })
  const first = await job.runOnce()
  assert.deepEqual(sent, [['telegram', '3'], ['telegram', '4'], ['x', '3'], ['x', '4']])
  assert.deepEqual(first.posts.map(p => [p.channel, p.status, p.url]), [['telegram', 'sent', 'https://example.test/1'], ['telegram', 'sent', 'https://example.test/2'],
    ['x', 'sent', 'https://example.test/3'], ['x', 'sent', 'https://example.test/4']])
  assert.deepEqual(sleeps, [LAUNCH_ALERT_DEFAULTS.spacingMs, LAUNCH_ALERT_DEFAULTS.spacingMs], 'spaced between posts')
  assert.deepEqual((await job.runOnce()).posts, [])
  assert.equal(sent.length, 4)
})

test('a backlog is capped per run and per day', async () => {
  const markets = Array.from({ length: 10 }, (_, i) => market(i + 1, 10 - i))
  const { job, sent, tick } = setup({ markets, config: { maxPerRun: 3, maxPerDay: 5 } })
  assert.equal((await job.runOnce()).posts.length, 3)
  tick(60_000)
  assert.equal((await job.runOnce()).posts.length, 2)
  tick(60_000)
  assert.equal((await job.runOnce()).posts.length, 0)
  assert.deepEqual(sent.map(([, repo]) => repo), ['1', '2', '3', '4', '5'], 'oldest first')
})

test('concurrent runs never post the same market twice', async () => {
  const { job, sent } = setup({ markets: [market(1, 1), market(2, 1)] })
  const [a, b] = await Promise.all([job.runOnce(), job.runOnce()])
  assert.deepEqual([a.skipped, b.skipped].filter(Boolean), ['LOCKED'])
  assert.equal(sent.length, 2)
  // Even without the lock, the claim is the gate: a lost claim is skipped.
  const other = setup({ markets: [market(1, 1)] })
  other.store.withLock = async fn => ({ locked: true, value: await fn() })
  await Promise.all([other.job.runOnce(), other.job.runOnce(), other.job.runOnce()])
  assert.equal(other.sent.length, 1)
})

test('ambiguous outcomes are never retried; provider rejections are retried after a delay', async () => {
  const { job, sent, store, tick } = setup({ markets: [market(1, 2), market(2, 1)], channels: ['x'],
    outcomes: { x: [{ status: 'unknown', error: 'network: timeout' }, { status: 'failed', error: 'HTTP 503' }] } })
  const first = await job.runOnce()
  assert.deepEqual(first.posts.map(p => [p.repo, p.status]), [['octo/repo-1', 'unknown']], 'the channel pauses after a failure')
  const second = await job.runOnce()
  assert.deepEqual(second.posts.map(p => [p.repo, p.status]), [['octo/repo-2', 'failed']])
  assert.deepEqual((await job.runOnce()).posts, [], 'failed waits for its retry time')
  tick(LAUNCH_ALERT_DEFAULTS.retryDelayMs)
  assert.deepEqual((await job.runOnce()).posts.map(p => [p.repo, p.status]), [['octo/repo-2', 'sent']])
  assert.deepEqual(sent.map(([, repo]) => repo), ['1', '2', '2'])
  assert.deepEqual(store.alerts.map(a => [a.repo, a.status, a.attempts]), [['1', 'unknown', 1], ['2', 'sent', 2]])
  tick(3600_000)
  await job.runOnce()
  assert.equal(sent.length, 3, 'the unknown post is left for an operator')
})

test('rate limits wait for the provider reset; attempts are capped', async () => {
  const failed = { status: 'failed', error: 'HTTP 429' }
  const { job, sent, store, tick } = setup({ markets: [market(1, 1)], outcomes: { telegram: [{ ...failed, retryAfterMs: 3600_000 }, failed, failed, failed] } })
  await job.runOnce()
  tick(LAUNCH_ALERT_DEFAULTS.retryDelayMs)
  await job.runOnce()
  assert.equal(sent.length, 1, 'retry-after honoured')
  for (let i = 0; i < 5; i++) { tick(3600_000); await job.runOnce() }
  assert.equal(sent.length, LAUNCH_ALERT_DEFAULTS.maxAttempts)
  assert.deepEqual(store.alerts.map(a => [a.status, a.attempts]), [['failed', 3]])
})

test('a claim left "sending" by a crashed run becomes unknown and is never re-sent', async () => {
  const { job, sent, store, tick } = setup({ markets: [market(1, 1)] })
  await store.claim({ channel: 'telegram', market: { githubRepoId: '1', mint: MINT }, maxAttempts: 3 })
  assert.deepEqual((await job.runOnce()).posts, [])
  tick(LAUNCH_ALERT_DEFAULTS.staleSendingMs + 1)
  assert.deepEqual((await job.runOnce()).interrupted, [{ channel: 'telegram', mint: undefined, status: 'unknown' }])
  assert.equal(sent.length, 0)
  assert.equal(store.alerts[0].status, 'unknown')
})

test('a sender that throws is treated as possibly posted; a missing table skips quietly', async () => {
  const { job, store } = setup({ markets: [market(1, 1)] })
  const broken = createLaunchAlerts({ store, config: { ...LAUNCH_ALERT_DEFAULTS, channels: ['telegram'], since: SINCE, origin: ORIGIN },
    senders: { telegram: async () => { throw Error('boom') } }, sleep: async () => {}, now: () => NOW })
  assert.deepEqual((await broken.runOnce()).posts.map(p => p.status), ['unknown'])
  assert.deepEqual((await job.runOnce()).posts, [])
  const missing = createLaunchAlerts({ store: { withLock: async () => { throw Object.assign(Error('relation "launch_alerts" does not exist'), { code: '42P01' }) } },
    config: { ...LAUNCH_ALERT_DEFAULTS, channels: ['telegram'], since: SINCE, origin: ORIGIN }, senders: {} })
  assert.deepEqual(await missing.runOnce(), { skipped: 'LAUNCH_ALERTS_NOT_MIGRATED' })
})

// ---------- real PostgreSQL ----------
// Throwaway local database (all committed migrations): selection (cutoff, age, finality, dedupe), claims, retries, lock.
const url = process.env.LAUNCH_ALERTS_TEST_DATABASE_URL
test('real PostgreSQL: launch alert store', { skip: !url }, async () => {
  const [{ default: pg }, { drizzle }, { migrate }] = await Promise.all([import('pg'), import('drizzle-orm/node-postgres'), import('drizzle-orm/node-postgres/migrator')])
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Disposable local test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    const base = 9_100_000_000 + (Date.now() % 1_000_000) * 100
    const since = new Date(Date.now() - 6 * 3600_000)
    const insert = async (offset, { hoursAgo = 1, status = 'confirmed', finality = 'finalized', indexed = true, description = 'Hello @you' } = {}) => {
      const id = base + offset, mint = `LA${id}`.padEnd(43, 'x')
      await pool.query(`insert into repositories (github_repo_id, owner, name, full_name, description, stars, forks, archived, github_updated_at)
        values ($1, 'octo', $2, $3, $4, 1234, 0, false, now())`, [id, `repo-${offset}`, `octo/repo-${offset}`, description])
      await pool.query(`insert into markets (github_repo_id, status, mint, pool, launcher_wallet, creator_wallet, token_name, token_symbol, launch_signature,
        launch_slot, launch_finality, indexed_at, last_verified_at) values ($1, $2, $3, $4, 'w', 'w', 'Repo', 'REPO', $5, 1, $6, $7, now())`,
      [id, status, mint, `P${id}`.padEnd(43, 'y'), `S${id}`.padEnd(87, 'z'), finality, indexed ? new Date(Date.now() - hoursAgo * 3600_000) : null])
      return String(id)
    }
    const fresh = await insert(1, { hoursAgo: 2 })
    const newest = await insert(2, { hoursAgo: 1 })
    await insert(3, { hoursAgo: 7 }) // before the cutoff
    await insert(4, { hoursAgo: 1, status: 'submitted', indexed: false })
    await insert(5, { hoursAgo: 1, finality: 'confirmed', indexed: false })
    const store = createLaunchAlertStore(pool)
    const mine = rows => rows.filter(row => BigInt(row.githubRepoId) >= BigInt(base) && BigInt(row.githubRepoId) < BigInt(base + 100))
    const query = channel => store.candidates({ channel, since, maxAgeMs: 86_400_000, maxAttempts: 3, limit: 100 }).then(mine)
    const found = await query('x')
    assert.deepEqual(found.map(row => row.githubRepoId), [fresh, newest], 'finalized, indexed, after the cutoff, oldest first')
    assert.deepEqual([found[0].fullName, found[0].tokenSymbol, found[0].stars, found[0].description, found[0].alertId], ['octo/repo-1', 'REPO', 1234, 'Hello @you', null])
    assert.equal(mine(await store.candidates({ channel: 'x', since, maxAgeMs: 90 * 60_000, maxAttempts: 3, limit: 100 })).length, 1, 'max age')

    const claims = await Promise.all([0, 1, 2].map(() => store.claim({ channel: 'x', market: found[0], maxAttempts: 3 })))
    assert.equal(claims.filter(Boolean).length, 1, 'exactly one concurrent claim wins')
    const id = claims.find(Boolean)
    assert.deepEqual((await query('x')).map(row => row.githubRepoId), [newest], 'claimed markets are not candidates')
    assert.equal((await query('telegram')).length, 2, 'channels are independent')
    assert.equal(await store.sentRecently('x') >= 1, true)
    await store.finish(id, { status: 'sent', messageId: '1', messageUrl: 'https://x.com/i/status/1' })
    const { rows: [row] } = await pool.query('select status, sent_at, message_url from launch_alerts where id=$1', [id])
    assert.deepEqual([row.status, Boolean(row.sent_at), row.message_url], ['sent', true, 'https://x.com/i/status/1'])

    const retry = await store.claim({ channel: 'x', market: (await query('x'))[0], maxAttempts: 3 })
    await store.finish(retry, { status: 'failed', error: 'HTTP 429', nextAttemptAt: new Date(Date.now() + 60_000) })
    assert.equal((await query('x')).length, 0, 'waits for next_attempt_at')
    await pool.query(`update launch_alerts set next_attempt_at = now() - interval '1 second' where id=$1`, [retry])
    const again = (await query('x'))[0]
    assert.equal(again.alertId, retry)
    assert.equal(await store.claim({ channel: 'x', market: again, maxAttempts: 3 }), retry)
    assert.equal(await store.claim({ channel: 'x', market: again, maxAttempts: 3 }), null, 'a retry is claimed once')
    await pool.query(`update launch_alerts set updated_at = now() - interval '11 minutes' where id=$1`, [retry])
    assert.ok((await store.expireStale(10 * 60_000)).some(r => r.id === retry))
    const { rows: [stale] } = await pool.query('select status, attempts from launch_alerts where id=$1', [retry])
    assert.deepEqual([stale.status, stale.attempts], ['unknown', 2])
    assert.equal((await query('x')).length, 0, 'unknown is never retried')

    await assert.rejects(pool.query(`insert into launch_alerts (github_repo_id, mint, channel, status) values ($1, 'm', 'x', 'sending')`, [fresh]), /launch_alerts_repo_channel_unique/)
    await assert.rejects(pool.query(`insert into launch_alerts (github_repo_id, mint, channel, status) values ($1, 'm', 'email', 'sending')`, [fresh]))
    await assert.rejects(pool.query(`insert into launch_alerts (github_repo_id, mint, channel, status) values ($1, 'm', 'telegram', 'sent')`, [fresh]), /launch_alerts_sent_check/)

    const inner = await store.withLock(async () => (await store.withLock(async () => 'nested')).locked)
    assert.deepEqual(inner, { locked: true, value: false }, 'a second holder is refused while the lock is held')

    // Full job against the database with a fake sender.
    const sent = []
    const job = createLaunchAlerts({ store, sleep: async () => {}, senders: { telegram: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: String(sent.length) } } },
      config: { ...LAUNCH_ALERT_DEFAULTS, channels: ['telegram'], since, origin: ORIGIN, maxPerRun: 100, maxPerDay: 500 } })
    await Promise.all([job.runOnce(), job.runOnce()])
    const ours = sent.filter(text => /octo\/repo-[12] —/.test(text))
    assert.equal(ours.length, 2)
    assert.match(ours[0], /· Hello you\n/)
    await job.runOnce()
    assert.equal(sent.filter(text => /octo\/repo-[12] —/.test(text)).length, 2, 'never posted twice')
  } finally { await pool.end() }
})
