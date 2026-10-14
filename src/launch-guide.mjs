import { githubApiHeaders } from './github-app-auth.mjs'
import { forkOf, githubTime, parseRepositoryUrl } from './github.mjs'
import { assertGithubRepoId, isGithubRepoId } from './market-identity.mjs'
import { checkLaunchLineage, LineageError } from './repo-lineage.mjs'
import { activeSchedule, publicSchedule, scheduleById, ScheduleError, SCHEDULE_RULES } from './launch-schedules.mjs'
import { LIVE_BUNDLE_STATUSES } from './bundle-raise-store.mjs'
import { SYMBOL_REVIEW_STATUSES } from './launch-symbols.mjs'
import { canonicalWallet, launchPreflight, SUPPLY_BPS_OPTIONS } from './launch-preflight.mjs'
import { launchBuyPreset } from './launch-buy.mjs'
import { launchFeeTerms, readFeeSchedule } from './launch-fee.mjs'
import { GUIDE_STEPS } from '../app/lib/launch-guide-funnel.mjs'
export { createGuideEvents, guideEvents, GUIDE_EVENT_RETENTION_DAYS, GUIDE_SUMMARY_SQL, recordGuideEvent } from './launch-guide-events.mjs'

// The guided launch for maintainers (docs/LAUNCH_GUIDE.md, /launches/new): the facts a preflight needs, read once and cached
// (GitHub) or read fresh and cheap (repo.ing's own records); saved drafts so a maintainer can stop and resume; conversion events
// that identify no one; and publishing, which is the existing scheduled launch (src/launch-schedules.mjs) and nothing more.
//
// Work per preflight (docs/LAUNCH_GUIDE.md#cost-per-preflight), counted in profile:
// - GitHub: the repository (1 request) and its last 7 days of commits (1), plus the fork guard's first-commit read (0 to 2) the
//   first time a repository is checked. Cached per repository for GITHUB_FACTS_TTL_MS in this process, so re-running, saving
//   and resuming read nothing from GitHub. The admin check (3 requests) runs when a repository is selected and at publish,
//   and is reused for ADMIN_FRESH_MS in between.
// - Database: 2 queries for the repository's market, opt-out, Group launch, ticker and schedule (always fresh), plus the fork
//   guard's stored verdict.
// - Solana: the launch config once per process (immutable), and the launching wallet's balance only when a full plan is checked.
export const GITHUB_FACTS_TTL_MS = 10 * 60_000
export const ADMIN_FRESH_MS = 15 * 60_000
export const DRAFT_RETENTION_DAYS = 30
const MAX_CACHED_REPOSITORIES = 500
const PRUNE_EVERY_MS = 60 * 60_000
const DAY = 86_400_000
const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/

export class GuideError extends Error {
  constructor(message, status = 400, code = null, detail = null) { super(message); this.name = 'GuideError'; this.status = status; this.code = code; this.detail = detail }
}

// A repository named by the visitor: a numeric GitHub id, owner/name, or a github.com URL. null when it is none of those.
export function parseRepositoryInput(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 256) return null
  if (/^[1-9]\d{0,15}$/.test(text)) return isGithubRepoId(text) ? { repoId: text } : null
  if (FULL_NAME.test(text)) { const [owner, name] = text.split('/'); return { owner, name: name.replace(/\.git$/i, '') } }
  try {
    const url = /^https?:\/\//i.test(text) ? text.replace(/^http:/i, 'https:') : `https://${text}`
    // A link to a file, branch or issue names its repository first.
    const { owner, name } = parseRepositoryUrl(/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+/i.exec(url)?.[0] ?? url)
    return FULL_NAME.test(`${owner}/${name}`) ? { owner, name } : null
  } catch { return null }
}

// --- GitHub reads -------------------------------------------------------------------------------------------------------

