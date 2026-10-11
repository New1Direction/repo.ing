// Worker job: public "first to launch" posts to the launch-alert channels (Telegram, X): a public GitHub repository that is
// gaining stars fast and has no market yet, with a link to launch it. Off unless TREND_ALERTS_ENABLED=true,
// TREND_ALERTS_SINCE is set, and at least one channel is fully configured (same credentials as launch alerts).
//
// Safety:
// - Candidates come only from the trend pipeline's launchable list (src/trend-launchable.mjs): fresh, verified evidence,
//   no market (a failed launch released the repository), not archived, maintainer not opted out or declined contact, not
//   on the do-not-promote list. On top of that, star growth must reach TREND_ALERTS_MIN_STARS_PER_DAY and forks are left
//   out (src/trend-alerts-message.mjs). Evidence observed before the cutoff is never announced.
// - Each (repository, channel) is posted at most once, ever: claimed in trend_alerts BEFORE sending, under an advisory lock.
//   Outcomes, retries, per-run/per-day caps and spacing work exactly like launch alerts. A failed post is retried only
//   while the repository is still a candidate.
// - Nothing here launches, trades or spends: a post only links the launch page, where a person reviews and signs.
// - The do-not-promote set is read every run (PROMOTION_EXCLUDED_REPO_IDS plus maintainers' opt-outs when the worker passes
//   `excluded`); when it cannot be read the run fails and nothing is posted.
import { alertChannels, alertMaxPerDay, alertOrigin, alertSince, deliverAlert, LaunchAlertConfigError, postInTurn, runAlertsLocked } from './launch-alerts.mjs'
import { buildTrendMessage, launchUrl, trendAlertCandidates } from './trend-alerts-message.mjs'
import { readLaunchableTrends } from './trend-launchable.mjs'
import { promotionExcludedRepoIds } from '../app/lib/promotion-exclusions.mjs'

export const TREND_ALERT_DEFAULTS = Object.freeze({
  maxPerRun: 1, maxPerDay: 4, minStarsPerDay: 200, spacingMs: 10_000, maxAttempts: 3, staleSendingMs: 10 * 60_000, retryDelayMs: 5 * 60_000 })
// Two-key advisory lock ('repo', 'trnd'): separate from launch and milestone alerts and from single-bigint repository locks.
const LOCK_KEYS = [0x7265706f, 0x74726e64]

// The star-growth threshold under `key` (the setting, or a preview flag), else the default.
export function trendAlertMinStars(env, key = 'TREND_ALERTS_MIN_STARS_PER_DAY') {
  const text = env[key]?.trim()
  const value = text ? Number(text) : TREND_ALERT_DEFAULTS.minStarsPerDay
  if (!Number.isInteger(value) || value < 25 || value > 1_000_000) throw new LaunchAlertConfigError(`${key} must be an integer from 25 to 1000000`)
  return value
}

// null when trend alerts are off. Throws LaunchAlertConfigError (no secret values) when half-configured. reward: the post
// names the launcher's discovery reward only with DISCOVERY_REWARDS_ENABLED=true in the worker's own environment (keep it
// the same as on web, where the reward is paid).
export function trendAlertsConfig(env = process.env) {
  if (env.TREND_ALERTS_ENABLED !== 'true') return null
  const { channels, telegram, x } = alertChannels(env)
  if (!channels.length) return null
  const since = alertSince(env, 'TREND_ALERTS_SINCE')
  const origin = alertOrigin(env)
  const maxPerDay = alertMaxPerDay(env, 'TREND_ALERTS_MAX_PER_DAY', TREND_ALERT_DEFAULTS.maxPerDay)
  return { ...TREND_ALERT_DEFAULTS, channels, since, origin, maxPerDay, minStarsPerDay: trendAlertMinStars(env), telegram, x,
    excluded: promotionExcludedRepoIds(env), reward: env.DISCOVERY_REWARDS_ENABLED === 'true' }
}

