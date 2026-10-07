// Worker job: public graduation-milestone posts to the launch-alert channels (Telegram, X) when a market first passes
// 25, 50, 75 or 90% of its graduation target and when it graduates. Off unless GRADUATION_ALERTS_ENABLED=true,
// GRADUATION_ALERTS_SINCE is set, and at least one channel is fully configured (same credentials as launch alerts).
//
// Safety:
// - Progress comes only from fresh, verified graduation observations (publicGraduation: the public curve endpoint's
//   freshness gate; graduation additionally needs durable migration evidence). Stale or unverified markets are skipped.
// - No backfill: the first time a channel sees a market (at/after the cutoff) it records a mark at the milestone already
//   reached and posts nothing; only milestones above the mark are ever posted (see planMilestones).
// - Each (market, channel, milestone) is claimed in milestone_alerts BEFORE sending and runs hold an advisory lock, so
//   nothing posts twice. Outcomes, retries, per-run/per-day caps and spacing work exactly like launch alerts.
// - Repositories on the do-not-promote list (PROMOTION_EXCLUDED_REPO_IDS, plus maintainers' opt-outs when the worker
//   passes `excluded`) are never posted and keep no marks (every run drops them, including marks taken before the
//   repository was listed). Once taken off the list, its first sight only takes a mark, so nothing from its excluded time
//   is announced. When that list cannot be read the run fails and nothing is posted.
// - Hugging Face model markets are included only with HF_MARKETS_ENABLED=true in the worker's own environment (as for
//   launch alerts), with model copy; their first sight after that only takes a mark, like any market's.
import { alertChannels, alertMaxPerDay, alertOrigin, alertSince, alertSources, deliverAlert, postInTurn, runAlertsLocked } from './launch-alerts.mjs'
import { hfMarketsEnabled } from './hf-launch.mjs'
import { tokenUrl } from './launch-alerts-message.mjs'
import { buildMilestoneMessage, milestoneOf, planMilestones } from './milestone-alerts-message.mjs'
import { promotionExcludedRepoIds } from '../app/lib/promotion-exclusions.mjs'

export const MILESTONE_ALERT_DEFAULTS = Object.freeze({
  maxPerRun: 2, maxPerDay: 10, spacingMs: 10_000, maxAttempts: 3, staleSendingMs: 10 * 60_000, retryDelayMs: 5 * 60_000 })
// Two-key advisory lock ('repo', 'mile'): separate from launch alerts and from single-bigint repository locks.
const LOCK_KEYS = [0x7265706f, 0x6d696c65]

// null when milestone alerts are off. Throws LaunchAlertConfigError (no secret values) when half-configured.
export function milestoneAlertsConfig(env = process.env) {
  if (env.GRADUATION_ALERTS_ENABLED !== 'true') return null
  const { channels, telegram, x } = alertChannels(env)
  if (!channels.length) return null
  const since = alertSince(env, 'GRADUATION_ALERTS_SINCE')
  const origin = alertOrigin(env)
  const maxPerDay = alertMaxPerDay(env, 'GRADUATION_ALERTS_MAX_PER_DAY', MILESTONE_ALERT_DEFAULTS.maxPerDay)
  return { ...MILESTONE_ALERT_DEFAULTS, channels, since, origin, maxPerDay, telegram, x, excluded: promotionExcludedRepoIds(env), models: hfMarketsEnabled(env) }
}

