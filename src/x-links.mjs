import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'

// Optional "Connect X": a wallet publicly shows the X (Twitter) @handle it linked. X OAuth 2.0 (authorization code +
// PKCE, confidential client, users.read tweet.read, no offline.access) proves the X account; a signMessage from the
// wallet proves the wallet. The access token is read once for /2/users/me, revoked, and never stored.
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize'
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token'
export const X_REVOKE_URL = 'https://api.x.com/2/oauth2/revoke'
export const X_ME_URL = 'https://api.x.com/2/users/me?user.fields=profile_image_url,verified'
export const X_SCOPES = 'users.read tweet.read'
export const X_STATE_MS = 10 * 60_000
export const X_PENDING_MS = 10 * 60_000
export const X_CHALLENGE_MS = 5 * 60_000
export const X_LIMITS = { connect: [10, 600], callback: [20, 600], link: [30, 600] }
const X_TIMEOUT_MS = 8000
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export class XLinkError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// Disabled (null) unless both credentials are set. X_CALLBACK_URL overrides the callback for local development.
export function xConfig(env = process.env) {
  const clientId = env.X_CLIENT_ID?.trim(), clientSecret = env.X_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return null
  let callbackUrl = null
  if (env.X_CALLBACK_URL) {
    const url = new URL(env.X_CALLBACK_URL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        (env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error('X_CALLBACK_URL must be an HTTPS URL')
    callbackUrl = url.href
  }
  return { clientId, clientSecret, redirectUri: origin => callbackUrl ?? `${origin}/api/x/callback` }
}

export const validUsername = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value)

// Only X's own image host, over HTTPS, on the default port.
export function safeImageUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 300) return null
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.port && !url.username && !url.password ? url.href : null
  } catch { return null }
}

const cleanName = value => typeof value !== 'string' ? null
  : [...value.normalize('NFC').replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, '').trim()].slice(0, 50).join('') || null

export const base58Wallet = value => {
  try {
    const key = new PublicKey(String(value ?? '')).toBase58()
    if (key !== value) throw Error()
    return key
  } catch { throw new XLinkError('Invalid wallet address') }
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

// Returns the X authorize URL and the (to-be-sealed) state cookie binding nonce, PKCE verifier and wallet.
export function startAuthorization({ config, origin, wallet, now = Date.now }) {
  if (!config) throw new XLinkError('Connect X is not available', 404)
  const state = randomBytes(24).toString('base64url'), { verifier, challenge } = pkcePair()
  // Spaces as %20 (not '+'), matching X's documented authorize URL.
  const query = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri(origin),
    scope: X_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString().replace(/\+/g, '%20')
  return { url: `${X_AUTHORIZE_URL}?${query}`, state: { purpose: 'x-connect', state, verifier, wallet: base58Wallet(wallet), expiresAt: now() + X_STATE_MS } }
}

// CSRF: the state X echoes back must equal the one sealed in this browser's cookie.
export function checkCallback(sealed, params, now = Date.now) {
  if (sealed?.purpose !== 'x-connect' || !Number.isFinite(sealed.expiresAt) || sealed.expiresAt <= now() ||
      typeof sealed.state !== 'string' || typeof sealed.verifier !== 'string') throw new XLinkError('X sign-in expired. Try again.')
  if (params.get('error')) throw new XLinkError('X sign-in was cancelled.')
  const state = Buffer.from(params.get('state') ?? ''), expected = Buffer.from(sealed.state)
  if (state.length !== expected.length || !timingSafeEqual(state, expected)) throw new XLinkError('X sign-in could not be verified. Try again.')
  const code = params.get('code') ?? ''
  if (!code || code.length > 1000) throw new XLinkError('X sign-in could not be verified. Try again.')
  return { code, verifier: sealed.verifier, wallet: base58Wallet(sealed.wallet) }
}

const basicAuth = config => `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`
const form = body => new URLSearchParams(body).toString()

export async function exchangeCode({ config, code, verifier, redirectUri, fetch = globalThis.fetch }) {
  const response = await fetch(X_TOKEN_URL, { method: 'POST', signal: AbortSignal.timeout(X_TIMEOUT_MS),
    headers: { authorization: basicAuth(config), 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: config.clientId }) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || typeof result.access_token !== 'string' || !result.access_token) throw new XLinkError('X sign-in could not be completed. Try again.', 502)
  return result.access_token
}

export function parseXProfile(body) {
  const data = body?.data
  if (!data || !/^[1-9]\d{0,19}$/.test(String(data.id ?? '')) || !validUsername(data.username)) throw new XLinkError('X returned an unexpected profile.', 502)
  return { xUserId: String(data.id), username: data.username, name: cleanName(data.name), profileImageUrl: safeImageUrl(data.profile_image_url),
    verified: data.verified === true }
}

export async function readXProfile({ accessToken, fetch = globalThis.fetch }) {
  const response = await fetch(X_ME_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(X_TIMEOUT_MS) })
  if (!response.ok) throw new XLinkError('Your X profile could not be read. Try again.', 502)
  return parseXProfile(await response.json().catch(() => null))
}

