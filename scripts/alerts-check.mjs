// Checks the launch and graduation alert settings and every configured channel WITHOUT posting (docs/ALERTS_SETUP.md):
//   settings  the jobs' own config functions: switches, cutoffs, daily caps, APP_ORIGIN, each channel all-or-nothing
//   X         GET /2/users/me with the bot's OAuth 1.0a keys: the posting @username and the x-access-level header
//   Telegram  getMe, getChat(TELEGRAM_CHAT_ID) and getChatMember(chat, bot): whether the bot may post there
// Only those read endpoints are called. Secret values are never printed. Exits 1 on any problem.
//   node scripts/alerts-check.mjs
import { pathToFileURL } from 'node:url'
import { hfMarketsEnabled } from '../src/hf-launch.mjs'
import { ALERT_CHANNEL_KEYS, alertChannels, alertMaxPerDay, alertOrigin, alertSince, LAUNCH_ALERT_DEFAULTS, LaunchAlertConfigError,
  launchAlertsConfig } from '../src/launch-alerts.mjs'
import { oauthHeader, TELEGRAM_API } from '../src/launch-alerts-senders.mjs'
import { MILESTONE_ALERT_DEFAULTS, milestoneAlertsConfig } from '../src/milestone-alerts.mjs'

export const X_ME_URL = 'https://api.x.com/2/users/me'
const TIMEOUT_MS = 15_000
// x-access-level values that allow POST /2/tweets.
const X_WRITE_LEVELS = new Set(['read-write', 'read-write-directmessages'])
export const X_READ_ONLY_FIX = 'In the X Developer Console open the app, set User authentication settings → App permissions to "Read and write" '
  + 'and save; then under Keys and tokens regenerate the Access Token and Secret (tokens made before the change stay read-only) '
  + 'and put the new pair in X_BOT_ACCESS_TOKEN and X_BOT_ACCESS_SECRET.'
// The sender records a post's link only for a public @username (src/launch-alerts-senders.mjs).
const PUBLIC_CHANNEL = /^@[A-Za-z0-9_]{5,32}$/
const LABEL = { telegram: 'Telegram', x: 'X' }
const JOBS = [
  { name: 'Launch alerts', enabled: 'LAUNCH_ALERTS_ENABLED', since: 'LAUNCH_ALERTS_SINCE', max: 'LAUNCH_ALERTS_MAX_PER_DAY',
    fallback: LAUNCH_ALERT_DEFAULTS.maxPerDay, config: launchAlertsConfig },
  { name: 'Graduation alerts', enabled: 'GRADUATION_ALERTS_ENABLED', since: 'GRADUATION_ALERTS_SINCE', max: 'GRADUATION_ALERTS_MAX_PER_DAY',
    fallback: MILESTONE_ALERT_DEFAULTS.maxPerDay, config: milestoneAlertsConfig },
]

const redact = (text, secrets) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), String(text))
// Provider text is printed: one line, no controls, bounded.
const plain = (value, max = 160) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
// A timeout is a DOMException whose legacy code (23) says nothing, so its name is read first.
const networkCode = error => ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : error?.cause?.code ?? error?.code ?? error?.name ?? 'error'
// Settings are echoed only when they look like what belongs there: a secret pasted into the wrong variable never is.
const shownChat = chatId => /^@[A-Za-z0-9_]{5,32}$/.test(chatId) || /^-?\d{1,20}$/.test(chatId) ? chatId : '(hidden: not an @username or a numeric id)'
const shownSwitch = value => /^[\w-]{1,12}$/.test(value) ? `"${value}"` : 'set to something else'

// ---------- settings ----------
function checkSettings(env, now, add) {
  try { add('ok', 'Links', `posts link to ${alertOrigin(env)}/token/<mint>`) } catch (error) { add('error', 'Links', error.message) }
  const caps = {}
  for (const job of JOBS) {
    const raw = env[job.enabled], on = raw === 'true'
    if (raw && raw !== 'true' && raw !== 'false') add('warn', job.name, `${job.enabled} is ${shownSwitch(raw)}: only exactly "true" turns it on`)
    if (env[job.since]?.trim()) {
      try {
        const since = alertSince(env, job.since)
        add('ok', job.name, since.getTime() > now ? `${job.since} is ${since.toISOString()}, in the future: nothing is posted before then`
          : `${job.since} is ${since.toISOString()}: nothing from before it is ever posted`)
      } catch (error) { add('error', job.name, error.message) }
    } else if (on) add('error', job.name, `${job.since} is required: set it to the go-live time in UTC, e.g. ${new Date(now).toISOString().slice(0, 19)}Z`)
    else add('info', job.name, `${job.since} is not set yet: set it to the go-live time when turning this on`)
    try {
      caps[job.name] = alertMaxPerDay(env, job.max, job.fallback)
      add('ok', job.name, `at most ${caps[job.name]} posts per channel per 24 hours${env[job.max]?.trim() ? '' : ` (the default; ${job.max} changes it)`}`)
    } catch (error) { add('error', job.name, error.message) }
    if (!on) { add('info', job.name, `off: set ${job.enabled}=true to turn it on`); continue }
    try {
      const config = job.config(env)
      if (config) add('ok', job.name, `on: the worker posts to ${config.channels.map(channel => LABEL[channel]).join(' and ')}`)
      else add('error', job.name, `${job.enabled}=true but no channel is fully configured, so nothing would be posted`)
    } catch (error) { add('error', job.name, `the worker would not start it: ${error instanceof LaunchAlertConfigError ? error.message : 'invalid settings'}`) }
  }
  add('info', 'Model markets', hfMarketsEnabled(env)
    ? 'Hugging Face model markets are included (HF_MARKETS_ENABLED=true: keep it the same as on web, where the posts link)'
    : 'Hugging Face model markets are left out: set HF_MARKETS_ENABLED=true on the worker, as on web, to post them too')
  return caps
}

