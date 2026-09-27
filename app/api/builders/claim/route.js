import { createClaim } from '../../../../src/claim.mjs'
import { database, chain, configAddress, creatorSigner } from '../../../lib/server.mjs'
import { githubSessionCookie, readGithubSession, readBuilderReview, assertSameOrigin } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'

export async function POST(request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  let session, review
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    review = readBuilderReview((await request.json()).review, session)
  } catch { return Response.json({ status: 'failed', error: 'Your review expired. Refresh and connect GitHub again if needed.' }, { status: 403, headers }) }
  try {
    const creator = creatorSigner(), config = configAddress()
    if (!creator || !config) throw new Error('Payout signer needs SOL for network costs')
    const result = await createClaim({ pool: database(), connection: chain(), creator, config,
      githubVerifier: sessionVerifier(session, request.url, { dashboard: true }) }).claim({
      githubRepoId: review.repoId, githubAuthorization: { session: true }, review })
    return Response.json({ status: 'settled', signature: result.signature, amount: result.amountBaseUnits.toString() }, { headers })
  } catch (error) {
    // A disconnected browser or concurrent retry can still retrieve the durable receipt.
    const result = await database().query(`select claim_signature as signature, amount_base_units::text as amount, status
      from repo_claims where github_repo_id=$1 and status in ('pending','settled') order by id desc limit 1`, [review.repoId]).catch(() => ({ rows: [] }))
    const latest = result.rows[0]
    const snapshotPaid = await database().query(`select coalesce(sum(amount_base_units),0)::text as paid from repo_claims
      where github_repo_id=$1 and status='settled'`, [review.repoId]).catch(() => ({ rows: [] }))
    if (latest?.status === 'pending') return Response.json({ ...latest, error: 'Submitted; settlement is being checked. Refresh to check the receipt.' }, { headers })
    if (latest?.status === 'settled' && BigInt(snapshotPaid.rows[0]?.paid ?? '0') > BigInt(review.paid)) {
      return Response.json({ status: 'already-settled', signature: latest.signature, error: 'This repository already has a newer payout. Refresh for its current balance.' }, { headers })
    }
    const message = /GitHub|permission|authority/.test(error.message) ? 'GitHub access needs checking. Reconnect GitHub or review this repository.' :
      /review|amount changed|details changed/i.test(error.message) ? 'Payout details changed. Refresh to review the latest balance.' :
      /No accrued|no creator fee/.test(error.message) ? 'No fees remain to claim.' :
      /signer needs SOL/.test(error.message) ? 'Payouts are paused while network funds are replenished.' :
      'Payout could not be confirmed. Refresh to check the current status.'
    return Response.json({ status: 'failed', error: message }, { status: 409, headers })
  }
}
