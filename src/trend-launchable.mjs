import { assertFreshTrend, trendScore, DAY, TREND_FRESH_MS } from './trend-rules.mjs'
import { DISCOVERY_VERSION, DISCOVERY_WINDOW_MS, discoveryCap, discoveryEarned } from './discovery-rewards.mjs'
import { safeGithubImageUrl } from './repo-logo.mjs'

// "Launch a trending repo": trend candidates nobody has launched yet. The trend pipeline decides what is
// trending (its review states, 6h freshness rule and versioned score); this module only removes repos that
// must not be suggested and orders the rest. Everything comes from stored evidence: no GitHub calls.
export const LAUNCHABLE_STATES = Object.freeze(['detected', 'reviewed', 'approved'])
// trendScore compares the newest observation with ones at least 1h and 2h older. The intake observes a repo
// at most once per 30-minute run, so the newest 24 observations always reach that far back.
export const OBSERVATION_LOOKBACK = 24
const REPO_ID = /^[1-9]\d{0,18}$/
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CLOCK_SKEW_MS = 60_000

// One read. It is bounded by the pipeline's own state and freshness rules and returns the facts the exclusion
// policy needs; selectLaunchableTrends applies that policy, so it lives (and is tested) in one place.
// Manual signals are operator evidence and never leave the server.
export const LAUNCHABLE_TRENDS_SQL = `select c.github_repo_id::text as "repoId", c.full_name as "fullName", c.description,
    c.state, c.observed_at as "observedAt", c.error, c.approved_config as "approvedConfig",
    r.avatar_url as "storedAvatarUrl", r.archived, m.status as "marketStatus",
    p.enabled as "participationEnabled", i.dismissed_at as "invitesDismissedAt",
    array(select o.evidence from trend_observations o where o.github_repo_id = c.github_repo_id
      order by o.observed_at desc limit $3) as observations,
    coalesce((select json_agg(s order by s."occurredAt" desc) from (select source, url, occurred_at as "occurredAt",
      expires_at as "expiresAt" from trend_signals where github_repo_id = c.github_repo_id and source <> 'manual'
      and expires_at > $1 order by occurred_at desc limit 50) s), '[]'::json) as signals
  from trend_candidates c
  left join repositories r on r.github_repo_id = c.github_repo_id
  left join markets m on m.github_repo_id = c.github_repo_id
  left join repository_participation p on p.github_repo_id = c.github_repo_id
  left join maintainer_invites i on i.github_repo_id = c.github_repo_id
  where c.state = any($4::text[]) and c.error is null and c.observed_at > $2
  order by c.observed_at desc, c.github_repo_id
  limit 200`

const isoTime = value => value instanceof Date ? value.toISOString() : value

// Why a candidate must not be suggested for launch, or null when it may be. promotionExcluded is the
// operator's do-not-promote list (PROMOTION_EXCLUDED_REPO_IDS, app/lib/promotion-exclusions.mjs).
export function launchExclusion(row, now = Date.now(), { promotionExcluded = new Set() } = {}) {
  if (!REPO_ID.test(String(row.repoId ?? '')) || !FULL_NAME.test(String(row.fullName ?? ''))) return 'INVALID_REPOSITORY'
  if (promotionExcluded.has(String(row.repoId))) return 'DO_NOT_PROMOTE'
  // duplicate and rejected are the pipeline's own verdicts; launched and active already have a market.
  if (!LAUNCHABLE_STATES.includes(row.state)) return 'NOT_LAUNCHABLE_STATE'
  try { assertFreshTrend({ observedAt: isoTime(row.observedAt), error: row.error }, now) } catch { return 'STALE_OR_UNVERIFIED' }
  // A failed launch released the repository; any other market row is live or in progress.
  if (row.marketStatus && row.marketStatus !== 'failed') return 'MARKET_EXISTS'
  if (row.archived === true) return 'ARCHIVED'
  if (row.participationEnabled === false) return 'MAINTAINER_OPTED_OUT'
  if (row.invitesDismissedAt) return 'MAINTAINER_DECLINED_CONTACT'
  return null
}

function parseObservations(values) {
  return (Array.isArray(values) ? values : []).flatMap(value => {
    try {
      const observation = typeof value === 'string' ? JSON.parse(value) : value
      return Number.isFinite(Date.parse(observation?.observedAt)) ? [observation] : []
    } catch { return [] }
  })
}
const languageName = value => typeof value === 'string' && value.trim() && value.trim().length <= 40 ? value.trim() : null
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null

