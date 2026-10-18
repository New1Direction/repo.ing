// Isolated identity HTTP boundary. Default off, no transaction or launch authority.
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { assertSameOrigin } from './auth.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { hookAddress } from '../../src/hooklab-execution-contract.mjs'
import { executionGenesis } from '../../src/hooklab-local-acceptance.mjs'
import { servedFromConfiguredOrigin } from './hooklab-origin.mjs'
const BINDING = '__Host-hook-wallet-binding', SESSION = '__Host-hook-wallet-session'
const sha = value => createHash('sha256').update(value).digest('hex')
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' }
const denied = { executionAuthorized: false, canSign: false, canSubmit: false, canLaunch: false }
const reply = (value, status = 200) => Response.json({ ...value, ...denied }, { status, headers })
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('challenge'), wallet: hookAddress }).strict(),
  z.object({ action: z.literal('verify'), wallet: hookAddress, nonce: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().max(88) }).strict(),
  z.object({ action: z.literal('logout') }).strict(),
])
function cookies(request) {
  const text = request.headers.get('cookie') ?? ''
  if (text.length > 8192) throw Error('Invalid cookie')
  const result = {}
  for (const part of text.split(';')) {
    const index = part.indexOf('='), name = part.slice(0, index).trim()
    if (![BINDING, SESSION].includes(name)) continue
    const value = part.slice(index + 1).trim()
    if (Object.hasOwn(result, name) || !/^[A-Za-z0-9_-]{43}$/.test(value)
      || Buffer.from(value, 'base64url').toString('base64url') !== value) throw Error('Invalid cookie')
    result[name] = value
  }
  return result
}
const setCookie = (response, name, value, seconds) => response.headers.append('Set-Cookie',
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`)
export function walletIdentityConfiguration(env = process.env) {
  const origin = new URL(env.HOOK_WALLET_IDENTITY_ORIGIN)
  if (origin.protocol !== 'https:' || origin.origin !== env.HOOK_WALLET_IDENTITY_ORIGIN
    || !env.HOOK_WALLET_IDENTITY_DATABASE_URL) throw Error('Explicit identity configuration required')
  return { origin: origin.origin, databaseUrl: env.HOOK_WALLET_IDENTITY_DATABASE_URL,
    audience: 'general-launcher', genesisHash: executionGenesis(env), enabled: true }
}
// Fail-closed, shared DB quota. Never respects the unrelated REQUEST_LIMITS_DISABLED flag.
export async function walletIdentityQuota(pool, scopes) {
  for (const [scope, limit] of scopes) {
    const result = await pool.query(`insert into hook_lab_wallet_request_limits(scope,hits,expires_at)
      values($1,1,clock_timestamp()+interval '10 minutes') on conflict(scope) do update
      set hits=case when hook_lab_wallet_request_limits.expires_at<=clock_timestamp() then 1 else hook_lab_wallet_request_limits.hits+1 end,
      expires_at=case when hook_lab_wallet_request_limits.expires_at<=clock_timestamp() then clock_timestamp()+interval '10 minutes' else hook_lab_wallet_request_limits.expires_at end
      where hook_lab_wallet_request_limits.expires_at<=clock_timestamp() or hook_lab_wallet_request_limits.hits<$2 returning hits`, [scope, limit])
    if (!result.rows.length) return false
  }
  return true
}
export function createWalletIdentityHandler({ env = process.env, configuration = walletIdentityConfiguration,
  database = createHookLabDatabasePool,
  store = walletPrincipalStore, quota = walletIdentityQuota } = {}) {
  return async request => {
    if (env.HOOK_WALLET_IDENTITY_ENABLED !== 'true') return reply({ status: 'disabled' }, 404)
    let pool
    try {
      const config = configuration(env)
      if (!servedFromConfiguredOrigin(request, config.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return reply({ error: 'Open the launcher on its configured origin.' }, 403)
      if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed.' }, 405)
      if (request.method === 'POST') {
        try { assertSameOrigin(request, config.origin) } catch { return reply({ error: 'Open the launcher on its configured origin.' }, 403) }
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply({ error: 'JSON required.' }, 415)
      }
      const saved = cookies(request)
      if (request.method === 'GET' && !saved[SESSION]) return reply({ signedIn: false })
      let body
      if (request.method === 'POST') {
        try { body = bodySchema.parse(JSON.parse((await readLimitedBody(request, 2048)).toString('utf8'))) }
        catch { return reply({ error: 'Invalid or oversized identity request.' }, 400) }
      }
      pool = database(config)
      const principal = store(pool, { enabled: true, origin: config.origin, audience: config.audience, genesisHash: config.genesisHash })
      const client = clientAddress(request)
      // Forwarded address is a rate-limit hint, never identity; unknown addresses share a bounded bucket.
      const scopes = [[`wallet-identity:ip:${sha(client ?? 'unknown')}`, 60]]
      if (body?.wallet) scopes.push([`wallet-identity:wallet:${body.wallet}`, 20])
      if (body?.nonce) scopes.push([`wallet-identity:nonce:${body.nonce}`, 10])
      if (!await quota(pool, scopes)) return reply({ error: 'Too many identity requests. Try again later.' }, 429)
      if (request.method === 'GET') {
        try { return reply({ signedIn: true, principal: await principal.resolve(saved[SESSION]) }) }
        catch (error) {
          if (error.status !== 401) throw error
          const response = reply({ signedIn: false }); setCookie(response, SESSION, '', 0); return response
        }
      }
      if (body.action === 'logout') {
        if (saved[SESSION]) await principal.revoke(saved[SESSION])
        const response = reply({ signedIn: false }); setCookie(response, SESSION, '', 0); setCookie(response, BINDING, '', 0); return response
      }
      if (body.action === 'challenge') {
        const binding = randomBytes(32).toString('base64url'), challenge = await principal.challenge(body.wallet, binding)
        const response = reply({ challenge }); setCookie(response, BINDING, binding, 300); return response
      }
      if (!saved[BINDING]) return reply({ error: 'Identity challenge expired. Start again.' }, 401)
      const session = await principal.verify({ nonce: body.nonce, wallet: body.wallet, signature: body.signature }, saved[BINDING])
      if (saved[SESSION]) await principal.revoke(saved[SESSION])
      const response = reply({ signedIn: true, wallet: body.wallet, expiresAt: session.expiresAt })
      setCookie(response, SESSION, session.sessionToken, 1800); setCookie(response, BINDING, '', 0)
      return response
    } catch (error) {
      // Never leak database URLs, tokens, signatures, SQL or lower-layer errors.
      return reply({ error: error.status === 401 ? 'Identity proof unavailable, expired or changed.' : 'Wallet identity is unavailable. Try again later.' }, error.status === 401 ? 401 : 503)
    } finally { if (pool) await pool.end().catch(() => {}) }
  }
}

// Server-only cookie extractor shared by owner-authenticated review boundaries.
export function walletIdentitySessionToken(request) { return cookies(request)[SESSION] ?? null }
