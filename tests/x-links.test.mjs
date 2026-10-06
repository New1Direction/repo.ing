import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, sign } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { X_AUTHORIZE_URL, X_ME_URL, X_PENDING_MS, X_REVOKE_URL, X_SCOPES, X_TOKEN_URL, XLinkError, checkCallback, createHandleLoader, createXLinks,
  exchangeCode, fetchXProfile, linkMessage, parseXProfile, pkcePair, publicLink, safeImageUrl, startAuthorization, unlinkMessage, validUsername,
  xConfig } from '../src/x-links.mjs'

const ENV = { X_CLIENT_ID: 'client-id', X_CLIENT_SECRET: 'client-secret' }
const CONFIG = xConfig(ENV)
const ORIGIN = 'https://repo.ing'
const wallet = () => Keypair.generate()
const signMessage = (keypair, message) => {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.subarray(0, 32))])
  return sign(null, Buffer.from(message, 'utf8'), { key: pkcs8, format: 'der', type: 'pkcs8' }).toString('base64')
}
const rejects = async (promise, pattern) => assert.rejects(promise, error => error instanceof XLinkError && pattern.test(error.message))
const throws = (fn, pattern) => assert.throws(fn, error => error instanceof XLinkError && pattern.test(error.message))
const PROFILE = { xUserId: '1234567890', username: 'repo_ing', name: 'repo.ing', profileImageUrl: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg', verified: false }
const params = values => new URLSearchParams(values)

// ---------- configuration ----------
test('disabled unless both X credentials are set; X_CALLBACK_URL overrides the callback', () => {
  assert.equal(xConfig({}), null)
  assert.equal(xConfig({ X_CLIENT_ID: 'id' }), null)
  assert.equal(xConfig({ X_CLIENT_SECRET: 'secret' }), null)
  assert.equal(xConfig({ X_CLIENT_ID: ' ', X_CLIENT_SECRET: 'secret' }), null)
  assert.equal(CONFIG.redirectUri(ORIGIN), 'https://repo.ing/api/x/callback')
  assert.equal(xConfig({ ...ENV, X_CALLBACK_URL: 'http://localhost:3001/api/x/callback' }).redirectUri(ORIGIN), 'http://localhost:3001/api/x/callback')
  assert.throws(() => xConfig({ ...ENV, NODE_ENV: 'production', X_CALLBACK_URL: 'http://repo.ing/api/x/callback' }), /HTTPS/)
  assert.throws(() => xConfig({ ...ENV, X_CALLBACK_URL: 'javascript:alert(1)' }), /HTTPS/)
  throws(() => startAuthorization({ config: null, origin: ORIGIN, wallet: wallet().publicKey.toBase58() }), /not available/)
})

test('app helpers report Connect X off and return no handles without env', async () => {
  const saved = { ...process.env }
  delete process.env.X_CLIENT_ID; delete process.env.X_CLIENT_SECRET; delete process.env.DATABASE_URL
  try {
    const { xLinksEnabled, xLinksConfig, xHandleFor, xHandlesFor, xLinksService } = await import('../app/lib/x-links.mjs')
    assert.equal(xLinksEnabled(), false)
    assert.equal(xLinksConfig(), null)
    assert.equal(xLinksService(), null)
    assert.equal(await xHandleFor(wallet().publicKey.toBase58()), null)
    assert.equal((await xHandlesFor([wallet().publicKey.toBase58()])).size, 0)
    Object.assign(process.env, ENV)
    assert.equal(xLinksEnabled(), false, 'still off without a database and sealing secret')
  } finally { for (const key of ['X_CLIENT_ID', 'X_CLIENT_SECRET']) delete process.env[key]; Object.assign(process.env, saved) }
})

// ---------- validation ----------
test('usernames and profile images are validated', () => {
  for (const ok of ['a', 'repo_ing', 'A1_b2', 'x'.repeat(15)]) assert.equal(validUsername(ok), true, ok)
  for (const bad of ['', 'x'.repeat(16), 'bad-name', 'bad.name', '@repo', 'repo ing', '<script>', 'naïve', null, 42]) assert.equal(validUsername(bad), false, String(bad))
  assert.equal(safeImageUrl('https://pbs.twimg.com/profile_images/1/a_normal.jpg'), 'https://pbs.twimg.com/profile_images/1/a_normal.jpg')
  for (const bad of ['http://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com.evil.com/a.jpg', 'https://evil.com/pbs.twimg.com/a.jpg', 'https://user@pbs.twimg.com/a.jpg',
    'https://pbs.twimg.com:8443/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AA', '', null, `https://pbs.twimg.com/${'a'.repeat(300)}`]) assert.equal(safeImageUrl(bad), null, String(bad))
  assert.equal(publicLink({ wallet: 'w', username: 'bad-name' }), null)
  assert.equal(publicLink({ wallet: 'w', username: 'ok', profileImageUrl: 'https://evil.com/a.png' }).image, null)
})

// ---------- OAuth: authorize, state/CSRF, PKCE ----------
test('PKCE uses S256 over a random 43-character verifier', () => {
  const { verifier, challenge } = pkcePair()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.notEqual(pkcePair().verifier, verifier)
})

test('authorize URL requests read-only scopes with PKCE and binds nonce, verifier and wallet in the state', () => {
  const key = wallet().publicKey.toBase58(), now = () => 1_000_000
  const { url, state } = startAuthorization({ config: CONFIG, origin: ORIGIN, wallet: key, now })
  const parsed = new URL(url)
  assert.equal(`${parsed.origin}${parsed.pathname}`, X_AUTHORIZE_URL)
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { response_type: 'code', client_id: 'client-id', redirect_uri: 'https://repo.ing/api/x/callback',
    scope: 'users.read tweet.read', state: state.state, code_challenge: createHash('sha256').update(state.verifier).digest('base64url'), code_challenge_method: 'S256' })
  assert.match(url, /&scope=users\.read%20tweet\.read&/)
  assert.equal(X_SCOPES.includes('offline.access'), false)
  assert.equal(url.includes('client-secret') || url.includes(state.verifier), false)
  assert.deepEqual([state.purpose, state.wallet, state.expiresAt], ['x-connect', key, 1_000_000 + 10 * 60_000])
  assert.ok(state.state.length >= 32)
  throws(() => startAuthorization({ config: CONFIG, origin: ORIGIN, wallet: 'not-a-wallet' }), /Invalid wallet/)
  throws(() => startAuthorization({ config: CONFIG, origin: ORIGIN, wallet: `${key} ` }), /Invalid wallet/)
})

