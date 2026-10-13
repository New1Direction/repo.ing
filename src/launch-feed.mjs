import { publicSchedule, scheduleState, upcomingSchedules } from './launch-schedules.mjs'
import { qualitySummary } from './launch-quality.mjs'

// The public launch feed (docs/MARKET_DATA_API.md#launch-feed): one deduplicated row per public fact, produced by the worker from
// records repo.ing already keeps, so the JSON events API, the Atom feed and webhooks all say the same thing. Kinds:
//   launch.scheduled / launch.schedule_cancelled / launch.window_open / launch.schedule_lapsed   (src/launch-schedules.mjs)
//   market.launched / market.graduated                                                          (indexed, finalized evidence)
//   group_launch.raising / group_launch.launched / group_launch.failed                           (Group launch raises)
// GitHub repositories only; repositories repo.ing must not promote (do-not-promote list, maintainer decisions) are left out,
// as in launch alerts. Facts older than LOOKBACK_DAYS are never added, so a fresh database starts with two weeks of history.
export const FEED_KINDS = Object.freeze(['launch.scheduled', 'launch.schedule_cancelled', 'launch.window_open', 'launch.schedule_lapsed',
  'market.launched', 'market.graduated', 'group_launch.raising', 'group_launch.launched', 'group_launch.failed'])
export const LOOKBACK_DAYS = 14
const GITHUB_MAX = 4503599627370495n

const iso = value => (value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null)

