import { NextResponse } from 'next/server'
import { createGitHubAppVerifier } from '../../../../src/github-verification.mjs'
import { database } from '../../../lib/server.mjs'
import { IDENTITY_SIGN_IN_PAGES, githubSessionCookie, unseal, cookieOptions, encryptGithubSession, newGithubSession, GITHUB_SESSION_SECONDS } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { contributorWalletAvailable } from '../../../lib/contributor-wallet.mjs'
import { handoffAvailable } from '../../../lib/handoff.mjs'
import { creditPacksAvailable } from '../../../lib/credit-packs.mjs'
import { funnelSource, verificationOutcome } from '../../../lib/claim-funnel.mjs'
import { recordFunnelEvent } from '../../../../src/funnel-store.mjs'
import { guideSource } from '../../../lib/launch-guide-funnel.mjs'
import { recordGuide } from '../../../lib/launch-guide-events.mjs'
export const runtime = 'nodejs'
export async function GET(request) {
  const origin = publicOrigin(request.url)
  const stateSession = unseal(request.cookies.get('gitfun_oauth')?.value)
  // A sealed value made for another purpose (a handoff request, a review) is never an OAuth state.
  if (!stateSession || stateSession.purpose !== undefined) return NextResponse.redirect(new URL('/explore', origin))
  // A contributor, handoff or credit pack sign-in started before its feature was turned off does not finish.
  if ((stateSession.mode === 'contributor' && !contributorWalletAvailable()) || (stateSession.mode === 'handoff' && !handoffAvailable())
    || (stateSession.mode === 'credits' && !creditPacksAvailable())) {
    const closed = NextResponse.redirect(new URL('/explore', origin))
    closed.cookies.delete('gitfun_oauth')
    return closed
  }
  // Identity-only sign-ins (builder dashboard, opt-out, contributor wallet) return to their own page.
  const identityPage = Object.hasOwn(IDENTITY_SIGN_IN_PAGES, stateSession.mode) ? IDENTITY_SIGN_IN_PAGES[stateSession.mode] : null
  const isDashboard = Boolean(identityPage)
  const back = new URL(identityPage ?? `/claim/${stateSession.repoId}`, origin)
  const githubError = request.nextUrl.searchParams.get('error')
  let session = null, result = null, failed = false
  // GitHub sends ?error=access_denied (and no code) when the person presses Cancel: nothing to exchange.
  if (!githubError) {
    try {
      const verifier = createGitHubAppVerifier({ pool: database(), clientId: process.env.GITHUB_APP_CLIENT_ID,
        clientSecret: process.env.GITHUB_APP_CLIENT_SECRET, redirectUri: `${origin}/api/github/callback` })
      const callback = { githubRepoId: stateSession.repoId, expectedGithubRepoId: stateSession.repoId,
        code: request.nextUrl.searchParams.get('code'), state: request.nextUrl.searchParams.get('state'),
        expectedState: stateSession.state, retainCredential: true }
      result = isDashboard ? await verifier.verifyBuilderCallback(callback) : await verifier.verifyCallback(callback)
    } catch { failed = true }
  }
  // Cancelled, not a current admin (a claim only; it never gets a session) and failed are told apart (app/lib/claim-funnel.mjs).
  // Identity pages other than the dashboard keep their single error code.
  const outcome = verificationOutcome({ githubError, result, failed, dashboard: isDashboard })
  if (outcome.outcome === 'verified') {
    session = newGithubSession(result)
    back.searchParams.set('verified', '1')
  } else {
    back.searchParams.set('error', !isDashboard || stateSession.mode === 'builders' || stateSession.mode === 'launch-guide' ? outcome.error : 'verification-failed')
    if (outcome.detail?.github) back.searchParams.set('github', outcome.detail.github)
    if (outcome.detail) back.searchParams.set('permission', outcome.detail.permission)
  }
  const src = stateSession.mode === 'launch-guide' ? guideSource(stateSession.src) : funnelSource(stateSession.src)
  if (src && !isDashboard) back.searchParams.set('src', src)
  if (!isDashboard) await recordFunnelEvent(database(), { event: 'verify_result', source: src, repoId: stateSession.repoId, outcome: outcome.outcome })
  else if (stateSession.mode === 'builders') await recordFunnelEvent(database(), { event: 'builders_result', source: src, outcome: outcome.outcome })
  else if (stateSession.mode === 'launch-guide') await recordGuide(request, { event: 'github_result', step: 'github', source: src, outcome: outcome.outcome })
  const response = NextResponse.redirect(back)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.cookies.delete('gitfun_oauth')
  response.cookies.delete('gitfun_user')
  if (session) response.cookies.set(githubSessionCookie, encryptGithubSession(session), { ...cookieOptions, maxAge: GITHUB_SESSION_SECONDS })
  else response.cookies.delete(githubSessionCookie)
  return response
}
