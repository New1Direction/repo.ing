import { timingSafeEqual } from 'node:crypto'
import { hfMarketsEnabled } from '../../../../src/hf-verification.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { database } from '../../../lib/server.mjs'
import { clientKey } from '../../../lib/holder-notes.mjs'
import { encryptHfSession, hfRedirect, hfSessionCookie, hfStateCookie, newHfSession, readHfCookie, readHfState } from '../../../lib/hf-auth.mjs'
import { hfOAuth } from '../../../lib/hf-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Hugging Face sends the user back here. Nothing is honoured (not even an error) unless the state matches the sealed
// state cookie set by /api/hf/start; a mismatched state changes no cookie, so a forged link can neither finish nor
// abort a sign-in. The code is exchanged with that sign-in's PKCE verifier and the client secret; userinfo then names
// the user. The access token is kept only inside the encrypted session cookie, for at most an hour. A failed sign-in
// leaves any existing session as it was. No authority is decided here: every bind, pasted address and claim checks the
// model's current owner again.
const EXCHANGES_PER_HOUR = 30
const sameState = (given, expected) => typeof given === 'string' && /^[0-9a-f]{64}$/.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(expected))

export async function GET(request) {
  if (!hfMarketsEnabled()) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const origin = publicOrigin(request.url)
  const saved = readHfState(readHfCookie(request, hfStateCookie))
  if (!saved) return hfRedirect(new URL('/explore', origin))
  const params = new URL(request.url).searchParams
  const back = new URL(saved.mode === 'claim' ? `/claim/${saved.marketId}` : '/opt-out', origin)
  if (saved.mode === 'models' && saved.model) back.searchParams.set('model', saved.model)
  if (saved.mode === 'models') back.hash = 'models'
  if (!sameState(params.get('state'), saved.state)) {
    back.searchParams.set('error', 'hf-sign-in-failed')
    return hfRedirect(back)
  }
  let session = null
  try {
    if (params.get('error')) throw new Error('Hugging Face sign-in was not approved')
    const pool = database()
    if (!pool || !await takeQuota(pool, [[`hf-callback:${clientKey(request)}`, EXCHANGES_PER_HOUR, 3600]])) throw new Error('Too many sign-ins')
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
  return hfRedirect(back, { cookies: [[hfStateCookie, '', 0],
    ...session ? [[hfSessionCookie, encryptHfSession(session), (session.expiresAt - Date.now()) / 1000]] : []] })
}