// A repository as the preflight needs it, by immutable id or by owner/name. status: 'ok' | 'not-found' (missing or private) |
// 'unavailable' (GitHub did not answer usably; retry).
export async function readGuideRepository(input, { fetchImpl = fetch, headers = null, now = Date.now() } = {}) {
  const byId = input?.repoId !== undefined && input?.repoId !== null
  if (byId && (!/^[1-9]\d{0,15}$/.test(String(input.repoId)) || !isGithubRepoId(String(input.repoId)))) return { status: 'not-found' }
  if (!byId && !FULL_NAME.test(`${input?.owner}/${input?.name}`)) return { status: 'not-found' }
  // A Hugging Face market id never reaches GitHub (returned as not-found above; the guard makes it impossible).
  if (byId) assertGithubRepoId(String(input.repoId))
  const url = byId ? `https://api.github.com/repositories/${input.repoId}` : `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`
  let response
  try {
    response = await fetchImpl(url, { headers: headers ?? await githubApiHeaders('repo.ing-launch-guide', fetchImpl), redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(8_000) })
  } catch { return { status: 'unavailable' } }
  if (response.status === 404) return { status: 'not-found' }
  if (!response.ok) return { status: 'unavailable', httpStatus: response.status }
  let json
  try { json = await response.json() } catch { return { status: 'unavailable' } }
  if (!Number.isSafeInteger(json?.id) || json.id < 1 || (byId && String(json.id) !== String(input.repoId)) || typeof json.full_name !== 'string' ||
      typeof json.owner?.login !== 'string') return { status: 'unavailable' }
  if (!isGithubRepoId(String(json.id))) return { status: 'not-found' }
  const observedAt = new Date(now).toISOString()
  if (json.private || (json.visibility && json.visibility !== 'public')) return { status: 'not-found', private: true, repoId: String(json.id), observedAt }
  const fork = forkOf(json)
  return { status: 'ok', repoId: String(json.id), owner: json.owner.login, name: json.name, fullName: json.full_name, description: json.description ?? null,
    avatarUrl: json.owner.avatar_url ?? null, stars: Number.isSafeInteger(json.stargazers_count) ? json.stargazers_count : null,
    forks: Number.isSafeInteger(json.forks_count) ? json.forks_count : 0, archived: json.archived === true, private: false,
    createdAt: githubTime(json.created_at)?.toISOString() ?? null, updatedAt: githubTime(json.updated_at)?.toISOString() ?? null,
    pushedAt: githubTime(json.pushed_at)?.toISOString() ?? null, defaultBranch: typeof json.default_branch === 'string' ? json.default_branch : null,
    license: json.license?.spdx_id ?? null, language: json.language ?? null, ...(fork ? { fork } : {}), observedAt }
}

// What a page may show of a repository read (public GitHub facts only).
export const publicGuideRepository = repo => (repo ? { repoId: repo.repoId, fullName: repo.fullName, description: repo.description, avatarUrl: repo.avatarUrl,
  stars: repo.stars, forks: repo.forks, language: repo.language, license: repo.license, createdAt: repo.createdAt, pushedAt: repo.pushedAt,
  fork: repo.fork ?? null } : null)

// Commits on the default branch in the last 7 days and how many distinct authors made them (one request; at most 100 counted,
// truncated: true beyond that). null when GitHub cannot list them now. Authors are counted in memory and never stored.
export async function readCommitActivity(fullName, { fetchImpl = fetch, headers = null, now = Date.now() } = {}) {
  if (!FULL_NAME.test(fullName ?? '')) return null
  const since = new Date(now - 7 * DAY).toISOString()
  let response
  try {
    response = await fetchImpl(`https://api.github.com/repos/${fullName}/commits?since=${encodeURIComponent(since)}&per_page=100`,
      { headers: headers ?? await githubApiHeaders('repo.ing-launch-guide', fetchImpl), cache: 'no-store', signal: AbortSignal.timeout(8_000) })
  } catch { return null }
  const observedAt = new Date(now).toISOString()
  if (response.status === 409) return { commits: 0, authors: 0, truncated: false, observedAt } // GitHub: "Git Repository is empty."
  if (!response.ok) return null
  let list
  try { list = await response.json() } catch { return null }
  if (!Array.isArray(list)) return null
  const authors = new Set(list.map(item => item?.author?.id ?? item?.commit?.author?.email ?? item?.commit?.author?.name).filter(value => value !== undefined && value !== null))
  return { commits: list.length, authors: authors.size, truncated: list.length >= 100, observedAt }
}

