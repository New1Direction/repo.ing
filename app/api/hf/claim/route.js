import { NextResponse } from 'next/server'
import { createClaim } from '../../../../src/claim.mjs'
import { claimProgressStream } from '../../../../src/claim-progress.mjs'
import { HfAuthorityError, hfMarketsEnabled } from '../../../../src/hf-verification.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { chain, configAddress, creatorSigner, database } from '../../../lib/server.mjs'
import { assertSameOrigin } from '../../../lib/auth.mjs'
import { hfSessionCookie, readHfClaimReview, readHfSession } from '../../../lib/hf-auth.mjs'
import { hfSessionAuthority } from '../../../lib/hf-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A model market's claim (the counterpart of /api/claim): the claim page's sealed review, the Hugging Face session for this
// market, and src/claim.mjs with the session's Hugging Face authority. The claim checks the model's current owner again
// under the market's lock, refuses a binding made for a previous owner, and pays only the bound wallet.
const CLAIMS_PER_HOUR = 20

function errorCode(error) {
  const message = error?.message ?? ''
  if (message === 'Payout signer needs SOL for network costs') return 'payout-unavailable'
  if (/48-hour hold/.test(message)) return 'payout-address-pending'
  if (/owner changed since this payout wallet was set/.test(message)) return 'owner-changed'
  if (error instanceof HfAuthorityError && error.code === 'HF_MODEL_MOVED') return 'model-moved'
  if (/review|amount changed/i.test(message)) return 'review-changed'
  if (error instanceof HfAuthorityError || /Hugging Face|authority/.test(message)) return 'verification-failed'
  return 'claim-failed'
}

export async function POST(request) {
  if (!hfMarketsEnabled()) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const origin = publicOrigin(request.url)
  let session, review, repoId
  try {
    assertSameOrigin(request, origin)
    session = readHfSession(request.cookies.get(hfSessionCookie)?.value)
    const form = await request.formData()
    repoId = form.get('repoId')
    if (!session || session.mode !== 'claim' || String(repoId) !== session.marketId) throw new Error('Session mismatch')
    review = readHfClaimReview(form.get('review'), session)
  } catch {
    if (typeof repoId === 'string' && /^\d{16}$/.test(repoId)) {
      return NextResponse.redirect(new URL(`/claim/${repoId}?error=${session ? 'review-changed' : 'verification-failed'}`, origin), 303)
    }
    return new Response('This claim review expired or is invalid. Return to the claim page, refresh, and review again.', { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!await takeQuota(database(), [[`hf-claim:${session.subject}`, CLAIMS_PER_HOUR, 3600]]).catch(() => false)) {
    return NextResponse.redirect(new URL(`/claim/${session.marketId}?error=rate-limited`, origin), 303)
  }
  const back = new URL(`/claim/${session.marketId}`, origin)
  const stream = claimProgressStream(async report => {
    try {
      const creator = creatorSigner(), config = configAddress()
      if (!creator || !config) throw new Error('Payout signer needs SOL for network costs')
      const result = await createClaim({ pool: database(), connection: chain(), config, creator, githubVerifier: hfSessionAuthority(session, request.url) })
        .claim({ githubRepoId: session.marketId, githubAuthorization: { session: true }, review, onProgress: report })
      back.searchParams.set('claimed', result.signature)
    } catch (error) {
      back.searchParams.set('error', errorCode(error))
      if (errorCode(error) === 'claim-failed') console.error('model claim failed', { repo: session.marketId, error: error?.message })
    }
    return back.toString()
  }, new URL(`/claim/${session.marketId}?error=claim-failed`, origin).toString(), { stage: 'Checking Hugging Face ownership and the current claim state…' })
  return new NextResponse(stream, { headers: { 'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' } })
}
