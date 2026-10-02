import { formatUnits } from '../app/lib/format.mjs'

// Verification bonus (docs/VERIFICATION_BONUS.md): a launcher earns a one-time bonus, paid from platform revenue by the
// protected partner signer, when the repository's maintainer first verifies within 30 days of the launch. This module
// holds the policy, environment parsing, the pure eligibility rules, the state machine and the public status view.
// Accrual (worker), operator review and payouts live in verification-bonus-{accrual,review,payouts}.mjs.

export const VERIFICATION_BONUS_RULES_VERSION = 1
const DAY_MS = 86_400_000
// The first admin verification must happen within 30 days of the DBC pool's activation point (exclusive end), the
// same chain clock discovery rewards use (markets.launch_block_time).
export const BONUS_WINDOW_MS = 30 * DAY_MS
// The repository must already have existed 30 days at launch (inclusive) and have 10 stars when the bonus accrues.
export const MIN_REPO_AGE_MS = 30 * DAY_MS
export const MIN_REPO_STARS = 10
// Curve (DBC) volume by wallets other than the launcher, traded before the verification.
export const MIN_OTHER_VOLUME_LAMPORTS = 1_000_000_000n
// Maintainers usually bind a payout wallet right after verifying; accrual waits so the self-launch rule can see it.
export const ACCRUAL_GRACE_MS = 10 * 60_000
// A bonus failing ONLY the volume rule is not decided until the trade index has had this long to catch up on trades
// made before the verification (idle markets are indexed every few minutes; outages back off further).
export const VOLUME_SETTLE_MS = 2 * 60 * 60_000
export const MIN_BONUS_LAMPORTS = 1_000_000n
export const MAX_BONUS_LAMPORTS = 1_000_000_000n
export const DEFAULT_MAX_PER_30D_LAMPORTS = 5_000_000_000n
// Operating float the partner signer keeps for discovery-claim network fees and temporary deposits. Payouts keep this
// ON TOP of the revenue the ledger says the payer still holds for other uses (see payerShortfall).
export const DEFAULT_PAYER_RESERVE_LAMPORTS = 50_000_000n
export const CAP_WINDOW_MS = 30 * DAY_MS
// One advisory lock serializes every review decision, payout and settlement (bonuses are few; the cap is global).
const BONUS_LOCK = 'verification-bonus'

export class VerificationBonusError extends Error {
  constructor(message, status = 409, { busy = false } = {}) { super(message); this.status = status; this.busy = busy }
}
const fail = (message, status) => { throw new VerificationBonusError(message, status) }

export const formatBonusSol = lamports => formatUnits(lamports)
const time = value => {
  const at = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(at)) throw new Error('Verification bonus timestamp is invalid')
  return at
}
const days = ms => (ms / DAY_MS).toFixed(1)

// The amount a NEW launch is stamped with, or null (not configured, or outside 0.001–1 SOL: never enroll on a typo).
export function verificationBonusEnrollment(env = process.env) {
  const value = String(env.VERIFICATION_BONUS_LAMPORTS ?? '').trim()
  if (!value) return { lamports: null, error: null }
  const lamports = /^[1-9]\d{0,18}$/.test(value) ? BigInt(value) : null
  if (lamports === null || lamports < MIN_BONUS_LAMPORTS || lamports > MAX_BONUS_LAMPORTS) {
    return { lamports: null, error: `VERIFICATION_BONUS_LAMPORTS must be whole lamports between ${MIN_BONUS_LAMPORTS} and ${MAX_BONUS_LAMPORTS}; new launches are not enrolled` }
  }
  return { lamports, error: null }
}
export const verificationBonusLamports = (env = process.env) => verificationBonusEnrollment(env).lamports

// Payouts ship dark: off unless VERIFICATION_BONUS_PAYOUTS_ENABLED=true. A malformed limit stops payouts (error).
export function verificationBonusPayoutConfig(env = process.env) {
  const read = (name, fallback) => {
    const raw = String(env[name] ?? '').trim()
    if (!raw) return { value: fallback }
    return /^\d{1,19}$/.test(raw) ? { value: BigInt(raw) } : { error: `${name} must be a whole number of lamports` }
  }
  const cap = read('VERIFICATION_BONUS_MAX_PER_30D_LAMPORTS', DEFAULT_MAX_PER_30D_LAMPORTS)
  const reserve = read('VERIFICATION_BONUS_PAYER_RESERVE_LAMPORTS', DEFAULT_PAYER_RESERVE_LAMPORTS)
  return { enabled: env.VERIFICATION_BONUS_PAYOUTS_ENABLED === 'true', cap: cap.value ?? null, reserve: reserve.value ?? null,
    error: cap.error ?? reserve.error ?? null }
}

// Settled payouts in the last 30 days plus every payout still in flight, against the rolling cap.
export const capAllows = ({ committed, amount, cap }) => BigInt(committed) + BigInt(amount) <= BigInt(cap)

