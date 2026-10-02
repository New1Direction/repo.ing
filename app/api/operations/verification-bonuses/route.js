import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { chain, database, partnerSigner } from '../../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { VerificationBonusError, verificationBonusEnrollment, verificationBonusPayoutConfig } from '../../../../src/verification-bonus.mjs'
import { createVerificationBonusReview } from '../../../../src/verification-bonus-review.mjs'
import { createVerificationBonusPayouts, readCommittedLamports, readPendingLamports, readProtectedRevenue } from '../../../../src/verification-bonus-payouts.mjs'

// Operator-only review of verification bonuses (/operations/bonuses). Same access as the other operations pages: a
// builders GitHub session whose immutable user ID is in PLATFORM_OPERATOR_GITHUB_IDS. Every mutation is same-origin.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
const session = request => requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
// A malformed key is reported as such (never echoed); payouts then refuse as if no signer were configured.
function readSigner() {
  try { return { partner: partnerSigner(), error: null } }
  catch { return { partner: null, error: 'PLATFORM_PARTNER_SECRET_KEY is malformed; payouts are unavailable until it is fixed.' } }
}
const payouts = () => createVerificationBonusPayouts({ pool: database(), connection: chain(), partner: readSigner().partner })

// The payer's balance and what a payout must leave in it: in-flight bonus payouts and ledger revenue held for other uses.
async function payerStatus(pool) {
  const { partner, error } = readSigner()
  if (!partner) return error ? { error } : null
  const address = partner.publicKey.toBase58()
  const [balance, pending, protectedRevenue] = await Promise.all([
    chain().getBalance(partner.publicKey, 'confirmed').then(String, () => null),
    readPendingLamports(pool, address), readProtectedRevenue(pool, address)])
  return { address, balance, pendingLamports: pending.toString(), unallocatedLamports: protectedRevenue.unallocated.toString(),
    liquidityLamports: protectedRevenue.liquidity.toString() }
}

export async function GET(request) {
  try { session(request) }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 403, headers }) }
  try {
    const pool = database()
    if (!pool) throw Error('Database is not configured')
    const [{ bonuses, checking }, committed, payer] = await Promise.all([createVerificationBonusReview({ pool }).list(),
      readCommittedLamports(pool), payerStatus(pool)])
    const enrollment = verificationBonusEnrollment(), config = verificationBonusPayoutConfig()
    return Response.json({ bonuses, checking, payer, checkedAt: new Date().toISOString(),
      policy: { enrollmentLamports: enrollment.lamports?.toString() ?? null, enrollmentError: enrollment.error,
        payoutsEnabled: config.enabled, capLamports: config.cap?.toString() ?? null, reserveLamports: config.reserve?.toString() ?? null,
        configError: config.error, committedLamports: committed.toString() } }, { headers })
  } catch { return Response.json({ error: 'Verification bonuses are temporarily unavailable. Try refreshing.' }, { status: 503, headers }) }
}

const message = (error, fallback) => error instanceof VerificationBonusError || error?.status ? error.message : fallback

export async function POST(request) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const operator = session(request)
    if (Number(request.headers.get('content-length') || 0) > 8192) throw new VerificationBonusError('Request is too large', 413)
    const body = await request.json()
    // The client sends the amount and launcher wallet it displayed; the server refuses a decision on anything else.
    const expected = { amount: body?.amount, wallet: body?.wallet }
    const review = createVerificationBonusReview({ pool: database() })
    if (body?.action === 'approve') {
      const result = await review.approve({ repoId: body.repoId, operator, expected })
      // With payouts on, the server pays right after approval; any refusal (cap, funding, fees) leaves it approved.
      if (!verificationBonusPayoutConfig().enabled) return Response.json({ result, payout: { status: 'waiting',
        reason: 'Payouts are off (VERIFICATION_BONUS_PAYOUTS_ENABLED), so the bonus waits as approved.' } }, { headers })
      try { return Response.json({ result, payout: await payouts().pay({ repoId: body.repoId, operator, expected }) }, { headers }) }
      catch (error) {
        if (!(error instanceof VerificationBonusError)) console.error('verification bonus payout failed', { repo: String(body.repoId), error: error?.message })
        return Response.json({ result, payout: { status: 'waiting', reason: message(error, 'The payout could not be sent; the bonus stays approved.') } }, { headers })
      }
    }
    if (body?.action === 'reject') return Response.json({ result: await review.reject({ repoId: body.repoId, operator, reason: body.reason, expected }) }, { headers })
    if (body?.action === 'pay') return Response.json({ payout: await payouts().pay({ repoId: body.repoId, operator, expected }) }, { headers })
    if (body?.action === 'check') return Response.json({ payout: await payouts().recover(body.repoId) }, { headers })
    throw new VerificationBonusError('Unsupported bonus action', 400)
  } catch (error) {
    if (!(error instanceof VerificationBonusError) && !error?.status) console.error('verification bonus operation failed', { error: error?.message })
    return Response.json({ error: message(error, 'Could not update the bonus. Refresh and try again.') }, { status: error?.status ?? 409, headers })
  }
}
