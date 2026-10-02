import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as z from 'zod/v4'
import { HF_ORIGIN, HfApiError, HfDisabledError, HfNotFoundError, HfPrivateError, HfRateLimitedError, HfUpstreamError, cleanText } from './hf-api.mjs'
import { HfUrlError, isHfName, parseHfModelUrl } from './hf-url.mjs'
import { assertHfMarketId } from './market-identity.mjs'

// Who may act for a Hugging Face model market: sign-in (OIDC with PKCE S256), the authority decision, and the fresh checks
// recorded before a model's payout wallet is bound or its fees are claimed (docs/HUGGING_FACE_API_NOTES.md).
//
// Authority is decided from two fresh reads on every bind, paste and claim, never from anything stored:
//   - the signed-in user, from Hugging Face's userinfo endpoint with the session's access token (sub, orgs[]);
//   - the model's CURRENT owner, from the public API: the market's registry row (hf_models, keyed by the model repo's
//     stable _id) gives the last known path, the path must still resolve to that same _id, and the owner's _id comes from
//     /api/users/{author}/overview or /api/organizations/{author}/overview.
// A user-owned model: the owner's _id must equal the user's sub. An org-owned model: the user's orgs[] entry whose sub is
// the org's _id (read fresh, never pinned) must have roleInOrg 'admin' and no unmet security restrictions (SSO, MFA,
// IP or token policy), else it fails closed.
//
// Nothing here stores a token. The caller keeps the access token only in the sealed, HttpOnly session cookie, for at most
// HF_SESSION_SECONDS (app/lib/hf-auth.mjs). Every Hugging Face behavior is gated by HF_MARKETS_ENABLED (default off).

export const HF_OAUTH_SCOPES = Object.freeze(['openid', 'profile', 'read-memberships'])
export const HF_SESSION_SECONDS = 3600
const OBJECT_ID = /^[0-9a-f]{24}$/
const STATE = /^[0-9a-f]{64}$/
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const MAX_BODY_BYTES = 256_000

export const hfMarketsEnabled = (env = process.env) => env.HF_MARKETS_ENABLED === 'true'
export const isHfSubject = value => typeof value === 'string' && OBJECT_ID.test(value)

// code: stable, for callers and tests; status: the HTTP status a route should answer with.
export class HfAuthorityError extends Error {
  constructor(code, message, status = 403, details = {}) {
    super(message)
    this.name = 'HfAuthorityError'
    this.code = code
    this.status = status
    Object.assign(this, details)
  }
}
const fail = (code, message, status, details) => { throw new HfAuthorityError(code, message, status, details) }

// HF_OAUTH_CLIENT_ID, HF_OAUTH_CLIENT_SECRET and HF_OAUTH_REDIRECT_URI (the callback registered with the Hugging Face OAuth
// app, ending in /api/hf/callback). null unless all three are set and the redirect URI is a plain https URL (http only
// for a local origin outside production): every sign-in path then refuses cleanly.
export function hfOAuthConfig(env = process.env) {
  const clientId = env.HF_OAUTH_CLIENT_ID?.trim(), clientSecret = env.HF_OAUTH_CLIENT_SECRET?.trim(), redirectUri = env.HF_OAUTH_REDIRECT_URI?.trim()
  if (!clientId || !clientSecret || !redirectUri) return null
  let url
  try { url = new URL(redirectUri) } catch { return null }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) && env.NODE_ENV !== 'production'
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/api/hf/callback' || !/^[\x21-\x7e]{1,256}$/.test(clientId) || !/^[\x21-\x7e]{8,512}$/.test(clientSecret)) return null
  return { clientId, clientSecret, redirectUri: url.toString() }
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function readBody(response) {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) { await response.body?.cancel().catch(() => {}); return null }
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

const objectId = z.string().regex(OBJECT_ID)
const handle = z.string().refine(isHfName)
const tokenSchema = z.object({ access_token: z.string().regex(/^[\x21-\x7e]{16,2048}$/), token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().optional(), scope: z.string().max(1000).optional() })
const userSchema = z.object({ sub: objectId, preferred_username: handle, name: z.string().max(1000).nullish(), orgs: z.array(z.unknown()).max(1000).nullish() })
const orgSchema = z.object({
  sub: objectId, preferred_username: handle.nullish(), name: z.string().max(1000).nullish(),
  roleInOrg: z.string().max(32).nullish(),
  securityRestrictions: z.array(z.string().max(32)).max(20).nullish(),
  pendingSSO: z.boolean().nullish(), missingMFA: z.boolean().nullish(),
})