// Self-launch: the repository's payout wallet is the launcher wallet, or the verifying GitHub user has ever bound the
// launcher wallet (for any repository: a current binding, or a consumed binding challenge it signed).
export function selfLaunchReason({ launcherWallet, repoPayoutWallet, verifierBoundLauncher, verifierSignedForLauncher }) {
  if (repoPayoutWallet && repoPayoutWallet === launcherWallet) return 'The repository’s payout wallet is the launcher wallet (self-launch)'
  if (verifierBoundLauncher || verifierSignedForLauncher) return 'The verifying maintainer has bound the launcher wallet as a payout wallet (self-launch)'
  return null
}

// An active maintainer decision (src/maintainer-opt-outs.mjs) means the maintainer showed up to turn the market down, not to
// take part: no bonus. Declining a market records an admin verification, so this is checked at accrual, approval and payment.
export function maintainerDecisionReason(decision) {
  if (!decision) return null
  return decision.kind === 'opt_out' ? 'The maintainer opted this repository out of repo.ing' : 'The maintainer declined this market'
}

// facts: { activatedAt, verifiedAt, launcherWallet, wallets, volume: { other }, decision, repository }. decision is the
// active maintainer decision or null. repository is undefined until GitHub has been read; { missing } when GitHub no
// longer serves the repository publicly. complete is false only while the GitHub rules still have to be evaluated.
// Every failing rule is reported, not only the first.
export function evaluateVerificationBonus({ activatedAt, verifiedAt, launcherWallet, wallets, volume, decision, repository }) {
  // Missing facts would silently pass a rule; refuse instead.
  if (!wallets || typeof wallets !== 'object' || !launcherWallet) throw new Error('Verification bonus wallet facts are required')
  if (!volume || volume.other === undefined || volume.other === null) throw new Error('Verification bonus volume facts are required')
  if (decision === undefined) throw new Error('Verification bonus maintainer decision is required (null when there is none)')
  const failures = []
  const declined = maintainerDecisionReason(decision)
  if (declined) failures.push({ rule: 'declined', reason: declined })
  const start = time(activatedAt), verified = time(verifiedAt)
  if (verified < start) failures.push({ rule: 'window', reason: 'The maintainer verification predates the market’s activation' })
  else if (verified >= start + BONUS_WINDOW_MS) {
    failures.push({ rule: 'window', reason: `The maintainer first verified ${days(verified - start)} days after launch (limit 30 days)` })
  }
  const self = selfLaunchReason({ launcherWallet, ...wallets })
  if (self) failures.push({ rule: 'self_launch', reason: self })
  const other = BigInt(volume.other)
  if (other < MIN_OTHER_VOLUME_LAMPORTS) {
    failures.push({ rule: 'volume', reason: `Only ${formatBonusSol(other)} SOL of curve volume from wallets other than the launcher before verification (minimum 1 SOL)` })
  }
  if (repository?.missing) failures.push({ rule: 'repository', reason: repository.missing })
  else if (repository) {
    const created = time(repository.createdAt)
    if (created > start) failures.push({ rule: 'repo_age', reason: 'The repository was created after the launch (minimum 30 days before)' })
    else if (created > start - MIN_REPO_AGE_MS) {
      failures.push({ rule: 'repo_age', reason: `The repository was created ${days(start - created)} days before launch (minimum 30 days)` })
    }
    if (!Number.isSafeInteger(repository.stars) || repository.stars < MIN_REPO_STARS) {
      failures.push({ rule: 'stars', reason: `The repository has ${repository.stars} stars (minimum ${MIN_REPO_STARS})` })
    }
  }
  const complete = repository !== undefined || failures.length > 0
  return { complete, eligible: complete && failures.length === 0, failures }
}
export const failureReason = failures => failures.map(item => item.reason).join('; ')

// The bonus state machine. Accrual creates 'pending_review' or 'ineligible' (terminal); an operator approves or
// rejects a pending bonus, and may still reject an approved one before any payout exists; only a settled payout pays.
const BONUS_TRANSITIONS = Object.freeze({ pending_review: ['approved', 'rejected'], approved: ['rejected', 'paid'],
  ineligible: [], rejected: [], paid: [] })
export function nextBonusStatus(from, to) {
  if (!BONUS_TRANSITIONS[from]?.includes(to)) fail(`A bonus that is ${String(from).replace('_', ' ')} cannot become ${to.replace('_', ' ')}`)
  return to
}
const PAYOUT_TRANSITIONS = Object.freeze({ pending: ['settled', 'aborted'], settled: [], aborted: [] })
export function nextPayoutStatus(from, to) {
  if (!PAYOUT_TRANSITIONS[from]?.includes(to)) throw new Error(`Bonus payout cannot move from ${from} to ${to}`)
  return to
}

// Operators' rejection reasons are kept for review history; the public status says only "not approved".
export function rejectionReason(value) {
  const reason = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (reason.length < 3 || reason.length > 300) fail('Give a rejection reason of 3–300 characters', 400)
  return reason
}

