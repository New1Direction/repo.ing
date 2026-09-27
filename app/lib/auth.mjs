import { createHmac, timingSafeEqual, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
const secret = () => process.env.GITHUB_APP_CLIENT_SECRET
export function seal(payload) {
  if (!secret()) throw new Error('GitHub App is not configured')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', secret()).update(body).digest('base64url')
  return `${body}.${mac}`
}
export function unseal(value) {
  if (!secret() || !value) return null
  const [body, mac] = value.split('.')
  if (!body || !mac) return null
  const expected = createHmac('sha256', secret()).update(body).digest('base64url')
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try { const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return decoded.expiresAt > Date.now() ? decoded : null }
  catch { return null }
}
export const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' }

// Unlike the signed UI/state cookies, this credential cookie must be confidential.
const sessionKey = () => {
  if (!secret()) throw new Error('GitHub App is not configured')
  return createHmac('sha256', secret()).update('repo.ing github session encryption v1').digest()
}
export const GITHUB_SESSION_SECONDS = 3600
export const githubSessionCookie = process.env.NODE_ENV === 'production' ? '__Host-repoing_github' : 'repoing_github'
export function encryptGithubSession(payload) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv)
  cipher.setAAD(Buffer.from('repo.ing github session v1'))
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}
export function readGithubSession(value) {
  try {
    if (!value || value.length > 4096) return null
    const [version, iv, body, tag, extra] = value.split('.')
    if (version !== 'v1' || extra || !iv || !body || !tag) return null
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from('repo.ing github session v1'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'))
    if (!Number.isFinite(decoded.expiresAt) || decoded.expiresAt <= Date.now() || decoded.expiresAt > Date.now() + GITHUB_SESSION_SECONDS * 1000 ||
        !decoded.accessToken?.startsWith('ghu_') || !/^[0-9a-f]{48}$/.test(decoded.sessionId) ||
        !/^\d+$/.test(decoded.githubUserId) ||
        !(decoded.scope === 'builders' && decoded.repoId === null && decoded.permission === 'identity' ||
          !decoded.scope && /^\d+$/.test(decoded.repoId) && decoded.permission === 'admin')) return null
    return decoded
  } catch { return null }
}
export function newGithubSession(result) {
  return { ...(result.scope === 'builders' ? { scope: 'builders' } : {}),
    repoId: result.githubRepoId === null ? null : String(result.githubRepoId), githubUserId: String(result.githubUserId),
    githubLogin: result.githubLogin, permission: result.permission, accessToken: result.accessToken,
    sessionId: randomBytes(24).toString('hex'),
    expiresAt: Math.min(Date.now() + GITHUB_SESSION_SECONDS * 1000, result.accessTokenExpiresAt) }
}
export function readBuilderReview(value, session) {
  const review = unseal(value)
  if (!session || review?.purpose !== 'builder-claim-review' || review.sessionId !== session.sessionId ||
      review.githubUserId !== session.githubUserId || !/^[1-9]\d*$/.test(review.repoId || '') ||
      !/^[1-9]\d*$/.test(review.amount || '') || !/^\d+$/.test(review.paid || '') || !review.wallet || !review.boundAt) {
    throw new Error('Claim review expired. Refresh and review again.')
  }
  return review
}
export function assertSameOrigin(request, origin) {
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new Error('Open the claim page on repo.ing and try again')
  }
}
export function readClaimReview(value, session) {
  const review = unseal(value)
  if (!session || review?.purpose !== 'creator-claim-review' || review.sessionId !== session.sessionId ||
      review.repoId !== session.repoId || review.githubUserId !== session.githubUserId ||
      !/^\d+$/.test(review.amount || '') || !/^\d+$/.test(review.paid || '') || !review.wallet || !review.boundAt) {
    throw new Error('Your claim review expired. Refresh this page and review again.')
  }
  return review
}
