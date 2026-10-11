import { NextResponse } from 'next/server'
import { CREDITS_SESSION_COOKIE, CreditsWebError, openCreditsSession, sealCreditsSession } from '../../../../src/credits-web.mjs'
import { createCreditsKeys, creditsKeysSettings, readKeyId, readLabel, readLimit } from '../../../../src/credits-keys.mjs'
import { assertSameOrigin, cookieOptions, githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { database } from '../../../lib/server.mjs'
export const runtime = 'nodejs'

// Keys for a coding tool on /credits (src/credits-keys.mjs): GET the account's credits and keys (never signs in, and never
// carries a token); POST check (a click that may sign in again), make or revoke. A GitHub session (the /credits sign-in) and, for
// POST, the same origin. A new key's token is in the one answer to its POST and nowhere else. 404 while dark.
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
// The fields each action may send: anything else is refused.
const ACTIONS = new Map([['check', []], ['make', ['label', 'limitMicro']], ['revoke', ['keyId']]])
const reply = (body, status = 200, session = null) => {
  const response = NextResponse.json(body, { status, headers })
  // The credit service's session, encrypted and HttpOnly; it never reaches the page's scripts.
  if (session) response.cookies.set(CREDITS_SESSION_COOKIE, sealCreditsSession(session),
    { ...cookieOptions, sameSite: 'strict', maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)) })
  return response
}
const githubSession = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)
function service(session, request, settings) {
  return createCreditsKeys({ pool: database(), settings, githubVerifier: sessionVerifier(session, request.url, { dashboard: session.scope === 'builders' }) })
}
// A sign-in that was made keeps its new credit service session (error.session): a retry uses it.
const failure = error => error instanceof CreditsWebError ? reply({ error: error.message }, error.status, error.session ?? null)
  // Never pass on database or credit service details, or a token, from other errors.
  : reply({ error: 'Your AI credits could not be checked. Look at your keys below before you try again.' }, 409, error?.session ?? null)

// The visitor's own words, checked before anything else is asked (the steps check them again).
function readInput(body) {
  if (body.action === 'make') { readLimit(body.limitMicro); return { label: readLabel(body.label), limitMicro: body.limitMicro } }
  return body.action === 'revoke' ? { keyId: readKeyId(body.keyId) } : {}
}

export async function GET(request) {
  const settings = creditsKeysSettings()
  if (!settings || !database()) return reply({ error: 'Not found' }, 404)
  const session = githubSession(request)
  if (!session) return reply({ enabled: true, signedIn: false })
  try {
    const current = openCreditsSession(request.cookies.get(CREDITS_SESSION_COOKIE)?.value, session.githubUserId)
    const overview = await service(session, request, settings).overview({ current })
    return reply({ enabled: true, signedIn: true, login: session.githubLogin, baseUrl: `${settings.inferenceOrigin}/v1`, ...overview })
  } catch (error) { return failure(error) }
}

export async function POST(request) {
  const settings = creditsKeysSettings()
  if (!settings || !database()) return reply({ error: 'Not found' }, 404)
  let session, body
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    session = githubSession(request)
    if (!session) throw Error('no session')
    if (Number(request.headers.get('content-length') ?? 0) > 8000) throw Error('too large')
    body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('fields')
    if (Object.keys(body).some(key => key !== 'action' && !(ACTIONS.get(body.action) ?? []).includes(key))) throw Error('fields')
  } catch { return reply({ error: 'Invalid or expired request. Refresh the page and sign in with GitHub again.' }, 403) }
  if (!ACTIONS.has(body.action)) return reply({ error: 'Unknown action.' }, 400)
  try {
    const input = readInput(body)
    const steps = service(session, request, settings)
    const current = openCreditsSession(request.cookies.get(CREDITS_SESSION_COOKIE)?.value, session.githubUserId)
    const sign = { githubUserId: session.githubUserId, login: session.githubLogin, current }
    if (body.action === 'check') {
      const result = await steps.check(sign)
      return reply(result.overview, 200, result.session)
    }
    if (body.action === 'revoke') {
      const result = await steps.revoke({ ...sign, ...input })
      return reply({ revoked: input.keyId, overview: result.overview }, 200, result.session)
    }
    // The token goes out in this one answer. Nothing here logs or keeps it.
    const result = await steps.make({ ...sign, ...input })
    return reply({ key: result.key, token: result.token, baseUrl: `${settings.inferenceOrigin}/v1` }, 200, result.session)
  } catch (error) { return failure(error) }
}
