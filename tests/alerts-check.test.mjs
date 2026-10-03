import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { checkAlerts, formatCheck, X_ME_URL } from '../scripts/alerts-check.mjs'
import { TELEGRAM_API } from '../src/launch-alerts-senders.mjs'

// scripts/alerts-check.mjs against a fake fetch: never the real APIs, and only their read endpoints are ever asked.
const NOW = Date.parse('2026-10-03T12:00:00Z')
const TOKEN = '7012345678:AAH-telegram-SECRET-token-value'
const SECRETS = { X_BOT_API_KEY: 'xapikey-SECRET-0001', X_BOT_API_SECRET: 'xapisecret-SECRET-0002', X_BOT_ACCESS_TOKEN: '1850000000-accesstoken-SECRET-0003',
  X_BOT_ACCESS_SECRET: 'xaccesssecret-SECRET-0004', TELEGRAM_BOT_TOKEN: TOKEN }
const ENV = { ...SECRETS, TELEGRAM_CHAT_ID: '@repoing_launches', LAUNCH_ALERTS_ENABLED: 'true', LAUNCH_ALERTS_SINCE: '2026-10-03T00:00:00Z',
  LAUNCH_ALERTS_MAX_PER_DAY: '5', GRADUATION_ALERTS_ENABLED: 'true', GRADUATION_ALERTS_SINCE: '2026-10-03T00:00:00Z', GRADUATION_ALERTS_MAX_PER_DAY: '5' }
const READ_ENDPOINTS = [X_ME_URL, `${TELEGRAM_API}/bot${TOKEN}/getMe`, `${TELEGRAM_API}/bot${TOKEN}/getChat`, `${TELEGRAM_API}/bot${TOKEN}/getChatMember`]

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const telegramOk = result => json({ ok: true, result })
// A fake X and Telegram: each route answers from `answers`, every call is recorded.
function providers(answers = {}) {
  const calls = []
  const routes = {
    xMe: () => json({ data: { id: '1850000000', name: 'repo.ing', username: 'repoing' } }, 200, { 'x-access-level': 'read-write' }),
    getMe: () => telegramOk({ id: 7012345678, is_bot: true, first_name: 'repo.ing alerts', username: 'repoing_alerts_bot' }),
    getChat: () => telegramOk({ id: -1001234567890, type: 'channel', title: 'repo.ing launches', username: 'repoing_launches' }),
    getChatMember: () => telegramOk({ status: 'administrator', can_post_messages: true, user: { id: 7012345678, is_bot: true } }),
    ...answers,
  }
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, init })
    const { pathname, searchParams } = new URL(url)
    if (String(url) === X_ME_URL) return routes.xMe()
    return routes[pathname.split('/').at(-1)](Object.fromEntries(searchParams))
  }
  return { calls, fetchImpl }
}
const run = (env = ENV, answers = {}) => {
  const { calls, fetchImpl } = providers(answers)
  return checkAlerts({ env, fetchImpl, now: NOW }).then(report => ({ report, calls, text: formatCheck(report) }))
}
const errors = report => report.findings.filter(finding => finding.level === 'error').map(finding => `${finding.area}: ${finding.message}`)
const noSecrets = text => { for (const secret of Object.values(SECRETS)) assert.equal(text.includes(secret), false, 'a secret value was printed') }

