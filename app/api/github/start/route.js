import { NextResponse } from 'next/server'
import { createGitHubAppVerifier } from '../../../../src/github-verification.mjs'
import { githubInstallationForRepository } from '../../../../src/github-app-auth.mjs'
import { database, marketByRepo, repositoryById } from '../../../lib/server.mjs'
import { IDENTITY_SIGN_IN_PAGES, seal, cookieOptions } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { contributorWalletAvailable } from '../../../lib/contributor-wallet.mjs'
import { handoffAvailable } from '../../../lib/handoff.mjs'
import { creditPacksAvailable } from '../../../lib/credit-packs.mjs'
import { funnelSource, withFunnelSource } from '../../../lib/claim-funnel.mjs'
import { recordFunnelEvent } from '../../../../src/funnel-store.mjs'
import { guideSource } from '../../../lib/launch-guide-funnel.mjs'
import { recordGuide } from '../../../lib/launch-guide-events.mjs'
export const runtime = 'nodejs'
export async function GET(request) {
  const origin = publicOrigin(request.url)
  const repoId = request.nextUrl.searchParams.get('repo')
  const mode = request.nextUrl.searchParams.get('mode')
  // Claim funnel attribution (app/lib/claim-funnel.mjs): kept in the sealed OAuth state so the callback can count the result.
  // The guided launch has its own sources (app/lib/launch-guide-funnel.mjs).
  const src = mode === 'launch-guide' ? guideSource(request.nextUrl.searchParams.get('src')) : funnelSource(request.nextUrl.searchParams.get('src'))
  // 'opt-out' is the builder dashboard's identity-only sign-in, returning to /opt-out instead of /builders; 'contributor'
  // returns to the contributor wallet page and exists only while it does (src/early-access.mjs); 'credits' likewise
  // returns to /credits (src/credits-packs.mjs).
  if (mode === 'contributor' && !contributorWalletAvailable()) return NextResponse.redirect(new URL('/explore', origin))
  if (mode === 'handoff' && !handoffAvailable()) return NextResponse.redirect(new URL('/explore', origin))
  if (mode === 'credits' && !creditPacksAvailable()) return NextResponse.redirect(new URL('/explore', origin))
  if (Object.hasOwn(IDENTITY_SIGN_IN_PAGES, mode)) {
    try {
      const verifier = createGitHubAppVerifier({ pool: database(), clientId: process.env.GITHUB_APP_CLIENT_ID,
        clientSecret: process.env.GITHUB_APP_CLIENT_SECRET, redirectUri: `${origin}/api/github/callback` })
      const authorization = verifier.authorizationUrl()
      const response = NextResponse.redirect(authorization.url)
      if (mode === 'builders') await recordFunnelEvent(database(), { event: 'builders_connect', source: src })
      if (mode === 'launch-guide') await recordGuide(request, { event: 'github_connect', step: 'github', source: src })
      response.cookies.set('gitfun_oauth', seal({ mode, src, state: authorization.state, expiresAt: Date.now() + 10 * 60_000 }),
        { ...cookieOptions, maxAge: 600 })
      return response
    } catch { return NextResponse.redirect(new URL(`${IDENTITY_SIGN_IN_PAGES[mode]}?error=github-unavailable`, origin)) }
  }
  if (!/^\d+$/.test(repoId || '') || !['verify', 'claim'].includes(mode)) return NextResponse.redirect(new URL('/explore', origin))
  const { market } = await marketByRepo(repoId)
  const clientId = process.env.GITHUB_APP_CLIENT_ID || (process.env.NODE_ENV === 'production' ? null : 'Iv23li0LF9CWsTgcIyQ0')
  if (!market || !database() || !clientId || !process.env.GITHUB_APP_CLIENT_SECRET) return NextResponse.redirect(new URL(withFunnelSource(`/claim/${repoId}?error=github-unavailable`, src), origin))
  try {
    const repo = await repositoryById(repoId)
    if (!repo || !await githubInstallationForRepository({ owner: repo.owner, name: repo.name })) {
      await recordFunnelEvent(database(), { event: 'app_access_required', source: src, repoId })
      return NextResponse.redirect(new URL(withFunnelSource(`/claim/${repoId}?error=app-access-required`, src), origin))
    }
  } catch { return NextResponse.redirect(new URL(withFunnelSource(`/claim/${repoId}?error=github-unavailable`, src), origin)) }
  const redirectUri = `${origin}/api/github/callback`
  const verifier = createGitHubAppVerifier({ pool: database(), clientId,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET, redirectUri })
  const authorization = verifier.authorizationUrl({ githubRepoId: repoId })
  const response = NextResponse.redirect(authorization.url)
  await recordFunnelEvent(database(), { event: 'verify_start', source: src, repoId })
  response.cookies.set('gitfun_oauth', seal({ repoId, mode, src, state: authorization.state, expiresAt: Date.now() + 10 * 60_000 }),
    { ...cookieOptions, maxAge: 600 })
  return response
}
