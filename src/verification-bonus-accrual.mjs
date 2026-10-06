import { githubApiHeaders } from './github-app-auth.mjs'
import { assertGithubRepoId } from './market-identity.mjs'
import { activeDecision } from './maintainer-opt-outs.mjs'
import { ACCRUAL_GRACE_MS, BONUS_WINDOW_MS, MIN_OTHER_VOLUME_LAMPORTS, MIN_REPO_AGE_MS, MIN_REPO_STARS, VERIFICATION_BONUS_RULES_VERSION,
  VOLUME_SETTLE_MS, evaluateVerificationBonus, failureReason, readSelfLaunchFacts } from './verification-bonus.mjs'

// Worker pass. A worker pass (rather than the OAuth callback) is the robust place to accrue: it retries when GitHub is
// unavailable, waits ACCRUAL_GRACE_MS so the maintainer's payout-wallet binding is visible to the self-launch rule, and
// runs no matter which path recorded the verification. It reads PostgreSQL and the public GitHub API only: no keys.
// Idempotent: one row per market (primary key, insert … on conflict do nothing), never re-evaluated once written.

// Stars and public visibility come from GitHub at accrual time. The creation date is taken from repositories.github_created_at
// when it is stored (0045; filled from earlier GitHub reads), else from this same read. A repository GitHub no longer
// serves publicly is a decision (ineligible); any other failure is retried on a later pass.
export async function readRepositoryFacts(repoId, { fetchImpl = fetch, headers = githubApiHeaders } = {}) {
  assertGithubRepoId(repoId)
  const response = await fetchImpl(`https://api.github.com/repositories/${repoId}`, { cache: 'no-store',
    headers: await headers('repo.ing-verification-bonus', fetchImpl), signal: AbortSignal.timeout(10_000) })
  const checkedAt = new Date().toISOString()
  if ([404, 410, 451].includes(response.status)) return { missing: `GitHub no longer serves this repository publicly (HTTP ${response.status})`, checkedAt }
  // GitHub answers 403 both for a rate limit (retry) and for a repository blocked for a terms violation (a decision).
  if (response.status === 403 && /access blocked/i.test(String((await response.json().catch(() => null))?.message ?? ''))) {
    return { missing: 'GitHub has blocked access to this repository (HTTP 403)', checkedAt }
  }
  if (!response.ok) throw new Error(`GitHub repository read failed: HTTP ${response.status}`)
  const body = await response.json()
  if (String(body?.id) !== String(repoId)) throw new Error('GitHub repository identity mismatch')
  if (body.private === true || (body.visibility && body.visibility !== 'public')) return { missing: 'The repository is no longer public', checkedAt }
  const createdAt = Date.parse(body.created_at)
  if (!Number.isFinite(createdAt) || !Number.isSafeInteger(body.stargazers_count) || body.stargazers_count < 0) {
    throw new Error('GitHub returned incomplete repository facts')
  }
  return { createdAt: new Date(createdAt).toISOString(), stars: body.stargazers_count, fullName: body.full_name ?? null, checkedAt }
}

// A stored creation date (immutable on GitHub) takes precedence over the live read; the evidence records which decided.
export function withStoredCreation(repository, storedCreatedAt) {
  if (repository?.missing || !storedCreatedAt) return repository && !repository.missing ? { ...repository, createdAtSource: 'github' } : repository
  const stored = new Date(storedCreatedAt)
  if (!Number.isFinite(stored.getTime())) throw new Error('Stored repository creation date is invalid')
  return { ...repository, githubCreatedAt: repository.createdAt, createdAt: stored.toISOString(), createdAtSource: 'stored' }
}

// The stamped, finalized market and its FIRST admin verification (earliest verified_at, then id). A contributor early access
// market (docs/EARLY_ACCESS.md) waits, undecided: the volume rule reads trade_events, which its transfer-hook pool does not write
// until step 5, and a decided bonus is never re-evaluated. Step 5 drops this condition here and in candidates().
async function marketFacts(db, repoId) {
  const { rows: [market] } = await db.query(`select m.github_repo_id::text as "repoId", m.pool, m.launcher_wallet as "launcherWallet",
      m.verification_bonus_lamports::text as amount, m.launch_block_time as "activatedAt", v.id as "verificationId",
      v.github_user_id::text as "verifierGithubUserId", v.github_login as "verifierLogin", v.verified_at as "verifiedAt",
      r.github_created_at as "storedCreatedAt"
    from markets m join repositories r on r.github_repo_id = m.github_repo_id
    join lateral (select id, github_user_id, github_login, verified_at from repo_verifications
      where github_repo_id = m.github_repo_id and permission = 'admin' order by verified_at, id limit 1) v on true
    where m.github_repo_id = $1 and m.verification_bonus_lamports is not null and m.status = 'confirmed'
      and m.indexed_at is not null and m.launch_finality = 'finalized' and m.launch_block_time is not null
      and m.early_access_end is null and m.bundle_id is null`, [String(repoId)])
  return market ?? null
}

// Curve volume in lamports (SOL side of each canonical DBC swap) traded strictly before the verification. Rows with no
// recorded trader cannot be attributed and never count toward the threshold (fail closed); they are reported.
export async function readVolumeFacts(db, { pool, launcherWallet, before }) {
  const { rows: [volume] } = await db.query(`select
      coalesce(sum(lamports) filter (where trader is not null and trader <> $2), 0)::text as other,
      coalesce(sum(lamports) filter (where trader = $2), 0)::text as launcher,
      coalesce(sum(lamports) filter (where trader is null), 0)::text as unattributed
    from (select trader, (case when direction = 'buy' then input_base_units else output_base_units end)::numeric as lamports
      from trade_events where pool = $1 and traded_at < $3) trades`, [pool, launcherWallet, before])
  return volume
}

