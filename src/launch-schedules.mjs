import { PublicKey } from '@solana/web3.js'
import { NoteError, sanitizeNote } from './holder-notes.mjs'
import { isBlockedWallet } from './blocked-wallets.mjs'

// Scheduled launches (docs/LAUNCH_TRANSPARENCY.md#scheduled-launches): a repository's current GitHub admin announces when its
// market will launch, from which wallet, and the most that wallet will buy in the launch transaction. The announcement is public
// (calendar, feeds, webhooks) at least an hour ahead, so nobody gets earlier notice than anyone else. Every launch path goes
// through the coordinator's reservation (src/launch-coordinator.mjs), which calls assertScheduleAllows:
//   before scheduled_at       nobody may launch the repository (not even the announced wallet: the time is the announcement);
//   during the window         only the announced wallet may, with at most the announced initial buy, and not as a Group launch;
//   after the window          the schedule has lapsed and the repository launches like any other.
// The launch itself is unchanged: the same 3% initial-buy cap, launch fee window and atomic transaction.
export const SCHEDULE_RULES = Object.freeze({
  minNoticeMs: 60 * 60 * 1000,
  maxAheadMs: 30 * 24 * 60 * 60 * 1000,
  minWindowMinutes: 15,
  maxWindowMinutes: 1440,
  defaultWindowMinutes: 120,
  // The launch path still enforces the 3% supply cap (src/launch-buy.mjs); this only bounds what may be announced.
  maxInitialBuyLamports: 1_000_000_000n,
})
export const SCHEDULE_CODES = Object.freeze({
  BEFORE: 'LAUNCH_SCHEDULED',
  LAUNCHER: 'SCHEDULED_LAUNCHER_ONLY',
  BUY: 'SCHEDULED_BUY_ABOVE_ANNOUNCED',
  BUNDLE: 'SCHEDULED_NO_GROUP_LAUNCH',
  EARLY_ACCESS: 'SCHEDULED_NO_EARLY_ACCESS',
})

// Scheduling is on unless LAUNCH_SCHEDULES_ENABLED=false (web); cancelling and the launch gate always work.
export const schedulesEnabled = (env = process.env) => env.LAUNCH_SCHEDULES_ENABLED !== 'false'

export class ScheduleError extends Error {
  constructor(message, status = 400, code = null) { super(message); this.name = 'ScheduleError'; this.status = status; this.code = code }
}

const REPO_ID = /^[1-9]\d{0,15}$/
const iso = value => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : new Date(value).toISOString())
const time = value => (value instanceof Date ? value.getTime() : new Date(value).getTime())

export function scheduleWindowEnd(row) {
  return time(row.scheduledAt) + Number(row.windowMinutes) * 60_000
}

// 'upcoming' | 'open' | 'lapsed' (window passed without a launch) | 'cancelled' | 'launched'
export function scheduleState(row, now = Date.now()) {
  if (!row) return null
  if (row.status === 'cancelled' || row.status === 'launched' || row.status === 'lapsed') return row.status
  if (now < time(row.scheduledAt)) return 'upcoming'
  return now < scheduleWindowEnd(row) ? 'open' : 'lapsed'
}

export function publicSchedule(row, now = Date.now()) {
  if (!row) return null
  return { id: String(row.id), repoId: String(row.githubRepoId), fullName: row.fullName ?? null, state: scheduleState(row, now),
    scheduledAt: iso(row.scheduledAt), windowEndsAt: new Date(scheduleWindowEnd(row)).toISOString(), windowMinutes: Number(row.windowMinutes),
    launcherWallet: row.launcherWallet, maxInitialBuyLamports: String(row.maxInitialBuyLamports), note: row.note ?? null,
    announcedBy: row.githubLogin, announcedAt: iso(row.createdAt), launchedMint: row.launchedMint ?? null,
    cancelledAt: iso(row.cancelledAt) }
}

const canonicalWallet = value => {
  try {
    const key = new PublicKey(String(value ?? '')).toBase58()
    if (key !== value) throw new Error()
    return key
  } catch { throw new ScheduleError('Enter the Solana wallet that will sign the launch.') }
}

