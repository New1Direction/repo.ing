import { NextResponse } from 'next/server'
import { CREDITS_SESSION_COOKIE, CreditsWebError, sealCreditsSession } from '../../../../../src/credits-web.mjs'
import { creditsPacksSettings } from '../../../../../src/credits-packs.mjs'
import { builderShareTargetOf, builderSharesSettings, cachedShareTotals, claimPackShares, confirmedSolMarket, shareRepository } from '../../../../../src/builder-pack-shares.mjs'
import { takeQuota } from '../../../../../src/request-quota.mjs'
import { assertSameOrigin, cookieOptions, githubSessionCookie, readGithubSession } from '../../../../lib/auth.mjs'
import { sessionVerifier } from '../../../../lib/github-session.mjs'
import { clientKey } from '../../../../lib/holder-notes.mjs'
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
// A GET is public and can name any repository, so it is counted before anything is read (agent_request_limits, shared by every
// replica; the key is a keyed hash of the visitor's address, and requests with no address share one allowance): 60 a minute
// each, 240 in all. The visitor's own allowance is taken first, so one visitor's refused requests never use up the one for all.
// The credit service allows repo.ing's one server address 300 calls a minute, pack purchases included; a GET makes at most one
// (totals are kept for a minute per repository).
const GET_QUOTA = { global: [240, 60], client: [60, 60] }
const repoOf = async params => { const { repo } = await params; return /^[1-9]\d{0,18}$/.test(repo ?? '') ? repo : null }

export async function GET(request, { params }) {
  const shares = builderSharesSettings(), settings = creditsPacksSettings(), pool = database()
  const repoId = await repoOf(params)
  if (!shares || !settings || !pool || !repoId) return reply({ error: 'Not found' }, 404)
  let allowed
  try { allowed = await takeQuota(pool, [[`credits:shares:get:client:${clientKey(request)}`, ...GET_QUOTA.client], ['credits:shares:get:global', ...GET_QUOTA.global]]) } catch {
    return reply({ error: 'Share totals are not available right now. Try again in a minute.' }, 503)
  }
  if (!allowed) {
    const limited = reply({ error: 'Too many requests. Try again in a minute.' }, 429)
    limited.headers.set('Retry-After', '60')
    return limited
  }
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  let row = null, target = null, reason = null
  try {
    row = await shareRepository(pool, repoId)
    target = builderShareTargetOf(row, { buyerGithubUserId: session?.githubUserId ?? '0' })
  } catch (error) { reason = error instanceof CreditsWebError ? error.message : 'This repository cannot be checked right now.' }
  // Amounts are asked of the credit service for a confirmed SOL market only, not for an eligible one alone: the payout wallet
  // holder's own repository and a declined one have shares to show too.
  const totals = confirmedSolMarket(row) ? await cachedShareTotals(settings, repoId).catch(() => null) : null
  const { rows: [known] } = row ? { rows: [] } : await pool.query('select full_name as "fullName" from repositories where github_repo_id=$1::bigint', [repoId]).catch(() => ({ rows: [] }))
  return reply({ repoId, fullName: target?.fullName ?? row?.fullName ?? known?.fullName ?? null, shareBps: shares.shareBps, eligible: Boolean(target), reason,
    ...totals ?? { packs: null, paidMicro: null, claimedMicro: null, unclaimedMicro: null },
    holder: Boolean(session && row?.holder && row.holder === String(session.githubUserId)) })
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
