import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { HF_SESSION_SECONDS, isHfSubject } from '../../src/hf-verification.mjs'
import { isHfModelPath, isHfName } from '../../src/hf-url.mjs'

// Hugging Face sign-in cookies, separate from GitHub's (app/lib/auth.mjs): their own names and their own keys, derived
// from HF_OAUTH_CLIENT_SECRET, so neither sign-in can read or forge the other's cookies. Every value is AES-256-GCM
// encrypted and authenticated, with a purpose label bound in, so a cookie of one kind never opens as another.
//   state   — the OAuth state and PKCE verifier, for one sign-in (10 minutes)
//   session — the signed-in user and the access token, for at most HF_SESSION_SECONDS (1 hour), never stored elsewhere
//   review  — a claim review pinned to the session, the recipient and the paid revision (like creator-claim-review)
//   allocation review — a builder allocation review pinned to the session, the binding and the model owner it was made under
const production = () => process.env.NODE_ENV === 'production'
export const hfSessionCookie = process.env.NODE_ENV === 'production' ? '__Host-repoing_hf' : 'repoing_hf'
export const hfStateCookie = process.env.NODE_ENV === 'production' ? '__Host-repoing_hf_oauth' : 'repoing_hf_oauth'
export const hfCookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: production(), path: '/' })
export { HF_SESSION_SECONDS }
const STATE_SECONDS = 600
const REVIEW_SECONDS = 600
const MARKET_ID = /^[1-9]\d{15}$/

function key(purpose) {
  const secret = process.env.HF_OAUTH_CLIENT_SECRET?.trim()
  if (!secret) throw new Error('Hugging Face sign-in is not configured')
  return createHmac('sha256', secret).update(`repo.ing hugging face ${purpose} key v1`).digest()
}