// Candidate events from the source tables (no writes): [{ kind, dedupeKey, repoId, occurredAt, payload }].
export async function feedCandidates(db, { now = Date.now() } = {}) {
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000), at = new Date(now)
  const optional = sql => db.query(sql, [since, at]).then(result => result.rows, error => (error?.code === '42P01' ? [] : Promise.reject(error)))
  const [schedules, launches, graduations, bundles] = await Promise.all([
    optional(`select s.id, s.github_repo_id::text as "repoId", s.status, s.scheduled_at as "scheduledAt", s.window_minutes as "windowMinutes",
        s.launcher_wallet as "launcherWallet", s.max_initial_buy_lamports::text as "maxInitialBuyLamports", s.note, s.github_login as "githubLogin",
        s.created_at as "createdAt", s.updated_at as "updatedAt", s.cancelled_at as "cancelledAt", s.launched_mint as "launchedMint", r.full_name as "fullName"
      from launch_schedules s join repositories r on r.github_repo_id = s.github_repo_id
      where s.updated_at >= $1 or s.created_at >= $1 or (s.scheduled_at between $1 and $2)`),
    optional(`select m.github_repo_id::text as "repoId", m.mint, m.token_symbol as symbol, m.token_name as name, m.launcher_wallet as "launcherWallet",
        m.bundle_id::text as "bundleId", coalesce(m.launch_block_time, m.indexed_at) as "launchedAt", m.launch_signature as signature, r.full_name as "fullName"
      from markets m join repositories r on r.github_repo_id = m.github_repo_id
      where m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized' and m.indexed_at >= $1 and m.indexed_at <= $2`),
    optional(`select g.github_repo_id::text as "repoId", g.signature, g.pool, g.recorded_at as "recordedAt", m.mint, m.token_symbol as symbol, r.full_name as "fullName"
      from graduation_events g join markets m on m.github_repo_id = g.github_repo_id join repositories r on r.github_repo_id = g.github_repo_id
      where g.recorded_at >= $1 and g.recorded_at <= $2`),
    optional(`select b.bundle_id::text as "bundleId", b.github_repo_id::text as "repoId", b.status, b.token_symbol as symbol, b.target_lamports::text as "targetLamports",
        b.deadline, b.created_at as "createdAt", b.updated_at as "updatedAt", b.launch_mint as "launchMint", r.full_name as "fullName"
      from bundles b join repositories r on r.github_repo_id = b.github_repo_id
      where b.status in ('raising', 'launched', 'failed', 'expired') and b.updated_at >= $1 and b.created_at <= $2`),
  ])
  const events = []
  const push = (kind, dedupeKey, repoId, occurredAt, payload) => {
    if (!occurredAt || BigInt(repoId) > GITHUB_MAX || new Date(occurredAt) > at) return
    events.push({ kind, dedupeKey, repoId: String(repoId), occurredAt: iso(occurredAt), payload: { repoId: String(repoId), ...payload } })
  }
  for (const row of schedules) {
    const schedule = publicSchedule({ ...row, githubRepoId: row.repoId }, now)
    const base = { fullName: row.fullName, schedule: { ...schedule, state: undefined }, path: `/launches#schedule-${row.id}` }
    push('launch.scheduled', `launch.scheduled:${row.id}`, row.repoId, row.createdAt, base)
    if (row.status === 'cancelled') push('launch.schedule_cancelled', `launch.schedule_cancelled:${row.id}`, row.repoId, row.cancelledAt, base)
    if (row.status !== 'cancelled' && new Date(row.scheduledAt).getTime() <= now) {
      push('launch.window_open', `launch.window_open:${row.id}`, row.repoId, row.scheduledAt, base)
    }
    if (row.status === 'lapsed' || (row.status === 'scheduled' && scheduleState({ ...row }, now) === 'lapsed')) {
      push('launch.schedule_lapsed', `launch.schedule_lapsed:${row.id}`, row.repoId, schedule.windowEndsAt, base)
    }
  }
  for (const row of launches) {
    push('market.launched', `market.launched:${row.repoId}`, row.repoId, row.launchedAt, { fullName: row.fullName, mint: row.mint, symbol: row.symbol,
      name: row.name, launcherWallet: row.launcherWallet, groupLaunch: row.bundleId !== null, signature: row.signature, path: `/token/${row.mint}` })
  }
  for (const row of graduations) {
    push('market.graduated', `market.graduated:${row.repoId}`, row.repoId, row.recordedAt, { fullName: row.fullName, mint: row.mint, symbol: row.symbol,
      pool: row.pool, signature: row.signature, path: `/token/${row.mint}` })
  }
  for (const row of bundles) {
    const base = { fullName: row.fullName, bundleId: row.bundleId, symbol: row.symbol, targetLamports: row.targetLamports, deadline: iso(row.deadline),
      path: `/group/${row.bundleId}` }
    push('group_launch.raising', `group_launch.raising:${row.bundleId}`, row.repoId, row.createdAt, base)
    if (row.status === 'launched') push('group_launch.launched', `group_launch.launched:${row.bundleId}`, row.repoId, row.updatedAt, { ...base, mint: row.launchMint })
    if (row.status === 'failed' || row.status === 'expired') push('group_launch.failed', `group_launch.failed:${row.bundleId}`, row.repoId, row.updatedAt, base)
  }
  return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.dedupeKey.localeCompare(b.dedupeKey))
}

// Inserts new events in occurrence order (ids then follow it); existing dedupe keys are left untouched.
export async function produceFeedEvents(db, { now = Date.now(), excluded = new Set() } = {}) {
  let candidates
  try { candidates = await feedCandidates(db, { now }) } catch (error) {
    if (error?.code === '42P01') return { added: 0, skipped: 'NOT_MIGRATED' }
    throw error
  }
  let added = 0
  for (const event of candidates) {
    if (excluded.has(event.repoId)) continue
    const { rowCount } = await db.query(`insert into launch_feed_events (kind, dedupe_key, github_repo_id, occurred_at, payload)
      values ($1, $2, $3, $4, $5) on conflict (dedupe_key) do nothing`, [event.kind, event.dedupeKey, event.repoId, event.occurredAt, event.payload])
    added += rowCount
  }
  return { added, candidates: candidates.length }
}

// A bad query parameter; the only error the feed routes repeat to the caller.
export class FeedQueryError extends Error {
  constructor(message) { super(message); this.name = 'FeedQueryError' }
}

