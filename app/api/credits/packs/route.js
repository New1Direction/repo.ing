import { NextResponse } from 'next/server'
import { CREDITS_SESSION_COOKIE, CreditsWebError, openCreditsSession, sealCreditsSession } from '../../../../src/credits-web.mjs'
import { PACK_ODDS, createCreditsPacks, creditsPacksSettings } from '../../../../src/credits-packs.mjs'
import { assertSameOrigin, cookieOptions, githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { chain, database } from '../../../lib/server.mjs'
export const runtime = 'nodejs'

// AI credit packs on /credits (src/credits-packs.mjs): GET the account's pack and offer (never signs in; signed out, the
// odds only); POST quote, prepare, submit, cancel or check (a click that may sign in again). A GitHub session (the /credits
// sign-in, or a repository's) and, for POST, the same origin. 404 while dark.
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
const FIELDS = ['action', 'packMicro', 'id', 'payer', 'signedTransaction']
const ACTIONS = ['quote', 'prepare', 'submit', 'cancel', 'check']
const reply = (body, status = 200, session = null) => {
  const response = NextResponse.json(body, { status, headers })
  // The credit service's session, encrypted and HttpOnly; it never reaches the page's scripts.
  if (session) response.cookies.set(CREDITS_SESSION_COOKIE, sealCreditsSession(session),
    { ...cookieOptions, sameSite: 'strict', maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)) })
  return response
}
const githubSession = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)
// A session from a repository's own sign-in can only speak for that repository.
const ownRepository = session => session.scope === 'builders' ? null : session.repoId
function service(session, request, settings) {
  return createCreditsPacks({ pool: database(), connection: chain(), settings,
    githubVerifier: sessionVerifier(session, request.url, { dashboard: session.scope === 'builders' }) })
}
// A quote that got no answer still keeps its new credit service session (error.session): a retry asks again with it.
const failure = error => error instanceof CreditsWebError ? reply({ error: error.message }, error.status, error.session ?? null)
  // Never pass on RPC URLs, credentials or signed bytes from other errors.
  : reply({ error: 'The pack could not be checked. Refresh its status before trying again.' }, 409, error?.session ?? null)

export async function GET(request) {
  const settings = creditsPacksSettings()
  if (!settings || !database()) return reply({ error: 'Not found' }, 404)
  const session = githubSession(request)
  if (!session) return reply({ enabled: true, network: settings.network, signedIn: false, odds: PACK_ODDS })
  try {
    const current = openCreditsSession(request.cookies.get(CREDITS_SESSION_COOKIE)?.value, session.githubUserId)
    const steps = service(session, request, settings)
    const [result, offer] = await Promise.all([steps.status({ githubUserId: session.githubUserId, current }), steps.offer({ current })])
    // The credit service's own odds when it answered (null if they do not add up: nothing is sold then); else policy sol-pack-v1.
    return reply({ enabled: true, network: settings.network, signedIn: true, login: session.githubLogin, odds: offer ? offer.odds : PACK_ODDS,
      offer: offer && { sales: offer.sales, roomMicro: String(offer.roomMicro), terms: offer.terms }, purchase: result.purchase, needsSignIn: result.needsSignIn })
  } catch (error) { return failure(error) }
}

export async function POST(request) {
  const settings = creditsPacksSettings()
  if (!settings || !database()) return reply({ error: 'Not found' }, 404)
  let session, body
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    session = githubSession(request)
    if (!session) throw Error('no session')
    if (Number(request.headers.get('content-length') ?? 0) > 8000) throw Error('too large')
    body = await request.json()
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !FIELDS.includes(key))) throw Error('fields')
  } catch { return reply({ error: 'Invalid or expired request. Refresh the page and sign in with GitHub again.' }, 403) }
  const id = Number(body.id), who = { githubUserId: session.githubUserId }
  if (!ACTIONS.includes(body.action)) return reply({ error: 'Unknown action.' }, 400)
  if (body.action !== 'quote' && (!Number.isSafeInteger(id) || id <= 0)) return reply({ error: 'Unknown pack.' }, 400)
  try {
    const steps = service(session, request, settings)
    const current = openCreditsSession(request.cookies.get(CREDITS_SESSION_COOKIE)?.value, session.githubUserId)
    const sign = { ...who, login: session.githubLogin, repoId: ownRepository(session), current }
    if (body.action === 'quote') {
      const result = await steps.quote({ ...sign, packMicro: body.packMicro })
      return reply({ purchase: result.purchase }, 200, result.session)
    }
    if (body.action === 'check') {
      const result = await steps.check({ ...sign, id })
      return reply({ purchase: result.purchase }, 200, result.session)
    }
    if (body.action === 'prepare') return reply(await steps.prepare({ ...who, id, payer: body.payer }))
    if (body.action === 'submit') return reply(await steps.submit({ ...who, id, signedTransaction: body.signedTransaction }))
    return reply(await steps.cancel({ ...who, id }))
  } catch (error) { return failure(error) }
}