// Each channel on its own, with the jobs' rule (alertChannels): all of its variables or none. Names only, never values.
function configuredChannels(env, add) {
  const found = {}
  for (const [channel, keys] of Object.entries(ALERT_CHANNEL_KEYS)) {
    try {
      const config = alertChannels(Object.fromEntries(keys.map(key => [key, env[key]])))
      if (config.channels.length) found[channel] = config[channel]
      else add('info', LABEL[channel], `not configured (${keys.join(', ')})`)
    } catch (error) {
      if (!(error instanceof LaunchAlertConfigError)) throw error
      add('error', LABEL[channel], `half configured: ${keys.filter(key => !env[key]?.trim()).join(', ')} missing (it needs ${keys.join(', ')})`)
    }
  }
  if (!found.telegram && !found.x) add('error', 'Channels', `none is configured: set ${ALERT_CHANNEL_KEYS.telegram.join(' and ')}, and/or ${ALERT_CHANNEL_KEYS.x.join(', ')}`)
  return found
}

// ---------- X ----------
const xDetail = body => {
  const text = plain([body?.title, body?.reason, body?.detail, body?.errors?.[0]?.message].filter(value => typeof value === 'string').join(' — '))
  return text ? `: ${text}` : ''
}

async function checkX({ credentials, fetchImpl, add }) {
  let response, body
  try {
    response = await fetchImpl(X_ME_URL, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: oauthHeader({ method: 'GET', url: X_ME_URL, credentials }) } })
    body = await response.json().catch(() => null)
  } catch (error) { return add('error', 'X', `could not reach api.x.com (${networkCode(error)}), so nothing was checked`) }
  if (response.status === 401) return add('error', 'X', `X refused the keys (HTTP 401${xDetail(body)}). Check that X_BOT_API_KEY and X_BOT_API_SECRET `
    + 'are from the same app as the access token, regenerate the Access Token and Secret if they were revoked, and check the server clock')
  if (response.status === 403) return add('error', 'X', `X refused the request (HTTP 403${xDetail(body)}). The app must belong to a Project in the X `
    + 'Developer Console, and the account needs X API credits (pay-per-use, bought in the Developer Console) before any call works, posting included')
  if (response.status === 429) return add('error', 'X', 'X rate-limited this check (HTTP 429): try again later')
  if (!response.ok) return add('error', 'X', `X answered HTTP ${response.status}${xDetail(body)}`)
  const username = body?.data?.username
  const account = typeof username === 'string' && /^\w{1,15}$/.test(username) ? `@${username}` : 'the account'
  add('ok', 'X', `the keys work: posts would come from ${account}`)
  const level = response.headers.get('x-access-level')
  if (X_WRITE_LEVELS.has(level)) add('ok', 'X', `access level ${level}: ${account} can post`)
  else if (level === 'read') add('error', 'X', `access level read: ${account} cannot post. ${X_READ_ONLY_FIX}`)
  else add('error', 'X', `X did not confirm write access (x-access-level ${level ? `"${plain(level, 40)}"` : 'missing'}). ${X_READ_ONLY_FIX}`)
}

