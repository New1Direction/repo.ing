// Worker job: one public "new market launched" post per market per channel (Telegram, X). Off unless
// LAUNCH_ALERTS_ENABLED=true, LAUNCH_ALERTS_SINCE is set, and at least one channel is fully configured.
//
// Safety:
// - Only finalized, indexed, confirmed markets indexed at/after LAUNCH_ALERTS_SINCE and within the last 24 hours.
// - A launch_alerts row (unique per repository and channel) is claimed BEFORE sending, so overlapping workers or
//   redeploys never post twice. A post that may have gone out (timeout, 5xx, crash mid-send) becomes 'unknown' and is
//   never retried automatically; only a provider rejection (4xx/connection refused) becomes 'failed' and is retried.
// - Runs are serialized with an advisory lock, capped per run and per 24 hours, and spaced out between posts.
import { buildLaunchMessage, tokenUrl } from './launch-alerts-message.mjs'
import { createTelegramSender, createXSender } from './launch-alerts-senders.mjs'

export const LAUNCH_ALERT_CHANNELS = ['telegram', 'x']
export const LAUNCH_ALERT_DEFAULTS = Object.freeze({
  maxPerRun: 2, maxPerDay: 15, spacingMs: 10_000, maxAgeMs: 24 * 3600_000, maxAttempts: 3, staleSendingMs: 10 * 60_000, retryDelayMs: 5 * 60_000 })
const X_KEYS = ['X_BOT_API_KEY', 'X_BOT_API_SECRET', 'X_BOT_ACCESS_TOKEN', 'X_BOT_ACCESS_SECRET']
const TELEGRAM_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']
// Two-key advisory lock form: never conflicts with the single-bigint repository locks used elsewhere.
const LOCK_KEYS = [0x7265706f, 0x616c7274]

export class LaunchAlertConfigError extends Error {}

// null when alerts are off. Throws LaunchAlertConfigError (no secret values in the message) when half-configured.
export function launchAlertsConfig(env = process.env) {
  if (env.LAUNCH_ALERTS_ENABLED !== 'true') return null
  const value = key => env[key]?.trim() || ''
  const channelSet = (name, keys) => {
    const present = keys.filter(value)
    if (present.length && present.length < keys.length) throw new LaunchAlertConfigError(`${name} alerts need ${keys.join(', ')}`)
    return present.length === keys.length
  }
  const channels = []
  if (channelSet('Telegram', TELEGRAM_KEYS)) channels.push('telegram')
  if (channelSet('X', X_KEYS)) channels.push('x')
  if (!channels.length) return null
  const sinceText = value('LAUNCH_ALERTS_SINCE')
  const since = /^\d{4}-\d{2}-\d{2}T/.test(sinceText) ? new Date(sinceText) : null
  if (!since || Number.isNaN(since.getTime())) throw new LaunchAlertConfigError('LAUNCH_ALERTS_SINCE must be an ISO timestamp, e.g. 2026-10-01T00:00:00Z')
  let origin
  try { origin = new URL(value('APP_ORIGIN') || 'https://repo.ing') } catch { throw new LaunchAlertConfigError('APP_ORIGIN is not a URL') }
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new LaunchAlertConfigError('APP_ORIGIN must be HTTPS')
  const maxPerDay = value('LAUNCH_ALERTS_MAX_PER_DAY') ? Number(value('LAUNCH_ALERTS_MAX_PER_DAY')) : LAUNCH_ALERT_DEFAULTS.maxPerDay
  if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 500) throw new LaunchAlertConfigError('LAUNCH_ALERTS_MAX_PER_DAY must be an integer from 1 to 500')
  return { ...LAUNCH_ALERT_DEFAULTS, channels, since, origin: origin.origin, maxPerDay,
    telegram: channels.includes('telegram') ? { token: value('TELEGRAM_BOT_TOKEN'), chatId: value('TELEGRAM_CHAT_ID') } : null,
    x: channels.includes('x') ? { apiKey: value('X_BOT_API_KEY'), apiSecret: value('X_BOT_API_SECRET'),
      accessToken: value('X_BOT_ACCESS_TOKEN'), accessSecret: value('X_BOT_ACCESS_SECRET') } : null }
}

export function createLaunchAlertSenders(config, { fetchImpl = fetch } = {}) {
  return { ...(config.telegram ? { telegram: createTelegramSender({ ...config.telegram, fetchImpl }) } : {}),
    ...(config.x ? { x: createXSender({ credentials: config.x, fetchImpl }) } : {}) }
}

// ---------- PostgreSQL store (migration 0034_launch_alerts) ----------
const MARKET_FIELDS = `m.github_repo_id::text as "githubRepoId", m.mint, m.token_symbol as "tokenSymbol", m.indexed_at as "indexedAt",
  r.full_name as "fullName", r.description, r.stars`
const ELIGIBLE = `m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.mint is not null
  and m.indexed_at >= $2 and m.indexed_at >= now() - make_interval(secs => $3)`