export function parseFeedQuery(params) {
  const after = params.get('after'), limit = params.get('limit')
  const kinds = (params.get('kind') ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const repos = (params.get('repo') ?? params.get('repos') ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (after !== null && !/^\d{1,18}$/.test(after)) throw new FeedQueryError('after must be an event id')
  if (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)) throw new FeedQueryError('limit is 1 to 200')
  if (kinds.some(kind => !FEED_KINDS.includes(kind))) throw new FeedQueryError(`kind must be one of ${FEED_KINDS.join(', ')}`)
  if (repos.length > 50 || repos.some(id => !/^[1-9]\d{0,15}$/.test(id))) throw new FeedQueryError('repo is up to 50 repository ids')
  return { after: after === null ? null : after, limit: limit === null ? 50 : Number(limit), kinds, repos }
}

const publicEvent = row => ({ id: String(row.id), kind: row.kind, repoId: String(row.githubRepoId), occurredAt: iso(row.occurredAt),
  recordedAt: iso(row.createdAt), data: row.payload })

// Newest first without `after`; with `after`, the next events in id order (for polling and resuming).
export async function readFeedEvents(db, { after = null, limit = 50, kinds = [], repos = [] } = {}) {
  const filters = [], params = []
  if (after !== null) { params.push(after); filters.push(`id > $${params.length}`) }
  if (kinds.length) { params.push(kinds); filters.push(`kind = any($${params.length}::text[])`) }
  if (repos.length) { params.push(repos); filters.push(`github_repo_id = any($${params.length}::bigint[])`) }
  params.push(limit)
  const { rows } = await db.query(`select id, kind, github_repo_id as "githubRepoId", occurred_at as "occurredAt", created_at as "createdAt", payload
    from launch_feed_events ${filters.length ? `where ${filters.join(' and ')}` : ''}
    order by id ${after === null ? 'desc' : 'asc'} limit $${params.length}`, params)
  return rows.map(publicEvent)
}

// The launch calendar: scheduled launches still ahead or open, Group launch raises still raising, and the last week's launches
// with their stored quality summary.
export async function launchCalendar(db, { now = Date.now(), excluded = new Set(), recentDays = 7 } = {}) {
  const optional = (sql, params) => db.query(sql, params).then(result => result.rows, error => (error?.code === '42P01' ? [] : Promise.reject(error)))
  const [upcoming, raising, recent] = await Promise.all([
    upcomingSchedules(db, { now }).catch(error => (error?.code === '42P01' ? [] : Promise.reject(error))),
    optional(`select b.bundle_id::text as "bundleId", b.github_repo_id::text as "repoId", b.token_symbol as symbol, b.token_name as name,
        b.target_lamports::text as "targetLamports", b.deadline, b.created_at as "openedAt", r.full_name as "fullName"
      from bundles b join repositories r on r.github_repo_id = b.github_repo_id where b.status = 'raising' and b.deadline > $1 order by b.deadline limit 100`, [new Date(now)]),
    optional(`select m.github_repo_id::text as "repoId", m.mint, m.token_symbol as symbol, m.token_name as name, m.launcher_wallet as "launcherWallet",
        coalesce(m.launch_block_time, m.indexed_at) as "launchedAt", m.bundle_id is not null as "groupLaunch", r.full_name as "fullName",
        q.report as "qualityReport"
      from markets m join repositories r on r.github_repo_id = m.github_repo_id
      left join launch_quality_reports q on q.github_repo_id = m.github_repo_id
      where m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized' and m.github_repo_id <= 4503599627370495
        and coalesce(m.launch_block_time, m.indexed_at) >= $1
      order by coalesce(m.launch_block_time, m.indexed_at) desc limit 100`, [new Date(now - recentDays * 86_400_000)])
      .catch(error => (error?.code === '42703' ? [] : Promise.reject(error))),
  ])
  const visible = row => !excluded.has(String(row.repoId))
  return {
    generatedAt: new Date(now).toISOString(),
    scheduled: upcoming.filter(visible),
    groupLaunches: raising.filter(visible).map(row => ({ ...row, deadline: iso(row.deadline), openedAt: iso(row.openedAt), path: `/group/${row.bundleId}` })),
    recentLaunches: recent.filter(visible).map(({ qualityReport, ...row }) => ({ ...row, launchedAt: iso(row.launchedAt), path: `/token/${row.mint}`,
      quality: qualitySummary(qualityReport) })),
  }
}