test('a read-write X account and a Telegram channel admin allowed to post pass, through read endpoints only', async () => {
  // Arrange + Act
  const { report, calls, text } = await run()

  // Assert
  assert.equal(report.ok, true, errors(report).join('\n'))
  assert.match(text, /✓ X: the keys work: posts would come from @repoing\n/)
  assert.match(text, /✓ X: access level read-write: @repoing can post/)
  assert.match(text, /✓ Telegram: @repoing_alerts_bot can post in the channel "repo\.ing launches" \(administrator\)/)
  assert.match(text, /✓ Telegram: each post's link is recorded \(https:\/\/t\.me\/repoing_launches\/<message id>\)/)
  assert.match(text, /· X: up to 10 posts per 24 hours with both on \(5 launch \+ 5 graduation\)\. Each carries a link, which X bills from your prepaid API credits/)
  assert.match(text, /All checks passed\. Nothing was posted\.\n$/)
  assert.deepEqual(calls.map(call => [call.method, call.url.split('?')[0]]), READ_ENDPOINTS.map(url => ['GET', url]))
  assert.deepEqual(Object.fromEntries(new URL(calls[3].url).searchParams), { chat_id: '@repoing_launches', user_id: '7012345678' })
  assert.match(calls[0].init.headers.authorization, /^OAuth oauth_consumer_key="xapikey-SECRET-0001", oauth_nonce="[0-9a-f]{32}", oauth_signature_method="HMAC-SHA1", .*oauth_signature="[^"]+"$/)
  assert.equal(calls.every(call => call.init.body === undefined && call.init.redirect === 'error'), true, 'no body, no redirects: nothing is sent')
  noSecrets(text)
})

test('a read-only X token fails with the fix: Read and write, then regenerate the access token and secret', async () => {
  // Arrange
  const readOnly = { xMe: () => json({ data: { username: 'repoing' } }, 200, { 'x-access-level': 'read' }) }
  const unconfirmed = { xMe: () => json({ data: { username: 'repoing' } }) }

  // Act
  const [denied, missing] = await Promise.all([run(ENV, readOnly), run(ENV, unconfirmed)])

  // Assert
  assert.equal(denied.report.ok, false)
  assert.deepEqual(errors(denied.report), ['X: access level read: @repoing cannot post. In the X Developer Console open the app, set User authentication '
    + 'settings → App permissions to "Read and write" and save; then under Keys and tokens regenerate the Access Token and Secret (tokens made before '
    + 'the change stay read-only) and put the new pair in X_BOT_ACCESS_TOKEN and X_BOT_ACCESS_SECRET.'])
  assert.match(denied.text, /1 problem found\. Nothing was posted\.\n$/)
  assert.equal(missing.report.ok, false)
  assert.match(errors(missing.report)[0], /^X: X did not confirm write access \(x-access-level missing\)\. In the X Developer Console/)
})

test('X rejections and network failures are problems, with no secret echoed back', async () => {
  // Arrange
  const echo = `bad ${SECRETS.X_BOT_API_SECRET} and ${SECRETS.X_BOT_ACCESS_SECRET}`
  const cases = {
    unauthorized: { xMe: () => json({ title: 'Unauthorized', detail: echo, status: 401 }, 401) },
    forbidden: { xMe: () => json({ title: 'Client Forbidden', reason: 'client-not-enrolled', detail: 'attach the app to a Project' }, 403) },
    limited: { xMe: () => json({ title: 'Too Many Requests' }, 429) },
    offline: { xMe: () => { throw new TypeError('fetch failed', { cause: Object.assign(Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }) } },
    slow: { xMe: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') } },
  }

  // Act
  const results = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([name, answers]) => [name, await run(ENV, answers)])))

  // Assert
  assert.match(errors(results.unauthorized.report)[0], /^X: X refused the keys \(HTTP 401: Unauthorized — bad \[redacted\] and \[redacted\]\)\. Check that X_BOT_API_KEY/)
  assert.match(errors(results.forbidden.report)[0], /HTTP 403: Client Forbidden — client-not-enrolled — attach the app to a Project\)\. The app must belong to a Project .*needs X API credits \(pay-per-use/)
  assert.deepEqual(errors(results.limited.report), ['X: X rate-limited this check (HTTP 429): try again later'])
  assert.deepEqual(errors(results.offline.report), ['X: could not reach api.x.com (ENOTFOUND), so nothing was checked'])
  assert.deepEqual(errors(results.slow.report), ['X: could not reach api.x.com (timeout), so nothing was checked'])
  for (const { report, text } of Object.values(results)) { assert.equal(report.ok, false); noSecrets(text) }
})