export function createLaunchAlertStore(pool) {
  return {
    // Runs fn only if no other worker is running alerts; returns { locked: false } otherwise.
    async withLock(fn) {
      const client = await pool.connect()
      try {
        const { rows: [{ locked }] } = await client.query('select pg_try_advisory_lock($1::int, $2::int) as locked', LOCK_KEYS)
        if (!locked) return { locked: false }
        try { return { locked: true, value: await fn() } }
        finally { await client.query('select pg_advisory_unlock($1::int, $2::int)', LOCK_KEYS) }
      } finally { client.release() }
    },
    // A claim still 'sending' long after it was taken belongs to a crashed run: it may have been posted.
    async expireStale(staleMs) {
      const { rows } = await pool.query(`update launch_alerts set status='unknown', error='interrupted while sending', updated_at=now()
        where status='sending' and updated_at < now() - make_interval(secs => $1) returning id::text, channel, mint`, [staleMs / 1000])
      return rows
    },
    async sentRecently(channel) {
      const { rows: [{ n }] } = await pool.query(`select count(*)::int as n from launch_alerts where channel=$1
        and status in ('sending','sent','unknown') and updated_at > now() - interval '24 hours'`, [channel])
      return n
    },
    // Oldest first: never-alerted markets and retryable failures on this channel.
    async candidates({ channel, since, maxAgeMs, maxAttempts, limit }) {
      const { rows } = await pool.query(`select ${MARKET_FIELDS}, a.id::text as "alertId" from markets m
        join repositories r on r.github_repo_id=m.github_repo_id
        left join launch_alerts a on a.github_repo_id=m.github_repo_id and a.channel=$1
        where ${ELIGIBLE} and (a.id is null or (a.status='failed' and a.attempts < $4 and coalesce(a.next_attempt_at, a.updated_at) <= now()))
        order by m.indexed_at, m.github_repo_id limit $5`, [channel, since, maxAgeMs / 1000, maxAttempts, limit])
      return rows
    },
    // The only path to a send: returns the claimed row id, or null when another run owns (or finished) this alert.
    async claim({ channel, market, maxAttempts }) {
      const { rows } = market.alertId
        ? await pool.query(`update launch_alerts set status='sending', attempts=attempts+1, error=null, next_attempt_at=null, updated_at=now()
            where id=$1 and status='failed' and attempts < $2 returning id::text`, [market.alertId, maxAttempts])
        : await pool.query(`insert into launch_alerts (github_repo_id, mint, channel, status, attempts) values ($1, $2, $3, 'sending', 1)
            on conflict (github_repo_id, channel) do nothing returning id::text`, [market.githubRepoId, market.mint, channel])
      return rows[0]?.id ?? null
    },
    async finish(id, outcome) {
      await pool.query(`update launch_alerts set status=$2::text, message_id=$3, message_url=$4, error=$5, updated_at=now(),
        sent_at=case when $2::text='sent' then now() end, next_attempt_at=$6 where id=$1 and status='sending'`,
      [id, outcome.status, outcome.messageId ?? null, outcome.messageUrl ?? null, outcome.error ?? null, outcome.nextAttemptAt ?? null])
    },
  }
}

// ---------- job ----------
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createLaunchAlerts({ store, config, senders, sleep = wait, now = () => Date.now() }) {
  async function deliver(channel, market) {
    let text
    try { text = buildLaunchMessage(market, { channel, origin: config.origin }) }
    catch (error) { return { status: 'failed', error: String(error.message).slice(0, 200) } }
    try { return await senders[channel]({ text, url: tokenUrl(config.origin, market.mint) }) }
    catch { return { status: 'unknown', error: 'sender threw' } }
  }

  async function runChannel(channel) {
    const results = []
    const budget = Math.min(config.maxPerRun, config.maxPerDay - await store.sentRecently(channel))
    if (budget <= 0) return results
    const markets = await store.candidates({ channel, since: config.since, maxAgeMs: config.maxAgeMs, maxAttempts: config.maxAttempts, limit: budget })
    for (const market of markets) {
      const id = await store.claim({ channel, market, maxAttempts: config.maxAttempts })
      if (!id) continue
      if (results.length) await sleep(config.spacingMs)
      const outcome = await deliver(channel, market)
      const nextAttemptAt = outcome.status === 'failed' ? new Date(now() + Math.max(config.retryDelayMs, outcome.retryAfterMs ?? 0)) : null
      await store.finish(id, { ...outcome, nextAttemptAt })
      results.push({ channel, repo: market.fullName, mint: market.mint, status: outcome.status,
        ...(outcome.messageUrl ? { url: outcome.messageUrl } : {}), ...(outcome.error ? { error: outcome.error } : {}) })
      // Any failure pauses this channel until the next run instead of hammering the provider.
      if (outcome.status !== 'sent') break
    }
    return results
  }

  async function runOnce() {
    let result
    try {
      result = await store.withLock(async () => {
        const interrupted = await store.expireStale(config.staleSendingMs)
        const posts = []
        for (const channel of config.channels) if (senders[channel]) posts.push(...await runChannel(channel))
        return { posts, interrupted: interrupted.map(row => ({ channel: row.channel, mint: row.mint, status: 'unknown' })) }
      })
    } catch (error) {
      if (error?.code === '42P01') return { skipped: 'LAUNCH_ALERTS_NOT_MIGRATED' }
      throw error
    }
    if (!result.locked) return { skipped: 'LOCKED' }
    return result.value
  }
  return { runOnce }
}