// body: { repoId, scheduledAt (ISO), windowMinutes?, launcherWallet, maxInitialBuyLamports?, note? }
export function parseScheduleRequest(body, now = Date.now()) {
  if (!body || typeof body !== 'object') throw new ScheduleError('Invalid request.')
  if (!REPO_ID.test(String(body.repoId ?? '')) || Number(body.repoId) > 4503599627370495) throw new ScheduleError('Invalid repository.')
  const at = typeof body.scheduledAt === 'string' ? Date.parse(body.scheduledAt) : NaN
  if (!Number.isFinite(at)) throw new ScheduleError('Choose the launch date and time.')
  if (at < now + SCHEDULE_RULES.minNoticeMs) throw new ScheduleError('Schedule the launch at least one hour from now, so everyone gets the same notice.')
  if (at > now + SCHEDULE_RULES.maxAheadMs) throw new ScheduleError('Schedule the launch within the next 30 days.')
  const windowMinutes = body.windowMinutes === undefined || body.windowMinutes === null || body.windowMinutes === ''
    ? SCHEDULE_RULES.defaultWindowMinutes : Number(body.windowMinutes)
  if (!Number.isSafeInteger(windowMinutes) || windowMinutes < SCHEDULE_RULES.minWindowMinutes || windowMinutes > SCHEDULE_RULES.maxWindowMinutes) {
    throw new ScheduleError('The launch window is 15 minutes to 24 hours.')
  }
  const launcherWallet = canonicalWallet(body.launcherWallet)
  if (isBlockedWallet(launcherWallet)) throw new ScheduleError('This wallet cannot launch on repo.ing.', 403)
  const rawBuy = body.maxInitialBuyLamports === undefined || body.maxInitialBuyLamports === null || body.maxInitialBuyLamports === '' ? '0' : String(body.maxInitialBuyLamports)
  if (!/^\d{1,20}$/.test(rawBuy)) throw new ScheduleError('The initial buy is a whole number of lamports.')
  const maxInitialBuyLamports = BigInt(rawBuy)
  if (maxInitialBuyLamports > SCHEDULE_RULES.maxInitialBuyLamports) throw new ScheduleError('Announce an initial buy of at most 1 SOL (the launch also caps it at 3% of supply).')
  let note = null
  if (typeof body.note === 'string' && body.note.trim()) {
    try { note = sanitizeNote(body.note) } catch (error) { throw new ScheduleError(error instanceof NoteError ? error.message : 'Invalid note.') }
  }
  return { repoId: String(body.repoId), scheduledAt: new Date(at), windowMinutes, launcherWallet, maxInitialBuyLamports, note }
}

const SELECT = `select s.id, s.github_repo_id as "githubRepoId", s.status, s.scheduled_at as "scheduledAt", s.window_minutes as "windowMinutes",
  s.launcher_wallet as "launcherWallet", s.max_initial_buy_lamports::text as "maxInitialBuyLamports", s.note, s.github_login as "githubLogin",
  s.created_at as "createdAt", s.cancelled_at as "cancelledAt", s.launched_mint as "launchedMint", r.full_name as "fullName",
  s.github_user_id::text as "githubUserId"
  from launch_schedules s left join repositories r on r.github_repo_id = s.github_repo_id`

// A database the migration has not reached has no schedules (42P01): every launch proceeds as before.
async function readSchedules(db, sql, params = []) {
  try { return (await db.query(sql, params)).rows }
  catch (error) { if (error?.code === '42P01') return []; throw error }
}

export async function activeSchedule(db, repoId) {
  const [row] = await readSchedules(db, `${SELECT} where s.github_repo_id = $1 and s.status = 'scheduled' limit 1`, [String(repoId)])
  return row ?? null
}

export async function scheduleById(db, id) {
  if (!/^[1-9]\d{0,18}$/.test(String(id ?? ''))) return null
  const [row] = await readSchedules(db, `${SELECT} where s.id = $1`, [String(id)])
  return row ?? null
}

