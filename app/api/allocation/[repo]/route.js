import { createBuilderAllocation, allocationRecord } from '../../../../src/builder-allocation.mjs'
import { HfAuthorityError } from '../../../../src/hf-verification.mjs'
import { hfMarketsEnabled, isHfMarketId } from '../../../../src/hf-launch.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { database, chain, configAddress, creatorSigner } from '../../../lib/server.mjs'
import { allocationView, modelAllocationView } from '../../../lib/allocation.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, unseal } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { hfSessionCookie, readHfAllocationReview, readHfSession } from '../../../lib/hf-auth.mjs'
import { hfSessionAuthority } from '../../../lib/hf-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }
export async function GET(request, { params }) {
  let repo
  try {
    ({ repo } = await params)
    if (!/^[1-9]\d*$/.test(repo)) return Response.json({ error: 'Invalid repository' }, { status: 400, headers })
    if (isHfMarketId(repo)) return await modelStatus(request, repo)
    return Response.json(await allocationView(repo, readGithubSession(request.cookies.get(githubSessionCookie)?.value)), { headers })
  } catch (error) {
    console.error('allocation status failed', { repo, error: error.message })
    return Response.json({ error: 'Allocation status is temporarily unavailable. Try refreshing.' }, { status: 503, headers })
  }
}
export async function POST(request, { params }) {
  let review, repo
  try {
    ({ repo } = await params)
    if (isHfMarketId(repo)) return await modelClaim(request, repo)
    assertSameOrigin(request, publicOrigin(request.url))
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    review = unseal((await request.json()).review)
    if (!session || review?.purpose !== 'builder-allocation-review' || review.sessionId !== session.sessionId ||
        review.githubUserId !== session.githubUserId || review.repoId !== repo ||
        !(session.scope === 'builders' || session.repoId === repo)) throw Error('Review expired')
    const result = await createBuilderAllocation({ pool: database(), connection: chain(), config: configAddress(), creator: creatorSigner(),
      githubVerifier: sessionVerifier(session, request.url, { dashboard: true }) }).claim({ review, githubAuthorization: { session: true } })
    return Response.json(result, { headers })
  } catch (error) {
    if (review?.repoId === repo && review?.purpose === 'builder-allocation-review') {
      const record = await allocationRecord(database(), repo).catch(() => null)
      if (['pending','settled'].includes(record?.latest?.status)) return Response.json(record.latest, { headers })
    }
    const message = /authority|GitHub|wallet/.test(error.message) ? 'Reconnect GitHub and confirm your saved payout wallet before claiming.' :
      /locked/.test(error.message) ? 'The builder allocation unlocks after verified graduation.' :
      /preflight/.test(error.message) ? 'Payout could not pass its checks. Your allocation is preserved; try again later.' :
      'Refresh this page to review the allocation and try again.'
    return Response.json({ status: 'failed', error: message }, { status: 409, headers })
  }
}

// A Hugging Face model market (the id range decides; src/market-identity.mjs): dormant unless HF_MARKETS_ENABLED. Its
// review is sealed for this market's Hugging Face session (app/lib/hf-auth.mjs), and the claim runs
// src/builder-allocation.mjs with that session's Hugging Face authority, which checks the model's current owner again.
const CLAIMS_PER_HOUR = 20
const dormant = () => new Response('Not found', { status: 404, headers })
class ClaimRefused extends Error { constructor(message, status = 409) { super(message); this.status = status } }

async function modelStatus(request, repo) {
  if (!hfMarketsEnabled()) return dormant()
  return Response.json(await modelAllocationView(repo, readHfSession(request.cookies.get(hfSessionCookie)?.value)), { headers })
}

async function modelClaim(request, repo) {
  if (!hfMarketsEnabled()) return dormant()
  let review
  try {
    try { assertSameOrigin(request, publicOrigin(request.url)) } catch { throw new ClaimRefused('Open this page on repo.ing and try again.', 403) }
    const session = readHfSession(request.cookies.get(hfSessionCookie)?.value)
    if (!session || session.mode !== 'claim' || session.marketId !== repo) throw new ClaimRefused('Sign in with Hugging Face again to continue.', 401)
    review = readHfAllocationReview((await request.json().catch(() => null))?.review, session)
    const pool = database(), creator = creatorSigner(), config = configAddress()
    if (!pool || !creator || !config) throw new ClaimRefused('Payouts are unavailable right now. Your allocation is preserved; try again later.', 503)
    if (!await takeQuota(pool, [[`hf-allocation:${session.subject}`, CLAIMS_PER_HOUR, 3600]]).catch(() => false)) {
      throw new ClaimRefused('Too many claim attempts. Try again later.', 429)
    }
    const result = await createBuilderAllocation({ pool, connection: chain(), config, creator, githubVerifier: hfSessionAuthority(session, request.url) })
      .claim({ review })
    return Response.json(result, { headers })
  } catch (error) {
    if (review?.repoId === repo) {
      const record = await allocationRecord(database(), repo).catch(() => null)
      if (['pending', 'settled'].includes(record?.latest?.status)) return Response.json(record.latest, { headers })
    }
    if (error instanceof ClaimRefused) return Response.json({ status: 'failed', error: error.message }, { status: error.status, headers })
    return Response.json({ status: 'failed', error: modelClaimMessage(error, repo), ...(error instanceof HfAuthorityError ? { code: error.code } : {}) },
      { status: 409, headers })
  }
}

// App-authored text only: a Hugging Face authority error keeps its own (who owns the model, sign in again, model moved);
// anything else is mapped like the GitHub branch's messages.
function modelClaimMessage(error, repo) {
  const message = error?.message ?? ''
  if (error instanceof HfAuthorityError) return error.message
  if (/owner changed since this payout wallet was set/.test(message)) return 'The model has a new owner since its payout wallet was set. The current owner must set a payout wallet before claiming.'
  if (/authority|Hugging Face|wallet/.test(message)) return 'Sign in with Hugging Face again and confirm your saved payout wallet before claiming.'
  if (/locked/.test(message)) return 'The builder allocation unlocks after verified graduation.'
  if (/preflight/.test(message)) return 'Payout could not pass its checks. Your allocation is preserved; try again later.'
  if (!/review expired|already submitted|not enrolled/.test(message)) console.error('model allocation claim failed', { repo, error: message })
  return 'Refresh this page to review the allocation and try again.'
}