test('callback state is checked against the sealed cookie (CSRF), expiry, cancellation and code', async () => {
  const key = wallet().publicKey.toBase58()
  const { state } = startAuthorization({ config: CONFIG, origin: ORIGIN, wallet: key })
  assert.deepEqual(checkCallback(state, params({ state: state.state, code: 'abc' })), { code: 'abc', verifier: state.verifier, wallet: key })
  throws(() => checkCallback(state, params({ state: `${state.state.slice(0, -1)}${state.state.endsWith('x') ? 'y' : 'x'}`, code: 'abc' })), /could not be verified/)
  throws(() => checkCallback(state, params({ state: 'short', code: 'abc' })), /could not be verified/)
  throws(() => checkCallback(state, params({ code: 'abc' })), /could not be verified/)
  throws(() => checkCallback(state, params({ state: state.state })), /could not be verified/)
  throws(() => checkCallback(state, params({ state: state.state, code: 'x'.repeat(1001) })), /could not be verified/)
  throws(() => checkCallback(state, params({ error: 'access_denied', state: state.state })), /cancelled/)
  throws(() => checkCallback(null, params({ state: state.state, code: 'abc' })), /expired/)
  throws(() => checkCallback({ ...state, purpose: 'x-unlink' }, params({ state: state.state, code: 'abc' })), /expired/)
  throws(() => checkCallback(state, params({ state: state.state, code: 'abc' }), () => state.expiresAt), /expired/)

  // The cookie is sealed: a tampered cookie does not unseal, so an attacker cannot choose the state or the wallet.
  const saved = process.env.GITHUB_APP_CLIENT_SECRET
  process.env.GITHUB_APP_CLIENT_SECRET = 'test-sealing-secret'
  try {
    const { seal, unseal } = await import('../app/lib/auth.mjs')
    const sealed = seal(state)
    assert.deepEqual(unseal(sealed), state)
    const [body, mac] = sealed.split('.')
    const forged = Buffer.from(JSON.stringify({ ...state, wallet: wallet().publicKey.toBase58() })).toString('base64url')
    assert.equal(unseal(`${forged}.${mac}`), null)
    // A different first character, so the tampered MAC always differs (ending it in "AA" left it unchanged about 1 run in 1,000).
    const tampered = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`
    assert.notEqual(tampered, mac)
    assert.equal(unseal(`${body}.${tampered}`), null)
  } finally { if (saved === undefined) delete process.env.GITHUB_APP_CLIENT_SECRET; else process.env.GITHUB_APP_CLIENT_SECRET = saved }
})

// ---------- token exchange + /users/me with fetch fakes ----------
function fakeX({ token = { access_token: 'tok-123', token_type: 'bearer', scope: 'users.read tweet.read' }, tokenStatus = 200, me, meStatus = 200 } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init })
    if (url === X_TOKEN_URL) return new Response(JSON.stringify(token), { status: tokenStatus })
    if (url === X_ME_URL) return new Response(JSON.stringify(me ?? { data: { id: '1234567890', username: 'repo_ing', name: 'repo.ing', verified: true,
      profile_image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' } }), { status: meStatus })
    if (url === X_REVOKE_URL) return new Response('{"revoked":true}')
    throw new Error(`unexpected ${url}`)
  }
  return { fetch, calls }
}

test('token exchange uses confidential-client basic auth, the PKCE verifier and the exact redirect URI', async () => {
  const { fetch, calls } = fakeX()
  assert.equal(await exchangeCode({ config: CONFIG, code: 'code-1', verifier: 'v'.repeat(43), redirectUri: 'https://repo.ing/api/x/callback', fetch }), 'tok-123')
  const [{ init }] = calls
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`)
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), { grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://repo.ing/api/x/callback',
    code_verifier: 'v'.repeat(43), client_id: 'client-id' })
  assert.equal(init.body.includes('client-secret'), false)
  await rejects(exchangeCode({ config: CONFIG, code: 'c', verifier: 'v', redirectUri: 'r', fetch: fakeX({ tokenStatus: 400, token: { error: 'invalid_grant' } }).fetch }), /could not be completed/)
  await rejects(exchangeCode({ config: CONFIG, code: 'c', verifier: 'v', redirectUri: 'r', fetch: fakeX({ token: {} }).fetch }), /could not be completed/)
})

