import { NextResponse } from 'next/server'
import { hfMarketsEnabled } from '../../../../src/hf-verification.mjs'
import { encryptHfSession, hfCookieOptions, hfSessionCookie, hfStateCookie, newHfSession, readHfState } from '../../../lib/hf-auth.mjs'
import { hfOAuth } from '../../../lib/hf-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Hugging Face sends the user back here. The state must match the sealed state cookie set by /api/hf/start; the code is
// exchanged with that sign-in's PKCE verifier and the client secret; userinfo then names the user. The access token is
// kept only inside the encrypted session cookie, for at most an hour. No authority is decided here: every bind, pasted
// address and claim checks the model's current owner again.
const expire = (response, name) => response.cookies.set(name, '', { ...hfCookieOptions(), maxAge: 0 })

export async function GET(request) {
  if (!hfMarketsEnabled()) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const origin = publicOrigin(request.url)
  const saved = readHfState(request.cookies.get(hfStateCookie)?.value)
  if (!saved) return NextResponse.redirect(new URL('/explore', origin))
  const params = request.nextUrl.searchParams
  const back = new URL(saved.mode === 'claim' ? `/claim/${saved.marketId}` : '/opt-out', origin)
  if (saved.mode === 'models' && saved.model) back.searchParams.set('model', saved.model)
  let session = null
  try {
    if (params.get('error')) throw new Error('Hugging Face sign-in was not approved')
    const oauth = hfOAuth(request.url)
    const token = await oauth.exchangeCode({ code: params.get('code'), state: params.get('state'), expectedState: saved.state, codeVerifier: saved.codeVerifier })
    const user = await oauth.userInfo(token.accessToken)
    session = newHfSession({ subject: user.subject, username: user.username, accessToken: token.accessToken, expiresAt: token.expiresAt,
      mode: saved.mode, marketId: saved.marketId })
    back.searchParams.set('hf', 'signed-in')
  } catch (error) {
    back.searchParams.set('error', params.get('error') === 'access_denied' ? 'hf-denied' : 'hf-sign-in-failed')
    if (!params.get('error')) console.warn('hf_sign_in_failed', { code: error?.code ?? error?.name ?? 'error' })
  }
  if (saved.mode === 'models') back.hash = 'models'
  const response = NextResponse.redirect(back)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  expire(response, hfStateCookie)
  if (session) response.cookies.set(hfSessionCookie, encryptHfSession(session), { ...hfCookieOptions(), maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)) })
  else expire(response, hfSessionCookie)
  return response
}