function launchable(row, { now, config, discoveryEnabled }) {
  const observations = parseObservations(row.observations)
  const [latest] = observations
  if (!latest) return null
  const signals = Array.isArray(row.signals) ? row.signals.filter(signal => signal?.source !== 'manual') : []
  const score = trendScore(observations, signals, now)
  // No measured attention (no velocity yet, no live listing or story, no recent release): not "trending".
  if (!(score.total > 0)) return null
  const [owner, name] = row.fullName.split('/')
  const stars = score.inputs.stars
  // Operator-approved trends keep their attributed launch path; the launch page re-checks the approval.
  const reviewed = Boolean(discoveryEnabled && config && row.state === 'approved' && row.approvedConfig === config)
  return {
    repoId: row.repoId, fullName: row.fullName, owner, name,
    description: typeof row.description === 'string' && row.description.trim() ? row.description.trim() : null,
    avatarUrl: safeGithubImageUrl(latest.repo?.avatarUrl) ?? safeGithubImageUrl(row.storedAvatarUrl) ??
      `https://avatars.githubusercontent.com/${owner}`,
    language: languageName(latest.repo?.language),
    stars: count(latest.stars),
    starsGained: stars && stars.delta > 0 ? { delta: stars.delta, hours: stars.hours, perDay: stars.perDay } : null,
    onGithubTrending: score.inputs.trending, hnStories: score.inputs.mentions,
    releasedAt: score.parts.release > 0 ? score.inputs.releaseAt : null,
    observedAt: isoTime(row.observedAt), score: score.total, reviewed,
    launchHref: `/launch/${row.repoId}${reviewed ? '?from=trend' : ''}`,
    // A fork: the repository it was forked from, as observed (src/repo-lineage.mjs decides at launch whether it may launch).
    ...typeof latest.repo?.forkOf === 'string' && /^[\w.-]+\/[\w.-]+$/.test(latest.repo.forkOf) ? { forkOf: latest.repo.forkOf } : {},
  }
}

const byRepoId = (a, b) => { const x = BigInt(a.repoId), y = BigInt(b.repoId); return x < y ? -1 : x > y ? 1 : 0 }
// Operator-reviewed first, then the pipeline's score, then measured star velocity and stars; the
// immutable repository id makes ties deterministic.
export function compareLaunchable(a, b) {
  return Number(b.reviewed) - Number(a.reviewed) || b.score - a.score ||
    (b.starsGained?.perDay ?? 0) - (a.starsGained?.perDay ?? 0) || (b.stars ?? -1) - (a.stars ?? -1) || byRepoId(a, b)
}

// The whole ordered list (the read is already bounded); pages decide how many rows to show.
export function selectLaunchableTrends(rows, { now = Date.now(), config = null, discoveryEnabled = false, promotionExcluded = new Set(),
  limit = Infinity } = {}) {
  return rows.filter(row => launchExclusion(row, now, { promotionExcluded }) === null)
    .flatMap(row => { const item = launchable(row, { now, config, discoveryEnabled }); return item ? [item] : [] })
    .toSorted(compareLaunchable)
    .slice(0, limit)
}

// The /find-repos search list covers every tracked trend. It leaves out do-not-promote repos, like the launch
// list, and offers "Launch" only where the launch policy allows it.
export function searchListCandidates(candidates, launchableRepos, promotionExcluded = new Set()) {
  const ids = new Set(launchableRepos.map(repo => repo.repoId))
  return candidates.filter(candidate => !promotionExcluded.has(String(candidate.repoId)))
    .map(candidate => ({ ...candidate, launchable: ids.has(candidate.repoId) }))
}

// A cached list must not outlive the pipeline's freshness rule.
export function freshLaunchable(items, now = Date.now()) {
  return items.filter(item => {
    const age = now - Date.parse(item.observedAt)
    return age >= -CLOCK_SKEW_MS && age <= TREND_FRESH_MS
  })
}

export async function readLaunchableTrends(pool, { now = Date.now(), timeoutMs = 5000, ...options } = {}) {
  const { rows } = await pool.query({ text: LAUNCHABLE_TRENDS_SQL, query_timeout: timeoutMs,
    values: [new Date(now), new Date(now - TREND_FRESH_MS), OBSERVATION_LOOKBACK, [...LAUNCHABLE_STATES]] })
  return selectLaunchableTrends(rows, { now, ...options })
}

// The launcher reward as the current discovery policy computes it, so copy cannot drift from the rules.
export function launcherRewardTerms(version = DISCOVERY_VERSION) {
  return { sharePercent: Number(discoveryEarned(10_000n, version)) / 100, windowDays: DISCOVERY_WINDOW_MS / DAY,
    capSol: (Number(discoveryCap(version)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 }) }
}