test('users/me is read with the bearer token, parsed strictly, and the token is revoked and never returned', async () => {
  const { fetch, calls } = fakeX()
  const profile = await fetchXProfile({ config: CONFIG, code: 'c', verifier: 'v', redirectUri: 'r', fetch })
  assert.deepEqual(profile, { xUserId: '1234567890', username: 'repo_ing', name: 'repo.ing', profileImageUrl: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg', verified: true })
  assert.equal(JSON.stringify(profile).includes('tok-123'), false)
  assert.deepEqual(calls.map(c => c.url), [X_TOKEN_URL, X_ME_URL, X_REVOKE_URL])
  assert.equal(calls[1].init.headers.authorization, 'Bearer tok-123')
  assert.match(X_ME_URL, /user\.fields=profile_image_url,verified/)
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[2].init.body)), { token: 'tok-123', token_type_hint: 'access_token', client_id: 'client-id' })

  // A failed profile read still revokes the token.
  const failing = fakeX({ meStatus: 401 })
  await rejects(fetchXProfile({ config: CONFIG, code: 'c', verifier: 'v', redirectUri: 'r', fetch: failing.fetch }), /could not be read/)
  assert.equal(failing.calls.at(-1).url, X_REVOKE_URL)
})

test('profile parsing rejects bad ids and usernames and sanitizes names and images', () => {
  const base = { id: '42', username: 'ok_name', name: 'Name' }
  assert.deepEqual(parseXProfile({ data: base }), { xUserId: '42', username: 'ok_name', name: 'Name', profileImageUrl: null, verified: false })
  for (const data of [{ ...base, id: 'abc' }, { ...base, id: '0' }, { ...base, id: '1'.repeat(21) }, { ...base, username: 'bad-name' }, { ...base, username: 'x'.repeat(16) }]) {
    throws(() => parseXProfile({ data }), /unexpected profile/)
  }
  throws(() => parseXProfile(null), /unexpected profile/)
  const odd = parseXProfile({ data: { ...base, name: ' A\u0000‮b\n\nc ' + 'z'.repeat(80), profile_image_url: 'https://evil.example/a.png', verified: 'true' } })
  assert.equal(odd.name, `Ab c ${'z'.repeat(45)}`)
  assert.equal(odd.profileImageUrl, null)
  assert.equal(odd.verified, false)
  assert.equal(parseXProfile({ data: { ...base, name: '' } }).name, null)
})

