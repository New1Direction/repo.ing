import { VerificationBonusError, maintainerDecisionReason, nextBonusStatus, readSelfLaunchFacts, rejectionReason, requireReviewedTerms,
  selfLaunchReason, withBonusLock } from './verification-bonus.mjs'
import { activeDecision, activeDecisions } from './maintainer-opt-outs.mjs'

// Operator review (/operations/bonuses): list bonuses with their review context, approve, or reject with a reason.
// Decisions run under the bonus advisory lock and only move a row out of the state the operator saw. Approval re-checks
// the self-launch rule against current wallet bindings, so a binding made after accrual still blocks the bonus.

const fail = (message, status) => { throw new VerificationBonusError(message, status) }
export const bonusRepoId = value => {
  if (!/^[1-9]\d{0,18}$/.test(String(value ?? ''))) fail('Invalid repository', 400)
  return String(value)
}

async function readBonus(db, repoId) {
  const { rows: [bonus] } = await db.query(`select github_repo_id::text as "repoId", status, amount::text as amount,
      launcher_wallet as "launcherWallet", verifier_github_user_id::text as "verifierGithubUserId"
    from verification_bonuses where github_repo_id = $1`, [repoId])
  if (!bonus) fail('Verification bonus not found', 404)
  return bonus
}

// Why a bonus may not be approved or paid right now (current wallet bindings and maintainer decision), or null. A failed
// read throws, so approval and payment fail closed. Shared by approval and payout.
export async function currentBonusBlock(db, bonus) {
  const [facts, decision] = await Promise.all([readSelfLaunchFacts(db, { repoId: bonus.repoId,
    verifierGithubUserId: bonus.verifierGithubUserId, launcherWallet: bonus.launcherWallet }), activeDecision(db, bonus.repoId)])
  return selfLaunchReason({ launcherWallet: bonus.launcherWallet, ...facts }) ?? maintainerDecisionReason(decision)
}

const reviewer = operator => {
  if (!/^[1-9]\d*$/.test(String(operator?.githubUserId ?? ''))) fail('Operator identity is required', 401)
  return [String(operator.githubUserId), operator.githubLogin ?? null]
}

