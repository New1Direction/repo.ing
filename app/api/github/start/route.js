import { NextResponse } from 'next/server'
import { createGitHubAppVerifier } from '../../../../src/github-verification.mjs'
import { githubInstallationForRepository } from '../../../../src/github-app-auth.mjs'
import { database, marketByRepo, repositoryById } from '../../../lib/server.mjs'
import { seal, cookieOptions } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
export async function GET(request) {
  const origin = publicOrigin(request.url)
  const repoId = request.nextUrl.searchParams.get('repo')
  const mode = request.nextUrl.searchParams.get('mode')
  // 'opt-out' is the builder dashboard's identity-only sign-in, returning to /opt-out instead of /builders.
  if (mode === 'builders' || mode === 'opt-out') {
    try {
      const verifier = createGitHubAppVerifier({ pool: database(), clientId: process.env.GITHUB_APP_CLIENT_ID,
        clientSecret: process.env.GITHUB_APP_CLIENT_SECRET, redirectUri: `${origin}/api/github/callback` })
      const authorization = verifier.authorizationUrl()
      const response = NextResponse.redirect(authorization.url)
      response.cookies.set('gitfun_oauth', seal({ mode, state: authorization.state, expiresAt: Date.now() + 10 * 60_000 }),
        { ...cookieOptions, maxAge: 600 })
      return response
    } catch { return NextResponse.redirect(new URL(`/${mode === 'opt-out' ? 'opt-out' : 'builders'}?error=github-unavailable`, origin)) }
  }
  if (!/^\d+$/.test(repoId || '') || !['verify', 'claim'].includes(mode)) return NextResponse.redirect(new URL('/explore', origin))
  const { market } = await marketByRepo(repoId)
  const clientId = process.env.GITHUB_APP_CLIENT_ID || (process.env.NODE_ENV === 'production' ? null : 'Iv23li0LF9CWsTgcIyQ0')
  if (!market || !database() || !clientId || !process.env.GITHUB_APP_CLIENT_SECRET) return NextResponse.redirect(new URL(`/claim/${repoId}?error=github-unavailable`, origin))
  try {
    const repo = await repositoryById(repoId)
    if (!repo || !await githubInstallationForRepository({ owner: repo.owner, name: repo.name })) {
      return NextResponse.redirect(new URL(`/claim/${repoId}?error=app-access-required`, origin))
    }
  } catch { return NextResponse.redirect(new URL(`/claim/${repoId}?error=github-unavailable`, origin)) }
  const redirectUri = `${origin}/api/github/callback`
  const verifier = createGitHubAppVerifier({ pool: database(), clientId,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET, redirectUri })
  const authorization = verifier.authorizationUrl({ githubRepoId: repoId })
  const response = NextResponse.redirect(authorization.url)
  response.cookies.set('gitfun_oauth', seal({ repoId, mode, state: authorization.state, expiresAt: Date.now() + 10 * 60_000 }),
    { ...cookieOptions, maxAge: 600 })
  return response
}