// Undecided repositories retry with a growing per-repository delay (1, 2, 4… minutes, at most an hour) so one that keeps
// failing never starves newer candidates. The delay is per worker process; a restart simply retries sooner.
const RETRY_BASE_MS = 60_000, RETRY_MAX_MS = 60 * 60_000

export function createVerificationBonusAccrual({ pool, fetchImpl = fetch, readRepository = readRepositoryFacts, now = Date.now,
  graceMs = ACCRUAL_GRACE_MS, volumeSettleMs = VOLUME_SETTLE_MS, limit = 10 }) {
  const retry = new Map()
  async function candidates() {
    const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", min(v.verified_at) as first
      from markets m join repositories r on r.github_repo_id = m.github_repo_id and r.source = 'github'
      join repo_verifications v on v.github_repo_id = m.github_repo_id and v.permission = 'admin'
      where m.verification_bonus_lamports is not null and m.status = 'confirmed' and m.indexed_at is not null
        and m.launch_finality = 'finalized' and m.launch_block_time is not null and m.early_access_end is null and m.bundle_id is null
        and not exists (select 1 from verification_bonuses b where b.github_repo_id = m.github_repo_id)
      group by m.github_repo_id having min(v.verified_at) <= $1 order by first, m.github_repo_id limit $2`,
    [new Date(now() - graceMs), limit * 10])
    return rows.map(row => row.repoId).filter(repoId => !((retry.get(repoId)?.at ?? 0) > now())).slice(0, limit)
  }
  const later = (repoId, result) => {
    const attempts = (retry.get(repoId)?.attempts ?? 0) + 1
    retry.set(repoId, { attempts, at: now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)) })
    return result
  }

  async function accrue(repoId) {
    const market = await marketFacts(pool, repoId)
    if (!market) return { repoId: String(repoId), status: 'not-enrolled' }
    const [wallets, volume, decision] = await Promise.all([readSelfLaunchFacts(pool, { repoId, verifierGithubUserId: market.verifierGithubUserId,
      launcherWallet: market.launcherWallet }), readVolumeFacts(pool, { pool: market.pool, launcherWallet: market.launcherWallet, before: market.verifiedAt }),
    activeDecision(pool, market.repoId)])
    const facts = { activatedAt: market.activatedAt, verifiedAt: market.verifiedAt, launcherWallet: market.launcherWallet, wallets, volume, decision }
    let result = evaluateVerificationBonus(facts), repository = null
    // GitHub is read only when the local rules pass; a failure here leaves no row and the next pass retries.
    if (!result.complete) {
      repository = withStoredCreation(await readRepository(repoId, { fetchImpl }), market.storedCreatedAt)
      result = evaluateVerificationBonus({ ...facts, repository })
    }
    // Volume alone is not final until trades made before the verification have had time to be indexed.
    if (result.failures.length === 1 && result.failures[0].rule === 'volume' &&
        now() < new Date(market.verifiedAt).getTime() + volumeSettleMs) {
      return later(market.repoId, { repoId: market.repoId, status: 'deferred', reason: 'Waiting for trade indexing to settle the volume rule' })
    }
    const status = result.eligible ? 'pending_review' : 'ineligible'
    const evidence = { rulesVersion: VERIFICATION_BONUS_RULES_VERSION, evaluatedAt: new Date(now()).toISOString(),
      thresholds: { windowDays: BONUS_WINDOW_MS / 86_400_000, minRepoAgeDays: MIN_REPO_AGE_MS / 86_400_000, minStars: MIN_REPO_STARS,
        minOtherVolumeLamports: MIN_OTHER_VOLUME_LAMPORTS.toString() },
      activatedAt: new Date(market.activatedAt).toISOString(), verifiedAt: new Date(market.verifiedAt).toISOString(),
      verification: { id: market.verificationId, githubUserId: market.verifierGithubUserId, login: market.verifierLogin },
      wallets: { launcher: market.launcherWallet, ...wallets }, volume, maintainerDecision: decision, repository, failures: result.failures }
    const { rowCount } = await pool.query(`insert into verification_bonuses (github_repo_id, status, amount, launcher_wallet,
        verification_id, verifier_github_user_id, verifier_login, verified_at, activated_at, evidence, reason)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (github_repo_id) do nothing`,
    [market.repoId, status, market.amount, market.launcherWallet, market.verificationId, market.verifierGithubUserId,
      market.verifierLogin, market.verifiedAt, market.activatedAt, JSON.stringify(evidence),
      result.eligible ? null : failureReason(result.failures)])
    retry.delete(market.repoId)
    return { repoId: market.repoId, status: rowCount ? status : 'exists', ...(result.eligible ? {} : { reason: failureReason(result.failures) }) }
  }

  async function runOnce() {
    const results = []
    for (const repoId of await candidates()) {
      try { results.push(await accrue(repoId)) }
      catch (error) { results.push(later(repoId, { repoId, status: 'deferred', error: String(error?.message ?? error).slice(0, 160) })) }
    }
    return results
  }
  return { runOnce, accrue, candidates }
}