test('a Telegram bot that cannot post where TELEGRAM_CHAT_ID points fails with what to change', async () => {
  // Arrange
  const member = status => ({ getChatMember: () => telegramOk({ status, user: { id: 7012345678 } }) })
  const cases = {
    noPostRight: { getChatMember: () => telegramOk({ status: 'administrator', can_post_messages: false }) },
    notAdmin: member('member'),
    left: member('left'),
    notFound: { getChat: () => json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400) },
    badToken: { getMe: () => json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401) },
    person: { getChat: () => telegramOk({ id: 5, type: 'private', first_name: 'Someone' }) },
    mutedGroup: { getChat: () => telegramOk({ id: -100, type: 'supergroup', title: 'Lounge', permissions: { can_send_messages: false } }), ...member('member') },
  }

  // Act
  const results = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([name, answers]) => [name, (await run(ENV, answers)).report])))

  // Assert
  assert.deepEqual(errors(results.noPostRight), ['Telegram: @repoing_alerts_bot is an administrator of the channel "repo.ing launches" without "Post messages": '
    + 'in the channel open Administrators → @repoing_alerts_bot and turn on Post messages'])
  assert.deepEqual(errors(results.notAdmin), ['Telegram: @repoing_alerts_bot is not an administrator of the channel "repo.ing launches" (status member): '
    + 'open the channel → Administrators → Add Admin, choose @repoing_alerts_bot and allow Post messages'])
  assert.match(errors(results.left)[0], /\(status left\)/)
  assert.deepEqual(errors(results.notFound), ['Telegram: @repoing_alerts_bot cannot open TELEGRAM_CHAT_ID @repoing_launches (Bad Request: chat not found). '
    + "Add @repoing_alerts_bot to the channel as an administrator, and set TELEGRAM_CHAT_ID to @channelusername (public channel) or the channel's -100… id"])
  assert.deepEqual(errors(results.badToken), ['Telegram: Telegram refused TELEGRAM_BOT_TOKEN: copy the token again from @BotFather (/mybots → the bot → API Token)'])
  assert.match(errors(results.person)[0], /TELEGRAM_CHAT_ID is a private chat, not a channel or group/)
  assert.match(errors(results.mutedGroup)[0], /cannot send messages in the group "Lounge" \(status member\): make it an administrator/)
  for (const report of Object.values(results)) assert.equal(report.ok, false)
})

test('a secret pasted into the wrong variable is never echoed, not even in part', async () => {
  // Arrange: the bot token pasted as the chat id too (Telegram cannot find such a chat), and an API key as a switch.
  const env = { ...ENV, TELEGRAM_CHAT_ID: TOKEN, LAUNCH_ALERTS_ENABLED: SECRETS.X_BOT_API_KEY }
  const notFound = { getChat: () => json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400) }

  // Act
  const { report, text } = await run(env, notFound)

  // Assert
  assert.equal(report.ok, false)
  assert.match(text, /cannot open TELEGRAM_CHAT_ID \(hidden: not an @username or a numeric id\) \(Bad Request: chat not found\)/)
  assert.match(text, /! Launch alerts: LAUNCH_ALERTS_ENABLED is set to something else: only exactly "true" turns it on/)
  for (const secret of [TOKEN, SECRETS.X_BOT_API_KEY]) assert.equal(text.includes(secret.slice(0, 12)), false, 'no prefix of a secret either')
})

