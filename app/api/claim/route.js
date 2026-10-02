import { NextResponse } from 'next/server'
import { createClaim } from '../../../src/claim.mjs'
import { claimProgressStream } from '../../../src/claim-progress.mjs'
import { database, chain, configAddress, creatorSigner } from '../../lib/server.mjs'
import { githubSessionCookie, readGithubSession, readClaimReview, assertSameOrigin } from '../../lib/auth.mjs'
import { sessionVerifier } from '../../lib/github-session.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
export const runtime = 'nodejs'

export async function POST(request) {
  const origin = publicOrigin(request.url)
  let session, review, repoId, reinvest = false
  try {
    assertSameOrigin(request, origin)
    session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    const form = await request.formData()
    repoId = form.get('repoId')
    review = readClaimReview(form.get('review'), session)
    reinvest = form.get('next') === 'reinvest' && process.env.BUILDER_REINVEST_ENABLED === 'true'
  } catch {
    if (typeof repoId === 'string' && /^\d+$/.test(repoId)) return NextResponse.redirect(new URL(`/claim/${repoId}?error=${session ? 'review-changed' : 'verification-failed'}`, origin), 303)
    return new Response('This claim review expired or is invalid. Return to the claim page, refresh, and review again.',
      { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  const back = new URL(`/claim/${session.repoId}`, origin)
  const stream = claimProgressStream(async report => {
    try {
      const creator = creatorSigner(), config = configAddress()
      if (!creator || !config) throw new Error('Payout signer needs SOL for network costs')
      const result = await createClaim({ pool: database(), connection: chain(), config, creator,
        githubVerifier: sessionVerifier(session, request.url) }).claim({ githubRepoId: session.repoId,
        githubAuthorization: { session: true }, review, onProgress: report })
      back.searchParams.set('claimed', result.signature)
      if (reinvest) back.searchParams.set('reinvest', '1')
    } catch (error) {
      back.searchParams.set('error', error.message === 'Payout signer needs SOL for network costs' ? 'payout-unavailable' :
        /48-hour hold/.test(error.message) ? 'payout-address-pending' :
        /review|amount changed/i.test(error.message) ? 'review-changed' :
          /GitHub|permission/.test(error.message) ? 'verification-failed' : 'claim-failed')
    }
    return back.toString()
  }, new URL(`/claim/${session.repoId}?error=claim-failed`, origin).toString())
  return new NextResponse(stream, { headers: { 'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' } })
}
