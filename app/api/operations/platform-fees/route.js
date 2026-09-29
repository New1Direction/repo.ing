import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { platformTreasuryWallet } from '../../../../src/platform-dbc-fees.mjs'
import { allocationReview, listPlatformFees, platformFeeReview, platformFeeService } from '../../../../src/platform-fee-operations.mjs'
import { createPlatformRevenue, platformRevenueSummary } from '../../../../src/platform-revenue.mjs'
import { database, chain, configAddress, partnerSigner } from '../../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, seal, unseal } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

function feeService(phase = 'DBC') {
  const partner = partnerSigner()
  if (!partner) throw Error('Platform fee claiming is not configured')
  return platformFeeService(phase, { pool: database(), connection: chain(), config: configAddress(), partner })
}

function session(request) {
  return requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
}

function reviewFor(sessionId, repoId, phase, data) {
  return seal(platformFeeReview({ sessionId, repoId, phase, data, partner: partnerSigner().publicKey }))
}

// Operator view over every finalized market's uncollected platform fees. On-chain
// inspection is read-only; claiming still requires the reviewed POST below.
function mapAllRepos(operator) {
  return listPlatformFees({ pool: database(), feeService,
    review: (repoId, phase, data) => reviewFor(operator.sessionId, repoId, phase, data) })
}

export async function GET(request) {
  let operator
  try { operator = session(request) }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 403, headers }) }
  try {
    const [repos, revenue] = await Promise.all([
      mapAllRepos(operator),
      platformRevenueSummary(database()),
    ])
    return Response.json({ repos, revenue: {
      available: revenue.available, claimed: revenue.claimed, allocated: revenue.allocated,
      buybackReserve: revenue.buybackReserve, buybackAhead: revenue.buybackAhead, publishedSpent: revenue.publishedSpent, activePolicy: revenue.activePolicy,
      reviews: { allocate: revenue.available !== '0' && revenue.activePolicy ? seal(allocationReview({
        sessionId: operator.sessionId, policyVersion: revenue.activePolicy.version })) : null } },
      checkedAt: new Date().toISOString() }, { headers })
  } catch { return Response.json({ error: 'Platform fee overview is temporarily unavailable. Try refreshing.' }, { status: 503, headers }) }
}

export async function POST(request) {
  let body
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    body = await request.json()
    const operator = session(request)
    if (body.action === 'claim') {
      const review = unseal(body.review)
      if (!review || review.purpose !== 'platform-fee-review' || review.sessionId !== operator.sessionId) throw Error('Review expired')
      return Response.json({ result: await feeService(review.phase || 'DBC').claim({ review }) }, { headers })
    }
    if (body.action === 'allocate') {
      const review = unseal(body.review)
      if (!review || review.purpose !== 'platform-revenue-allocate' || review.sessionId !== operator.sessionId) throw Error('Review expired')
      const partner = partnerSigner()
      const service = createPlatformRevenue({ pool: database(), partnerWallet: platformTreasuryWallet(partner.publicKey) })
      return Response.json({ result: await service.allocate({ review, createdBy: operator.githubUserId }) }, { headers })
    }
    throw Error('Unsupported platform fee action')
  } catch (error) {
    return Response.json({ error: error.status ? error.message : 'Refresh this page to review platform fees and try again.' },
      { status: error.status ?? 409, headers })
  }
}