// ---------- wallet signature binding ----------
function memoryStore() {
  const links = new Map(), pending = new Map(), nonces = new Set(), quotas = new Map()
  return { links, rows: pending,
    async takeQuota(scopes) {
      for (const [scope, limit] of scopes) { const hits = (quotas.get(scope) ?? 0) + 1; if (hits > limit) return false; quotas.set(scope, hits) }
      return true
    },
    async savePending(row) { pending.set(row.id, { ...row }) },
    async pending(id) { return pending.get(id) ?? null },
    async consumePending(id) { const row = pending.get(id) ?? null; pending.delete(id); return row },
    async link({ wallet, xUserId, username, name, profileImageUrl, verified }) {
      for (const [key, row] of links) if (row.xUserId === xUserId || key === wallet) links.delete(key)
      const row = { wallet, xUserId, username, name, profileImageUrl, verified, linkedAt: new Date() }
      links.set(wallet, row)
      return row
    },
    async unlink(wallet) { return links.delete(wallet) },
    async consumeNonce(nonce) { if (nonces.has(nonce)) return false; nonces.add(nonce); return true },
    async byWallets(wallets) { return wallets.flatMap(w => links.has(w) ? [links.get(w)] : []) },
  }
}
function setup() {
  let clock = 5_000_000
  const store = memoryStore(), service = createXLinks({ store, now: () => clock })
  return { store, service, advance: ms => { clock += ms } }
}

test('the pending link names the handle, wallet and nonce, and a valid wallet signature links it', async () => {
  const { store, service } = setup(), owner = wallet(), key = owner.publicKey.toBase58()
  const { id } = await service.stagePending({ wallet: key, profile: PROFILE })
  assert.match(id, /^[0-9a-f]{32}$/)
  const view = await service.pending(id)
  assert.equal(view.message.split('\n')[0], `Link X @repo_ing to ${key} on repo.ing — nonce ${id}`)
  assert.ok(view.message.includes('This publicly links this wallet to your X account.'))
  assert.equal(view.message, linkMessage({ username: 'repo_ing', wallet: key, xUserId: PROFILE.xUserId, nonce: id, expiresAt: 5_000_000 + X_PENDING_MS }))
  const link = await service.confirm({ id, signature: signMessage(owner, view.message) })
  assert.deepEqual({ ...link, linkedAt: undefined }, { wallet: key, username: 'repo_ing', name: 'repo.ing', image: PROFILE.profileImageUrl, verified: false, linkedAt: undefined })
  assert.equal(store.rows.size, 0)
  assert.equal((await service.byWallet(key)).username, 'repo_ing')
  assert.equal(await service.pending('../../etc'), null)
})

test('wrong wallet, altered message, expired and replayed signatures are rejected', async () => {
  const { store, service, advance } = setup(), owner = wallet(), key = owner.publicKey.toBase58()
  const { id } = await service.stagePending({ wallet: key, profile: PROFILE })
  const { message } = await service.pending(id)
  await rejects(service.confirm({ id, signature: signMessage(wallet(), message) }), /Invalid Solana wallet signature/)
  await rejects(service.confirm({ id, signature: signMessage(owner, message.replace('@repo_ing', '@someone_else')) }), /Invalid Solana wallet signature/)
  await rejects(service.confirm({ id, signature: 'AAAA' }), /Invalid Solana wallet signature/)
  assert.equal(store.rows.size, 1, 'a failed signature does not consume the pending link')
  assert.equal(store.links.size, 0)

  const signature = signMessage(owner, message)
  await service.confirm({ id, signature })
  await rejects(service.confirm({ id, signature }), /expired/)

  const late = await service.stagePending({ wallet: key, profile: PROFILE })
  const lateMessage = (await service.pending(late.id)).message
  advance(X_PENDING_MS)
  await rejects(service.confirm({ id: late.id, signature: signMessage(owner, lateMessage) }), /expired/)

  // A concurrent confirm that loses the delete race is treated as a replay.
  const race = await service.stagePending({ wallet: key, profile: PROFILE })
  const raceSignature = signMessage(owner, (await service.pending(race.id)).message)
  const consume = store.consumePending
  store.consumePending = async () => null
  await rejects(service.confirm({ id: race.id, signature: raceSignature }), /already used/)
  store.consumePending = consume
})