// --- Launch terms ---------------------------------------------------------------------------------------------------------------

// What the active launch config means for a plan: its launch fee terms and, per initial-buy option, the exact lamports the launch
// page will use (launchBuyPreset: the largest buy whose tokens stay within that share of supply). Pure math on the config account,
// which cannot change, so a caller reads it once. client: a DynamicBondingCurveClient (only its local quote math is used).
export function launchTerms({ config, fixed, client, allocation = false }) {
  let launchFee = null, feeKnown = false
  try { launchFee = launchFeeTerms(readFeeSchedule(fixed)); feeKnown = true } catch { /* an unsupported fee mode: shown as unknown */ }
  const presets = {}
  for (const bps of SUPPLY_BPS_OPTIONS.filter(value => value > 0)) {
    try { presets[String(bps)] = launchBuyPreset(client, fixed, bps) } catch { /* that option cannot be priced on this config */ }
  }
  return { config, feeKnown, launchFee, presets, allocation: Boolean(allocation) }
}

// --- Preflight service ----------------------------------------------------------------------------------------------------

const STATE_SQL = `select
    (select json_build_object('status', m.status, 'mint', case when m.status = 'confirmed' then m.mint end) from markets m
      where m.github_repo_id = $1 and m.status <> 'failed' order by m.id desc limit 1) as market,
    (select json_build_object('kind', o.kind) from maintainer_opt_outs o where o.github_repo_id = $1 and o.withdrawn_at is null limit 1) as "optOut",
    (select b.bundle_id::text from bundles b where b.github_repo_id = $1 and b.status = any($2::text[]) limit 1) as "liveBundleId",
    (case when $3::text is null then false else exists (select 1 from markets m where lower(m.token_symbol) = lower($3) and m.github_repo_id <> $1
      and m.status = any($4::text[]) and not exists (select 1 from maintainer_opt_outs o where o.github_repo_id = m.github_repo_id and o.withdrawn_at is null))
      or exists (select 1 from bundles b where lower(b.token_symbol) = lower($3) and b.github_repo_id <> $1 and b.status = any($2::text[])) end) as "symbolTaken"`

// repo.ing's own records for one repository, always fresh: 2 queries.
export async function readGuideState(db, repoId, { symbol = null, now = Date.now() } = {}) {
  const [{ rows: [row] }, schedule] = await Promise.all([
    db.query(STATE_SQL, [String(repoId), [...LIVE_BUNDLE_STATUSES], symbol, [...SYMBOL_REVIEW_STATUSES]]),
    activeSchedule(db, repoId),
  ])
  const live = schedule ? publicSchedule(schedule, now) : null
  return { market: row?.market ?? null, optOut: row?.optOut ?? null, liveBundleId: row?.liveBundleId ?? null, symbolTaken: row?.symbolTaken === true,
    // A schedule whose window passed without a launch no longer holds the repository (the worker marks it lapsed).
    schedule: live && (live.state === 'upcoming' || live.state === 'open') ? live : null }
}

