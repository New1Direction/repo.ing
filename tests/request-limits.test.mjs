import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createRequestLimiter } from '../src/request-limiter.mjs'
import { clientAddress, REQUEST_LIMITS, refuseOverLimit } from '../app/lib/request-limits.mjs'

test('each client has its own allowance, everyone together has another, and both start over each window', () => {
  let clock = 0
  const take = createRequestLimiter({ limits: { quote: { perClient: 2, global: 5 } }, windowMs: 60_000, now: () => clock })
  assert.deepEqual([take('quote', 'a'), take('quote', 'a')], [{ allowed: true }, { allowed: true }])
  clock = 15_000
  assert.deepEqual(take('quote', 'a'), { allowed: false, scope: 'client', retryAfterSeconds: 45 })
  // Another client is not held back by the first, and a refused request spends nothing.
  assert.equal(take('quote', 'b').allowed, true)
  assert.equal(take('quote', 'b').allowed, true)
  assert.equal(take('quote', 'c').allowed, true)
  assert.deepEqual(take('quote', 'd'), { allowed: false, scope: 'global', retryAfterSeconds: 45 })
  clock = 60_000
  assert.equal(take('quote', 'a').allowed, true)
  assert.equal(take('quote', 'd').allowed, true)
})

test('actions are counted apart, and an action with no limit is always allowed', () => {
  const take = createRequestLimiter({ limits: { quote: { perClient: 1, global: 1 }, costs: { perClient: 1, global: 1 } }, now: () => 0 })
  assert.equal(take('quote', 'a').allowed, true)
  assert.equal(take('costs', 'a').allowed, true)
  assert.equal(take('quote', 'a').allowed, false)
  for (let i = 0; i < 50; i++) assert.equal(take('submit', 'a').allowed, true)
})

test('made-up client names cannot grow memory or buy more than one shared allowance', () => {
  const take = createRequestLimiter({ limits: { quote: { perClient: 2, global: 1000 } }, maxClients: 3, now: () => 0 })
  for (const client of ['a', 'b', 'c']) assert.equal(take('quote', client).allowed, true)
  // Past maxClients distinct clients in one window, every further name shares one allowance.
  assert.equal(take('quote', 'x1').allowed, true)
  assert.equal(take('quote', 'x2').allowed, true)
  assert.deepEqual(take('quote', 'x3'), { allowed: false, scope: 'client', retryAfterSeconds: 60 })
  // Clients seen before the table filled keep their own allowance.
  assert.equal(take('quote', 'a').allowed, true)
  assert.equal(take('quote', 'a').allowed, false)
})

const request = (headers = {}) => new Request('https://repo.ing/api/trade', { method: 'POST', headers })