test('one X account ↔ one wallet: re-linking moves it, and a wallet re-linking replaces its old account', async () => {
  const { store, service } = setup(), a = wallet(), b = wallet()
  const link = async (keypair, profile) => {
    const { id } = await service.stagePending({ wallet: keypair.publicKey.toBase58(), profile })
    return service.confirm({ id, signature: signMessage(keypair, (await service.pending(id)).message) })
  }
  await link(a, PROFILE)
  await link(b, PROFILE)
  assert.equal(await service.byWallet(a.publicKey.toBase58()), null)
  assert.equal((await service.byWallet(b.publicKey.toBase58())).username, 'repo_ing')
  await link(b, { ...PROFILE, xUserId: '777', username: 'other' })
  assert.equal(store.links.size, 1)
  assert.equal((await service.byWallet(b.publicKey.toBase58())).username, 'other')
})

test('unlink needs a fresh single-use signature from the linked wallet', async () => {
  const { store, service, advance } = setup(), owner = wallet(), key = owner.publicKey.toBase58()
  const { id } = await service.stagePending({ wallet: key, profile: PROFILE })
  await service.confirm({ id, signature: signMessage(owner, (await service.pending(id)).message) })

  const { terms, message } = service.unlinkChallenge({ wallet: key })
  assert.equal(message, unlinkMessage(terms))
  assert.equal(message.split('\n')[0], `Unlink X from ${key} on repo.ing — nonce ${terms.nonce}`)
  await rejects(service.unlink({ terms, signature: signMessage(wallet(), message) }), /Invalid Solana wallet signature/)
  await rejects(service.unlink({ terms: { ...terms, wallet: wallet().publicKey.toBase58() }, signature: signMessage(owner, message) }), /Invalid Solana wallet signature/)
  assert.equal(store.links.size, 1)
  assert.deepEqual(await service.unlink({ terms, signature: signMessage(owner, message) }), { unlinked: true })
  assert.equal(store.links.size, 0)
  await rejects(service.unlink({ terms, signature: signMessage(owner, message) }), /already used/)

  const stale = service.unlinkChallenge({ wallet: key })
  advance(5 * 60_000)
  await rejects(service.unlink({ terms: stale.terms, signature: signMessage(owner, stale.message) }), /expired/)
  await rejects(service.unlink({ terms: { ...stale.terms, purpose: 'x-connect' }, signature: 'x' }), /expired/)
  throws(() => service.unlinkChallenge({ wallet: 'nope' }), /Invalid wallet/)
})

test('rate limits reject once a scope is exhausted', async () => {
  const { service } = setup()
  await service.quota('x-connect:ip', [2, 600]); await service.quota('x-connect:ip', [2, 600])
  await rejects(service.quota('x-connect:ip', [2, 600]), /Too many/)
})