// ---------- PostgreSQL store (migration 0037_milestone_alerts) ----------
export function createMilestoneAlertStore(pool) {
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
    async expireStale(staleMs) {
      const { rows } = await pool.query(`update milestone_alerts set status='unknown', error='interrupted while sending', updated_at=now()
        where status='sending' and updated_at < now() - make_interval(secs => $1) returning id::text, channel, mint`, [staleMs / 1000])
      return rows
    },
    async sentRecently(channel) {
      const { rows: [{ n }] } = await pool.query(`select count(*)::int as n from milestone_alerts where channel=$1
        and status in ('sending','sent','unknown') and updated_at > now() - interval '24 hours'`, [channel])
      return n
    },
    // Raw graduation rows for every public GitHub market (and model market, with models: true, plus its registry path) with
    // a VERIFIED observation; freshness is checked per row in JS. A contributor early access market is held while its window is open
    // (a post would invite buys its transfer hook refuses), unless it has graduated (the hook is revoked; docs/EARLY_ACCESS.md).
    async progressRows({ models = false } = {}) {
      const { rows } = await pool.query(`select m.github_repo_id::text as "githubRepoId", m.mint, m.token_symbol as "tokenSymbol",
          r.full_name as "fullName", h.repo_path as "modelPath", o.status, o.observation, o.error_code, e.evidence_hash as migration_evidence_hash
        from markets m join repositories r on r.github_repo_id=m.github_repo_id and r.source = any($1::text[])
        left join hf_models h on h.market_ref=r.hf_model_ref
        join graduation_observations o on o.github_repo_id=m.github_repo_id
        left join graduation_events e on e.github_repo_id=m.github_repo_id
        where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.mint is not null and o.status='VERIFIED'
          and (m.early_access_end is null or m.early_access_end <= now() or e.evidence_hash is not null)
        order by m.github_repo_id`, [alertSources(models)])
      return rows
    },
    // This channel's marks and alert rows, keyed by repository id.
    async channelState(channel) {
      const [{ rows: marks }, { rows: alerts }] = await Promise.all([
        pool.query(`select github_repo_id::text as "githubRepoId", milestone, marked_at as "markedAt" from milestone_alert_marks where channel=$1`, [channel]),
        pool.query(`select id::text, github_repo_id::text as "githubRepoId", milestone, status, attempts, next_attempt_at as "nextAttemptAt",
          updated_at as "updatedAt" from milestone_alerts where channel=$1`, [channel])])
      const byRepo = new Map()
      for (const row of alerts) byRepo.set(row.githubRepoId, [...byRepo.get(row.githubRepoId) ?? [], row])
      return { marks: new Map(marks.map(row => [row.githubRepoId, row])), alerts: byRepo }
    },
    // Takes new marks and re-takes marks from before the cutoff; a mark is never lowered or moved twice.
    async mark(channel, marks, since) {
      if (!marks.length) return
      await pool.query(`insert into milestone_alert_marks (github_repo_id, channel, milestone)
        select repo, $2, milestone from unnest($1::bigint[], $3::smallint[]) as t(repo, milestone)
        on conflict (github_repo_id, channel) do update set milestone=greatest(milestone_alert_marks.milestone, excluded.milestone), marked_at=now()
        where milestone_alert_marks.marked_at < $4`, [marks.map(m => m.githubRepoId), channel, marks.map(m => m.milestone), since])
    },
    // Drops every channel's marks for these repositories (the do-not-promote list). Ids compare as text, so a malformed
    // or out-of-range id in the env matches nothing instead of failing the run.
    async forgetMarks(repoIds) {
      if (!repoIds.length) return
      await pool.query('delete from milestone_alert_marks where github_repo_id::text = any($1::text[])', [repoIds])
    },
    // The only path to a send: returns the claimed row id, or null when another run owns (or finished) this milestone,
    // or a higher one was already claimed on this channel.
    async claim({ channel, post, maxAttempts }) {
      const { rows } = post.alertId
        ? await pool.query(`update milestone_alerts set status='sending', attempts=attempts+1, error=null, next_attempt_at=null, updated_at=now()
            where id=$1 and status='failed' and attempts < $2 returning id::text`, [post.alertId, maxAttempts])
        : await pool.query(`insert into milestone_alerts (github_repo_id, mint, channel, milestone, status, attempts)
            select $1::bigint, $2::varchar, $3::varchar, $4::smallint, 'sending', 1 where not exists (select 1 from milestone_alerts
              where github_repo_id=$1::bigint and channel=$3::varchar and milestone >= $4::smallint)
            on conflict (github_repo_id, channel, milestone) do nothing returning id::text`, [post.githubRepoId, post.mint, channel, post.milestone])
      return rows[0]?.id ?? null
    },
    async finish(id, outcome) {
      await pool.query(`update milestone_alerts set status=$2::text, message_id=$3, message_url=$4, error=$5, updated_at=now(),
        sent_at=case when $2::text='sent' then now() end, next_attempt_at=$6 where id=$1 and status='sending'`,
      [id, outcome.status, outcome.messageId ?? null, outcome.messageUrl ?? null, outcome.error ?? null, outcome.nextAttemptAt ?? null])
    },
  }
}

// ---------- job ----------
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// The markets whose fresh, verified progress has reached a milestone at `at`, minus the do-not-promote set. Shared with
// scripts/alerts-preview.mjs, so a preview plans from exactly the markets the job would.
export function milestoneMarkets(rows, excluded, at) {
  return rows.flatMap(row => {
    if (excluded.has(String(row.githubRepoId))) return []
    const reached = milestoneOf(row, at)
    return reached ? [{ githubRepoId: row.githubRepoId, mint: row.mint, tokenSymbol: row.tokenSymbol, fullName: row.fullName,
      ...(row.modelPath ? { modelPath: row.modelPath } : {}), ...reached }] : []
  })
}

export function createMilestoneAlerts({ store, config, senders, sleep = wait, now = () => Date.now(), excluded: readExcluded = async () => config.excluded ?? new Set() }) {
  async function runChannel(channel, markets) {
    const { marks, alerts } = await store.channelState(channel)
    const plan = planMilestones({ markets, marks, alerts, since: config.since, now: now(), maxAttempts: config.maxAttempts })
    await store.mark(channel, plan.marks, config.since)
    const budget = Math.min(config.maxPerRun, config.maxPerDay - await store.sentRecently(channel))
    if (budget <= 0) return []
    return postInTurn({ items: plan.posts.slice(0, budget), config, sleep, now,
      claim: post => store.claim({ channel, post, maxAttempts: config.maxAttempts }),
      deliver: post => deliverAlert({ sender: senders[channel], url: tokenUrl(config.origin, post.mint),
        build: () => buildMilestoneMessage(post, { channel, origin: config.origin }) }),
      finish: (id, outcome) => store.finish(id, outcome),
      describe: post => ({ channel, repo: post.fullName, mint: post.mint, milestone: post.milestone }) })
  }

  async function runOnce() {
    // Before the cutoff nothing is marked or posted, so the first marks are always taken at/after it.
    if (now() < config.since.getTime()) return { posts: [], interrupted: [], skipped: 'BEFORE_SINCE' }
    return runAlertsLocked({ store, config, notMigrated: 'MILESTONE_ALERTS_NOT_MIGRATED' }, async () => {
      const excluded = await readExcluded()
      await store.forgetMarks([...excluded])
      const at = now()
      const markets = milestoneMarkets(await store.progressRows({ models: config.models === true }), excluded, at)
      const posts = []
      for (const channel of config.channels) if (senders[channel]) posts.push(...await runChannel(channel, markets))
      return posts
    })
  }
  return { runOnce }
}
