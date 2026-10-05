import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { createRequestLimiter } from '../src/request-limiter.mjs'
import { HF_MARKET_REF_MIN } from '../src/market-identity.mjs'
import { isHfMarketId } from '../src/hf-launch.mjs'
import { clientAddress, REQUEST_LIMITS, refuseOverLimit } from '../app/lib/request-limits.mjs'
import { clientKey } from '../app/lib/holder-notes.mjs'
import { cliClientId } from '../src/cli-launch-http.mjs'

test('a client may make its burst at once and its rate after that; a refusal spends nothing and says how long to wait', () => {
  let clock = 0
  const take = createRequestLimiter({ limits: { quote: { burst: 3, perMinute: 6 } }, now: () => clock })
  assert.deepEqual([take('quote', 'a'), take('quote', 'a'), take('quote', 'a')], Array(3).fill({ allowed: true }))
  // One more every ten seconds.
  assert.deepEqual(take('quote', 'a'), { allowed: false, retryAfterSeconds: 10 })
  clock = 4_000
  assert.deepEqual(take('quote', 'a'), { allowed: false, retryAfterSeconds: 6 })
  // Asking while refused did not push the next one back.
  clock = 10_000
  assert.deepEqual(take('quote', 'a'), { allowed: true })
  assert.deepEqual(take('quote', 'a'), { allowed: false, retryAfterSeconds: 10 })
  // A long pause earns the burst back, never more than it.
  clock += 3_600_000
  assert.deepEqual([1, 2, 3, 4].map(() => take('quote', 'a').allowed), [true, true, true, false])
})

test('clients are counted apart: one that floods never gets another refused', () => {
  const take = createRequestLimiter({ limits: { prepare: { burst: 5, perMinute: 5 } }, now: () => 0 })
  for (let i = 0; i < 10_000; i++) take('prepare', `flood-${i % 50}`)
  assert.equal(take('prepare', 'flood-0').allowed, false)
  assert.deepEqual([1, 2, 3, 4, 5].map(() => take('prepare', 'visitor').allowed), Array(5).fill(true))
})

test('actions are counted apart, and an action with no limit is always allowed', () => {
  const take = createRequestLimiter({ limits: { quote: { burst: 1, perMinute: 1 }, costs: { burst: 1, perMinute: 1 } }, now: () => 0 })
  assert.equal(take('quote', 'a').allowed, true)
  assert.equal(take('costs', 'a').allowed, true)
  assert.equal(take('quote', 'a').allowed, false)
  for (let i = 0; i < 50; i++) assert.equal(take('submit', 'a').allowed, true)
})

test('made-up client names cannot grow memory or get anyone refused', () => {
  let clock = 0
  const take = createRequestLimiter({ limits: { quote: { burst: 2, perMinute: 60 } }, maxClients: 3, now: () => clock })
  for (const client of ['a', 'b', 'c']) assert.equal(take('quote', client).allowed, true)
  assert.equal(take('quote', 'a').allowed, true)
  assert.equal(take('quote', 'a').allowed, false)
  // The table is full: a new name is let through uncounted, however often it asks.
  for (let i = 0; i < 100; i++) assert.equal(take('quote', `made-up-${i % 7}`).allowed, true)
  // Clients it already holds keep their own count.
  assert.equal(take('quote', 'a').allowed, false)
  // Allowances that have refilled are forgotten, and new clients are counted again.
  clock = 5_000
  assert.deepEqual([1, 2, 3].map(() => take('quote', 'made-up-0').allowed), [true, true, false])
})

test('a clock that steps back cannot wedge an allowance', () => {
  let clock = 500_000
  const take = createRequestLimiter({ limits: { quote: { burst: 1, perMinute: 6 } }, now: () => clock })
  assert.equal(take('quote', 'a').allowed, true)
  clock = 0
  assert.deepEqual(take('quote', 'a'), { allowed: false, retryAfterSeconds: 10 })
  clock = 10_000
  assert.equal(take('quote', 'a').allowed, true)
})