// Code → token → /users/me → revoke. The token never leaves this function.
export async function fetchXProfile({ config, code, verifier, redirectUri, fetch = globalThis.fetch }) {
  const accessToken = await exchangeCode({ config, code, verifier, redirectUri, fetch })
  try { return await readXProfile({ accessToken, fetch }) }
  finally {
    await fetch(X_REVOKE_URL, { method: 'POST', signal: AbortSignal.timeout(X_TIMEOUT_MS),
      headers: { authorization: basicAuth(config), 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token: accessToken, token_type_hint: 'access_token', client_id: config.clientId }) }).catch(() => {})
  }
}

const iso = ms => new Date(ms).toISOString()
export const linkMessage = ({ username, wallet, xUserId, nonce, expiresAt }) => [
  `Link X @${username} to ${wallet} on repo.ing — nonce ${nonce}`,
  `X user ID: ${xUserId}`, `Expires: ${iso(expiresAt)}`,
  'This publicly links this wallet to your X account.',
  'This signature does not send a transaction.',
].join('\n')
export const unlinkMessage = ({ wallet, nonce, expiresAt }) => [
  `Unlink X from ${wallet} on repo.ing — nonce ${nonce}`,
  `Expires: ${iso(expiresAt)}`,
  'This signature does not send a transaction.',
].join('\n')

export function verifyWalletSignature(wallet, message, signatureBase64) {
  const signature = Buffer.from(String(signatureBase64 ?? ''), 'base64')
  if (signature.length !== 64) throw new XLinkError('Invalid Solana wallet signature')
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(wallet).toBuffer()]), format: 'der', type: 'spki' })
  if (!verifySignature(null, Buffer.from(message, 'utf8'), publicKey, signature)) throw new XLinkError('Invalid Solana wallet signature')
}

// Public shape, re-validated on the way out.
export const publicLink = row => !row || !validUsername(row.username) ? null : { wallet: row.wallet, username: row.username, name: row.name ?? null,
  image: safeImageUrl(row.profileImageUrl), verified: row.verified === true, ...row.linkedAt ? { linkedAt: new Date(row.linkedAt).toISOString() } : {} }

const expiresMs = row => new Date(row.expiresAt).getTime()
const pendingView = row => ({ ...publicLink(row), xUserId: row.xUserId, expiresAt: iso(expiresMs(row)),
  message: linkMessage({ username: row.username, wallet: row.wallet, xUserId: row.xUserId, nonce: row.id, expiresAt: expiresMs(row) }) })

// store: createXLinkStore(pool) or a fake.
export function createXLinks({ store, now = Date.now }) {
  const quota = async (scope, [limit, seconds]) => { if (!await store.takeQuota([[scope, limit, seconds]])) throw new XLinkError('Too many requests. Try again later.', 429) }
  return {
    quota,
    // After the X callback: hold the verified profile for ≤10 minutes until the wallet signs.
    async stagePending({ wallet, profile }) {
      const id = randomBytes(16).toString('hex'), expiresAt = new Date(now() + X_PENDING_MS)
      await store.savePending({ id, wallet: base58Wallet(wallet), ...profile, expiresAt })
      return { id, expiresAt: expiresAt.getTime() }
    },
    async pending(id) {
      if (!/^[0-9a-f]{32}$/.test(id ?? '')) return null
      const row = await store.pending(id)
      return row && expiresMs(row) > now() ? pendingView(row) : null
    },
    // The pending row is the single-use nonce: it is verified first, then deleted, and only a successful delete links.
    async confirm({ id, signature }) {
      const view = await this.pending(id)
      if (!view) throw new XLinkError('This X sign-in expired. Connect X again.', 410)
      verifyWalletSignature(view.wallet, view.message, signature)
      const row = await store.consumePending(id)
      if (!row || expiresMs(row) <= now()) throw new XLinkError('This signature was already used. Connect X again.', 409)
      return publicLink(await store.link(row))
    },
    cancel: id => /^[0-9a-f]{32}$/.test(id ?? '') ? store.consumePending(id) : null,
    unlinkChallenge({ wallet }) {
      const terms = { purpose: 'x-unlink', wallet: base58Wallet(wallet), nonce: randomBytes(16).toString('hex'), expiresAt: now() + X_CHALLENGE_MS }
      return { terms, message: unlinkMessage(terms) }
    },
    async unlink({ terms, signature }) {
      if (terms?.purpose !== 'x-unlink' || !Number.isFinite(terms.expiresAt) || terms.expiresAt <= now() || !/^[0-9a-f]{32}$/.test(terms.nonce ?? '')) {
        throw new XLinkError('Signature request expired. Try again.')
      }
      const wallet = base58Wallet(terms.wallet)
      verifyWalletSignature(wallet, unlinkMessage(terms), signature)
      if (!await store.consumeNonce(terms.nonce, new Date(terms.expiresAt))) throw new XLinkError('This signature was already used. Sign again.', 409)
      return { unlinked: await store.unlink(wallet) }
    },
    async byWallet(wallet) { return publicLink((await store.byWallets([base58Wallet(wallet)]))[0]) },
  }
}