test('a group member allowed to send passes; a numeric chat id is told how to record post links', async () => {
  // Arrange
  const group = { getChat: () => telegramOk({ id: -1009, type: 'supergroup', title: 'repo.ing chat', username: 'repoing_chat', permissions: { can_send_messages: true } }),
    getChatMember: () => telegramOk({ status: 'member' }) }

  // Act
  const { report, text } = await run({ ...ENV, TELEGRAM_CHAT_ID: '-1009' }, group)

  // Assert
  assert.equal(report.ok, true, errors(report).join('\n'))
  assert.match(text, /✓ Telegram: @repoing_alerts_bot can post in the group "repo\.ing chat" \(member\)/)
  assert.match(text, /· Telegram: set TELEGRAM_CHAT_ID=@repoing_chat instead of the numeric id so each post's public link is recorded/)
})

test('half-configured channels are problems that name only the missing variables, and nothing is called for them', async () => {
  // Arrange
  const halfTelegram = { ...ENV, TELEGRAM_CHAT_ID: '' }, halfX = { ...ENV, X_BOT_ACCESS_TOKEN: ' ', X_BOT_ACCESS_SECRET: undefined }

  // Act
  const [telegram, x, none] = await Promise.all([run(halfTelegram), run(halfX), run({ LAUNCH_ALERTS_ENABLED: 'true', LAUNCH_ALERTS_SINCE: '2026-10-03T00:00:00Z' })])

  // Assert
  assert.ok(errors(telegram.report).includes('Telegram: half configured: TELEGRAM_CHAT_ID missing (it needs TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)'))
  assert.deepEqual(telegram.calls.map(call => call.url), [X_ME_URL], 'X is still checked; Telegram is not called')
  assert.ok(errors(x.report).includes('X: half configured: X_BOT_ACCESS_TOKEN, X_BOT_ACCESS_SECRET missing (it needs X_BOT_API_KEY, X_BOT_API_SECRET, X_BOT_ACCESS_TOKEN, X_BOT_ACCESS_SECRET)'))
  assert.equal(x.calls.some(call => call.url === X_ME_URL), false)
  for (const result of [telegram, x]) {
    assert.ok(errors(result.report).some(error => error.startsWith('Launch alerts: the worker would not start it: ')), 'the worker refuses a half-configured channel')
    noSecrets(result.text)
  }
  assert.deepEqual(errors(none.report), ['Launch alerts: LAUNCH_ALERTS_ENABLED=true but no channel is fully configured, so nothing would be posted',
    'Channels: none is configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, and/or X_BOT_API_KEY, X_BOT_API_SECRET, X_BOT_ACCESS_TOKEN, X_BOT_ACCESS_SECRET'])
  assert.deepEqual(none.calls, [])
})

test('switches, cutoffs and caps are checked with the jobs\' own rules; turned off is fine', async () => {
  // Arrange
  const off = { ...SECRETS, TELEGRAM_CHAT_ID: '@repoing_launches' }
  const broken = { ...off, LAUNCH_ALERTS_ENABLED: 'true', GRADUATION_ALERTS_ENABLED: 'yes', GRADUATION_ALERTS_SINCE: 'tomorrow', LAUNCH_ALERTS_MAX_PER_DAY: '0',
    APP_ORIGIN: 'http://repo.ing' }
  const later = { ...ENV, LAUNCH_ALERTS_SINCE: '2026-10-05T16:00:00Z', HF_MARKETS_ENABLED: 'true' }

  // Act
  const [quiet, bad, scheduled] = await Promise.all([run(off), run(broken), run(later)])

  // Assert
  assert.equal(quiet.report.ok, true, errors(quiet.report).join('\n'))
  assert.match(quiet.text, /· Launch alerts: LAUNCH_ALERTS_SINCE is not set yet: set it to the go-live time when turning this on/)
  assert.match(quiet.text, /✓ Launch alerts: at most 15 posts per channel per 24 hours \(the default; LAUNCH_ALERTS_MAX_PER_DAY changes it\)/)
  assert.match(quiet.text, /· Graduation alerts: off: set GRADUATION_ALERTS_ENABLED=true to turn it on/)
  assert.match(quiet.text, /· Model markets: Hugging Face model markets are left out: set HF_MARKETS_ENABLED=true on the worker/)
  assert.deepEqual(errors(bad.report).slice(0, 4), ['Links: APP_ORIGIN must be HTTPS', 'Launch alerts: LAUNCH_ALERTS_SINCE is required: set it to the go-live time in UTC, e.g. 2026-10-03T12:00:00Z',
    'Launch alerts: LAUNCH_ALERTS_MAX_PER_DAY must be an integer from 1 to 500', 'Launch alerts: the worker would not start it: LAUNCH_ALERTS_SINCE must be an ISO timestamp, e.g. 2026-10-01T00:00:00Z'])
  assert.ok(errors(bad.report).includes('Graduation alerts: GRADUATION_ALERTS_SINCE must be an ISO timestamp, e.g. 2026-10-01T00:00:00Z'))
  assert.match(bad.text, /! Graduation alerts: GRADUATION_ALERTS_ENABLED is "yes": only exactly "true" turns it on/)
  assert.equal(scheduled.report.ok, true)
  assert.match(scheduled.text, /✓ Launch alerts: LAUNCH_ALERTS_SINCE is 2026-10-05T16:00:00\.000Z, in the future: nothing is posted before then/)
  assert.match(scheduled.text, /✓ Launch alerts: on: the worker posts to Telegram and X/)
  assert.match(scheduled.text, /· Model markets: Hugging Face model markets are included/)
})

test('the command exits 1 on a problem and prints no secret value', () => {
  // Arrange: no channel at all, so nothing is called.
  const env = { PATH: process.env.PATH, LAUNCH_ALERTS_ENABLED: 'false' }

  // Act
  const result = spawnSync(process.execPath, ['scripts/alerts-check.mjs'], { env, encoding: 'utf8' })

  // Assert
  assert.equal(result.status, 1)
  assert.match(result.stdout, /✗ Channels: none is configured/)
  assert.match(result.stdout, /1 problem found\. Nothing was posted\.\n$/)
})