test('every action the routes count has an allowance, and each fits several heavy visitors behind one address', () => {
  const counted = ['trade', 'launch', 'resolve'].flatMap(route => [...readFileSync(new URL(`../app/api/${route}/route.js`, import.meta.url), 'utf8')
    .matchAll(/refuseOverLimit\(request, '([^']+)'/g)].map(match => match[1]))
  // A name without an allowance would never be limited, silently.
  assert.deepEqual([...new Set(counted)].sort(), Object.keys(REQUEST_LIMITS).sort())
  // Heaviest honest use by one visitor per minute, from the client code: the trade panel refreshes a typed quote and its
  // costs every 15 s and after each edit, and polls a signed trade every 3 s; the launch form's review lasts 20 s.
  const heavy = { 'trade:quote': 25, 'trade:costs': 25, 'trade:depth': 3, 'trade:prepare': 2, 'trade:status': 20, 'launch:quote': 7, 'launch:prepare': 3, resolve: 5 }
  assert.deepEqual(Object.keys(REQUEST_LIMITS).sort(), Object.keys(heavy).sort())
  for (const [action, { burst, perMinute }] of Object.entries(REQUEST_LIMITS)) {
    assert.ok(burst >= heavy[action] * 4, `${action}: four heavy visitors at once`)
    assert.ok(perMinute > heavy[action], `${action}: one heavy visitor is never refused`)
    assert.ok(Number.isInteger(burst) && Number.isInteger(perMinute) && perMinute >= 1)
  }
})

const request = (headers = {}) => new Request('https://repo.ing/api/trade', { method: 'POST', headers })

test('a client is the address Cloudflare connected from, else the first forwarded address, else nobody', () => {
  assert.equal(clientAddress(request({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 203.0.113.7', 'x-real-ip': '172.64.0.1' })), '203.0.113.7')
  assert.equal(clientAddress(request({ 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' })), '198.51.100.1')
  assert.equal(clientAddress(request({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9')
  assert.equal(clientAddress(request()), null)
  assert.equal(clientAddress(request({ 'cf-connecting-ip': 'x'.repeat(500) })).length, 64)
})

test('an IPv6 visitor is its /64, however it writes or rotates the rest', () => {
  const from = address => clientAddress(request({ 'cf-connecting-ip': address }))
  assert.equal(from('2001:db8:abcd:12:1::1'), '2001:db8:abcd:12::/64')
  assert.equal(from('2001:0DB8:ABCD:0012:ffff:ffff:ffff:ffff'), '2001:db8:abcd:12::/64')
  assert.equal(from('2001:db8:abcd:12::'), '2001:db8:abcd:12::/64')
  assert.equal(from('2001:db8:abcd:12::1%eth0'), '2001:db8:abcd:12::/64')
  assert.notEqual(from('2001:db8:abcd:13::1'), from('2001:db8:abcd:12::1'))
})

test('an IPv4 address written as IPv6 is that IPv4 visitor, and an address with no network part is nobody', () => {
  const from = address => clientAddress(request({ 'cf-connecting-ip': address }))
  // Without this every such visitor would share the key of the all-zero /64, and one allowance.
  for (const address of ['::ffff:203.0.113.7', '::FFFF:203.0.113.7', '::ffff:cb00:7107', '64:ff9b::203.0.113.7', '64:ff9b::cb00:7107']) assert.equal(from(address), '203.0.113.7', address)
  assert.notEqual(from('::ffff:203.0.113.8'), from('::ffff:203.0.113.7'))
  for (const address of ['::', '::1', '::203.0.113.7', '0:0:0:0:1:2:3:4']) assert.equal(from(address), null, address)
  // A request nobody can be told apart by is never limited.
  for (let i = 0; i < 500; i++) assert.equal(refuseOverLimit(request({ 'cf-connecting-ip': '::1' }), 'trade:prepare', {}, { env: {}, log: () => {} }), null)
})

test('every per-visitor quota is keyed on the address Cloudflare reports, not on a forwarded address the client sent', () => {
  const forged = suffix => request({ 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': `10.0.0.${suffix}, 198.51.100.2` })
  assert.equal(clientKey(forged(1)), clientKey(forged(2)))
  assert.notEqual(clientKey(forged(1)), clientKey(request({ 'cf-connecting-ip': '198.51.100.3', 'x-forwarded-for': '10.0.0.1, 198.51.100.3' })))
  assert.equal(cliClientId(forged(1)), '198.51.100.2')
  assert.equal(cliClientId(forged(2)), '198.51.100.2')
  // Without Cloudflare's header the forwarded address still tells requests apart, and no address is one shared name.
  assert.equal(cliClientId(request({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9')
  assert.equal(cliClientId(request()), 'unknown')
  assert.match(clientKey(request()), /^[0-9a-f]{32}$/)
  // The agent and CSP-report handlers read the same helper.
  for (const file of ['../src/agent-launch-http.mjs', '../app/lib/csp-report.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /clientAddress\(request\) \?\? 'unknown'/, file)
    assert.doesNotMatch(source, /x-forwarded-for/, file)
  }
})

// The process's limiter on a clock that stands still, so nothing refills while a test runs.
const freeze = () => { globalThis.__repoingRequestLimiter = { take: createRequestLimiter({ limits: REQUEST_LIMITS, now: () => 0 }), refused: new Map(), faultAt: -Infinity } }
// What a refusal says to an address with nothing left: the wait for one more request.
const refusedFor = (action, extra = {}) => {
  const seconds = Math.ceil(60 / REQUEST_LIMITS[action].perMinute)
  return { error: `Too many requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`, code: 'RATE_LIMITED', ...extra }
}
// Uses up one address's allowance for an action, without a route.
function drain(action, address) {
  const from = request({ 'cf-connecting-ip': address })
  for (let i = 0; i < 1000; i++) if (refuseOverLimit(from, action, {}, { env: {}, log: () => {} })) return
  throw Error(`${action} never refused ${address}`)
}

test('a refusal is HTTP 429 with Retry-After and never cached; other addresses are unaffected', async () => {
  freeze()
  const from = request({ 'cf-connecting-ip': '203.0.113.7' }), quiet = { env: {}, log: () => {} }
  for (let i = 0; i < REQUEST_LIMITS['launch:prepare'].burst; i++) assert.equal(refuseOverLimit(from, 'launch:prepare', {}, quiet), null)
  const refusal = refuseOverLimit(from, 'launch:prepare', { canRetry: true }, quiet)
  assert.equal(refusal.status, 429)
  // The wait for one more review: ten seconds at six a minute.
  assert.equal(refusal.headers.get('retry-after'), '10')
  assert.equal(refusal.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await refusal.json(), { error: 'Too many requests. Try again in 10 seconds.', code: 'RATE_LIMITED', canRetry: true })
  assert.deepEqual(refusedFor('launch:prepare', { canRetry: true }), { error: 'Too many requests. Try again in 10 seconds.', code: 'RATE_LIMITED', canRetry: true })
  assert.equal(refusedFor('trade:quote').error, 'Too many requests. Try again in 1 second.')
  assert.equal(refuseOverLimit(request({ 'cf-connecting-ip': '203.0.113.8' }), 'launch:prepare', {}, quiet), null)
  // Another action from the same address has its own allowance.
  assert.equal(refuseOverLimit(from, 'launch:quote', {}, quiet), null)
})

test('refusals are logged once a minute per action, as counts without any address', () => {
  freeze()
  let clock = 1_000_000
  const logged = [], options = { env: {}, log: line => logged.push(JSON.parse(line)), now: () => clock }
  for (const address of ['203.0.113.50', '203.0.113.51']) drain('resolve', address)
  // Count from here: using the allowances up was refused once each.
  globalThis.__repoingRequestLimiter.refused.clear()
  const refuse = address => assert.equal(refuseOverLimit(request({ 'cf-connecting-ip': address }), 'resolve', {}, options).status, 429)
  refuse('203.0.113.50')
  assert.deepEqual(logged, [{ requestLimited: { action: 'resolve', refused: 1, addresses: 1 } }])
  for (let i = 0; i < 5; i++) refuse('203.0.113.50')
  refuse('203.0.113.51')
  assert.equal(logged.length, 1, 'nothing more inside the minute')
  clock += 60_000
  refuse('203.0.113.51')
  assert.deepEqual(logged[1], { requestLimited: { action: 'resolve', refused: 7, addresses: 2 } })
  assert.doesNotMatch(JSON.stringify(logged), /203\.0\.113/)
})

test('the switch turns every limit off, and a request with no address is never limited', () => {
  freeze()
  drain('trade:prepare', '203.0.113.60')
  const from = request({ 'cf-connecting-ip': '203.0.113.60' })
  for (const value of ['true', 'TRUE', ' true ', '1', 'on', 'yes']) {
    assert.equal(refuseOverLimit(from, 'trade:prepare', {}, { env: { REQUEST_LIMITS_DISABLED: value }, log: () => {} }), null, value)
  }
  for (const value of ['false', '', '0', 'off', undefined]) {
    assert.equal(refuseOverLimit(from, 'trade:prepare', {}, { env: { REQUEST_LIMITS_DISABLED: value }, log: () => {} }).status, 429, String(value))
  }
  // Everyone would share one allowance.
  for (let i = 0; i < 500; i++) assert.equal(refuseOverLimit(request(), 'trade:prepare', {}, { env: {}, log: () => {} }), null)
})

test('a fault in the limiter never stops a request, and is logged once a minute', () => {
  const saved = globalThis.__repoingRequestLimiter
  let clock = 0
  const logged = [], options = { env: {}, log: line => logged.push(JSON.parse(line)), now: () => clock }
  globalThis.__repoingRequestLimiter = { take() { throw new TypeError('broken') }, refused: new Map() }
  try {
    const from = request({ 'cf-connecting-ip': '203.0.113.70' })
    for (let i = 0; i < 5; i++) assert.equal(refuseOverLimit(from, 'trade:quote', {}, options), null)
    assert.deepEqual(logged, [{ requestLimiterFault: 'TypeError' }])
    clock = 60_000
    refuseOverLimit(from, 'trade:quote', {}, options)
    assert.equal(logged.length, 2)
    // A request that cannot even be read for an address proceeds too.
    assert.equal(refuseOverLimit({}, 'trade:quote', {}, options), null)
  } finally { globalThis.__repoingRequestLimiter = saved }
})

// The routes, with nothing configured behind them: a limited action answers 429 before it reaches the database, the chain
// or GitHub. The tests leave REQUEST_LIMITS_DISABLED as the runner set it: unset.
const post = (handler, body, headers = {}) => handler(new Request('https://repo.ing/api/x', { method: 'POST', body: JSON.stringify(body), headers }))
function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  for (const [name, value] of Object.entries(values)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  const globals = { pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  return Promise.resolve().then(run).finally(() => {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    globalThis.__gitfunPool = globals.pool; globalThis.fetch = globals.fetch
  })
}

test('/api/trade: each read action past its allowance is refused; other addresses and a signed trade are not', () => withEnv({ DATABASE_URL: undefined, REQUEST_LIMITS_DISABLED: undefined }, async () => {
  freeze()
  const { POST } = await import('../app/api/trade/route.js')
  const trade = { direction: 'buy', githubRepoId: '1', amountBaseUnits: '1000000', wallet: Keypair.generate().publicKey.toBase58() }
  const bodies = { 'trade:depth': { action: 'depth', githubRepoId: '1' }, 'trade:quote': { action: 'quote', ...trade }, 'trade:costs': { action: 'costs', ...trade },
    'trade:prepare': { action: 'prepare', ...trade }, 'trade:status': { action: 'status', id: 'none', signature: '5'.repeat(88) } }
  let octet = 100
  for (const [action, body] of Object.entries(bodies)) {
    const from = { 'cf-connecting-ip': `203.0.113.${octet++}` }
    // Within the allowance the request goes on and fails for want of a database: nothing is configured here.
    assert.equal((await post(POST, body, from)).status, 400, action)
    drain(action, from['cf-connecting-ip'])
    const refused = await post(POST, body, from)
    assert.equal(refused.status, 429, action)
    assert.deepEqual(await refused.json(), refusedFor(action))
    assert.equal((await post(POST, body, { 'cf-connecting-ip': '198.51.100.1' })).status, 400, `${action}: another address`)
    // A signed trade is never limited, whatever else this address has used up.
    assert.equal((await post(POST, { action: 'submit', id: 'none' }, from)).status, 400)
    // A malformed request is refused for what it is, even from an address with nothing left: it is checked first.
    const malformed = action === 'trade:status' ? { ...body, signature: 'not-a-signature' } : action === 'trade:depth' ? null : { ...body, direction: 'sideways' }
    if (malformed) assert.equal((await post(POST, malformed, from)).status, 400, `${action}: malformed`)
  }
}))

const MODEL_MARKET_ID = HF_MARKET_REF_MIN.toString()
const launchEnv = () => ({ DATABASE_URL: 'postgres://test-only', DBC_CONFIG: Keypair.generate().publicKey.toBase58(),
  PLATFORM_CREATOR_SECRET_KEY: JSON.stringify([...Keypair.generate().secretKey]), REQUEST_LIMITS_DISABLED: undefined, STOCK_QUOTES_ENABLED: undefined })
const review = { action: 'prepare', repoId: '700', repositoryUrl: 'https://github.com/octo/missing', tokenImage: 'data:image/png;base64,AAAA',
  tokenName: 'Missing', tokenSymbol: 'MISS', launcherWallet: Keypair.generate().publicKey.toBase58() }

test('/api/launch: a review past the allowance is refused with a retry, before GitHub is asked', () => withEnv(launchEnv(), async () => {
  freeze()
  globalThis.__gitfunPool = { query: async () => { throw Error('database is not part of this test') } }
  let github = 0
  globalThis.fetch = async () => { github++; return Response.json({ message: 'Not Found' }, { status: 404 }) }
  const { POST, GET } = await import('../app/api/launch/route.js')
  const from = { 'cf-connecting-ip': '203.0.113.30' }
  assert.equal((await post(POST, review, from)).status, 400)
  assert.equal(github, 1, 'within the allowance GitHub is asked')
  drain('launch:prepare', from['cf-connecting-ip'])
  const refused = await post(POST, review, from)
  assert.equal(refused.status, 429)
  assert.deepEqual(await refused.json(), refusedFor('launch:prepare', { canRetry: true }))
  assert.equal(github, 1, 'a refused review asks GitHub nothing')
  // Releasing a review and reading a launch's status are never limited.
  assert.equal((await post(POST, { action: 'cancel', id: 'none' }, from)).status, 200)
  assert.notEqual((await GET(new Request('https://repo.ing/api/launch?repo=700', { headers: from }))).status, 429)
  // A model review is not counted here: it has its own lookup allowance (and model markets are off in this test).
  assert.equal(isHfMarketId(MODEL_MARKET_ID), true)
  const model = await post(POST, { ...review, repoId: MODEL_MARKET_ID }, from)
  assert.equal(model.status, 400)
  assert.notEqual((await model.json()).code, 'RATE_LIMITED')
  // The initial-buy quote has its own allowance.
  drain('launch:quote', from['cf-connecting-ip'])
  const quote = await post(POST, { action: 'quote', supplyBps: 100 }, from)
  assert.deepEqual([quote.status, await quote.json()], [429, refusedFor('launch:quote')])
  // A quote for a pair that has none is refused for what it is, before it is counted; cancel and status stay free.
  assert.equal((await post(POST, { action: 'quote', supplyBps: 100, quoteAssetId: 'not a pair' }, from)).status, 400)
  assert.equal((await post(POST, { action: 'cancel', id: 'none' }, from)).status, 200)
  assert.notEqual((await GET(new Request('https://repo.ing/api/launch?repo=700', { headers: from }))).status, 429)
}))

test('/api/launch: a stock-paired review is counted before its owner is looked up on GitHub', () => withEnv({ ...launchEnv(), STOCK_QUOTES_ENABLED: 'true' }, async () => {
  freeze()
  globalThis.__gitfunPool = { query: async () => { throw Error('database is not part of this test') } }
  let github = 0
  globalThis.fetch = async () => { github++; return Response.json({ message: 'Not Found' }, { status: 404 }) }
  const { POST } = await import('../app/api/launch/route.js')
  const paired = { ...review, quoteAssetId: 'msft-xstock' }, from = { 'cf-connecting-ip': '203.0.113.35' }
  // Within the allowance the pair's owner is read from GitHub first.
  assert.equal((await post(POST, paired, from)).status, 400)
  assert.equal(github, 1)
  drain('launch:prepare', from['cf-connecting-ip'])
  assert.equal((await post(POST, paired, from)).status, 429)
  assert.equal(github, 1, 'a refused review asks GitHub nothing, whatever pair it names')
}))

test('/api/resolve: lookups past the allowance are refused before GitHub is asked; a market already known is not counted', () => withEnv({ DATABASE_URL: 'postgres://test-only', REQUEST_LIMITS_DISABLED: undefined }, async () => {
  freeze()
  let known = false, github = 0
  globalThis.__gitfunPool = { query: async sql => {
    if (/join markets m/.test(sql) && known) return { rows: [{ repoId: '700', mint: 'KnownMint' }] }
    if (/join markets m/.test(sql)) return { rows: [] }
    throw Error('database is not part of this test')
  } }
  globalThis.fetch = async () => { github++; return Response.json({ message: 'Not Found' }, { status: 404 }) }
  const { POST } = await import('../app/api/resolve/route.js')
  const lookup = { url: 'github.com/octo/missing' }, from = { 'cf-connecting-ip': '203.0.113.40' }
  assert.notEqual((await post(POST, lookup, from)).status, 429)
  assert.equal(github, 1)
  drain('resolve', from['cf-connecting-ip'])
  const refused = await post(POST, lookup, from)
  assert.equal(refused.status, 429)
  assert.deepEqual(await refused.json(), refusedFor('resolve'))
  assert.equal(github, 1)
  known = true
  assert.deepEqual(await (await post(POST, lookup, from)).json(), { repoId: '700', mint: 'KnownMint' })
}))