// pool: PostgreSQL. readTerms({ meter }): the launch config's terms ({ config, feeKnown, launchFee, presets, allocation }), counting its
// own RPC reads in meter.rpc. readBalance(wallet, { meter }): lamports as a string. platform(): { launchAvailable, schedulesEnabled }.
export function createPreflightService({ pool, fetchImpl = fetch, readTerms = async () => null, readBalance = async () => null,
  platform = () => ({ launchAvailable: true, schedulesEnabled: true }), now = Date.now, ttlMs = GITHUB_FACTS_TTL_MS, lineage = checkLaunchLineage, log = () => {} }) {
  const cache = new Map()
  const remember = (key, value) => {
    if (cache.size >= MAX_CACHED_REPOSITORIES) cache.delete(cache.keys().next().value)
    cache.set(key, value)
  }
  async function githubFacts(input, { refresh, meter, db }) {
    const key = input.repoId ? `id:${input.repoId}` : `name:${String(input.owner).toLowerCase()}/${String(input.name).toLowerCase()}`
    const hit = !refresh ? cache.get(key) : null
    if (hit && now() - hit.at < ttlMs) return { ...hit.facts, cached: true }
    const counted = async (url, options) => { meter.github += 1; return fetchImpl(url, options) }
    let headers
    try { headers = await githubApiHeaders('repo.ing-launch-guide', fetchImpl) } catch { return { repository: { status: 'unavailable' }, activity: null, lineage: null, cached: false } }
    const repository = await readGuideRepository(input, { fetchImpl: counted, headers, now: now() })
    let activity = null, verdict = null
    if (repository.status === 'ok') {
      const [commits, check] = await Promise.all([
        readCommitActivity(repository.fullName, { fetchImpl: counted, headers, now: now() }),
        lineage({ pool: db, repo: { githubRepoId: repository.repoId, fullName: repository.fullName, owner: repository.owner, githubCreatedAt: repository.createdAt,
          ...(repository.fork ? { fork: repository.fork } : {}) }, fetchImpl: counted, advisory: true, log })
          .then(result => ({ status: 'ok', forkOf: result?.forkOf ?? null }),
            error => error instanceof LineageError ? { status: 'blocked', message: error.message, mint: error.original?.mint ?? null } : { status: 'unknown' }),
      ])
      activity = commits; verdict = check
    }
    const facts = { repository, activity, lineage: verdict }
    // Only a complete read is cached; a GitHub hiccup is read again next time.
    if (repository.status === 'ok' && activity) {
      const entry = { at: now(), facts }
      remember(`id:${repository.repoId}`, entry)
      remember(`name:${repository.fullName.toLowerCase()}`, entry)
    }
    return { ...facts, cached: false }
  }
  return {
    // input: { repoId } or { owner, name }. plan: the draft plan or null. maintainer: { status, githubLogin, permission, checkedAt }
    // or null (signed out). balance: read the launching wallet's balance (only when the plan names a valid wallet).
    async run(input, { plan = null, maintainer = null, refresh = false, balance = true } = {}) {
      const started = performance.now()
      const meter = { github: 0, rpc: 0, database: 0 }
      const db = { query: (...args) => { meter.database += 1; return pool.query(...args) } }
      const facts = await githubFacts(input, { refresh, meter, db })
      const repoId = facts.repository.status === 'ok' ? facts.repository.repoId : null
      const symbol = typeof plan?.tokenSymbol === 'string' && plan.tokenSymbol ? plan.tokenSymbol : null
      const wallet = canonicalWallet(plan?.launcherWallet ?? '')
      const [state, terms, walletFacts] = await Promise.all([
        repoId ? readGuideState(db, repoId, { symbol, now: now() }).catch(error => { log('launch_guide_state_unavailable', { code: error?.code ?? 'error' }); return null }) : null,
        readTerms({ meter }).catch(() => null),
        balance && wallet && plan?.supplyBps !== undefined
          ? readBalance(wallet, { meter }).then(value => ({ balanceLamports: value === null || value === undefined ? null : String(value), observedAt: new Date(now()).toISOString() }), () => null)
          : null,
      ])
      const preflight = launchPreflight({ ...facts, maintainer, state, platform: platform(), plan, terms, wallet: walletFacts }, { now: now() })
      const profile = { githubRequests: meter.github, rpcRequests: meter.rpc, databaseQueries: meter.database, githubCached: facts.cached,
        ms: Math.round(performance.now() - started) }
      return { preflight, profile, repository: facts.repository.status === 'ok' ? facts.repository : null }
    },
    // Whether a run for this input would be answered from the GitHub cache (callers budget only uncached runs).
    isCached(input) {
      const key = input?.repoId ? `id:${input.repoId}` : `name:${String(input?.owner).toLowerCase()}/${String(input?.name).toLowerCase()}`
      const hit = cache.get(key)
      return Boolean(hit && now() - hit.at < ttlMs)
    },
    // The repository facts last read (for persisting the repository row at publish without reading GitHub again), or null.
    cachedRepository(repoId) {
      const hit = cache.get(`id:${repoId}`)
      return hit && now() - hit.at < ttlMs ? hit.facts.repository : null
    },
    forget(repoId) { cache.delete(`id:${repoId}`) },
  }
}