// ---------- PostgreSQL store (migration 0068_trend_alerts) ----------
export function createTrendAlertStore(pool) {
  return {
    async withLock(fn) {
      const client = await pool.connect()
      try {
        const { rows: [{ locked }] } = await client.query('select pg_try_advisory_lock($1::int, $2::int) as locked', LOCK_KEYS)
        if (!locked) return { locked: false }
        try { return { locked: true, value: await fn() } }
        finally { await client.query('select pg_advisory_unlock($1::int, $2::int)', LOCK_KEYS) }
      } finally { client.release() }
    },
    // runAlertsLocked reports interrupted claims by mint; a trending repository has none, so its id stands in.
    async expireStale(staleMs) {
      const { rows } = await pool.query(`update trend_alerts set status='unknown', error='interrupted while sending', updated_at=now()
        where status='sending' and updated_at < now() - make_interval(secs => $1) returning id::text, channel, github_repo_id::text as mint`, [staleMs / 1000])
      return rows
    },
    async sentRecently(channel) {
      const { rows: [{ n }] } = await pool.query(`select count(*)::int as n from trend_alerts where channel=$1
        and status in ('sending','sent','unknown') and updated_at > now() - interval '24 hours'`, [channel])
      return n
    },
    // The launchable trends (one bounded read, the same one /find-repos lists), minus the do-not-promote set.
    trends({ now, promotionExcluded }) {
      return readLaunchableTrends(pool, { now, promotionExcluded })
    },
    // This channel's alert rows, keyed by repository id.
    async channelState(channel) {
      const { rows } = await pool.query(`select id::text, github_repo_id::text as "repoId", status, attempts, next_attempt_at as "nextAttemptAt",
        updated_at as "updatedAt" from trend_alerts where channel=$1`, [channel])
      return new Map(rows.map(row => [row.repoId, row]))
    },
    // The only path to a send: returns the claimed row id, or null when another run owns (or finished) this repository.
    async claim({ channel, post, maxAttempts }) {
      const { rows } = post.alertId
        ? await pool.query(`update trend_alerts set status='sending', attempts=attempts+1, stars_gained=$3, error=null, next_attempt_at=null, updated_at=now()
            where id=$1 and status='failed' and attempts < $2 returning id::text`, [post.alertId, maxAttempts, post.starsGained.delta])
        : await pool.query(`insert into trend_alerts (github_repo_id, channel, stars_gained, status, attempts) values ($1, $2, $3, 'sending', 1)
            on conflict (github_repo_id, channel) do nothing returning id::text`, [post.repoId, channel, post.starsGained.delta])
      return rows[0]?.id ?? null
    },
    async finish(id, outcome) {
      await pool.query(`update trend_alerts set status=$2::text, message_id=$3, message_url=$4, error=$5, updated_at=now(),
        sent_at=case when $2::text='sent' then now() end, next_attempt_at=$6 where id=$1 and status='sending'`,
      [id, outcome.status, outcome.messageId ?? null, outcome.messageUrl ?? null, outcome.error ?? null, outcome.nextAttemptAt ?? null])
    },
  }
}

// ---------- job ----------
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const time = value => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)

// One channel's posts this run, in candidate order: never-posted repositories, and a 'failed' post once its retry time has
// come (while attempts remain). 'sending', 'sent' and 'unknown' are never posted again.
export function planTrendAlerts({ candidates, alerted, now, maxAttempts }) {
  return candidates.flatMap(item => {
    const row = alerted.get(String(item.repoId))
    if (!row) return [item]
    return row.status === 'failed' && row.attempts < maxAttempts && time(row.nextAttemptAt ?? row.updatedAt) <= now ? [{ ...item, alertId: row.id }] : []
  })
}

export function createTrendAlerts({ store, config, senders, sleep = wait, now = () => Date.now(), excluded: readExcluded = async () => config.excluded ?? new Set() }) {
  async function runChannel(channel, candidates) {
    const budget = Math.min(config.maxPerRun, config.maxPerDay - await store.sentRecently(channel))
    if (budget <= 0) return []
    const plan = planTrendAlerts({ candidates, alerted: await store.channelState(channel), now: now(), maxAttempts: config.maxAttempts })
    return postInTurn({ items: plan.slice(0, budget), config, sleep, now,
      claim: post => store.claim({ channel, post, maxAttempts: config.maxAttempts }),
      deliver: post => deliverAlert({ sender: senders[channel], url: launchUrl(config.origin, post.repoId),
        build: () => buildTrendMessage(post, { channel, origin: config.origin, reward: config.reward === true }) }),
      finish: (id, outcome) => store.finish(id, outcome),
      describe: post => ({ channel, repo: post.fullName, starsGained: post.starsGained.delta }) })
  }

  async function runOnce() {
    if (now() < config.since.getTime()) return { posts: [], interrupted: [], skipped: 'BEFORE_SINCE' }
    return runAlertsLocked({ store, config, notMigrated: 'TREND_ALERTS_NOT_MIGRATED' }, async () => {
      const promotionExcluded = await readExcluded()
      const at = now()
      const candidates = trendAlertCandidates(await store.trends({ now: at, promotionExcluded }), { since: config.since, minStarsPerDay: config.minStarsPerDay })
      const posts = []
      for (const channel of config.channels) if (senders[channel]) posts.push(...await runChannel(channel, candidates))
      return posts
    })
  }
  return { runOnce }
}