function encrypt(purpose, payload) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv)
  cipher.setAAD(Buffer.from(`repo.ing hugging face ${purpose} v1`))
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return ['h1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

// null for anything that is not an intact, unexpired value of this purpose.
function decrypt(purpose, value, maxSeconds) {
  try {
    if (typeof value !== 'string' || !value || value.length > 4096) return null
    const [version, iv, body, tag, extra] = value.split('.')
    if (version !== 'h1' || extra !== undefined || !iv || !body || !tag) return null
    // A full 16-byte tag and the 12-byte IV only: GCM would otherwise accept a truncated tag, which is far easier to forge.
    const ivBytes = Buffer.from(iv, 'base64url'), tagBytes = Buffer.from(tag, 'base64url')
    if (ivBytes.length !== 12 || tagBytes.length !== 16) return null
    const decipher = createDecipheriv('aes-256-gcm', key(purpose), ivBytes, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(`repo.ing hugging face ${purpose} v1`))
    decipher.setAuthTag(tagBytes)
    const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'))
    if (!decoded || typeof decoded !== 'object' || !Number.isFinite(decoded.expiresAt) || decoded.expiresAt <= Date.now() ||
        decoded.expiresAt > Date.now() + maxSeconds * 1000) return null
    return decoded
  } catch { return null }
}

// mode 'claim' (one model market, marketId) or 'models' (the /opt-out model section, any model; authority is checked per
// model on every change; model: the owner/name to show again after sign-in, if one was being managed).
export function sealHfState({ state, codeVerifier, mode, marketId = null, model = null }) {
  return encrypt('oauth state', { state, codeVerifier, mode, marketId: marketId === null ? null : String(marketId), model,
    expiresAt: Date.now() + STATE_SECONDS * 1000 })
}
export function readHfState(value) {
  const decoded = decrypt('oauth state', value, STATE_SECONDS)
  if (!decoded || !/^[0-9a-f]{64}$/.test(decoded.state) || typeof decoded.codeVerifier !== 'string' ||
      !(decoded.mode === 'claim' && MARKET_ID.test(decoded.marketId ?? '') || decoded.mode === 'models' && decoded.marketId === null) ||
      !(decoded.model === null || decoded.model === undefined || isHfModelPath(decoded.model))) return null
  return { ...decoded, model: decoded.model ?? null }
}

// signedIn: createHfOAuth().exchangeCode() and userInfo() results.
export function newHfSession({ subject, username, accessToken, expiresAt, mode, marketId = null }) {
  return { subject, username, accessToken, mode, marketId: marketId === null ? null : String(marketId), sessionId: randomBytes(24).toString('hex'),
    expiresAt: Math.min(Date.now() + HF_SESSION_SECONDS * 1000, expiresAt) }
}
export const encryptHfSession = payload => encrypt('session', payload)
export function readHfSession(value) {
  const decoded = decrypt('session', value, HF_SESSION_SECONDS)
  if (!decoded || !isHfSubject(decoded.subject) || !isHfName(decoded.username) ||
      typeof decoded.accessToken !== 'string' || !/^[\x21-\x7e]{16,2048}$/.test(decoded.accessToken) || !/^[0-9a-f]{48}$/.test(decoded.sessionId) ||
      !(decoded.mode === 'claim' && MARKET_ID.test(decoded.marketId ?? '') || decoded.mode === 'models' && decoded.marketId === null)) return null
  return decoded
}
// Public fields only, for pages: the access token never reaches a client component.
export const publicHfUser = session => session ? { username: session.username, expiresAt: session.expiresAt } : null

// A redirect that sets (maxAge > 0) or clears (maxAge 0) Hugging Face cookies, as a plain Response, so the sign-in and claim
// routes run the same under Next and in node tests. Values are this module's sealed strings (base64url and dots only).
export function hfRedirect(location, { status = 307, cookies = [] } = {}) {
  const headers = new Headers({ Location: String(location), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  const { secure } = hfCookieOptions()
  for (const [name, value, maxAge] of cookies) {
    const seconds = Math.max(0, Math.floor(maxAge))
    headers.append('Set-Cookie', [`${name}=${value}`, 'Path=/', `Max-Age=${seconds}`, ...seconds ? [] : ['Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
      'HttpOnly', 'SameSite=Lax', ...secure ? ['Secure'] : []].join('; '))
  }
  return new Response(null, { status, headers })
}
export const readHfCookie = (request, name) => request.cookies?.get(name)?.value

// A claim review sealed for one session and market (app/components/hf/claim-page.jsx → /api/hf/claim). includeGraduatedFees:
// the market has graduated, so its claim also takes the DAMM position's fees (src/claim-amounts.mjs requires the flag then).
export function sealHfClaimReview(session, { repoId, wallet, boundAt, amount, paid, includeGraduatedFees = false }) {
  return encrypt('claim review', { purpose: 'model-claim-review', sessionId: session.sessionId, subject: session.subject, repoId: String(repoId),
    wallet, boundAt: new Date(boundAt).toISOString(), amount: String(amount), paid: String(paid), includeGraduatedFees: includeGraduatedFees === true,
    expiresAt: Math.min(session.expiresAt, Date.now() + REVIEW_SECONDS * 1000) })
}
export function readHfClaimReview(value, session) {
  const review = decrypt('claim review', value, REVIEW_SECONDS)
  if (!session || review?.purpose !== 'model-claim-review' || review.sessionId !== session.sessionId || review.subject !== session.subject ||
      review.repoId !== session.marketId || !/^\d+$/.test(review.amount || '') || !/^\d+$/.test(review.paid || '') || !review.wallet || !review.boundAt) {
    throw new Error('Your claim review expired. Refresh this page and review again.')
  }
  return review
}

// A builder allocation review (app/lib/allocation.mjs → /api/allocation/[repo] → src/builder-allocation.mjs), the model
// counterpart of builder-allocation-review: sealed for one session and market, it names the binding the claim must still
// find (wallet, boundAt), the model owner that binding was made under (ownerSubject) and the fixed grant.
export function sealHfAllocationReview(session, { repoId, wallet, boundAt, ownerSubject, amount }) {
  return encrypt('allocation review', { purpose: 'model-allocation-review', sessionId: session.sessionId, subject: session.subject,
    repoId: String(repoId), wallet, boundAt: new Date(boundAt).toISOString(), ownerSubject, amount: String(amount),
    expiresAt: Math.min(session.expiresAt, Date.now() + REVIEW_SECONDS * 1000) })
}
export function readHfAllocationReview(value, session) {
  const review = decrypt('allocation review', value, REVIEW_SECONDS)
  if (!session || review?.purpose !== 'model-allocation-review' || review.sessionId !== session.sessionId || review.subject !== session.subject ||
      review.repoId !== session.marketId || !isHfSubject(review.ownerSubject) || !/^\d+$/.test(review.amount || '') || !review.wallet || !review.boundAt) {
    throw new Error('Your allocation review expired. Refresh this page and review again.')
  }
  return review
}
