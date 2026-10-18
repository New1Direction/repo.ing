import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createWalletIdentityHandler, walletIdentityConfiguration } from '../app/lib/hooklab-wallet-identity.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
const wallet = Keypair.fromSeed(Buffer.alloc(32, 5)).publicKey.toBase58()
const token = Buffer.alloc(32, 7).toString('base64url'), binding = Buffer.alloc(32, 9).toString('base64url'), nonce = 'a'.repeat(64)
const config = { origin: 'https://repo.ing', databaseUrl: 'postgres://isolated.invalid/identity', audience: 'general-launcher', genesisHash: HOOK_MAINNET_GENESIS }
function setup(options = {}) {
  const calls = [], pool = { end: async () => calls.push('end') }
  const principal = { challenge: async (address, cookie) => { calls.push(['challenge', address, cookie]); return { nonce, wallet: address, message: 'review fixture', expiresAt: '2030-01-01T00:00:00.000Z' } },
    verify: async (body, cookie) => { calls.push(['verify', body, cookie]); return { sessionToken: token, expiresAt: '2030-01-01T00:00:00.000Z' } },
    resolve: async cookie => { calls.push(['resolve', cookie]); return { kind: 'wallet', wallet } }, revoke: async cookie => calls.push(['revoke', cookie]) }
  const handler = createWalletIdentityHandler({ env: { HOOK_WALLET_IDENTITY_ENABLED: 'true' }, configuration: () => config,
    database: () => { calls.push('database'); return pool }, store: () => principal, quota: async (_pool, scopes) => { calls.push(['quota', scopes]); return true }, ...options })
  return { handler, calls, principal }
}
const request = (body, { method = 'POST', headers = {}, url = 'https://repo.ing/api/hook-lab/wallet-identity' } = {}) => new Request(url,
  { method, headers: { Origin: 'https://repo.ing', 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })
const verifyBody = { action: 'verify', wallet, nonce, signature: Buffer.alloc(64).toString('base64') }
const off = body => { for (const key of ['canSign','canSubmit','canLaunch','executionAuthorized']) assert.equal(body[key], false) }

test('disabled boundary does not read body, config, cookies or database', async () => {
  const { handler, calls } = setup({ env: {}, configuration: () => assert.fail('config') })
  const result = await handler({ get body() { assert.fail('body') } })
  assert.equal(result.status, 404); off(await result.json()); assert.deepEqual(calls, [])
})

test('strict configured HTTPS origin allows explicit app DB co-location but no ambient fallback', () => {
  assert.deepEqual(walletIdentityConfiguration({ HOOK_WALLET_IDENTITY_ORIGIN: config.origin, HOOK_WALLET_IDENTITY_DATABASE_URL: config.databaseUrl }), { ...config, enabled: true })
  assert.equal(walletIdentityConfiguration({ HOOK_WALLET_IDENTITY_ORIGIN: config.origin, HOOK_WALLET_IDENTITY_DATABASE_URL: config.databaseUrl, DATABASE_URL: config.databaseUrl }).databaseUrl, config.databaseUrl)
  for (const env of [{}, { HOOK_WALLET_IDENTITY_ORIGIN: 'http://repo.ing' }, { HOOK_WALLET_IDENTITY_ORIGIN: 'https://repo.ing/path' },
    { HOOK_WALLET_IDENTITY_ORIGIN: config.origin, DATABASE_URL: config.databaseUrl }]) assert.throws(() => walletIdentityConfiguration(env))
})

test('CSRF, wrong host, content type and malformed or duplicate cookies fail before DB', async () => {
  for (const options of [{ headers: { Origin: 'https://evil.invalid' } }, { headers: { Origin: '' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { url: 'https://evil.invalid/api/hook-lab/wallet-identity' }, { headers: { 'Content-Type': 'text/plain' } },
    { headers: { Cookie: '__Host-hook-wallet-binding=bad' } }, { headers: { Cookie: `__Host-hook-wallet-binding=${binding}; __Host-hook-wallet-binding=${binding}` } }]) {
    const { handler, calls } = setup(), result = await handler(request({ action: 'challenge', wallet }, options))
    assert.ok([403,415,503].includes(result.status)); assert.deepEqual(calls, [])
  }
})

test('body bounds and strict actions reject identity, binding and authorization injection before DB', async () => {
  for (const body of [{ action: 'challenge', wallet, githubUserId: '1' }, { ...verifyBody, browserBinding: binding },
    { ...verifyBody, approved: true }, { action: 'launch' }, '{', ' '.repeat(2049)]) {
    const { handler, calls } = setup(), result = await handler(request(body))
    assert.equal(result.status, 400); assert.deepEqual(calls, [])
  }
})

test('challenge uses server binding and host-only Secure HttpOnly Strict cookie; JSON has no binding token', async () => {
  const { handler, calls } = setup(), result = await handler(request({ action: 'challenge', wallet }))
  assert.equal(result.status, 200)
  const cookie = result.headers.get('set-cookie'), body = await result.json(), challenge = calls.find(c => c[0] === 'challenge')
  assert.match(cookie, /^__Host-hook-wallet-binding=/); assert.match(cookie, /Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=300/)
  assert.doesNotMatch(cookie, /Domain=/); assert.ok(!JSON.stringify(body).includes(challenge[2])); off(body)
  assert.equal(result.headers.get('cache-control'), 'private, no-store'); assert.equal(result.headers.get('vary'), 'Cookie')
  assert.equal(calls.at(-1), 'end')
})

test('verification uses only cookie binding, rotates session and exposes no token in JSON', async () => {
  const { handler, calls } = setup(), result = await handler(request(verifyBody, { headers: { Cookie: `__Host-hook-wallet-binding=${binding}; __Host-hook-wallet-session=${binding}` } }))
  assert.equal(result.status, 200); const body = await result.json(); off(body)
  assert.ok(!JSON.stringify(body).includes(token)); assert.equal(body.wallet, wallet)
  assert.equal(calls.find(c => c[0] === 'verify')[2], binding)
  assert.deepEqual(calls.find(c => c[0] === 'revoke'), ['revoke', binding])
  assert.match(result.headers.get('set-cookie'), new RegExp(`__Host-hook-wallet-session=${token}`))
  assert.match(result.headers.get('set-cookie'), /__Host-hook-wallet-binding=;.*Max-Age=0/)
})

test('missing binding cannot verify; quotas and DB errors fail closed without secrets', async () => {
  const first = setup(), missing = await first.handler(request(verifyBody))
  assert.equal(missing.status, 401); assert.ok(!first.calls.some(c => c[0] === 'verify'))
  const second = setup({ quota: async () => false }), limited = await second.handler(request({ action: 'challenge', wallet }))
  assert.equal(limited.status, 429); assert.ok(!second.calls.some(c => c[0] === 'challenge'))
  const third = setup({ quota: async () => { throw Error(`private ${token}`) } }), failed = await third.handler(request({ action: 'challenge', wallet }))
  assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes(token)); assert.equal(third.calls.at(-1), 'end')
})

test('read and logout use only session cookie, logout is CSRF protected and clears both cookies', async () => {
  const f = setup(), absent = await f.handler(request(null, { method: 'GET' }))
  assert.equal((await absent.json()).signedIn, false); assert.deepEqual(f.calls, [])
  const read = await f.handler(request(null, { method: 'GET', headers: { Cookie: `__Host-hook-wallet-session=${token}` } }))
  assert.equal((await read.json()).principal.wallet, wallet)
  const logout = await f.handler(request({ action: 'logout' }, { headers: { Cookie: `__Host-hook-wallet-session=${token}` } }))
  assert.equal(logout.status, 200); assert.deepEqual(f.calls.find(c => c[0] === 'revoke'), ['revoke', token])
  assert.match(logout.headers.get('set-cookie'), /__Host-hook-wallet-session=;.*Max-Age=0/)
})