test('a client is the address Cloudflare connected from, else the first forwarded address', () => {
  assert.equal(clientAddress(request({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 203.0.113.7', 'x-real-ip': '172.64.0.1' })), '203.0.113.7')
  assert.equal(clientAddress(request({ 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' })), '198.51.100.1')
  assert.equal(clientAddress(request({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9')
  assert.equal(clientAddress(request()), 'unknown')
  assert.equal(clientAddress(request({ 'cf-connecting-ip': 'x'.repeat(500) })).length, 64)
})

test('a refusal is HTTP 429 with Retry-After, never cached, and the switch turns every limit off', () => {
  delete globalThis.__repoingRequestLimiter
  const limit = REQUEST_LIMITS['launch:prepare'].perClient, from = { 'cf-connecting-ip': '203.0.113.7' }
  for (let i = 0; i < limit; i++) assert.equal(refuseOverLimit(request(from), 'launch:prepare', {}, { log: () => {} }), null)
  const logged = []
  const refusal = refuseOverLimit(request(from), 'launch:prepare', { canRetry: true }, { log: line => logged.push(JSON.parse(line)) })
  assert.equal(refusal.status, 429)
  assert.match(refusal.headers.get('retry-after'), /^([1-9]|[1-5]\d|60)$/)
  assert.equal(refusal.headers.get('cache-control'), 'no-store')
  // Logged once per action and scope per minute, without the address.
  refuseOverLimit(request(from), 'launch:prepare', {}, { log: line => logged.push(JSON.parse(line)) })
  assert.deepEqual(logged, [{ requestLimited: { action: 'launch:prepare', scope: 'client' } }])
  assert.equal(refuseOverLimit(request({ 'cf-connecting-ip': '203.0.113.8' }), 'launch:prepare'), null, 'another address is unaffected')
  assert.equal(refuseOverLimit(request(from), 'launch:prepare', {}, { env: { REQUEST_LIMITS_DISABLED: 'true' } }), null)
  return refusal.json().then(body => assert.deepEqual(body, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED', canRetry: true }))
})

test('every limit leaves room for several heavy users behind one address, and the total for many', () => {
  // Heaviest honest use by one visitor per minute, from the client code (trade panel polling and debounce, launch form).
  const heavy = { 'trade:quote': 13, 'trade:costs': 13, 'trade:depth': 3, 'trade:prepare': 2, 'trade:status': 20, 'launch:quote': 7, 'launch:prepare': 3, resolve: 5 }
  assert.deepEqual(Object.keys(REQUEST_LIMITS).sort(), Object.keys(heavy).sort())
  for (const [action, { perClient, global }] of Object.entries(REQUEST_LIMITS)) {
    assert.ok(perClient >= heavy[action] * 4, `${action}: one address must fit four heavy users`)
    assert.ok(global >= perClient * 2, `${action}: one address must not be able to use the whole total`)
  }
})

// The routes, with nothing configured behind them: a limited action answers 429 before it reaches the database or the chain.
const post = (handler, body, headers = {}) => handler(new Request('https://repo.ing/api/x', { method: 'POST', body: JSON.stringify(body), headers }))

test('/api/trade: quotes past the allowance are refused, other addresses and unlimited actions are not', async () => {
  delete globalThis.__repoingRequestLimiter
  const saved = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  try {
    const { POST } = await import('../app/api/trade/route.js')
    const quote = { action: 'quote', direction: 'buy', githubRepoId: '1', amountBaseUnits: '1000000' }, from = { 'cf-connecting-ip': '203.0.113.20' }
    for (let i = 0; i < REQUEST_LIMITS['trade:quote'].perClient; i++) assert.equal((await post(POST, quote, from)).status, 400)
    const refused = await post(POST, quote, from)
    assert.equal(refused.status, 429)
    assert.deepEqual(await refused.json(), { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED' })
    assert.equal((await post(POST, quote, { 'cf-connecting-ip': '203.0.113.21' })).status, 400)
    // A malformed request is refused for what it is and spends nothing; a signed trade is never limited.
    assert.equal((await post(POST, { ...quote, direction: 'sideways' }, from)).status, 400)
    assert.equal((await post(POST, { action: 'submit', id: 'none' }, from)).status, 400)
  } finally { if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved }
})

test('/api/launch: review requests past the allowance are refused with a retry, before GitHub is asked', async () => {
  delete globalThis.__repoingRequestLimiter
  const saved = { db: process.env.DATABASE_URL, config: process.env.DBC_CONFIG, creator: process.env.PLATFORM_CREATOR_SECRET_KEY, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  process.env.DATABASE_URL = 'postgres://test-only'
  process.env.DBC_CONFIG = Keypair.generate().publicKey.toBase58()
  process.env.PLATFORM_CREATOR_SECRET_KEY = JSON.stringify([...Keypair.generate().secretKey])
  globalThis.__gitfunPool = { query: async () => { throw Error('database is not part of this test') } }
  let github = 0
  globalThis.fetch = async () => { github++; return Response.json({ message: 'Not Found' }, { status: 404 }) }
  try {
    const { POST } = await import('../app/api/launch/route.js')
    const prepare = { action: 'prepare', repoId: '700', repositoryUrl: 'https://github.com/octo/missing', tokenImage: 'data:image/png;base64,AAAA',
      tokenName: 'Missing', tokenSymbol: 'MISS', launcherWallet: Keypair.generate().publicKey.toBase58() }
    const from = { 'cf-connecting-ip': '203.0.113.30' }, limit = REQUEST_LIMITS['launch:prepare'].perClient
    for (let i = 0; i < limit; i++) assert.equal((await post(POST, prepare, from)).status, 400)
    assert.equal(github, limit)
    const refused = await post(POST, prepare, from)
    assert.equal(refused.status, 429)
    assert.deepEqual(await refused.json(), { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED', canRetry: true })
    assert.equal(github, limit, 'a refused review asks GitHub nothing')
    // Releasing a review is never limited.
    assert.equal((await post(POST, { action: 'cancel', id: 'none' }, from)).status, 200)
  } finally {
    for (const [name, value] of [['DATABASE_URL', saved.db], ['DBC_CONFIG', saved.config], ['PLATFORM_CREATOR_SECRET_KEY', saved.creator]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
  }
})

test('/api/resolve: lookups past the allowance are refused before GitHub is asked; a market already known is not counted', async () => {
  delete globalThis.__repoingRequestLimiter
  const saved = { db: process.env.DATABASE_URL, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  process.env.DATABASE_URL = 'postgres://test-only'
  let known = false, github = 0
  globalThis.__gitfunPool = { query: async sql => {
    if (/join markets m/.test(sql) && known) return { rows: [{ repoId: '700', mint: 'KnownMint' }] }
    if (/join markets m/.test(sql)) return { rows: [] }
    throw Error('database is not part of this test')
  } }
  globalThis.fetch = async () => { github++; return Response.json({ message: 'Not Found' }, { status: 404 }) }
  try {
    const { POST } = await import('../app/api/resolve/route.js')
    const lookup = { url: 'github.com/octo/missing' }, from = { 'cf-connecting-ip': '203.0.113.40' }, limit = REQUEST_LIMITS.resolve.perClient
    for (let i = 0; i < limit; i++) assert.notEqual((await post(POST, lookup, from)).status, 429)
    assert.equal(github, limit)
    const refused = await post(POST, lookup, from)
    assert.equal(refused.status, 429)
    assert.deepEqual(await refused.json(), { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED' })
    assert.equal(github, limit)
    known = true
    assert.deepEqual(await (await post(POST, lookup, from)).json(), { repoId: '700', mint: 'KnownMint' })
  } finally {
    if (saved.db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.db
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
  }
})