// userinfo → { subject, username, name, orgs: [{ subject, handle, role, restrictions, pendingSSO, missingMFA }] }. A
// malformed account is refused. A malformed org entry is dropped, so it can never grant authority (an org whose entry is
// dropped is treated as one the user does not belong to).
export function parseUserInfo(data) {
  const parsed = userSchema.safeParse(data)
  if (!parsed.success) fail('HF_SIGN_IN_FAILED', 'Hugging Face returned an account repo.ing could not read. Sign in again.', 502)
  const user = parsed.data
  const orgs = (user.orgs ?? []).flatMap(entry => {
    const org = orgSchema.safeParse(entry)
    if (!org.success) return []
    const { sub, preferred_username, roleInOrg, securityRestrictions, pendingSSO, missingMFA } = org.data
    return [{ subject: sub, handle: preferred_username ?? null, role: roleInOrg ?? null, restrictions: securityRestrictions ?? [],
      pendingSSO: pendingSSO === true, missingMFA: missingMFA === true }]
  })
  return { subject: user.sub, username: user.preferred_username, name: user.name ? cleanText(user.name, 100) : null, orgs }
}

// The authority decision, pure. user: parseUserInfo output. owner: the model's current owner { id, handle, kind } from the
// public API. → { authorized, role: 'owner' | 'admin' | null, reason }.
export function decideModelAuthority(user, owner) {
  const deny = reason => ({ authorized: false, role: null, reason })
  if (!isHfSubject(user?.subject) || !Array.isArray(user.orgs) || !isHfSubject(owner?.id) || typeof owner.handle !== 'string') return deny('invalid')
  if (owner.kind === 'user') return owner.id === user.subject ? { authorized: true, role: 'owner', reason: null } : deny('not-owner')
  if (owner.kind !== 'org' || owner.id === user.subject) return deny('invalid')
  const membership = user.orgs.find(org => org.subject === owner.id)
  if (!membership) {
    // Listed under the owner's name with a different id: never trust the name.
    const named = user.orgs.some(org => org.handle?.toLowerCase() === owner.handle.toLowerCase())
    return deny(named ? 'org-mismatch' : 'not-member')
  }
  // roleInOrg is only present for an organization the user shared with repo.ing on Hugging Face's consent screen.
  if (membership.role === null) return deny('org-not-granted')
  if (membership.role !== 'admin') return deny('not-admin')
  if (membership.restrictions.length || membership.pendingSSO || membership.missingMFA) return deny('security-restrictions')
  return { authorized: true, role: 'admin', reason: null }
}

export function authorityMessage(reason, { username = null, owner = null } = {}) {
  const org = owner?.handle ?? 'the organization'
  switch (reason) {
    case 'not-owner': return `Only the model’s owner can do this.${username ? ` You are signed in as ${username}, but ` : ' '}${owner?.handle ?? 'someone else'} owns it on Hugging Face.`
    case 'not-member': return `Only an admin of ${org}, which owns this model, can do this. If you are one, sign in again and share ${org} with repo.ing on Hugging Face’s consent screen.`
    case 'org-not-granted': return `Sign in again and share ${org} with repo.ing on Hugging Face’s consent screen: repo.ing needs to see your role in ${org}.`
    case 'not-admin': return `Only admins of ${org} can do this. Ask an admin of ${org} on Hugging Face.`
    case 'security-restrictions': return `${org} requires single sign-on, two-factor or another security check your Hugging Face session has not completed. Complete it on Hugging Face, then sign in here again.`
    case 'org-mismatch': return `Hugging Face reported a different organization ID for ${org} than its public profile. Nothing was changed; sign in again later.`
    default: return 'Hugging Face authority could not be confirmed. Sign in again.'
  }
}