// --- Plans and drafts -------------------------------------------------------------------------------------------------------

export const PLAN_KEYS = Object.freeze(['scheduledAt', 'windowMinutes', 'launcherWallet', 'supplyBps', 'note', 'tokenName', 'tokenSymbol', 'acknowledged'])

// A draft plan's shape (the preflight judges its content): known keys only, bounded strings, numbers and booleans. Empty values
// are left out, so a partial plan is fine.
export function normalizePlan(input) {
  if (input === null || input === undefined) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new GuideError('Invalid plan.')
  const plan = {}
  const text = (key, max) => {
    const value = input[key]
    if (value === undefined || value === null || value === '') return
    if (typeof value !== 'string' || value.length > max) throw new GuideError(`Invalid ${key}.`)
    const trimmed = value.trim()
    if (trimmed) plan[key] = trimmed
  }
  text('scheduledAt', 40)
  if (plan.scheduledAt !== undefined) {
    const at = Date.parse(plan.scheduledAt)
    if (!Number.isFinite(at)) throw new GuideError('Choose a valid launch time.')
    plan.scheduledAt = new Date(at).toISOString()
  }
  if (input.windowMinutes !== undefined && input.windowMinutes !== null && input.windowMinutes !== '') {
    const value = Number(input.windowMinutes)
    if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new GuideError('Invalid launch window.')
    plan.windowMinutes = value
  }
  text('launcherWallet', 64)
  if (input.supplyBps !== undefined && input.supplyBps !== null && input.supplyBps !== '') {
    const value = Number(input.supplyBps)
    if (!SUPPLY_BPS_OPTIONS.includes(value)) throw new GuideError('Choose no initial buy, 1%, 2% or 3% of supply.')
    plan.supplyBps = value
  }
  text('note', 1200)
  text('tokenName', 64)
  text('tokenSymbol', 16)
  if (plan.tokenSymbol) plan.tokenSymbol = plan.tokenSymbol.replace(/^\$/, '').toUpperCase()
  if (input.acknowledged !== undefined && input.acknowledged !== null) {
    if (typeof input.acknowledged !== 'boolean') throw new GuideError('Invalid acknowledgement.')
    plan.acknowledged = input.acknowledged
  }
  return plan
}
export const planComplete = plan => Boolean(plan?.scheduledAt && plan?.launcherWallet && plan?.supplyBps !== undefined)

const DRAFT_SELECT = `select d.id, d.github_repo_id::text as "repoId", r.full_name as "fullName", d.status, d.step, d.plan, d.preflight,
    d.preflight_at as "preflightAt", d.admin_login as "adminLogin", d.admin_checked_at as "adminCheckedAt", d.schedule_id::text as "scheduleId",
    d.created_at as "createdAt", d.updated_at as "updatedAt", d.published_at as "publishedAt"
  from launch_guide_drafts d left join repositories r on r.github_repo_id = d.github_repo_id`
const isoOf = value => (value instanceof Date ? value.toISOString() : value ?? null)
export function publicDraft(row) {
  if (!row) return null
  return { id: row.id, repoId: row.repoId, fullName: row.fullName ?? row.preflight?.fullName ?? null, status: row.status, step: row.step, plan: row.plan ?? {},
    preflight: row.preflight ?? null, preflightAt: isoOf(row.preflightAt), adminLogin: row.adminLogin ?? null, adminCheckedAt: isoOf(row.adminCheckedAt),
    scheduleId: row.scheduleId ?? null, createdAt: isoOf(row.createdAt), updatedAt: isoOf(row.updatedAt), publishedAt: isoOf(row.publishedAt) }
}
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const assertDraftId = id => { if (typeof id !== 'string' || !DRAFT_ID.test(id)) throw new GuideError('Invalid draft.', 400) }
const userId = value => { if (!/^[1-9]\d{0,19}$/.test(String(value ?? ''))) throw new GuideError('Sign in with GitHub again.', 401); return String(value) }