// The launch gate (coordinator reservation, under the repository lock). wallet: the canonical launcher; initialBuyLamports: the
// requested launch buy; bundle: whether this is a Group launch; earlyAccess: whether it opens a contributor early access window (an
// allowlist the announcement did not disclose, so it is refused during the window).
export async function assertScheduleAllows(db, repoId, { wallet, initialBuyLamports = '0', bundle = false, earlyAccess = false, now = Date.now() } = {}) {
  const row = await activeSchedule(db, repoId)
  if (!row) return null
  const state = scheduleState(row, now)
  if (state === 'upcoming') {
    throw new ScheduleError(`This repository's launch is scheduled for ${iso(row.scheduledAt)}. It cannot launch before then.`, 409, SCHEDULE_CODES.BEFORE)
  }
  if (state !== 'open') return null
  if (bundle) throw new ScheduleError('This repository has a scheduled launch; a Group launch cannot take it during the window.', 409, SCHEDULE_CODES.BUNDLE)
  if (earlyAccess) throw new ScheduleError('A scheduled launch opens to everyone at once; contributor early access cannot be added during its window.', 409, SCHEDULE_CODES.EARLY_ACCESS)
  if (wallet !== row.launcherWallet) {
    throw new ScheduleError(`During its scheduled window only the announced wallet ${row.launcherWallet} can launch this repository.`, 403, SCHEDULE_CODES.LAUNCHER)
  }
  let buy
  try { buy = BigInt(String(initialBuyLamports ?? '0')) } catch { buy = -1n }
  if (buy < 0n || buy > BigInt(row.maxInitialBuyLamports)) {
    throw new ScheduleError(`The announced initial buy is at most ${row.maxInitialBuyLamports} lamports.`, 403, SCHEDULE_CODES.BUY)
  }
  return row
}

// verifyAdmin({ githubRepoId }) must freshly confirm the signed-in user's CURRENT GitHub admin permission and return
// { githubUserId, githubLogin }. resolveRepository(repoId) persists the public repository row (needed by the foreign key).
export function createLaunchSchedules({ pool, verifyAdmin, persistRepository = async () => {} }) {
  async function authority(repoId) {
    let admin
    try { admin = await verifyAdmin({ githubRepoId: repoId }) } catch { admin = null }
    if (!/^[1-9]\d*$/.test(String(admin?.githubUserId ?? '')) || !admin?.githubLogin) {
      throw new ScheduleError('Only a current GitHub admin of this repository can schedule its launch. Sign in with GitHub again.', 403)
    }
    return { githubUserId: String(admin.githubUserId), githubLogin: String(admin.githubLogin) }
  }
  return {
    async create(body, { now = Date.now() } = {}) {
      const request = parseScheduleRequest(body, now)
      const actor = await authority(request.repoId)
      await persistRepository(request.repoId)
      const client = await pool.connect()
      try {
        await client.query('begin')
        // The coordinator's repository lock: no launch can reserve this repository while the schedule is checked and saved.
        await client.query('select pg_advisory_xact_lock($1::bigint)', [request.repoId])
        const { rows: markets } = await client.query(`select status from markets where github_repo_id = $1 and status <> 'failed'`, [request.repoId])
        if (markets.length) throw new ScheduleError('This repository already has a market or a launch in progress.', 409)
        // A database before the opt-out migration has no opt-outs; the savepoint keeps the transaction usable after that error.
        await client.query('savepoint opt_outs')
        const { rows: optOut } = await client.query('select 1 from maintainer_opt_outs where github_repo_id = $1 and withdrawn_at is null', [request.repoId])
          .catch(async error => { if (error?.code !== '42P01') throw error; await client.query('rollback to savepoint opt_outs'); return { rows: [] } })
        if (optOut.length) throw new ScheduleError('This repository is opted out of repo.ing. Withdraw the opt-out first.', 409)
        const { rows: bundles } = await client.query(`select 1 from bundles where github_repo_id = $1 and status in ('opening', 'raising', 'launching', 'launched')`, [request.repoId])
        if (bundles.length) throw new ScheduleError('This repository has a Group launch raise in progress.', 409)
        const { rows } = await client.query(`insert into launch_schedules (github_repo_id, scheduled_at, window_minutes, launcher_wallet,
            max_initial_buy_lamports, note, github_user_id, github_login, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) returning id`, [request.repoId, request.scheduledAt, request.windowMinutes,
          request.launcherWallet, request.maxInitialBuyLamports.toString(), request.note, actor.githubUserId, actor.githubLogin, new Date(now)])
        await client.query('commit')
        const [row] = await readSchedules(pool, `${SELECT} where s.id = $1`, [rows[0].id])
        return publicSchedule(row, now)
      } catch (error) {
        await client.query('rollback').catch(() => {})
        if (error?.code === '23505') throw new ScheduleError('This repository already has a scheduled launch. Cancel it to choose another time.', 409)
        throw error
      } finally { client.release() }
    },
    async cancel({ repoId }, { now = Date.now() } = {}) {
      if (!REPO_ID.test(String(repoId ?? ''))) throw new ScheduleError('Invalid repository.')
      const actor = await authority(String(repoId))
      const { rows } = await pool.query(`update launch_schedules set status = 'cancelled', cancelled_at = $3, cancelled_by_github_user_id = $2, updated_at = $3
        where github_repo_id = $1 and status = 'scheduled' returning id`, [String(repoId), actor.githubUserId, new Date(now)])
      if (!rows.length) throw new ScheduleError('There is no scheduled launch to cancel.', 409)
      const [row] = await readSchedules(pool, `${SELECT} where s.id = $1`, [rows[0].id])
      return publicSchedule(row, now)
    },
  }
}

