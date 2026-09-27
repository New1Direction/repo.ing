import { NextResponse } from 'next/server'
import { createGitHubAppVerifier } from '../../../../src/github-verification.mjs'
import { database } from '../../../lib/server.mjs'
import { githubSessionCookie, unseal, cookieOptions, encryptGithubSession, newGithubSession, GITHUB_SESSION_SECONDS } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
export async function GET(request) {
  const origin = publicOrigin(request.url)
  const stateSession = unseal(request.cookies.get('gitfun_oauth')?.value)
  if (!stateSession) return NextResponse.redirect(new URL('/explore', origin))
  const isDashboard = stateSession.mode === 'builders'
  const back = new URL(isDashboard ? '/builders' : `/claim/${stateSession.repoId}`, origin)
  let session = null
  try {
    const verifier = createGitHubAppVerifier({ pool: database(), clientId: process.env.GITHUB_APP_CLIENT_ID,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET, redirectUri: `${origin}/api/github/callback` })
    const callback = { githubRepoId: stateSession.repoId, expectedGithubRepoId: stateSession.repoId,
      code: request.nextUrl.searchParams.get('code'), state: request.nextUrl.searchParams.get('state'),
      expectedState: stateSession.state, retainCredential: true }
    const result = isDashboard ? await verifier.verifyBuilderCallback(callback) : await verifier.verifyCallback(callback)
    if (!isDashboard && (!result.verified || result.permission !== 'admin')) throw new Error('Admin permission required')
    session = newGithubSession(result)
    back.searchParams.set('verified', '1')
  } catch { back.searchParams.set('error', 'verification-failed') }
  const response = NextResponse.redirect(back)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.cookies.delete('gitfun_oauth')
  response.cookies.delete('gitfun_user')
  if (session) response.cookies.set(githubSessionCookie, encryptGithubSession(session), { ...cookieOptions, maxAge: GITHUB_SESSION_SECONDS })
  else response.cookies.delete(githubSessionCookie)
  return response
}