// Drafts belong to one GitHub account (by its numeric id); every read and write is scoped to it. One open draft per account and
// repository. A draft not touched for DRAFT_RETENTION_DAYS, or published that long ago, is deleted (the schedule is the public record).
export function createGuideDrafts(pool, { retentionDays = DRAFT_RETENTION_DAYS, now = Date.now } = {}) {
  let nextPrune = 0
  const prune = async () => (await pool.query(`delete from launch_guide_drafts where (status = 'draft' and updated_at < now() - make_interval(days => $1))
    or (status = 'published' and published_at < now() - make_interval(days => $1))`, [retentionDays])).rowCount
  const maybePrune = () => { if (now() >= nextPrune) { nextPrune = now() + PRUNE_EVERY_MS; prune().catch(() => {}) } }
  const one = async (sql, params) => publicDraft((await pool.query(sql, params)).rows[0] ?? null)
  const get = async (id, githubUserId) => {
    assertDraftId(id)
    return one(`${DRAFT_SELECT} where d.id = $1 and d.github_user_id = $2`, [id, userId(githubUserId)])
  }
  return {
    prune,
    get,
    // The open draft for this account and repository, created or resumed (resumed: true), with a fresh admin check recorded.
    async open({ githubUserId, repoId, adminLogin, adminCheckedAt, step = 'preflight' }) {
      maybePrune()
      if (!LOGIN.test(adminLogin ?? '')) throw new GuideError('GitHub returned an unexpected login.', 503)
      const { rows: [row] } = await pool.query(`insert into launch_guide_drafts (github_user_id, github_repo_id, step, admin_login, admin_checked_at)
          values ($1, $2, $3, $4, $5)
        on conflict (github_user_id, github_repo_id) where status = 'draft'
          do update set admin_login = excluded.admin_login, admin_checked_at = excluded.admin_checked_at, updated_at = now()
        returning id, (xmax <> 0) as resumed`, [userId(githubUserId), String(repoId), step, adminLogin, adminCheckedAt ?? new Date(now())])
      return { ...await get(row.id, githubUserId), resumed: row.resumed === true }
    },
    async list(githubUserId, { limit = 20 } = {}) {
      const { rows } = await pool.query(`${DRAFT_SELECT} where d.github_user_id = $1 and d.status = 'draft' order by d.updated_at desc limit $2`, [userId(githubUserId), limit])
      return rows.map(publicDraft)
    },
    async save(id, githubUserId, { step, plan }) {
      assertDraftId(id)
      if (step !== undefined && !GUIDE_STEPS.includes(step)) throw new GuideError('Invalid step.')
      const draft = await one(`update launch_guide_drafts set step = coalesce($3, step), plan = coalesce($4::jsonb, plan), updated_at = now()
        where id = $1 and github_user_id = $2 and status = 'draft'
        returning id, github_repo_id::text as "repoId", status, step, plan, preflight, preflight_at as "preflightAt", admin_login as "adminLogin",
          admin_checked_at as "adminCheckedAt", schedule_id::text as "scheduleId", created_at as "createdAt", updated_at as "updatedAt", published_at as "publishedAt"`,
      [id, userId(githubUserId), step ?? null, plan === undefined ? null : JSON.stringify(normalizePlan(plan))])
      if (!draft) throw new GuideError('This draft is no longer open. Start again from your repositories.', 404)
      return draft
    },
    async recordAdmin(id, githubUserId, { adminLogin, adminCheckedAt }) {
      await pool.query(`update launch_guide_drafts set admin_login = $3, admin_checked_at = $4 where id = $1 and github_user_id = $2 and status = 'draft'`,
        [id, userId(githubUserId), adminLogin, adminCheckedAt])
    },
    async storePreflight(id, githubUserId, preflight, at = new Date(now())) {
      await pool.query(`update launch_guide_drafts set preflight = $3::jsonb, preflight_at = $4 where id = $1 and github_user_id = $2 and status = 'draft'`,
        [id, userId(githubUserId), JSON.stringify(preflight), at])
    },
    async markPublished(id, githubUserId, scheduleId) {
      const { rowCount } = await pool.query(`update launch_guide_drafts set status = 'published', step = 'publish', schedule_id = $3, published_at = now(), updated_at = now()
        where id = $1 and github_user_id = $2 and status = 'draft'`, [id, userId(githubUserId), String(scheduleId)])
      return rowCount === 1
    },
    async discard(id, githubUserId) {
      assertDraftId(id)
      const { rowCount } = await pool.query(`delete from launch_guide_drafts where id = $1 and github_user_id = $2 and status = 'draft'`, [id, userId(githubUserId)])
      return rowCount === 1
    },
  }
}