// Worker step. 'launched': the announced wallet's own (not a Group) launch landed within the window (block time, five minutes of
// grace for a review signed at its end). 'lapsed': the window passed and the announced wallet has no launch still in flight (a
// reservation, a prepared or submitted launch, or a confirmed one not indexed yet). A market launched by anyone else after the window
// never credits the schedule.
export async function reconcileSchedules(db, now = Date.now()) {
  try {
    const launched = await db.query(`update launch_schedules s set status = 'launched', launched_mint = m.mint, updated_at = now()
      from markets m where s.status = 'scheduled' and m.github_repo_id = s.github_repo_id and m.status = 'confirmed' and m.mint is not null
        and m.launcher_wallet = s.launcher_wallet and m.bundle_id is null and m.launch_block_time is not null
        and m.launch_block_time >= s.scheduled_at - interval '1 minute'
        and m.launch_block_time <= s.scheduled_at + make_interval(mins => s.window_minutes) + interval '5 minutes'
      returning s.id`)
    const lapsed = await db.query(`update launch_schedules s set status = 'lapsed', updated_at = now()
      where s.status = 'scheduled' and s.scheduled_at + make_interval(mins => s.window_minutes) <= $1
        and not exists (select 1 from markets m where m.github_repo_id = s.github_repo_id and m.launcher_wallet = s.launcher_wallet
          and (m.status in ('reserved', 'prepared', 'submitted', 'ambiguous') or (m.status = 'confirmed' and m.launch_block_time is null)))
      returning s.id`, [new Date(now)])
    return { launched: launched.rowCount, lapsed: lapsed.rowCount }
  } catch (error) {
    if (error?.code === '42P01') return { launched: 0, lapsed: 0, skipped: 'NOT_MIGRATED' }
    throw error
  }
}

// Calendar reads: scheduled launches not yet past their window, soonest first.
export async function upcomingSchedules(db, { now = Date.now(), limit = 100 } = {}) {
  const rows = await readSchedules(db, `${SELECT} where s.status = 'scheduled'
    and s.scheduled_at + make_interval(mins => s.window_minutes) > $1 order by s.scheduled_at, s.id limit $2`, [new Date(now), limit])
  return rows.map(row => publicSchedule(row, now))
}

export async function schedulesForRepos(db, repoIds, { now = Date.now() } = {}) {
  const ids = (repoIds ?? []).filter(id => REPO_ID.test(String(id))).map(String)
  if (!ids.length) return new Map()
  const rows = await readSchedules(db, `${SELECT} where s.github_repo_id = any($1::bigint[]) and s.status = 'scheduled'`, [ids])
  return new Map(rows.map(row => [String(row.githubRepoId), publicSchedule(row, now)]))
}

// The schedule a market launched under, if any (Launch Quality "Announced launch time").
export async function launchedSchedule(db, repoId) {
  const [row] = await readSchedules(db, `${SELECT} where s.github_repo_id = $1 and s.status = 'launched' order by s.id desc limit 1`, [String(repoId)])
  return row ? { scheduledAt: iso(row.scheduledAt), createdAt: iso(row.createdAt) } : null
}