// ---------- Telegram ----------
async function telegram({ token, method, params, fetchImpl }) {
  const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}${params ? `?${new URLSearchParams(params)}` : ''}`,
    { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  const body = await response.json().catch(() => null)
  return body?.ok === true && body.result ? { ok: true, result: body.result } : { ok: false, status: response.status, description: plain(body?.description ?? `HTTP ${response.status}`) }
}

// Whether a member may send to the chat: a channel needs an admin with "Post messages"; a group any member allowed to send.
function postingRights(chat, member) {
  if (member.status === 'creator') return true
  if (chat.type === 'channel') return member.status === 'administrator' && member.can_post_messages === true
  if (member.status === 'administrator') return true
  if (member.status === 'member') return chat.permissions?.can_send_messages !== false
  return member.status === 'restricted' && member.is_member !== false && member.can_send_messages === true
}

async function checkTelegram({ token, chatId, fetchImpl, add }) {
  const call = (method, params = null) => telegram({ token, method, params, fetchImpl })
  try {
    const me = await call('getMe')
    if (!me.ok) return add('error', 'Telegram', [401, 404].includes(me.status)
      ? 'Telegram refused TELEGRAM_BOT_TOKEN: copy the token again from @BotFather (/mybots → the bot → API Token)' : `getMe failed (${me.description})`)
    const bot = /^\w{1,64}$/.test(String(me.result.username)) ? `@${me.result.username}` : 'the bot'
    add('ok', 'Telegram', `the token works: posts would come from ${bot}`)
    const chat = await call('getChat', { chat_id: chatId })
    if (!chat.ok) return add('error', 'Telegram', `${bot} cannot open TELEGRAM_CHAT_ID ${shownChat(chatId)} (${chat.description}). Add ${bot} to the channel `
      + 'as an administrator, and set TELEGRAM_CHAT_ID to @channelusername (public channel) or the channel\'s -100… id')
    const { type, title, username } = chat.result
    if (!['channel', 'supergroup', 'group'].includes(type)) return add('error', 'Telegram', `TELEGRAM_CHAT_ID is a ${plain(type, 20)} chat, not a channel or `
      + 'group: set it to the channel (@channelusername or its -100… id)')
    const where = `the ${type === 'channel' ? 'channel' : 'group'} "${plain(title, 80)}"`
    const member = await call('getChatMember', { chat_id: chatId, user_id: me.result.id })
    if (!member.ok) return add('error', 'Telegram', `getChatMember failed for ${where} (${member.description})`)
    if (postingRights(chat.result, member.result)) add('ok', 'Telegram', `${bot} can post in ${where} (${member.result.status})`)
    else if (type === 'channel' && member.result.status === 'administrator') add('error', 'Telegram', `${bot} is an administrator of ${where} without `
      + `"Post messages": in the channel open Administrators → ${bot} and turn on Post messages`)
    else if (type === 'channel') add('error', 'Telegram', `${bot} is not an administrator of ${where} (status ${plain(member.result.status, 20)}): open `
      + `the channel → Administrators → Add Admin, choose ${bot} and allow Post messages`)
    else add('error', 'Telegram', `${bot} cannot send messages in ${where} (status ${plain(member.result.status, 20)}): make it an administrator`)
    if (PUBLIC_CHANNEL.test(chatId)) add('ok', 'Telegram', `each post's link is recorded (https://t.me/${chatId.slice(1)}/<message id>)`)
    else if (typeof username === 'string' && /^\w{5,32}$/.test(username)) add('info', 'Telegram', `set TELEGRAM_CHAT_ID=@${username} instead of the `
      + 'numeric id so each post\'s public link is recorded')
    else add('info', 'Telegram', 'private chat: posts have no public links (their message ids are still recorded)')
  } catch (error) { add('error', 'Telegram', `the check could not finish (${networkCode(error)}): is api.telegram.org reachable from here?`) }
}

// ---------- report ----------
// findings: [{ level: 'ok' | 'info' | 'warn' | 'error', area, message }]; ok is false when any finding is an error.
export async function checkAlerts({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const findings = []
  const add = (level, area, message) => { findings.push({ level, area, message }) }
  const caps = checkSettings(env, now, add)
  const channels = configuredChannels(env, add)
  if (channels.x) {
    const [launch, graduation] = JOBS.map(job => caps[job.name])
    // Every post links its token page, and X bills a post with a link from prepaid credits (docs/ALERTS_SETUP.md), so the
    // caps set the spend.
    if (launch && graduation) add('info', 'X', `up to ${launch + graduation} posts per 24 hours with both on (${launch} launch + ${graduation} `
      + 'graduation). Each carries a link, which X bills from your prepaid API credits at its "with URL" post price: the caps set the spend')
    await checkX({ credentials: channels.x, fetchImpl, add })
  }
  if (channels.telegram) await checkTelegram({ ...channels.telegram, fetchImpl, add })
  // Defense in depth: no message ever carries a secret value, whatever a provider echoed.
  const secrets = [...ALERT_CHANNEL_KEYS.x, 'TELEGRAM_BOT_TOKEN'].map(key => env[key]?.trim()).filter(Boolean)
  return { ok: !findings.some(finding => finding.level === 'error'), findings: findings.map(finding => ({ ...finding, message: redact(finding.message, secrets) })) }
}

const MARK = { ok: '✓', info: '·', warn: '!', error: '✗' }
export function formatCheck({ ok, findings }) {
  const problems = findings.filter(finding => finding.level === 'error').length
  return `${[...findings.map(finding => `${MARK[finding.level]} ${finding.area}: ${finding.message}`), '',
    ok ? 'All checks passed. Nothing was posted.' : `${problems} problem${problems === 1 ? '' : 's'} found. Nothing was posted.`].join('\n')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkAlerts().then(report => { process.stdout.write(formatCheck(report)); process.exitCode = report.ok ? 0 : 1 },
    error => { process.stderr.write(`alerts check could not run (${networkCode(error)})\n`); process.exitCode = 1 })
}