// The operator's client sends the amount and launcher wallet it displayed; a decision on anything else is refused.
export function requireReviewedTerms(bonus, expected = {}) {
  if (String(expected.amount ?? '') !== String(bonus.amount) || expected.wallet !== bonus.launcherWallet) {
    fail('This bonus changed since it was displayed. Refresh and review it again.')
  }
}

// Try-lock only: a payout holds the lock across RPC calls and a bounded broadcast, so a second caller gets a prompt
// "busy" refusal (the worker skips; the operator retries) instead of waiting on a pooled connection.
export async function withBonusLock(pool, callback) {
  const db = await pool.connect()
  try {
    if (!(await db.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [BONUS_LOCK])).rows[0].locked) {
      throw new VerificationBonusError('Another verification bonus operation is in progress. Try again in a few seconds.', 409, { busy: true })
    }
    try { return await callback(db) }
    finally { await db.query('select pg_advisory_unlock(hashtextextended($1, 0))', [BONUS_LOCK]) }
  } finally { db.release() }
}

// Lamports the payer would be short after paying `amount` + `fee`: in-flight payouts are treated as already spent, and
// it must keep the operating reserve plus the revenue the ledger says it holds for other uses. 0n means it can pay.
export function payerShortfall({ balance, pending = 0n, amount, fee, reserve, protectedLamports = 0n }) {
  const values = [balance, pending, amount, fee, reserve, protectedLamports].map(value => BigInt(value))
  if (values.some(value => value < 0n)) throw new Error('Payer amounts must not be negative')
  const [held, inFlight, paid, networkFee, float, owed] = values
  const left = held - inFlight - paid - networkFee, required = float + owed
  return left >= required ? 0n : required - left
}

export async function readSelfLaunchFacts(db, { repoId, verifierGithubUserId, launcherWallet }) {
  const { rows: [facts] } = await db.query(`select
      (select wallet from repo_beneficiaries where github_repo_id = $1) as "repoPayoutWallet",
      (select github_user_id::text from repo_beneficiaries where github_repo_id = $1) as "repoPayoutBoundBy",
      exists(select 1 from repo_beneficiaries where github_user_id = $2 and wallet = $3) as "verifierBoundLauncher",
      exists(select 1 from wallet_binding_challenges where github_user_id = $2 and wallet = $3 and consumed_at is not null) as "verifierSignedForLauncher"`,
  [String(repoId), String(verifierGithubUserId), launcherWallet])
  return facts
}

// Public status: offered (no verification yet) → checking → in_review → approved → sending → paid, or ineligible,
// rejected, or expired (no maintainer verification within 30 days). Amount and deadline come from the market's stamp.
// Ineligible reasons are the rules' own wording; an operator's free-text rejection reason stays on the operator page.
export function verificationBonusView(row, now = Date.now()) {
  if (!row?.amount) return null
  const deadline = new Date(time(row.activatedAt) + BONUS_WINDOW_MS)
  const base = { amount: String(row.amount), deadline: deadline.toISOString() }
  if (!row.status) return { ...base, status: row.verified ? 'checking' : now < deadline.getTime() ? 'offered' : 'expired' }
  if (row.status === 'pending_review') return { ...base, status: 'in_review' }
  if (row.status === 'approved') return row.payoutStatus === 'pending' ? { ...base, status: 'sending', signature: row.payoutSignature } : { ...base, status: 'approved' }
  if (row.status === 'paid') return { ...base, status: 'paid', signature: row.payoutSignature ?? null, paidAt: row.paidAt ? new Date(row.paidAt).toISOString() : null }
  if (row.status === 'ineligible') return { ...base, status: 'ineligible', reason: row.reason }
  if (row.status === 'rejected') return { ...base, status: 'rejected' }
  return null
}

const VIEW_COLUMNS = `m.github_repo_id::text as "repoId", m.verification_bonus_lamports::text as amount, m.launch_block_time as "activatedAt",
  exists(select 1 from repo_verifications v where v.github_repo_id = m.github_repo_id and v.permission = 'admin') as verified,
  b.status, b.reason, b.paid_at as "paidAt", p.status as "payoutStatus", p.signature as "payoutSignature"
  from markets m left join verification_bonuses b on b.github_repo_id = m.github_repo_id
  left join lateral (select status, signature from verification_bonus_payouts where github_repo_id = m.github_repo_id
    and status in ('pending', 'settled') order by created_at desc limit 1) p on true
  where m.verification_bonus_lamports is not null and m.status = 'confirmed' and m.indexed_at is not null
    and m.launch_finality = 'finalized' and m.launch_block_time is not null`

export async function readVerificationBonusView(db, repoId, now = Date.now()) {
  const { rows: [row] } = await db.query(`select ${VIEW_COLUMNS} and m.github_repo_id = $1`, [String(repoId)])
  return verificationBonusView(row, now)
}

export async function readWalletVerificationBonuses(db, wallet, now = Date.now()) {
  const { rows } = await db.query(`select ${VIEW_COLUMNS} and m.launcher_wallet = $1`, [wallet])
  return new Map(rows.map(row => [row.repoId, verificationBonusView(row, now)]))
}
