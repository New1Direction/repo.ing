import { createPrivateKey, createPublicKey, randomUUID, sign as signBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import https from 'node:https'
import { FEED_KINDS } from './launch-feed.mjs'

// Webhooks for the public launch feed (docs/MARKET_DATA_API.md#webhooks). A signed-in GitHub user subscribes an HTTPS URL to
// feed event kinds (optionally for some repositories); the worker POSTs each new event as JSON, signed with repo.ing's Ed25519
// key so a receiver can check it came from repo.ing. Off unless LAUNCH_WEBHOOKS_ENABLED is exactly "true" and
// LAUNCH_WEBHOOK_SIGNING_KEY holds the key. Delivery is guarded against server-side request forgery: HTTPS on port 443 only,
// no credentials in the URL, every resolved address must be public (checked at connection time, so DNS rebinding cannot
// point a delivery inside the network), no redirects, a short timeout and a discarded response body.
export const WEBHOOK_LIMITS = Object.freeze({
  perUser: 5,
  batch: 25,
  attempts: 6,
  backoffMs: Object.freeze([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]),
  disableAfterFailures: 20,
  timeoutMs: 5_000,
  // One delivery run stops claiming new deliveries after this long, so webhooks never hold up the rest of the worker job.
  runBudgetMs: 60_000,
  staleSendingMs: 10 * 60_000,
})

export class WebhookError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'WebhookError'; this.status = status }
}

export function webhooksEnabled(env = process.env) {
  return env.LAUNCH_WEBHOOKS_ENABLED === 'true' && Boolean(signingKey(env))
}

// LAUNCH_WEBHOOK_SIGNING_KEY: the base64 32-byte Ed25519 seed (or a PKCS#8 PEM). null when unset or invalid.
export function signingKey(env = process.env) {
  const value = String(env.LAUNCH_WEBHOOK_SIGNING_KEY ?? '').trim()
  if (!value) return null
  try {
    if (value.includes('BEGIN PRIVATE KEY')) return createPrivateKey(value)
    const seed = Buffer.from(value, 'base64')
    if (seed.length !== 32) return null
    // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
    return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
  } catch { return null }
}

export function publicSigningKey(env = process.env) {
  const key = signingKey(env)
  if (!key) return null
  const publicKey = createPublicKey(key)
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { algorithm: 'Ed25519', publicKeyBase64: der.subarray(der.length - 32).toString('base64'), pem: publicKey.export({ format: 'pem', type: 'spki' }) }
}

// Signature over `${timestamp}.${body}` (timestamp in Unix seconds), base64.
export function signDelivery(body, timestamp, key) {
  return signBytes(null, Buffer.from(`${timestamp}.${body}`, 'utf8'), key).toString('base64')
}