export function createVerificationBonusReview({ pool, now = Date.now }) {
  async function list({ limit = 100 } = {}) {
    const { rows: bonuses } = await pool.query(`select b.github_repo_id::text as "repoId", b.status, b.amount::text as amount,
        b.launcher_wallet as "launcherWallet", b.verifier_github_user_id::text as "verifierGithubUserId", b.verifier_login as "verifierLogin",
        b.verified_at as "verifiedAt", b.activated_at as "activatedAt", b.evidence, b.reason, b.created_at as "createdAt",
        b.reviewed_at as "reviewedAt", b.reviewer_login as "reviewerLogin", b.approved_at as "approvedAt", b.approver_login as "approverLogin",
        b.paid_at as "paidAt",
        r.full_name as "fullName", r.stars as "currentStars", m.mint,
        rb.wallet as "repoPayoutWallet", rb.github_user_id::text as "repoPayoutBoundBy",
        (exists(select 1 from repo_beneficiaries x where x.github_user_id = b.verifier_github_user_id and x.wallet = b.launcher_wallet)
          or exists(select 1 from wallet_binding_challenges c where c.github_user_id = b.verifier_github_user_id
            and c.wallet = b.launcher_wallet and c.consumed_at is not null)) as "verifierLinkedToLauncher",
        (select coalesce(sum((case when t.direction = 'buy' then t.input_base_units else t.output_base_units end)::numeric), 0)::text
          from trade_events t where t.pool = m.pool) as "curveVolume",
        p.id as "payoutId", p.status as "payoutStatus", p.signature as "payoutSignature", p.attempt as "payoutAttempt",
        p.created_at as "payoutCreatedAt", p.settled_at as "payoutSettledAt", p.network_fee::text as "payoutNetworkFee",
        p.resolution_reason as "payoutResolution"
      from verification_bonuses b join markets m on m.github_repo_id = b.github_repo_id
      join repositories r on r.github_repo_id = b.github_repo_id
      left join repo_beneficiaries rb on rb.github_repo_id = b.github_repo_id
      left join lateral (select * from verification_bonus_payouts where github_repo_id = b.github_repo_id
        order by created_at desc limit 1) p on true
      order by case b.status when 'pending_review' then 0 when 'approved' then 1 else 2 end, b.created_at desc
      limit $1`, [limit])
    // Verified, stamped markets the accrual pass has not decided yet (grace period, or GitHub unavailable).
    const { rows: checking } = await pool.query(`select m.github_repo_id::text as "repoId", r.full_name as "fullName",
        min(v.verified_at) as "verifiedAt"
      from markets m join repositories r on r.github_repo_id = m.github_repo_id
      join repo_verifications v on v.github_repo_id = m.github_repo_id and v.permission = 'admin'
      where m.verification_bonus_lamports is not null and m.status = 'confirmed' and m.indexed_at is not null
        and not exists (select 1 from verification_bonuses b where b.github_repo_id = m.github_repo_id)
      group by m.github_repo_id, r.full_name order by min(v.verified_at) limit 20`)
    const decisions = await activeDecisions(pool, bonuses.map(bonus => bonus.repoId))
    return { bonuses: bonuses.map(bonus => ({ ...bonus, maintainerDecision: decisions.get(bonus.repoId)?.kind ?? null })), checking }
  }

  async function approve({ repoId, operator, expected }) {
    const id = bonusRepoId(repoId), [reviewerId, reviewerLogin] = reviewer(operator)
    return withBonusLock(pool, async db => {
      const bonus = await readBonus(db, id)
      requireReviewedTerms(bonus, expected)
      nextBonusStatus(bonus.status, 'approved')
      const blocked = await currentBonusBlock(db, bonus)
      if (blocked) fail(`${blocked}. Reject this bonus instead.`)
      const at = new Date(now())
      const { rowCount } = await db.query(`update verification_bonuses set status = 'approved', reviewed_at = $2,
        reviewer_github_user_id = $3, reviewer_login = $4, approved_at = $2, approver_github_user_id = $3, approver_login = $4
        where github_repo_id = $1 and status = 'pending_review'`, [id, at, reviewerId, reviewerLogin])
      if (rowCount !== 1) fail('This bonus changed. Refresh and review it again.')
      return { repoId: id, status: 'approved', reviewedAt: at.toISOString() }
    })
  }

  // A pending bonus, or an approved one with no payout in flight or settled, can be rejected. Terminal. A rejection
  // after approval records the rejecting operator as reviewer and keeps the approver (approved_at / approver_*).
  async function reject({ repoId, operator, reason, expected }) {
    const id = bonusRepoId(repoId), text = rejectionReason(reason), [reviewerId, reviewerLogin] = reviewer(operator)
    return withBonusLock(pool, async db => {
      const bonus = await readBonus(db, id)
      requireReviewedTerms(bonus, expected)
      nextBonusStatus(bonus.status, 'rejected')
      const { rowCount: live } = await db.query(`select 1 from verification_bonus_payouts where github_repo_id = $1
        and status in ('pending', 'settled')`, [id])
      if (live) fail('A payout for this bonus is in flight or settled, so it can no longer be rejected')
      const at = new Date(now())
      const { rowCount } = await db.query(`update verification_bonuses set status = 'rejected', reason = $2, reviewed_at = $3,
        reviewer_github_user_id = $4, reviewer_login = $5 where github_repo_id = $1 and status = $6`,
      [id, text, at, reviewerId, reviewerLogin, bonus.status])
      if (rowCount !== 1) fail('This bonus changed. Refresh and review it again.')
      return { repoId: id, status: 'rejected', reason: text, reviewedAt: at.toISOString() }
    })
  }
  return { list, approve, reject }
}