// The confidential OAuth client (client secret plus PKCE). redirectUri must be exactly the one registered on Hugging Face.
export function createHfOAuth({ clientId, clientSecret, redirectUri, fetchImpl = fetch, timeoutMs = 10_000, now = Date.now } = {}) {
  if (!clientId || !clientSecret || !redirectUri) fail('HF_NOT_CONFIGURED', 'Hugging Face sign-in is not configured.', 503)

  // orgId: the owning organization's _id, so Hugging Face asks the user to share that organization (roleInOrg is only
  // reported for shared ones).
  function authorizationUrl({ orgId = null } = {}) {
    if (orgId !== null && !isHfSubject(orgId)) throw new TypeError('Invalid Hugging Face organization id')
    const state = randomBytes(32).toString('hex'), { verifier, challenge } = pkcePair()
    const url = new URL('/oauth/authorize', HF_ORIGIN)
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: HF_OAUTH_SCOPES.join(' '),
      state, code_challenge: challenge, code_challenge_method: 'S256', ...(orgId ? { orgIds: orgId } : {}) }).toString()
    return { url: url.toString(), state, codeVerifier: verifier }
  }

  async function exchangeCode({ code, state, expectedState, codeVerifier }) {
    if (typeof code !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(code) || typeof state !== 'string' || typeof expectedState !== 'string' ||
        !STATE.test(state) || !STATE.test(expectedState) || !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState)) ||
        typeof codeVerifier !== 'string' || !CODE_VERIFIER.test(codeVerifier)) {
      fail('HF_STATE_INVALID', 'This Hugging Face sign-in is invalid or expired. Start again.', 400)
    }
    let response
    try {
      response = await fetchImpl(`${HF_ORIGIN}/oauth/token`, { method: 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'repo.ing',
          Authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}` },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier }).toString() })
    } catch { fail('HF_UPSTREAM', 'Hugging Face could not be reached. Try signing in again.', 503) }
    const body = response.status === 200 ? await readBody(response) : (await response.body?.cancel().catch(() => {}), null)
    const token = tokenSchema.safeParse(body)
    if (!token.success) fail('HF_SIGN_IN_FAILED', 'Hugging Face sign-in could not be completed. Start again.', 502)
    const granted = token.data.scope?.split(/\s+/)
    if (granted && !granted.includes('openid')) fail('HF_SIGN_IN_FAILED', 'Hugging Face did not grant the sign-in scope. Start again.', 502)
    const seconds = Math.min(HF_SESSION_SECONDS, token.data.expires_in ?? HF_SESSION_SECONDS)
    return { accessToken: token.data.access_token, expiresAt: now() + seconds * 1000, scope: token.data.scope ?? null }
  }

  async function userInfo(accessToken) {
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]{16,2048}$/.test(accessToken)) fail('HF_SESSION_EXPIRED', 'Sign in with Hugging Face again.', 401)
    let response
    try {
      response = await fetchImpl(`${HF_ORIGIN}/oauth/userinfo`, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'User-Agent': 'repo.ing', Authorization: `Bearer ${accessToken}` } })
    } catch { fail('HF_UPSTREAM', 'Hugging Face could not be reached. Try again in a minute.', 503) }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      fail('HF_SESSION_EXPIRED', 'Your Hugging Face sign-in expired or was revoked. Sign in again.', 401)
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      fail('HF_UPSTREAM', 'Hugging Face could not confirm your account right now. Try again in a minute.', 503)
    }
    return parseUserInfo(await readBody(response))
  }

  return { authorizationUrl, exchangeCode, userInfo }
}

// Hugging Face API failures as authority errors. A path that no longer answers, or that now redirects too far or to
// another repository, is "moved": the market's model has to be pointed at its new URL (repoint).
function modelError(error, path) {
  if (error instanceof HfAuthorityError) return error
  if (error instanceof HfUrlError) return new HfAuthorityError('HF_MODEL_INVALID', 'That is not a Hugging Face model URL (huggingface.co/owner/name).', 400)
  if (error instanceof HfNotFoundError || (error instanceof HfUpstreamError && ['HF_TOO_MANY_REDIRECTS', 'HF_REDIRECT_REFUSED'].includes(error.code))) {
    return new HfAuthorityError('HF_MODEL_MOVED', `The model’s last known address (${path}) no longer leads to it on Hugging Face. Model moved? Paste its new URL.`, 409)
  }
  if (error instanceof HfPrivateError || error instanceof HfDisabledError) {
    return new HfAuthorityError('HF_MODEL_UNAVAILABLE', 'This model is private or disabled on Hugging Face. Claims and payout changes open again once it is public.', 409)
  }
  if (error instanceof HfRateLimitedError) return new HfAuthorityError('HF_UPSTREAM', 'Hugging Face is busy right now. Try again in a minute.', 503, { retryAt: error.retryAt })
  if (error instanceof HfApiError) return new HfAuthorityError('HF_UPSTREAM', 'Hugging Face could not be reached. Try again in a minute.', 503)
  return error
}

// pool: PostgreSQL (the registry, model_verifications). hf: src/hf-api.mjs client (anonymous public reads). oauth:
// createHfOAuth(), needed only to check a signed-in user.
export function createHfVerifier({ pool, hf, oauth = null, now = Date.now }) {
  if (!pool || !hf) throw new Error('Hugging Face verifier needs a database and a Hugging Face client')

  async function model(path) {
    try { return await hf.model({ path }) } catch (error) { throw modelError(error, path) }
  }
  async function owner(handle) {
    let found
    try { found = await hf.owner(handle) } catch (error) {
      throw error instanceof HfNotFoundError ? new HfAuthorityError('HF_UPSTREAM', 'The model’s owner could not be found on Hugging Face. Try again later.', 503) : modelError(error, handle)
    }
    if (found.handle.toLowerCase() !== handle.toLowerCase() || !isHfSubject(found.id) || !['user', 'org'].includes(found.kind)) {
      fail('HF_UPSTREAM', 'The model’s owner changed while it was being checked. Try again.', 503)
    }
    return { id: found.id, handle: found.handle, kind: found.kind }
  }

  async function registryRow(executor, marketId) {
    const { rows: [row] } = await executor.query(`select market_ref::text as "marketId", hf_id as "hfId", repo_path as path,
      owner_handle as "ownerHandle", owner_kind as "ownerKind", owner_subject as "ownerSubject" from hf_models where market_ref = $1`, [marketId.toString()])
    if (!row) fail('HF_MODEL_UNREGISTERED', 'This model market is not registered.', 404)
    return row
  }

  // The registry keeps the last confirmed path and owner; identity (market_ref, hf_id) never changes.
  async function remember(executor, marketId, found, current) {
    await executor.query(`update hf_models set repo_path = $3, owner_handle = $4, owner_kind = $5, owner_subject = $6, gated = $7,
        path_confirmed_at = now() where market_ref = $1 and hf_id = $2`,
    [marketId.toString(), found.hfId, found.path, current.handle, current.kind, current.id, found.gated !== false])
  }

  // The market's model as it is now: the registry's path must still resolve to the registry's _id (a moved model is
  // re-pointed with repoint()), and the owner is read fresh. update: record the confirmed path and owner.
  async function resolveMarketModel(marketId, { update = true } = {}) {
    const id = assertHfMarketId(marketId)
    const entry = await registryRow(pool, id)
    const found = await model(entry.path)
    if (found.hfId !== entry.hfId) {
      fail('HF_MODEL_MOVED', `The model’s last known address (${entry.path}) now leads to a different model on Hugging Face. Model moved? Paste its new URL.`, 409)
    }
    const current = await owner(found.owner.handle)
    if (update) await remember(pool, id, found, current)
    return { marketId: id, hfId: found.hfId, path: found.path, gated: found.gated, owner: current }
  }

  async function signedInUser(accessToken, expectedSubject) {
    if (!oauth) fail('HF_NOT_CONFIGURED', 'Hugging Face sign-in is not configured.', 503)
    if (!isHfSubject(expectedSubject)) fail('HF_SESSION_EXPIRED', 'Sign in with Hugging Face again.', 401)
    const user = await oauth.userInfo(accessToken)
    if (user.subject !== expectedSubject) fail('HF_SESSION_CHANGED', 'Your Hugging Face account changed. Sign in again.', 401)
    return user
  }

  // The fresh check behind every bind, pasted address and claim (verifyCurrentAuthority in app/lib/hf-session.mjs). The
  // model is read again after the decision, so a transfer while it runs fails the check. record: write model_verifications
  // (binding and pasted addresses require one from the last five minutes; a model without a market has no row to name).
  // recheck and update false (display only, never before a change): skip the second read and the registry write.
  async function verifyMarketAuthority({ marketId, accessToken, expectedSubject, record = true, recheck = true, update = true }) {
    const id = assertHfMarketId(marketId)
    const user = await signedInUser(accessToken, expectedSubject)
    const resolved = await resolveMarketModel(id, { update })
    const decision = decideModelAuthority(user, resolved.owner)
    if (!decision.authorized) {
      fail('HF_NOT_AUTHORIZED', authorityMessage(decision.reason, { username: user.username, owner: resolved.owner }), 403, { reason: decision.reason })
    }
    const after = recheck ? await model(resolved.path) : null
    if (after && (after.hfId !== resolved.hfId || after.owner.handle.toLowerCase() !== resolved.owner.handle.toLowerCase())) {
      fail('HF_UPSTREAM', 'The model changed owner while it was being checked. Try again.', 503)
    }
    let verifiedAt = new Date(now())
    if (record) {
      const { rows: [row] } = await pool.query(`insert into model_verifications(github_repo_id, hf_id, subject, username, owner_kind, owner_subject, role)
        values ($1, $2, $3, $4, $5, $6, $7) returning verified_at as "verifiedAt"`,
      [id.toString(), resolved.hfId, user.subject, user.username, resolved.owner.kind, resolved.owner.id, decision.role])
      verifiedAt = row.verifiedAt
    }
    return { source: 'huggingface', verified: true, permission: 'admin', role: decision.role, githubRepoId: id, hfId: resolved.hfId,
      path: resolved.path, subject: user.subject, username: user.username, ownerSubject: resolved.owner.id, ownerKind: resolved.owner.kind,
      ownerHandle: resolved.owner.handle, verifiedAt }
  }

  // A model named by its URL, before it has a registry row or a market (maintainer opt-outs): its public identity and owner.
  async function lookupModel(input) {
    let path
    try { path = parseHfModelUrl(input).path } catch (error) { throw modelError(error, String(input).slice(0, 200)) }
    const found = await model(path)
    const current = await owner(found.owner.handle)
    return { hfId: found.hfId, path: found.path, gated: found.gated, owner: current }
  }

  // The signed-in user's authority over a model looked up by URL: { authorized, role, reason, message, subject, username }.
  async function modelAuthority({ model: found, accessToken, expectedSubject }) {
    const user = await signedInUser(accessToken, expectedSubject)
    const decision = decideModelAuthority(user, found.owner)
    return { ...decision, message: decision.authorized ? null : authorityMessage(decision.reason, { username: user.username, owner: found.owner }),
      subject: user.subject, username: user.username }
  }

  // "Model moved?": the market's model is now at another URL. Accepted only if that URL resolves to the registered _id;
  // anything else (another model, a fork, a re-upload) is refused and nothing changes.
  async function repoint({ marketId, url }) {
    const id = assertHfMarketId(marketId)
    const entry = await registryRow(pool, id)
    let path
    try { path = parseHfModelUrl(url).path } catch (error) { throw modelError(error, '') }
    const found = await model(path)
    if (found.hfId !== entry.hfId) {
      fail('HF_REPOINT_MISMATCH', 'That URL is a different model: its Hugging Face ID does not match this market’s. Only the same model at a new address is accepted.', 409)
    }
    const current = await owner(found.owner.handle)
    await remember(pool, id, found, current)
    return { marketId: id, hfId: found.hfId, path: found.path, previousPath: entry.path, owner: current }
  }

  return { source: 'huggingface', resolveMarketModel, verifyMarketAuthority, lookupModel, modelAuthority, repoint }
}

// The market id a model has (or gets): registry rows are keyed by the model repo's stable _id, so a model is registered
// once whatever path it is reached by. Used for maintainer decisions on models without a market; launches register
// models the same way. found: lookupModel() output.
export async function registerModel(pool, found) {
  if (!isHfSubject(found?.hfId) || !isHfSubject(found.owner?.id) || !['user', 'org'].includes(found.owner.kind)) throw new TypeError('Invalid model')
  const { rows: [row] } = await pool.query(`insert into hf_models(hf_id, repo_path, owner_handle, owner_kind, owner_subject, gated)
      values ($1, $2, $3, $4, $5, $6)
    on conflict (hf_id) do update set repo_path = excluded.repo_path, owner_handle = excluded.owner_handle, owner_kind = excluded.owner_kind,
      owner_subject = excluded.owner_subject, gated = excluded.gated, path_confirmed_at = now()
    returning market_ref::text as "marketId"`, [found.hfId, found.path, found.owner.handle, found.owner.kind, found.owner.id, found.gated !== false])
  return row.marketId
}

// A model's market id without registering it: null if repo.ing has never seen the model.
export async function registeredMarketId(pool, hfId) {
  if (!isHfSubject(hfId)) return null
  const { rows: [row] } = await pool.query('select market_ref::text as "marketId" from hf_models where hf_id = $1', [hfId])
  return row?.marketId ?? null
}