// Coalesces every load(wallet) made in the same tick into one query, and caches results (including "no link") briefly.
export function createHandleLoader({ loadMany, ttlMs = 60_000, max = 5000, now = Date.now, defer = fn => setTimeout(fn, 0) }) {
  const cache = new Map()
  let queue = null
  function flush(batch) {
    queue = null
    const wallets = [...batch.keys()]
    loadMany(wallets).then(rows => {
      const found = new Map(rows.map(row => [row.wallet, publicLink(row)]))
      if (cache.size + wallets.length > max) cache.clear()
      for (const wallet of wallets) {
        const link = found.get(wallet) ?? null
        cache.set(wallet, { link, expiresAt: now() + ttlMs })
        for (const resolve of batch.get(wallet)) resolve(link)
      }
    }, () => { for (const waiters of batch.values()) for (const resolve of waiters) resolve(null) })
  }
  const load = wallet => {
    if (typeof wallet !== 'string' || !wallet || wallet.length > 44) return Promise.resolve(null)
    const hit = cache.get(wallet)
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.link)
    return new Promise(resolve => {
      if (!queue) { const batch = queue = new Map(); defer(() => flush(batch)) }
      queue.set(wallet, [...queue.get(wallet) ?? [], resolve])
    })
  }
  return {
    load,
    // Map of wallet → link for the wallets that have one.
    async loadMany(wallets) {
      const unique = [...new Set(wallets.filter(Boolean))].slice(0, 500)
      const links = await Promise.all(unique.map(load))
      return new Map(unique.flatMap((wallet, i) => links[i] ? [[wallet, links[i]]] : []))
    },
    forget: wallet => { cache.delete(wallet) },
  }
}

// ---------- PostgreSQL store ----------
const LINK_COLUMNS = `wallet, x_user_id as "xUserId", username, name, profile_image_url as "profileImageUrl", verified, linked_at as "linkedAt"`
const PENDING_COLUMNS = `id, wallet, x_user_id as "xUserId", username, name, profile_image_url as "profileImageUrl", verified, expires_at as "expiresAt"`
export function createXLinkStore(pool) {
  return {
    async takeQuota(scopes) {
      for (const [scope, limit, seconds] of scopes) {
        const { rows } = await pool.query(`insert into agent_request_limits(scope,hits,expires_at) values($1,1,now()+make_interval(secs=>$3))
          on conflict(scope) do update set hits=case when agent_request_limits.expires_at<=now() then 1 else agent_request_limits.hits+1 end,
          expires_at=case when agent_request_limits.expires_at<=now() then now()+make_interval(secs=>$3) else agent_request_limits.expires_at end
          where agent_request_limits.expires_at<=now() or agent_request_limits.hits<$2 returning hits`, [scope, limit, seconds])
        if (!rows.length) return false
      }
      return true
    },
    async savePending({ id, wallet, xUserId, username, name, profileImageUrl, verified, expiresAt }) {
      await pool.query('delete from x_link_pending where expires_at < now()')
      await pool.query(`insert into x_link_pending(id,wallet,x_user_id,username,name,profile_image_url,verified,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, wallet, xUserId, username, name, profileImageUrl, verified === true, expiresAt])
    },
    async pending(id) {
      const { rows } = await pool.query(`select ${PENDING_COLUMNS} from x_link_pending where id=$1 and expires_at > now()`, [id])
      return rows[0] ?? null
    },
    async consumePending(id) {
      const { rows } = await pool.query(`delete from x_link_pending where id=$1 returning ${PENDING_COLUMNS}`, [id])
      return rows[0] ?? null
    },
    // One X account ↔ one wallet: linking moves the X account off any other wallet and replaces this wallet's old link.
    async link({ wallet, xUserId, username, name, profileImageUrl, verified }) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('delete from x_links where x_user_id=$1 or wallet=$2', [xUserId, wallet])
        const { rows } = await client.query(`insert into x_links(wallet,x_user_id,username,name,profile_image_url,verified) values($1,$2,$3,$4,$5,$6)
          returning ${LINK_COLUMNS}`, [wallet, xUserId, username, name, profileImageUrl, verified === true])
        await client.query('commit')
        return rows[0]
      } catch (error) { await client.query('rollback').catch(() => {}); throw error }
      finally { client.release() }
    },
    async unlink(wallet) {
      const { rowCount } = await pool.query('delete from x_links where wallet=$1', [wallet])
      return rowCount === 1
    },
    async consumeNonce(nonce, expiresAt) {
      await pool.query('delete from x_link_nonces where expires_at < now()')
      const { rowCount } = await pool.query('insert into x_link_nonces(nonce,expires_at) values($1,$2) on conflict do nothing', [nonce, expiresAt])
      return rowCount === 1
    },
    async byWallets(wallets) {
      if (!wallets.length) return []
      const { rows } = await pool.query(`select ${LINK_COLUMNS} from x_links where wallet = any($1::varchar[])`, [wallets])
      return rows
    },
  }
}
