import { NextResponse } from 'next/server'
import { CREDITS_SESSION_COOKIE, CreditsWebError, createCreditsConvert, creditsWebSettings, openCreditsSession, sealCreditsSession } from '../../../../../src/credits-web.mjs'
import { assertSameOrigin, cookieOptions, githubSessionCookie, readGithubSession } from '../../../../lib/auth.mjs'
import { sessionVerifier } from '../../../../lib/github-session.mjs'
import { publicOrigin } from '../../../../lib/origin.mjs'
import { chain, database } from '../../../../lib/server.mjs'
export const runtime = 'nodejs'

// "Claim as AI credits" (src/credits-web.mjs): GET the builder's latest conversion on this repository; POST quote, prepare,
// submit or cancel. A GitHub session for this repository (or the builder dashboard's) and the same origin. 404 while dark.
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
const FIELDS = ['action', 'lamports', 'id', 'payer', 'signedTransaction']
const reply = (body, status = 200, session = null) => {
  const response = NextResponse.json(body, { status, headers })
  // The credit service's session, encrypted and HttpOnly; it never reaches the page's scripts.
  if (session) response.cookies.set(CREDITS_SESSION_COOKIE, sealCreditsSession(session),
    { ...cookieOptions, sameSite: 'strict', maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)) })
  return response
}
function access(request, repoId) {
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  if (!session || !/^[1-9]\d{0,18}$/.test(repoId) || (session.scope !== 'builders' && session.repoId !== repoId)) return null
  return session
}
function service(session, request, settings) {
  return createCreditsConvert({ pool: database(), connection: chain(), settings,
    githubVerifier: sessionVerifier(session, request.url, { dashboard: session.scope === 'builders' }) })
}
const failure = error => error instanceof CreditsWebError ? reply({ error: error.message }, error.status)
  // Never pass on RPC URLs, credentials or signed bytes from other errors.
  : reply({ error: 'The conversion could not be checked. Refresh its status before trying again.' }, 409)

export async function GET(request, { params }) {
  const settings = creditsWebSettings()
  if (!settings || !database()) return reply({ error: 'Not found' }, 404)
  const { repo } = await params
  const session = access(request, repo)
  if (!session) return reply({ error: 'Verify GitHub for this repository first.' }, 403)
  try {
    const current = openCreditsSession(request.cookies.get(CREDITS_SESSION_COOKIE)?.value, session.githubUserId)
    const result = await service(session, request, settings).status({ repoId: repo, githubUserId: session.githubUserId, login: session.githubLogin, current })
    return reply({ enabled: true, network: settings.network, conversion: result.conversion }, 200, result.session)
  } catch (error) { return failure(error) }
}

export async function POST(request, { params }) {
  const settings = creditsWebSettings()
  if (!settings || !database()) return reply({ error: 'Not found' }, 404)
  const { repo } = await params
  let session, body
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    session = access(request, repo)
    if (!session) throw Error('no session')
    if (Number(request.headers.get('content-length') ?? 0) > 8000) throw Error('too large')
    body = await request.json()
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !FIELDS.includes(key))) throw Error('fields')
  } catch { return reply({ error: 'Invalid or expired request. Refresh the page and verify GitHub again.' }, 403) }
  const id = Number(body.id), who = { githubUserId: session.githubUserId }
  if (!['quote', 'prepare', 'submit', 'cancel'].includes(body.action)) return reply({ error: 'Unknown action.' }, 400)
  if (body.action !== 'quote' && (!Number.isSafeInteger(id) || id <= 0)) return reply({ error: 'Unknown conversion.' }, 400)
  try {
    const steps = service(session, request, settings)
    if (body.action === 'quote') {
      const current = openCreditsSession(request.cookies.get(CREDITS_SESSION_COOKIE)?.value, session.githubUserId)
      const result = await steps.quote({ ...who, repoId: repo, login: session.githubLogin, lamports: body.lamports, current })
      return reply({ conversion: result.conversion }, 200, result.session)
    }
    if (body.action === 'prepare') return reply(await steps.prepare({ ...who, id, payer: body.payer }))
    if (body.action === 'submit') return reply(await steps.submit({ ...who, id, signedTransaction: body.signedTransaction }))
    return reply(await steps.cancel({ ...who, id }))
  } catch (error) { return failure(error) }
}