// ---------- batched handle lookup ----------
test('handle lookups in the same tick are batched into one query and cached briefly', async () => {
  let clock = 0
  const calls = [], rows = new Map([['w1', { wallet: 'w1', username: 'one', profileImageUrl: 'https://pbs.twimg.com/a.jpg', verified: true }], ['w3', { wallet: 'w3', username: 'bad-name' }]])
  const loader = createHandleLoader({ ttlMs: 1000, now: () => clock, loadMany: async wallets => { calls.push(wallets); return wallets.flatMap(w => rows.has(w) ? [rows.get(w)] : []) } })
  const [one, two, three, again] = await Promise.all([loader.load('w1'), loader.load('w2'), loader.load('w3'), loader.load('w1')])
  assert.deepEqual(calls, [['w1', 'w2', 'w3']])
  assert.deepEqual([one.username, one.image, one.verified, two, three, again.username], ['one', 'https://pbs.twimg.com/a.jpg', true, null, null, 'one'])

  const many = await loader.loadMany(['w1', 'w2', 'w1', '', null])
  assert.deepEqual([...many.keys()], ['w1'])
  assert.equal(calls.length, 1, 'cached, including misses')
  clock = 1001
  await loader.loadMany(['w1', 'w4'])
  assert.deepEqual(calls[1], ['w1', 'w4'])
  loader.forget('w1')
  await loader.load('w1')
  assert.deepEqual(calls[2], ['w1'])
  assert.equal(await loader.load('x'.repeat(45)), null)

  const broken = createHandleLoader({ loadMany: async () => { throw new Error('db down') } })
  assert.deepEqual(await Promise.all([broken.load('a'), broken.load('b')]), [null, null])
})

// ---------- real PostgreSQL ----------
// Throwaway local database (all committed migrations): one-to-one moves, pending consumption, nonces, constraints.
const url = process.env.X_LINKS_TEST_DATABASE_URL
test('real PostgreSQL: X link store', { skip: !url }, async () => {
  const [{ default: pg }, { drizzle }, { migrate }, { createXLinkStore }] = await Promise.all([import('pg'), import('drizzle-orm/node-postgres'),
    import('drizzle-orm/node-postgres/migrator'), import('../src/x-links.mjs')])
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Disposable local test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    const store = createXLinkStore(pool), service = createXLinks({ store })
    const [a, b] = [wallet(), wallet()], [ka, kb] = [a.publicKey.toBase58(), b.publicKey.toBase58()]
    const xUserId = String(Date.now()), other = `${xUserId}9`
    const link = async (keypair, profile) => {
      const { id } = await service.stagePending({ wallet: keypair.publicKey.toBase58(), profile })
      return service.confirm({ id, signature: signMessage(keypair, (await service.pending(id)).message) })
    }
    const first = await link(a, { ...PROFILE, xUserId })
    assert.equal(first.wallet, ka)
    await link(b, { ...PROFILE, xUserId })
    assert.deepEqual((await store.byWallets([ka, kb])).map(r => r.wallet), [kb])
    await link(b, { ...PROFILE, xUserId: other, username: 'other_one' })
    assert.deepEqual((await store.byWallets([ka, kb])).map(r => [r.wallet, r.username]), [[kb, 'other_one']])
    const { rows: [{ n }] } = await pool.query('select count(*)::int n from x_links where x_user_id = any($1)', [[xUserId, other]])
    assert.equal(n, 1)

    const { id } = await service.stagePending({ wallet: ka, profile: { ...PROFILE, xUserId } })
    assert.equal((await store.consumePending(id)).id, id)
    assert.equal(await store.consumePending(id), null)
    await pool.query(`insert into x_link_pending(id,wallet,x_user_id,username,expires_at) values($1,$2,'1','late',now()-interval '1 second')`, ['f'.repeat(32), ka])
    assert.equal(await store.pending('f'.repeat(32)), null)
    await store.savePending({ id: 'e'.repeat(32), wallet: ka, ...PROFILE, expiresAt: new Date(Date.now() + 60_000) })
    assert.equal(await store.pending('f'.repeat(32)), null, 'expired rows are pruned')

    const nonce = 'a'.repeat(16) + Date.now().toString(16).padStart(16, '0'), later = new Date(Date.now() + 60_000)
    assert.equal(await store.consumeNonce(nonce, later), true)
    assert.equal(await store.consumeNonce(nonce, later), false)
    assert.equal(await store.unlink(kb), true)
    assert.equal(await store.unlink(kb), false)

    await assert.rejects(pool.query(`insert into x_links(wallet,x_user_id,username) values('w','1','bad-name')`))
    await assert.rejects(pool.query(`insert into x_links(wallet,x_user_id,username,profile_image_url) values('w','1','ok','https://evil.com/a.png')`))
    assert.equal(await store.takeQuota([[`x-test:${xUserId}`, 1, 60]]), true)
    assert.equal(await store.takeQuota([[`x-test:${xUserId}`, 1, 60]]), false)
  } finally { await pool.end() }
})
