// Channel senders for launch alerts: Telegram Bot API sendMessage and X API v2 POST /2/tweets (OAuth 1.0a user
// context, HMAC-SHA1). Every send resolves to one outcome, never throws:
//   { status: 'sent', messageId, messageUrl }
//   { status: 'failed', error, retryAfterMs? }  the provider proved nothing was posted (safe to retry later)
//   { status: 'unknown', error }                it may have been posted (never retried automatically)
import { createHmac, randomBytes } from 'node:crypto'

export const TELEGRAM_API = 'https://api.telegram.org'
export const X_TWEETS_URL = 'https://api.x.com/2/tweets'
const TIMEOUT_MS = 15_000
// Connection errors raised before any request byte reaches the provider.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_INVALID_URL', 'UND_ERR_CONNECT_TIMEOUT'])

// ---------- OAuth 1.0a (RFC 5849) ----------
export const percentEncode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

// params: every oauth_* value plus query/form parameters (a JSON body is not signed).
export function oauthSignature({ method, url, params, consumerSecret, tokenSecret }) {
  const normalized = Object.entries(params).map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&')
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(normalized)].join('&')
  return createHmac('sha1', `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`).update(base).digest('base64')
}

export function oauthHeader({ method, url, credentials, params = {}, nonce = randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) }) {
  const oauth = { oauth_consumer_key: credentials.apiKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp), oauth_token: credentials.accessToken, oauth_version: '1.0' }
  const signature = oauthSignature({ method, url, params: { ...params, ...oauth }, consumerSecret: credentials.apiSecret, tokenSecret: credentials.accessSecret })
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`).join(', ')}`
}

// ---------- shared request handling ----------
const clip = (text, secrets) => {
  let out = String(text ?? '').replace(/\s+/g, ' ').slice(0, 200)
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]')
  return out
}

function thrownOutcome(error, secrets) {
  const code = error?.cause?.code ?? error?.code
  if (NOT_SENT_CODES.has(code)) return { status: 'failed', error: clip(`network: ${code}`, secrets) }
  const name = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : (code ?? error?.name ?? 'error')
  return { status: 'unknown', error: clip(`network: ${name}`, secrets) }
}

const retryAfterMs = (response, body) => {
  const seconds = Number(body?.parameters?.retry_after ?? response.headers.get('retry-after'))
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const reset = Number(response.headers.get('x-rate-limit-reset'))
  return Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined
}

// 4xx: the provider rejected the request, so nothing was posted. 5xx or a malformed success: it may have been posted.
async function post({ fetchImpl, url, headers, body, secrets, parse }) {
  let response
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  } catch (error) { return thrownOutcome(error, secrets) }
  let json = null
  try { json = await response.json() } catch { json = null }
  if (response.status >= 400 && response.status < 500) {
    const detail = json?.description ?? json?.detail ?? json?.title ?? json?.errors?.[0]?.message ?? ''
    return { status: 'failed', error: clip(`HTTP ${response.status} ${detail}`, secrets),
      ...(response.status === 429 ? { retryAfterMs: retryAfterMs(response, json) } : {}) }
  }
  if (!response.ok) return { status: 'unknown', error: clip(`HTTP ${response.status}`, secrets) }
  const parsed = json && parse(json)
  return parsed ? { status: 'sent', ...parsed } : { status: 'unknown', error: `HTTP ${response.status} without a message id` }
}

// ---------- Telegram ----------
export function createTelegramSender({ token, chatId, fetchImpl = fetch }) {
  const chat = String(chatId)
  const publicChannel = /^@[A-Za-z0-9_]{5,32}$/.test(chat) ? chat.slice(1) : null
  return async ({ text, url }) => post({ fetchImpl, url: `${TELEGRAM_API}/bot${token}/sendMessage`, secrets: [token],
    body: { chat_id: chat, text, parse_mode: 'HTML',
      // Current form of disable_web_page_preview=false (deprecated): show the token page's link card.
      link_preview_options: { is_disabled: false, url } },
    parse: json => {
      const id = json.ok === true ? json.result?.message_id : null
      if (!Number.isSafeInteger(id)) return null
      return { messageId: String(id), messageUrl: publicChannel ? `https://t.me/${publicChannel}/${id}` : null }
    } })
}

// ---------- X ----------
export function createXSender({ credentials, fetchImpl = fetch, nonce, timestamp }) {
  const secrets = [credentials.apiSecret, credentials.accessSecret]
  return async ({ text }) => post({ fetchImpl, url: X_TWEETS_URL, secrets, body: { text },
    headers: { authorization: oauthHeader({ method: 'POST', url: X_TWEETS_URL, credentials, nonce: nonce?.(), timestamp: timestamp?.() }) },
    parse: json => {
      const id = json.data?.id
      return typeof id === 'string' && /^\d{1,25}$/.test(id) ? { messageId: id, messageUrl: `https://x.com/i/status/${id}` } : null
    } })
}
