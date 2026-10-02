import { createGitHubAppVerifier } from '../../src/github-verification.mjs'
import { database, feeStatus, chain, creatorSigner } from './server.mjs'
import { seal, sealTipReview } from './auth.mjs'
import { repoTipSummary } from './tips.mjs'
import { publicOrigin } from './origin.mjs'
import { mapLimited } from '../../src/builder-queue.mjs'
import { activeDecisions } from '../../src/maintainer-opt-outs.mjs'
import { currentPayoutDestinations } from './payout-destination.mjs'

export async function builderOverview(session) {
  const pool = database()
  const verifier = createGitHubAppVerifier({ pool, clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET, redirectUri: `${publicOrigin()}/api/github/callback` })
  const ids = await verifier.listAdminRepositoryIds({ accessToken: session.accessToken, expectedGithubUserId: session.githubUserId })
  // Activates pasted addresses whose hold has passed, so rows (and their reviews) show the current recipient.
  const destinations = await currentPayoutDestinations(pool, ids)
  const { rows: marketRows } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, r.full_name as "fullName",
    (select coalesce(sum(amount_base_units),0)::text from builder_fee_credits where github_repo_id=m.github_repo_id) as earned,
    (select coalesce(sum(amount_base_units),0)::text from repo_claims where github_repo_id=m.github_repo_id and status='settled') as paid,
    (select claim_signature from repo_claims where github_repo_id=m.github_repo_id and status='pending' limit 1) as "pendingSignature"
    from markets m join repositories r on r.github_repo_id=m.github_repo_id
    where m.github_repo_id=any($1::bigint[]) and m.status='confirmed' and m.indexed_at is not null
    and m.launch_finality='finalized' order by r.full_name`, [ids])
  // Only the active binding is a recipient; a waiting pasted address (pending) is shown, never paid.
  const rows = marketRows.map(row => {
    const { active, pending } = destinations.get(row.repoId) ?? { active: null, pending: null }
    return { ...row, wallet: active?.wallet ?? null, boundAt: active?.boundAt ?? null, method: active?.method ?? null, pending }
  })
  const payoutReady = await (async () => { try { const signer = creatorSigner(); return Boolean(signer && await chain().getBalance(signer.publicKey, 'confirmed') > 0) } catch { return false } })()
  // Each row's active decline (src/maintainer-opt-outs.mjs); unreadable leaves it out and the row hides that control.
  const decisions = await activeDecisions(pool, rows.map(row => row.repoId)).catch(error => { console.error('builder decisions unavailable', { error: error.message }); return null })
  const repositories = await mapLimited(rows, 3, async row => {
    const fees = await feeStatus(row.repoId)
    const available = fees.status === 'MATCH' ? fees.onchainCreatorFee?.toString() ?? null : null
    const ready = payoutReady && row.wallet && !row.pendingSignature && available && BigInt(available) > 0n
    const expiresAt = Math.min(session.expiresAt, Date.now() + 30 * 60_000)
    const review = ready ? seal({ purpose: 'builder-claim-review', sessionId: session.sessionId,
      githubUserId: session.githubUserId, repoId: row.repoId, wallet: row.wallet,
      boundAt: new Date(row.boundAt).toISOString(), amount: available, includeGraduatedFees: fees.graduated === true, paid: row.paid, expiresAt }) : null
    // Tips waiting (hidden when tips are disabled); claimable once a payout wallet is set and no tip payout is in flight.
    const tips = await repoTipSummary(row.repoId)
    const tipReview = tips?.waiting.length && row.wallet && !tips.waiting.some(t => t.inFlight)
      ? sealTipReview(session, { repoId: row.repoId, wallet: row.wallet, boundAt: row.boundAt }) : null
    return { ...row, available, review, expiresAt, feeStatus: fees.status, tips, tipReview, decision: decisions ? decisions.get(row.repoId) ?? null : undefined }
  })
  return { repositories, payoutReady, githubLogin: session.githubLogin, expiresAt: session.expiresAt }
}