// --- The guide --------------------------------------------------------------------------------------------------------------

// Classifies a failed admin check: GitHub refusing the App's view of the repository (no installation access) versus a hiccup.
export function adminFailure(error) {
  return /HTTP 40[34]|identity could not be confirmed/.test(String(error?.message ?? '')) ? 'no-access' : 'unknown'
}

// session: { githubUserId, githubLogin }. verifyAdmin(repoId): GitHub's fresh answer { admin, githubLogin, permission } (throws when it
// cannot tell). schedules: createLaunchSchedules bound to the same session (it checks admin again itself). persistRepository(repo).
export function createLaunchGuide({ pool, preflight, drafts = createGuideDrafts(pool), verifyAdmin, schedules, persistRepository = async () => {},
  record = async () => {}, now = Date.now }) {
  async function maintainerFor(draft, session) {
    const fresh = draft?.adminCheckedAt && now() - Date.parse(draft.adminCheckedAt) < ADMIN_FRESH_MS
    if (fresh) return { status: 'admin', githubLogin: draft.adminLogin, checkedAt: draft.adminCheckedAt }
    let result
    try { result = await verifyAdmin(draft.repoId) } catch (error) { return { status: adminFailure(error), githubLogin: session.githubLogin } }
    const checkedAt = new Date(now()).toISOString()
    if (!result?.admin) return { status: 'not-admin', githubLogin: result?.githubLogin ?? session.githubLogin, permission: result?.permission ?? 'none', checkedAt }
    await drafts.recordAdmin(draft.id, session.githubUserId, { adminLogin: result.githubLogin, adminCheckedAt: checkedAt })
    return { status: 'admin', githubLogin: result.githubLogin, checkedAt }
  }
  return {
    drafts,
    // Select a repository: a fresh admin check, then the open draft for it (created or resumed).
    async select(session, repoId, { source = null } = {}) {
      if (!/^[1-9]\d{0,15}$/.test(String(repoId ?? '')) || !isGithubRepoId(String(repoId))) throw new GuideError('Invalid repository.')
      let result
      try { result = await verifyAdmin(String(repoId)) } catch (error) {
        const status = adminFailure(error)
        await record({ event: 'repo_selected', source, repoId, outcome: status === 'no-access' ? 'no-access' : 'failed' })
        return { draft: null, maintainer: { status, githubLogin: session.githubLogin } }
      }
      if (!result?.admin) {
        await record({ event: 'repo_selected', source, repoId, outcome: 'not-admin' })
        return { draft: null, maintainer: { status: 'not-admin', githubLogin: result?.githubLogin ?? session.githubLogin, permission: result?.permission ?? 'none' } }
      }
      const checkedAt = new Date(now())
      const draft = await drafts.open({ githubUserId: session.githubUserId, repoId: String(repoId), adminLogin: result.githubLogin, adminCheckedAt: checkedAt })
      await record({ event: draft.resumed ? 'draft_resumed' : 'repo_selected', source, repoId, outcome: draft.resumed ? null : 'admin' })
      return { draft, maintainer: { status: 'admin', githubLogin: result.githubLogin, checkedAt: checkedAt.toISOString() } }
    },
    // Runs the preflight for a draft (plan included) and stores the result on it.
    async check(session, draftId, { plan, refresh = false, source = null } = {}) {
      let draft = await drafts.get(draftId, session.githubUserId)
      if (!draft) throw new GuideError('Draft not found. Choose the repository again.', 404)
      if (plan !== undefined && draft.status === 'draft') draft = await drafts.save(draft.id, session.githubUserId, { plan })
      const maintainer = await maintainerFor(draft, session)
      const result = await preflight.run({ repoId: draft.repoId }, { plan: Object.keys(draft.plan ?? {}).length ? draft.plan : null, maintainer, refresh })
      if (draft.status === 'draft') await drafts.storePreflight(draft.id, session.githubUserId, result.preflight)
      await record({ event: 'preflight_run', source, repoId: draft.repoId, outcome: result.repository ? result.preflight.verdict : 'unavailable' })
      return { ...result, draft: { ...draft, preflight: result.preflight, preflightAt: result.preflight.checkedAt } }
    },
    // Publishes the draft's plan as the repository's scheduled launch. Idempotent: a published draft returns its schedule.
    async publish(session, draftId, { source = null } = {}) {
      const draft = await drafts.get(draftId, session.githubUserId)
      if (!draft) throw new GuideError('Draft not found. Choose the repository again.', 404)
      if (draft.status === 'published') {
        const row = await scheduleById(pool, draft.scheduleId)
        return { schedule: publicSchedule(row, now()), draft, alreadyPublished: true }
      }
      const plan = draft.plan ?? {}
      if (!planComplete(plan)) throw new GuideError('Finish the plan first: time, launching wallet and initial buy.', 409, 'PLAN_INCOMPLETE')
      if (plan.acknowledged !== true) throw new GuideError('Confirm the disclosures before publishing.', 409, 'NOT_ACKNOWLEDGED')
      // A publish whose response was lost reached the database: the same admin's schedule with this plan's wallet and time is this
      // draft's own, so it is adopted instead of refused as "already scheduled".
      const mine = row => row && String(row.launcherWallet) === plan.launcherWallet && new Date(row.scheduledAt).toISOString() === plan.scheduledAt
        && String(row.githubUserId ?? '') === String(session.githubUserId)
      const adopt = async row => {
        const schedule = publicSchedule(row, now())
        await drafts.markPublished(draft.id, session.githubUserId, schedule.id)
        await record({ event: 'publish', source, repoId: draft.repoId, outcome: 'scheduled' })
        return { schedule, draft: await drafts.get(draft.id, session.githubUserId), alreadyPublished: true }
      }
      const existing = await activeSchedule(pool, draft.repoId)
      if (mine(existing)) return adopt(existing)
      const maintainer = await maintainerFor(draft, session)
      const { preflight: checked } = await preflight.run({ repoId: draft.repoId }, { plan, maintainer, balance: false })
      await drafts.storePreflight(draft.id, session.githubUserId, checked)
      if (!checked.ready.schedule) {
        await record({ event: 'publish', source, repoId: draft.repoId, outcome: 'refused' })
        throw new GuideError('The preflight found requirements that are not met yet.', 409, 'PREFLIGHT_NOT_READY', { missing: checked.missing, preflight: checked })
      }
      const body = { repoId: draft.repoId, scheduledAt: plan.scheduledAt, windowMinutes: plan.windowMinutes ?? SCHEDULE_RULES.defaultWindowMinutes,
        launcherWallet: plan.launcherWallet, maxInitialBuyLamports: checked.plannedBuyLamports, note: plan.note ?? null }
      let schedule
      try {
        await persistRepository(draft.repoId)
        schedule = await schedules.create(body)
      } catch (error) {
        // Two publishes of the same draft at once: the other one's schedule is this draft's own.
        if (error instanceof ScheduleError && error.status === 409) {
          const row = await activeSchedule(pool, draft.repoId)
          if (mine(row)) return adopt(row)
        }
        await record({ event: 'publish', source, repoId: draft.repoId, outcome: error instanceof ScheduleError ? 'refused' : 'failed' })
        throw error
      }
      await drafts.markPublished(draft.id, session.githubUserId, schedule.id)
      await record({ event: 'publish', source, repoId: draft.repoId, outcome: 'scheduled' })
      return { schedule, draft: await drafts.get(draft.id, session.githubUserId), alreadyPublished: false }
    },
  }
}
