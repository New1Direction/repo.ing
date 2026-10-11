import { NextResponse } from 'next/server'
import { CREDITS_SESSION_COOKIE, CreditsWebError, sealCreditsSession } from '../../../../../src/credits-web.mjs'
import { creditsPacksSettings } from '../../../../../src/credits-packs.mjs'
import { builderShareTarget, builderSharesSettings, cachedShareTotals, claimPackShares } from '../../../../../src/builder-pack-shares.mjs'
import { assertSameOrigin, cookieOptions, githubSessionCookie, readGithubSession } from '../../../../lib/auth.mjs'
import { sessionVerifier } from '../../../../lib/github-session.mjs'
import { publicOrigin } from '../../../../lib/origin.mjs'
import { database } from '../../../../lib/server.mjs'
export const runtime = 'nodejs'

// Every pack pays a builder (src/builder-pack-shares.mjs): GET a repository's share totals and whether packs may back it
// (for the signed-in buyer); POST { action: 'claim' } claims them for the payout-wallet holder. 404 while dark.
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
const reply = (body, status = 200, session = null) => {
  const response = NextResponse.json(body, { status, headers })
  // The credit service's session, encrypted and HttpOnly; it never reaches the page's scripts.
  if (session) response.cookies.set(CREDITS_SESSION_COOKIE, sealCreditsSession(session),
    { ...cookieOptions, sameSite: 'strict', maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)) })
  return response
}
const repoOf = async params => { const { repo } = await params; return /^[1-9]\d{0,18}$/.test(repo ?? '') ? repo : null }

export async function GET(request, { params }) {
  const shares = builderSharesSettings(), settings = creditsPacksSettings(), pool = database()
  const repoId = await repoOf(params)
  if (!shares || !settings || !pool || !repoId) return reply({ error: 'Not found' }, 404)
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  let target = null, reason = null
  try { target = await builderShareTarget(pool, { repoId, buyerGithubUserId: session?.githubUserId ?? '0' }) } catch (error) { reason = error instanceof CreditsWebError ? error.message : 'This repository cannot be checked right now.' }
  const totals = await cachedShareTotals(settings, repoId).catch(() => null)
  const { rows: [binding] } = await pool.query('select github_user_id::text as holder from repo_beneficiaries where github_repo_id=$1::bigint', [repoId]).catch(() => ({ rows: [] }))
  const { rows: [repo] } = await pool.query('select full_name as "fullName" from repositories where github_repo_id=$1::bigint', [repoId]).catch(() => ({ rows: [] }))
  return reply({ repoId, fullName: target?.fullName ?? repo?.fullName ?? null, shareBps: shares.shareBps, eligible: Boolean(target), reason,
    ...totals ?? { packs: null, paidMicro: null, claimedMicro: null, unclaimedMicro: null },
    holder: Boolean(session && binding?.holder && binding.holder === String(session.githubUserId)) })
}

export async function POST(request, { params }) {
  const shares = builderSharesSettings(), settings = creditsPacksSettings(), pool = database()
  const repoId = await repoOf(params)
  if (!shares || !settings || !pool || !repoId) return reply({ error: 'Not found' }, 404)
  let session
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    const body = await request.json()
    if (!session || body?.action !== 'claim' || Object.keys(body).length !== 1) throw Error('invalid')
  } catch { return reply({ error: 'Invalid or expired request. Refresh the page and sign in with GitHub again.' }, 403) }
  try {
    const result = await claimPackShares({ pool, settings, shares, session, repoId, githubVerifier: sessionVerifier(session, request.url) })
    return reply({ claimedMicro: result.claimedMicro, shares: result.shares }, 200, result.session)
  } catch (error) {
    // Never pass on internals (queries, RPC or GitHub text): only the credit service's own plain answers.
    return error instanceof CreditsWebError ? reply({ error: error.message }, error.status) : reply({ error: 'The claim could not be completed. Try again.' }, 409)
  }
}