// IPv4 and IPv6 ranges a delivery must never reach (private, loopback, link-local, carrier NAT, documentation, multicast…).
const V4_BLOCKED = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
const v4Number = ip => ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
function publicV4(ip) {
  const value = v4Number(ip)
  return !V4_BLOCKED.some(([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)))
}
function expandV6(ip) {
  let address = ip.toLowerCase().split('%')[0]
  const v4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const n = v4Number(v4[1])
    address = address.replace(v4[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`)
  }
  const [head, tail = ''] = address.split('::')
  const left = head ? head.split(':') : [], right = address.includes('::') ? (tail ? tail.split(':') : []) : []
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  return groups.map(group => parseInt(group || '0', 16))
}
export function isPublicAddress(ip) {
  const family = isIP(ip)
  if (family === 4) return publicV4(ip)
  if (family !== 6) return false
  const g = expandV6(ip)
  if (g.length !== 8 || g.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) return false
  const v4 = (high, low) => `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`
  const zeros = (from, to) => g.slice(from, to).every(value => value === 0)
  // Addresses that embed an IPv4 address are judged by it: IPv4-compatible ::a.b.c.d, mapped ::ffff:a.b.c.d, ::ffff:0:a.b.c.d,
  // the well-known NAT64 prefix 64:ff9b::/96 and 6to4 2002::/16.
  if (zeros(0, 6)) return g[6] === 0 && g[7] <= 1 ? false : publicV4(v4(g[6], g[7]))
  if (zeros(0, 5) && g[5] === 0xffff) return publicV4(v4(g[6], g[7]))
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return publicV4(v4(g[6], g[7]))
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return publicV4(v4(g[6], g[7]))
  if (g[0] === 0x2002) return publicV4(v4(g[1], g[2]))
  // Otherwise only global unicast 2000::/3, without documentation (2001:db8::/32) or the local NAT64 range.
  if ((g[0] & 0xe000) !== 0x2000) return false
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false
  return true
}

export function validateWebhookUrl(value) {
  let url
  try { url = new URL(String(value ?? '').trim()) } catch { throw new WebhookError('Enter a full https:// URL.') }
  if (url.protocol !== 'https:') throw new WebhookError('Webhook URLs must use https://.')
  if (url.username || url.password) throw new WebhookError('Remove the user name and password from the URL.')
  if (url.port && url.port !== '443') throw new WebhookError('Webhook URLs use the standard HTTPS port.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || /^localhost$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) throw new WebhookError('Use a public host name.')
  if (isIP(host) && !isPublicAddress(host)) throw new WebhookError('Use a public address.')
  url.hash = ''
  if (url.href.length > 500) throw new WebhookError('Keep the URL under 500 characters.')
  return url.href
}

// dns.lookup replacement for https.request: resolves every address and refuses the connection unless ALL are public.
export function publicOnlyLookup(resolve = dnsLookup) {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error)
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }]
      if (!list.length || list.some(entry => !isPublicAddress(entry.address))) {
        return callback(Object.assign(new Error('Webhook host resolves to a non-public address'), { code: 'WEBHOOK_PRIVATE_ADDRESS' }))
      }
      if (options?.all) return callback(null, list)
      callback(null, list[0].address, list[0].family)
    })
  }
}

// POST with no redirects and a hard deadline for the whole exchange: the answer counts once its status line arrives, and the
// connection is then closed without reading the body, so a receiver that trickles or never ends its response cannot hold a
// delivery (or the worker run) open. Resolves { status } or rejects.
export function postJson(url, body, headers, { timeoutMs = WEBHOOK_LIMITS.timeoutMs, lookup = publicOnlyLookup(), request = https.request } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(error) : resolve(value) }
    const req = request(url, { method: 'POST', lookup, timeout: timeoutMs, headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body), 'user-agent': 'repo.ing-webhooks/1', ...headers } }, response => {
      finish(null, { status: response.statusCode })
      response.destroy()
    })
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('Webhook timed out'), { code: 'WEBHOOK_TIMEOUT' })), timeoutMs)
    deadline.unref?.()
    req.on('timeout', () => req.destroy(Object.assign(new Error('Webhook timed out'), { code: 'WEBHOOK_TIMEOUT' })))
    req.on('error', error => finish(error))
    req.end(body)
  })
}

const parseKinds = kinds => {
  const list = [...new Set((Array.isArray(kinds) ? kinds : []).map(String))]
  if (!list.length) return [...FEED_KINDS]
  if (list.some(kind => !FEED_KINDS.includes(kind))) throw new WebhookError('Unknown event kind.')
  return list
}
const parseRepos = repos => {
  if (repos === undefined || repos === null || (Array.isArray(repos) && !repos.length)) return null
  const list = [...new Set((Array.isArray(repos) ? repos : String(repos).split(',')).map(value => String(value).trim()).filter(Boolean))]
  if (list.length > 50 || list.some(id => !/^[1-9]\d{0,15}$/.test(id))) throw new WebhookError('Repositories are up to 50 GitHub repository ids.')
  return list
}
const publicWebhook = row => ({ id: row.id, url: row.url, kinds: row.kinds, repoIds: row.repoIds?.map(String) ?? null, status: row.status,
  consecutiveFailures: row.consecutiveFailures, lastDeliveryAt: row.lastDeliveryAt?.toISOString?.() ?? row.lastDeliveryAt ?? null,
  disabledReason: row.disabledReason ?? null, createdAt: row.createdAt?.toISOString?.() ?? row.createdAt })
const COLUMNS = `id, url, kinds, repo_ids as "repoIds", status, consecutive_failures as "consecutiveFailures", last_delivery_at as "lastDeliveryAt",
  disabled_reason as "disabledReason", created_at as "createdAt"`

export function createWebhookStore(pool) {
  return {
    async list(githubUserId) {
      const { rows } = await pool.query(`select ${COLUMNS} from launch_webhooks where github_user_id = $1 and status <> 'deleted' order by created_at`, [String(githubUserId)])
      return rows.map(publicWebhook)
    },
    // New subscriptions start at the newest event: no backlog is replayed.
    async create({ githubUserId, githubLogin, url, kinds, repoIds }) {
      const href = validateWebhookUrl(url), kindList = parseKinds(kinds), repos = parseRepos(repoIds)
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`launch-webhooks:${githubUserId}`])
        const { rows: [{ count }] } = await client.query(`select count(*)::int as count from launch_webhooks where github_user_id = $1 and status <> 'deleted'`, [String(githubUserId)])
        if (count >= WEBHOOK_LIMITS.perUser) throw new WebhookError(`You can keep up to ${WEBHOOK_LIMITS.perUser} webhooks.`, 409)
        const { rows } = await client.query(`insert into launch_webhooks (id, github_user_id, github_login, url, kinds, repo_ids, last_event_id)
          values ($1, $2, $3, $4, $5, $6, coalesce((select max(id) from launch_feed_events), 0)) returning ${COLUMNS}`,
        [randomUUID(), String(githubUserId), String(githubLogin), href, kindList, repos])
        await client.query('commit')
        return publicWebhook(rows[0])
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw error
      } finally { client.release() }
    },
    async remove(githubUserId, id) {
      if (!/^[0-9a-f-]{36}$/.test(String(id ?? ''))) throw new WebhookError('Invalid webhook.')
      const { rowCount } = await pool.query(`update launch_webhooks set status = 'deleted', updated_at = now() where id = $1 and github_user_id = $2 and status <> 'deleted'`,
        [id, String(githubUserId)])
      if (!rowCount) throw new WebhookError('Webhook not found.', 404)
      await pool.query(`update launch_webhook_deliveries set status = 'failed', last_error = 'deleted' where webhook_id = $1 and status in ('pending', 'sending')`, [id])
      return { id, deleted: true }
    },
  }
}

// Queue deliveries for every active webhook: the next events after its cursor that match its kinds and repositories.
export async function fanOutDeliveries(pool, { batch = 500 } = {}) {
  const { rows: hooks } = await pool.query(`select id, kinds, repo_ids as "repoIds", last_event_id::text as "lastEventId" from launch_webhooks where status = 'active'`)
  let queued = 0
  for (const hook of hooks) {
    const { rows: events } = await pool.query(`select id::text, kind, github_repo_id::text as "repoId" from launch_feed_events where id > $1 order by id limit $2`,
      [hook.lastEventId, batch])
    if (!events.length) continue
    const repos = hook.repoIds ? new Set(hook.repoIds.map(String)) : null
    const matching = events.filter(event => hook.kinds.includes(event.kind) && (!repos || repos.has(event.repoId))).map(event => event.id)
    if (matching.length) {
      const { rowCount } = await pool.query(`insert into launch_webhook_deliveries (webhook_id, event_id) select $1, unnest($2::bigint[]) on conflict do nothing`, [hook.id, matching])
      queued += rowCount
    }
    await pool.query('update launch_webhooks set last_event_id = greatest(last_event_id, $2::bigint), updated_at = now() where id = $1', [hook.id, events.at(-1).id])
  }
  return { webhooks: hooks.length, queued }
}

// Send due deliveries. send(url, body, headers) → { status }; key: the signing key. Returns per-delivery outcomes (no URLs).
export async function deliverDue(pool, { send = postJson, key = signingKey(), now = Date.now, limits = WEBHOOK_LIMITS } = {}) {
  if (!key) return { skipped: 'NO_SIGNING_KEY' }
  // A delivery left 'sending' by a crash is retried (the attempt already counted).
  await pool.query(`update launch_webhook_deliveries set status = 'pending' where status = 'sending' and next_attempt_at < $1`, [new Date(now() - limits.staleSendingMs)])
  const { rows } = await pool.query(`update launch_webhook_deliveries d set status = 'sending', attempts = d.attempts + 1, next_attempt_at = $1
    from (select webhook_id, event_id from launch_webhook_deliveries where status = 'pending' and next_attempt_at <= $1
      order by next_attempt_at, event_id limit $2 for update skip locked) due
    where d.webhook_id = due.webhook_id and d.event_id = due.event_id
    returning d.webhook_id as "webhookId", d.event_id::text as "eventId", d.attempts`, [new Date(now()), limits.batch])
  const results = { sent: 0, retrying: 0, failed: 0, disabled: 0 }
  const startedAt = now()
  for (const [index, row] of rows.entries()) {
    // Out of time: hand the rest back untouched (their attempt is not counted) for the next run.
    if (now() - startedAt > limits.runBudgetMs) {
      const rest = rows.slice(index)
      await pool.query(`update launch_webhook_deliveries d set status = 'pending', attempts = d.attempts - 1 from unnest($1::uuid[], $2::bigint[]) as r(w, e)
        where d.webhook_id = r.w and d.event_id = r.e and d.status = 'sending'`, [rest.map(item => item.webhookId), rest.map(item => item.eventId)])
      results.deferred = rest.length
      break
    }
    const { rows: [context] } = await pool.query(`select w.url, w.status, e.id::text as id, e.kind, e.github_repo_id::text as "repoId", e.occurred_at as "occurredAt",
        e.created_at as "createdAt", e.payload from launch_webhooks w, launch_feed_events e where w.id = $1 and e.id = $2`, [row.webhookId, row.eventId])
    if (!context || context.status !== 'active') {
      await pool.query(`update launch_webhook_deliveries set status = 'failed', last_error = 'webhook inactive' where webhook_id = $1 and event_id = $2`, [row.webhookId, row.eventId])
      results.failed++
      continue
    }
    const body = JSON.stringify({ id: context.id, kind: context.kind, repoId: context.repoId, occurredAt: new Date(context.occurredAt).toISOString(),
      recordedAt: new Date(context.createdAt).toISOString(), data: context.payload })
    const timestamp = Math.floor(now() / 1000)
    let status = null, error = null
    try {
      ;({ status } = await send(context.url, body, { 'x-repoing-event': context.kind, 'x-repoing-event-id': context.id,
        'x-repoing-timestamp': String(timestamp), 'x-repoing-signature': `ed25519=${signDelivery(body, timestamp, key)}` }))
    } catch (failure) { error = String(failure?.code ?? failure?.name ?? 'error').slice(0, 60) }
    if (status >= 200 && status < 300) {
      await pool.query(`update launch_webhook_deliveries set status = 'sent', sent_at = $3, last_status = $4, last_error = null where webhook_id = $1 and event_id = $2`,
        [row.webhookId, row.eventId, new Date(now()), status])
      await pool.query(`update launch_webhooks set consecutive_failures = 0, last_delivery_at = $2, updated_at = now() where id = $1`, [row.webhookId, new Date(now())])
      results.sent++
      continue
    }
    const finalAttempt = row.attempts >= limits.attempts
    const wait = limits.backoffMs[Math.min(row.attempts - 1, limits.backoffMs.length - 1)]
    await pool.query(`update launch_webhook_deliveries set status = $3, next_attempt_at = $4, last_status = $5, last_error = $6 where webhook_id = $1 and event_id = $2`,
      [row.webhookId, row.eventId, finalAttempt ? 'failed' : 'pending', new Date(now() + wait), status, error ?? (status ? `HTTP ${status}` : 'error')])
    const { rows: [hook] } = await pool.query(`update launch_webhooks set consecutive_failures = consecutive_failures + 1, updated_at = now(),
        status = case when consecutive_failures + 1 >= $2 then 'disabled' else status end,
        disabled_reason = case when consecutive_failures + 1 >= $2 then 'too-many-failures' else disabled_reason end
      where id = $1 returning status`, [row.webhookId, limits.disableAfterFailures])
    if (hook?.status === 'disabled') results.disabled++
    if (finalAttempt) results.failed++
    else results.retrying++
  }
  return results
}
