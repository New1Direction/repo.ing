import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Script, createContext } from 'node:vm'
import { createHash, webcrypto } from 'node:crypto'

// Integrated Worker behavior with only the Cloudflare runtime substituted.
// The committed public manifest is not a credential or signing authority.
const workerUrl = new URL('../scripts/existing-market-trading-worker.mjs', import.meta.url)
const manifest = readFileSync(new URL('../config/existing-market-custody.json', import.meta.url), 'utf8')
const configs = [...new Set(JSON.parse(manifest).poolCreators.map(row => row.config))]
const inputs = { configs, custody: { sha256: '2c31354ba8009acb0da1319b068f479216b0615120328510cba50665f0ecd888' },
  proposedEnvironment: { EXISTING_MARKET_TRADING_ONLY: 'true', EXISTING_MARKET_TRADING_STAGE: 'review',
    DBC_CONFIG: '3ZESQPHgao8ZyyEU4tJSwDmrVC3nunhGnTFVGdarRDbZ', DBC_LEGACY_CONFIGS: ['Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7', ...configs].join(','),
    TRADING_CUSTODY_RECOVERY_SHA256: '2c31354ba8009acb0da1319b068f479216b0615120328510cba50665f0ecd888' } }
const mint = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const hookFlags = ['HOOK_PRODUCTION_BOOTSTRAP', 'HOOK_NATIVE_LAUNCH_ENABLED', 'HOOK_NATIVE_LAUNCHES_ENABLED', 'HOOK_INCLUSIVE_TRADING_ENABLED', 'HOOK_NATIVE_TRADING_ENABLED', 'HOOK_WALLET_FUNDING_ENABLED', 'HOOK_WALLET_IDENTITY_ENABLED', 'HOOK_SELECTED_HOOKS_ENABLED']

async function fixture(bundledManifest = manifest) {
  assert(existsSync(workerUrl), 'deployable review worker must exist')
  const storage = new Map()
  const runtime = { env: { DATABASE_URL: 'old-reader' }, starts: 1, calls: [], failDestroy: false, failStorage: false, hold: null, html: false }
  let queue = Promise.resolve()
  const ctx = { storage: {
    get: async key => storage.get(key),
    delete: async key => storage.delete(key),
    put: async (key, value) => {
      if (runtime.failStorage) throw Error('storage failed')
      storage.set(key, value)
    },
  }, blockConcurrencyWhile(fn) {
    const result = queue.then(fn)
    queue = result.catch(() => {})
    return result
  } }
  class Container {
    constructor(ctx) { this.ctx = ctx }
    async destroy() {
      if (runtime.failDestroy) throw Error('restart failed')
      runtime.env = null; runtime.stale = false; runtime.destroys = (runtime.destroys ?? 0) + 1
    }
    async fetch(request) {
      if (runtime.hold && (!runtime.holdPath || new URL(request.url).pathname === runtime.holdPath)) await runtime.hold
      if (runtime.stale) return new Response('Error proxying request to container: The container is not running, consider calling start()', { status: 500 })
      if (!runtime.env) { runtime.env = { ...this.envVars }; runtime.starts++ }
      runtime.calls.push({ request, env: { ...runtime.env }, body: request.body ? await request.text() : null })
      return runtime.html
        ? new Response('<body>App</body>', { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'unsafe=session' } })
        : Response.json(runtime.env, { headers: { 'Set-Cookie': 'unsafe=session' } })
    }
  }
  class HTMLRewriter {
    on(selector, handler) { this.handler = handler; return this }
    transform(response) {
      let notice = ''
      this.handler.element({ getAttribute: () => '', setAttribute() {}, append: text => { notice = text } })
      return new Response(notice, response)
    }
  }
  const context = createContext({ Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, HTMLRewriter, Container, custodyManifest: bundledManifest })
  const source = readFileSync(workerUrl, 'utf8')
  const module = new Script(source.replace("import { Container } from '@cloudflare/containers'", '')
    .replace("import custodyManifest from '../config/existing-market-custody.json'", '')
    .replace('export class PublicSite', 'class PublicSite').replace('export default {', 'const worker = {')
    + '\n;({ PublicSite, worker })').runInContext(context)
  const env = {
    ...inputs.proposedEnvironment,
    PUBLIC_DATABASE_URL: 'public-reader', TRADING_DATABASE_URL: 'trade-only',
    TRADING_CUSTODY_RECOVERY_JSON: manifest,
    DATABASE_URL: 'ignored-owner', PRIVATE_KEY: 'ignored-key',
    ...Object.fromEntries(hookFlags.map(key => [key, 'true'])),
  }
  const instance = new module.PublicSite(ctx, { PUBLIC_DATABASE_URL: 'stale-constructor' })
  env.PUBLIC_SITE = { getByName(name) { assert.equal(name, 'public-readonly'); return instance } }
  const fetch = request => module.worker.fetch(request, env)
  const request = (path = '/stats', options = {}) => fetch(new Request('https://repo.ing' + path, options))
  const trade = (action = 'quote', headers = {}) => request('/api/trade', {
    method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action }),
  })
  return { env, runtime, storage, request, trade, fetch, instance }
}

test('only the five explicit review actions and two balance routes reach the container', async () => {
  const f = await fixture()
  for (const action of ['depth', 'quote', 'costs', 'prepare', 'status']) {
    assert.equal((await f.trade(action)).status, 200)
    assert.deepEqual(JSON.parse(f.runtime.calls.at(-1).body), { action })
  }
  for (const path of ['/api/wallet/balance?wallet=test', `/api/market/${mint}/balance?wallet=test`]) {
    for (const method of ['GET', 'HEAD']) assert.equal((await f.request(path, { method })).status, 200)
  }
  for (const action of ['submit', 'claim', 'replay', '', null]) assert.equal((await f.trade(action)).status, 403)
  assert.equal(f.runtime.calls.length, 9)
})

test('policy fallback serves public discovery and wallet reads but rejects private/mutation routes', async () => {
  const f = await fixture()
  const allowed = ['/', '/launch', '/explore', '/find-repos', '/discoverers', '/referrals', '/agents', '/wallet', '/api/repo-search', '/api/wallet/overview', '/builders', '/stats', '/how-it-works', '/about', '/programmable-coins', '/hooks', `/token/${mint}`, ...['trades', 'metrics', 'curve', 'traders', 'activity', 'pulse', 'events'].map(s => `/api/market/${mint}/${s}`), `/api/token-image/${mint}`, '/api/repo-logo/123', '/api/growth', '/favicon.ico', '/brand-cat.webp', '/gitcat.png', '/launch-on-repoing.svg', '/opengraph-image.png', ...['art', 'badges', 'launch-icons', 'hook-icons', 'credits'].map(s => `/${s}/test-image.webp`), '/video/repoing-flywheel-poster.jpg', '/video/repoing-flywheel.mp4', '/_next/static/chunks/test.js']
  for (const path of allowed) for (const method of ['GET', 'HEAD']) assert.equal((await f.request(path, { method })).status, 200, `${method} ${path}`)
  const before = f.runtime.calls.length
  for (const path of ['/api/trade', '/api/trade/', '/api/auth/session', '/api/launch', '/api/hook-lab/native-launch', '/api/hook-lab/inclusive-trade', '/api/builders/claim', '/api/bundles', '/api/replay', '/api/actions/trade', '/api/mcp/', '/builders?owner=x', '/admin/restart', '/api/market/not-a-mint/balance', `/api/market/${mint}/balance/`, '/stats/', '/art/image.svg']) {
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'DELETE']) assert.equal((await f.request(path, { method })).status, 403, `${method} ${path}`)
  }
  assert.equal(f.runtime.calls.length, before)
  assert.equal((await f.request('/stats', { headers: { upgrade: 'websocket' } })).status, 403)
})

test('health is a public read, never a mutation route', async () => {
  const f = await fixture()
  for (const method of ['GET', 'HEAD']) assert.equal((await f.request('/api/health', { method })).status, 200)
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await f.request('/api/health', { method })).status, 403)
})

test('finalized launch metadata is readable without opening launch execution or forwarding credentials', async () => {
  const f = await fixture()
  f.env.EXISTING_MARKET_TRADING_STAGE = 'live'
  for (const path of ['/m/1278009399', `/api/token-metadata/${mint}`]) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await f.request(path, { method, headers: { cookie: 'private', authorization: 'Bearer private' } })).status, 200)
      const request = f.runtime.calls.at(-1).request
      assert.equal(request.headers.has('cookie'), false)
      assert.equal(request.headers.has('authorization'), false)
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await f.request(path, { method })).status, 403)
  }
  for (const path of ['/m/0123', '/m/123/', '/m/not-an-id', '/api/token-metadata/nope', '/api/launch']) {
    assert.equal((await f.request(path)).status, 403)
  }
  assert.equal((await f.request('/api/launch', { method: 'POST' })).status, 403)
  assert.equal((await f.trade('quote')).status, 200)
  f.env.DBC_LEGACY_CONFIGS += `,${mint}`
  assert.equal((await f.request('/m/1278009399')).status, 503)
})

test('both MCP paths reach only the read-only handler with bounded bodies and no credentials', async () => {
  const f = await fixture()
  for (const path of ['/api/mcp', '/api/mcp/readonly']) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const headers = { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18', cookie: 'private', authorization: 'Bearer private', 'cf-connecting-ip': '192.0.2.17', 'x-forwarded-for': 'spoofed' }
    assert.equal((await f.request(path, { method: 'POST', headers, body })).status, 200)
    const upstream = f.runtime.calls.at(-1).request
    assert.equal(new URL(upstream.url).pathname, '/api/mcp/readonly')
    assert.equal(upstream.headers.get('mcp-protocol-version'), '2025-06-18')
    assert.equal(upstream.headers.get('x-forwarded-for'), '192.0.2.17')
    assert.equal(upstream.headers.has('authorization'), false)
    assert.equal(upstream.headers.has('cookie'), false)
    assert.equal((await f.request(path, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body })).status, 403)
    assert.equal((await f.request(path, { method: 'POST', headers, body: body.padEnd(16384, ' ') })).status, 200)
    assert.equal((await f.request(path, { method: 'POST', headers, body: body.padEnd(16385, ' ') })).status, 403)
    for (const method of ['PUT', 'DELETE', 'OPTIONS']) assert.equal((await f.request(path, { method, headers, body })).status, 403)
  }
})

test('public repository search accepts bounded same-origin queries without forwarding credentials or enabling writes', async () => {
  const f = await fixture()
  const headers = { origin: 'https://repo.ing', 'content-type': 'application/json', cookie: 'private', authorization: 'Bearer private' }
  const request = { method: 'POST', headers, body: JSON.stringify({ query: 'solana' }) }
  assert.equal((await f.request('/api/repo-search', request)).status, 200)
  const upstream = f.runtime.calls.at(-1)
  assert.deepEqual(JSON.parse(upstream.body), { query: 'solana' })
  assert.equal(upstream.request.headers.has('authorization'), false)
  assert.equal(upstream.request.headers.has('cookie'), false)
  for (const path of ['/api/resolve', '/api/wallet/overview', '/find-repos', '/api/claim', '/api/launch']) {
    assert.equal((await f.request(path, request)).status, 403)
  }
  for (const overrides of [{ origin: 'https://elsewhere.example' }, { 'content-type': 'text/plain' }]) {
    assert.equal((await f.request('/api/repo-search', { ...request, headers: { ...headers, ...overrides } })).status, 403)
  }
  const body = JSON.stringify({ query: 'solana' }).padEnd(2048, ' ')
  assert.equal((await f.request('/api/repo-search', { ...request, body })).status, 200)
  assert.equal((await f.request('/api/repo-search', { ...request, body: body + ' ' })).status, 403)
  assert.equal((await f.trade('submit')).status, 403)
  Object.assign(f.env, { EXISTING_MARKET_TRADING_STAGE: 'test', EXISTING_MARKET_TEST_PLAN: 'existing-markets-six-swaps-v1', EXISTING_MARKET_TEST_SUBMISSION: 'false', EXISTING_MARKET_TEST_ACCESS_TOKEN: 'a'.repeat(64) })
  assert.equal((await f.request('/api/repo-search', request)).status, 200)
  assert.equal(f.runtime.calls.at(-1).request.headers.has('authorization'), false)
  assert.equal((await f.trade('prepare')).status, 403)
})

test('strips legacy credentials and spoofed forwarding headers, keeps trusted IP on trading requests', async () => {
  const f = await fixture()
  const unsafe = { cookie: 'legacy', authorization: 'Bearer legacy', 'x-api-key': 'legacy', 'x-forwarded-for': 'spoof', 'x-real-ip': 'spoof', 'cf-connecting-ip': '192.0.2.10', 'x-database-url': 'spoof', 'x-existing-market-trading-stage': 'live' }
  const response = await f.trade('prepare', unsafe)
  const upstream = f.runtime.calls.at(-1).request
  assert.equal(upstream.redirect, 'manual')
  assert.equal(upstream.headers.get('cf-connecting-ip'), '192.0.2.10')
  for (const key of Object.keys(unsafe).filter(key => key !== 'cf-connecting-ip')) assert.equal(upstream.headers.has(key), false)
  assert.equal(response.headers.has('set-cookie'), false)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'; frame-src 'none'/)
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  await f.request('/stats', { headers: { ...unsafe, rsc: '1', range: 'bytes=0-10' } })
  const pageHeaders = f.runtime.calls.at(-1).request.headers
  for (const key of Object.keys(unsafe)) assert.equal(pageHeaders.has(key), false)
  assert.equal(pageHeaders.get('rsc'), '1')
  assert.equal(pageHeaders.get('range'), 'bytes=0-10')
  const preview = await f.fetch(new Request('https://review.workers.dev/stats'))
  assert.equal(preview.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
})

test('rejects cross-origin, non-JSON, malformed, streamed oversized and unreadable bodies before dispatch', async () => {
  const f = await fixture()
  assert.equal((await f.trade('quote', { origin: 'https://attacker.invalid' })).status, 403)
  assert.equal((await f.trade('quote', { 'content-type': 'text/plain' })).status, 403)
  for (const body of ['{', 'null', '[]', '{}']) assert.equal((await f.request('/api/trade', { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json' }, body })).status, 403)
  let cancelled = false
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8193)) }, cancel() { cancelled = true } })
  const options = { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json', 'content-length': '1' }, duplex: 'half' }
  assert.equal((await f.request('/api/trade', { ...options, body })).status, 403)
  assert(cancelled)
  assert.equal((await f.request('/api/trade', { ...options, body: new ReadableStream({ start(c) { c.error(Error('broken input')) } }) })).status, 403)
  assert.equal(f.runtime.calls.length, 0)
  assert.equal(f.storage.size, 0)
})

test('binds only the reader, separate trading credential and exact public review inputs; all eight Hook flags stay false', async () => {
  const f = await fixture()
  const body = await (await f.request()).json()
  assert.equal(body.DATABASE_URL, 'public-reader')
  assert.equal(body.TRADING_DATABASE_URL, 'trade-only')
  assert.equal(body.APP_ORIGIN, 'https://repo.ing')
  for (const [key, value] of Object.entries(inputs.proposedEnvironment)) assert.equal(body[key], value)
  assert.equal(body.TRADING_CUSTODY_RECOVERY_JSON, undefined)
  assert(Object.values(body).every(value => Buffer.byteLength(value) <= 16000), 'container environment values respect the runtime limit')
  for (const key of hookFlags) assert.equal(body[key], 'false')
  assert.equal(body.PRIVATE_KEY, undefined)
  assert.equal(body.PUBLIC_DATABASE_URL, undefined)
  assert.equal(body.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com')
  assert.equal(body.GRADUATION_VERIFICATION_RPC_URL, '', 'no independent verifier when the primary is the public endpoint')
  assert.equal(f.runtime.starts, 2)
  await f.request()
  assert.equal(f.runtime.starts, 2)
  assert(!JSON.stringify([...f.storage]).includes('public-reader'))
  assert(!JSON.stringify([...f.storage]).includes(manifest.slice(0, 30)))
  // Independent expected digest: notably both raw manifest bytes and its pin,
  // and both credentials must participate even though only review is accepted.
  const expected = createHash('sha256').update(JSON.stringify({
    PUBLIC_DATABASE_URL: 'public-reader',
    TRADING_DATABASE_URL: 'trade-only',
    DBC_CONFIG: inputs.proposedEnvironment.DBC_CONFIG,
    DBC_LEGACY_CONFIGS: inputs.proposedEnvironment.DBC_LEGACY_CONFIGS,
    TRADING_CUSTODY_RECOVERY_SHA256: inputs.custody.sha256,
    TRADING_CUSTODY_RECOVERY_JSON: manifest,
    EXISTING_MARKET_TRADING_ONLY: 'true',
    EXISTING_MARKET_TRADING_STAGE: 'review',
    APP_ORIGIN: 'https://repo.ing',
  })).digest('hex')
  assert.equal([...f.storage.values()][0], expected)
})

test('missing or mismatched bindings fail closed, including unknown stages and changed manifest bytes', async () => {
  const f = await fixture()
  await f.request()
  const required = ['PUBLIC_DATABASE_URL', 'TRADING_DATABASE_URL', 'EXISTING_MARKET_TRADING_ONLY', 'EXISTING_MARKET_TRADING_STAGE', 'DBC_CONFIG', 'DBC_LEGACY_CONFIGS', 'TRADING_CUSTODY_RECOVERY_SHA256']
  for (const key of required) {
    const prior = f.env[key]
    delete f.env[key]
    assert.equal((await f.request()).status, 503, key)
    f.env[key] = prior
  }
  for (const [key, value] of [['EXISTING_MARKET_TRADING_STAGE', 'unknown'], ['EXISTING_MARKET_TRADING_ONLY', 'false'], ['DBC_CONFIG', mint], ['DBC_LEGACY_CONFIGS', mint], ['TRADING_CUSTODY_RECOVERY_SHA256', '0'.repeat(64)], ['TRADING_DATABASE_URL', 'public-reader']]) {
    const prior = f.env[key]
    f.env[key] = value
    assert.equal((await f.request()).status, 503, key)
    assert.notEqual((await f.trade('submit')).status, 200)
    f.env[key] = prior
  }
  assert.equal(f.runtime.calls.length, 1)
})

test('bundled exact custody bytes avoid the 5KB binding limit and cannot be overridden by an environment binding', async () => {
  const f = await fixture()
  delete f.env.TRADING_CUSTODY_RECOVERY_JSON
  assert.equal((await f.request()).status, 200)
  f.env.TRADING_CUSTODY_RECOVERY_JSON = 'untrusted override'
  assert.equal((await (await f.request()).json()).TRADING_CUSTODY_RECOVERY_JSON, undefined)
  const corrupt = await fixture(manifest + '\n')
  assert.equal((await corrupt.request()).status, 503)
  assert.equal(corrupt.runtime.calls.length, 0)
})

test('the DO itself rejects unvalidated raw fetch and invalid binding RPCs', async () => {
  const f = await fixture()
  assert.equal((await f.instance.fetch(new Request('https://repo.ing/stats'))).status, 503)
  await assert.rejects(f.instance.fetchWithReviewBindings(new Request('https://repo.ing/stats'), { ...f.env, EXISTING_MARKET_TRADING_STAGE: 'unknown' }), /bindings/i)
  assert.equal(f.runtime.calls.length, 0)
  assert.equal(f.storage.size, 0)
})

test('live stage exposes only existing-market trades while launches, hooks, claims and replay stay closed', async () => {
  const f = await fixture()
  f.env.EXISTING_MARKET_TRADING_STAGE = 'live'
  for (const action of ['depth', 'quote', 'costs', 'prepare', 'submit', 'status']) assert.equal((await f.trade(action)).status, 200)
  const body = await (await f.request()).json()
  assert.equal(body.EXISTING_MARKET_TRADING_STAGE, 'live')
  assert.equal(body.EXISTING_MARKET_TEST_ACCESS_TOKEN, '')
  assert.equal(body.EXISTING_MARKET_TEST_SUBMISSION, 'false')
  for (const key of hookFlags) assert.equal(body[key], 'false')
  for (const path of ['/api/launch', '/api/claim', '/api/replay', '/api/hook-lab/native-launch', '/api/actions/trade']) {
    assert.equal((await f.request(path, { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json' }, body: '{}' })).status, 403)
  }
  assert.equal((await f.trade('submit', { origin: 'https://evil.example' })).status, 403)
  f.runtime.html = true
  const html = await (await f.request()).text()
  assert.equal(html, '<body>App</body>', 'the app owns the hydrated live recovery notice; the Worker must not inject a duplicate')
})

test('both DB bindings and raw config changes restart warm instances; rollback restarts too', async () => {
  const f = await fixture()
  await f.request()
  for (const [key, value] of [['PUBLIC_DATABASE_URL', 'rotated-reader'], ['TRADING_DATABASE_URL', 'rotated-trader'], ['DBC_LEGACY_CONFIGS', ['Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7', ...inputs.configs].reverse().join(',')], ['TRADING_DATABASE_URL', 'trade-only']]) {
    const starts = f.runtime.starts
    f.env[key] = value
    const body = await (await f.request()).json()
    assert.equal(body[key === 'PUBLIC_DATABASE_URL' ? 'DATABASE_URL' : key], value)
    assert.equal(f.runtime.starts, starts + 1)
  }
})

test('review cutover invalidates the legacy reader-only fingerprint so rollback cannot reuse a trading process', async () => {
  const f = await fixture()
  f.storage.set('database-binding-sha256', createHash('sha256').update('public-reader').digest('hex'))
  assert.equal((await f.request()).status, 200)
  assert.equal(f.storage.has('database-binding-sha256'), false)
  assert.equal(f.storage.size, 1)
  // The old wrapper leaves our new key intact but writes its own key after a
  // rollback. Re-entering review with identical bindings must still restart.
  f.storage.set('database-binding-sha256', createHash('sha256').update('public-reader').digest('hex'))
  f.runtime.env = { DATABASE_URL: 'public-reader' }
  const starts = f.runtime.starts
  assert.equal((await (await f.request()).json()).TRADING_DATABASE_URL, 'trade-only')
  assert.equal(f.runtime.starts, starts + 1)
  assert.equal(f.storage.has('database-binding-sha256'), false)
})

test('restart/storage failure and an old DO implementation return retryable unavailability, never stale content', async () => {
  for (const failure of ['failDestroy', 'failStorage']) {
    const f = await fixture()
    await f.request()
    f.env.TRADING_DATABASE_URL = 'rotated-trader'
    f.runtime[failure] = true
    const response = await f.request()
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '5')
    assert.equal(f.runtime.calls.length, 1)
    assert(!JSON.stringify([...f.storage]).includes('rotated-trader'))
    f.runtime[failure] = false
    assert.equal((await (await f.request()).json()).TRADING_DATABASE_URL, 'rotated-trader')
  }
  const f = await fixture()
  f.env.PUBLIC_SITE.getByName = () => ({ fetchWithDatabase() { throw Error('obsolete method') } })
  assert.equal((await f.request()).status, 503)
  assert.equal(f.runtime.calls.length, 0)
})

test('a slow page does not block health with unchanged bindings', async () => {
  const f = await fixture()
  await f.request()
  let release
  f.runtime.holdPath = '/stats'
  f.runtime.hold = new Promise(resolve => { release = resolve })
  const page = f.request('/stats')
  await new Promise(resolve => setTimeout(resolve, 20))
  try {
    const health = await Promise.race([f.request('/api/health'), new Promise(resolve => setTimeout(() => resolve(null), 200))])
    assert.equal(health?.status, 200, 'health must finish before the slow page is released')
  } finally { release(); await page }
})

test('the restored RPC is restricted to the rotated mainnet provider and included in runtime identity', async () => {
  const f = await fixture()
  await f.request()
  const starts = f.runtime.starts
  f.env.SOLANA_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=fixture-only'
  const restored = await (await f.request()).json()
  assert.equal(restored.SOLANA_RPC_URL, f.env.SOLANA_RPC_URL)
  assert.equal(restored.GRADUATION_VERIFICATION_RPC_URL, 'https://api.mainnet-beta.solana.com')
  assert.equal(f.runtime.starts, starts + 1)
  for (const url of ['https://devnet.helius-rpc.com/?api-key=fixture-only', 'http://mainnet.helius-rpc.com/?api-key=x', 'https://mainnet.helius-rpc.com/?api-key=x&api-key=y']) {
    f.env.SOLANA_RPC_URL = url
    assert.equal((await f.request()).status, 503)
  }
})

test('only successful public static assets can be browser-cached; dynamic and financial responses stay private', async () => {
  const f = await fixture()
  for (const path of ['/_next/static/chunks/contenthash.js', '/brand-cat.webp', '/video/repoing-flywheel-poster.jpg']) {
    assert.match((await f.request(path)).headers.get('cache-control'), /public, max-age=/)
  }
  for (const path of ['/', '/api/health', `/api/market/${mint}/curve`, '/api/launch', '/_next/static/../api/claim']) {
    assert.equal((await f.request(path)).headers.get('cache-control'), 'no-store')
  }
  assert.equal((await f.trade()).headers.get('cache-control'), 'no-store')
  f.runtime.failDestroy = true
  f.env.TRADING_DATABASE_URL = 'changed'
  assert.equal((await f.request('/_next/static/chunks/contenthash.js')).headers.get('cache-control'), 'no-store')
})

test('binding refresh cannot race dispatch into the previous or next process environment', async () => {
  const f = await fixture()
  let release
  f.runtime.hold = new Promise(resolve => { release = resolve })
  const first = f.request()
  // Reach the container fetch, not merely Worker digest validation.
  while (f.storage.size === 0) await new Promise(resolve => setImmediate(resolve))
  f.env.TRADING_DATABASE_URL = 'second-trader'
  const second = f.request()
  release()
  assert.equal((await (await first).json()).TRADING_DATABASE_URL, 'trade-only')
  assert.equal((await (await second).json()).TRADING_DATABASE_URL, 'second-trader')
})

test('HTML review notice does not imply live trading or live accounting', async () => {
  const f = await fixture()
  f.runtime.html = true
  const response = await f.request()
  const html = await response.text()
  assert.match(html, /unsigned preparation only/i)
  assert.match(html, /do not sign/i)
  assert.match(html, /launches.*claims.*replay.*paused/i)
  assert.match(html, /read-only finalized-chain indexing/i)
  assert.match(html, /fee accounting and payouts remain under verification/i)
  assert.doesNotMatch(html, /history snapshot through Oct 22/i)
  assert.doesNotMatch(html, /do not connect a wallet/i)
  assert.equal(response.headers.has('set-cookie'), false)
})

test('test-only stage needs pinned plan and operator access; sending remains separately disabled', async () => {
  const f = await fixture()
  f.env.EXISTING_MARKET_TRADING_STAGE = 'test'
  assert.equal((await f.request()).status, 503)
  f.env.EXISTING_MARKET_TEST_PLAN = 'existing-markets-six-swaps-v1'
  f.env.EXISTING_MARKET_TEST_SUBMISSION = 'false'
  f.env.EXISTING_MARKET_TEST_ACCESS_TOKEN = 'a'.repeat(64) // fixture, not a credential
  assert.equal((await f.request()).status, 200)
  assert.equal((await f.trade('prepare')).status, 403)
  assert.equal((await f.trade('prepare', { authorization: `Bearer ${'b'.repeat(64)}` })).status, 403)
  const auth = { authorization: `Bearer ${'a'.repeat(64)}` }
  assert.equal((await f.trade('prepare', auth)).status, 200)
  assert.equal(f.runtime.calls.at(-1).request.headers.get('authorization'), auth.authorization)
  assert.equal((await f.trade('submit', auth)).status, 403)
  f.env.EXISTING_MARKET_TEST_SUBMISSION = 'true'
  const starts = f.runtime.starts
  assert.equal((await f.trade('submit', auth)).status, 200)
  assert.equal(f.runtime.starts, starts + 1, 'approval change restarts the process')
  for (const action of ['claim', 'replay', 'depth', 'quote', 'costs']) assert.equal((await f.trade(action, auth)).status, 403)
  for (const path of ['/api/launch', '/api/actions/trade', '/api/replay']) assert.equal((await f.request(path, { method: 'POST', headers: auth })).status, 403)
  f.runtime.html = true
  assert.match(await (await f.request()).text(), /six-swap test only/i)
})

test('ordinary launch admission is separately bound and never opens other financial lanes', async () => {
  const f = await fixture()
  f.env.EXISTING_MARKET_TRADING_STAGE = 'live'
  const post = (path, body, headers = {}) => f.request(path, { method: 'POST', headers: {
    origin: 'https://repo.ing', 'content-type': 'application/json', ...headers,
  }, body: JSON.stringify(body) })
  assert.equal((await post('/api/launch', { action: 'prepare' })).status, 403)
  Object.assign(f.env, {
    ORDINARY_LAUNCH_RECOVERY_ENABLED: 'true',
    ORDINARY_LAUNCH_CONFIG: '3ZESQPHgao8ZyyEU4tJSwDmrVC3nunhGnTFVGdarRDbZ',
    ORDINARY_LAUNCH_DATABASE_URL: 'postgres://repoing_ordinary_launcher:synthetic@localhost/repoing_operational?sslmode=verify-full',
    ORDINARY_LAUNCH_BOOTSTRAP_SECRET_KEY: '1'.repeat(88),
    GITHUB_APP_PRIVATE_KEY_BASE64: 'synthetic', GITHUB_APP_CLIENT_ID: 'synthetic', GITHUB_APP_INSTALLATION_ID: '1',
  })
  for (const path of ['/launch/123', '/api/launch?repo=123', '/api/repo-images/123']) {
    assert.equal((await f.request(path)).status, 200, path)
  }
  for (const action of ['quote', 'prepare', 'submit', 'cancel']) assert.equal((await post('/api/launch', { action })).status, 200)
  assert.equal((await post('/api/resolve', { url: 'https://github.com/org/repo' })).status, 200)
  for (const path of ['/api/builders/claim', '/api/bundles', '/api/hook-lab/native-launch', '/api/replay']) {
    assert.equal((await post(path, {})).status, 403, path)
  }
  assert.equal((await post('/api/launch', { action: 'prepare' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await post('/api/launch', { action: 'claim' })).status, 403)
  assert.equal((await post('/api/launch', { action: 'prepare', padding: 'x'.repeat(600001) })).status, 403)
  assert.equal((await f.request('/launch/4503599627370497')).status, 403, 'HF IDs remain closed')
  const starts = f.runtime.starts
  f.env.ORDINARY_LAUNCH_BOOTSTRAP_SECRET_KEY = '2'.repeat(88)
  assert.equal((await f.request('/api/health')).status, 200)
  assert.equal(f.runtime.starts, starts + 1, 'bootstrap change restarts sealed-session runtime')
  assert.equal(f.runtime.env.DBC_CONFIG, inputs.proposedEnvironment.DBC_CONFIG)
  assert.equal(f.runtime.env.ORDINARY_LAUNCH_CONFIG, f.env.ORDINARY_LAUNCH_CONFIG)
  assert.equal(f.runtime.env.PLATFORM_CREATOR_SECRET_KEY, undefined)
  f.env.ORDINARY_LAUNCH_DATABASE_URL = 'postgres://owner:synthetic@localhost/repoing_operational?sslmode=verify-full'
  assert.equal((await f.request('/api/health')).status, 503)
})

test('accounting recovery binds only the isolated ledger reader and never admits payout routes or a fee writer', async () => {
  const f = await fixture()
  Object.assign(f.env, { EXISTING_MARKET_TRADING_STAGE: 'live', ACCOUNTING_RECOVERY_ENABLED: 'true',
    ACCOUNTING_DATABASE_URL: 'postgres://repoing_ledger_reader:synthetic@localhost/repoing_operational?sslmode=verify-full',
    ACCOUNTING_CUSTODY_SHA256: inputs.custody.sha256,
    RECOVERY_FEE_DATABASE_URL: 'never-forward-this-writer' })
  assert.equal((await f.request(`/token/${mint}`)).status, 200)
  assert.equal(f.runtime.env.ACCOUNTING_RECOVERY_ENABLED, 'true')
  assert.equal(f.runtime.env.ACCOUNTING_DATABASE_URL, f.env.ACCOUNTING_DATABASE_URL)
  assert.equal(f.runtime.env.ACCOUNTING_CUSTODY_SHA256, inputs.custody.sha256)
  assert.equal(f.runtime.env.RECOVERY_FEE_DATABASE_URL, undefined)
  for (const path of ['/api/claim', '/api/builders/claim', '/api/replay', '/api/bundles', '/api/hook-lab/native-launch']) {
    assert.equal((await f.request(path, { method: 'POST' })).status, 403)
  }
  const starts = f.runtime.starts
  f.env.ACCOUNTING_DATABASE_URL = f.env.ACCOUNTING_DATABASE_URL.replace('synthetic', 'replacement-fixture')
  assert.equal((await f.request('/api/health')).status, 200)
  assert.equal(f.runtime.starts, starts + 1)
  const valid = f.env.ACCOUNTING_DATABASE_URL
  for (const invalid of [valid.replace('repoing_ledger_reader', 'repoing_owner'), valid + '&options=unsafe',
    valid + '&sslmode=require', valid.replace('verify-full', 'require')]) {
    f.env.ACCOUNTING_DATABASE_URL = invalid
    assert.equal((await f.request('/api/health')).status, 503)
  }
  f.env.ACCOUNTING_DATABASE_URL = valid
  f.env.ACCOUNTING_CUSTODY_SHA256 = '0'.repeat(64)
  assert.equal((await f.request('/api/health')).status, 503)
  f.env.ACCOUNTING_RECOVERY_ENABLED = 'false'
  assert.equal((await f.request('/api/health')).status, 200)
  assert.equal(f.runtime.env.ACCOUNTING_DATABASE_URL, undefined)
})

test('a container replaced under the Durable Object is restarted once and reads retried; writes are never replayed', async () => {
  const f = await fixture()
  f.env.EXISTING_MARKET_TRADING_STAGE = 'live'
  await f.request()
  const starts = f.runtime.starts, destroys = f.runtime.destroys ?? 0
  f.runtime.stale = true
  const [a, b] = await Promise.all([f.request('/api/health'), f.request('/explore')])
  assert.deepEqual([a.status, b.status], [200, 200], 'concurrent reads recover in the same request')
  assert.equal(f.runtime.destroys - destroys, 1, 'one shared restart')
  assert.equal(f.runtime.starts, starts + 1)
  const calls = f.runtime.calls.length
  f.runtime.stale = true
  const write = await f.trade('quote')
  assert.equal(write.status, 503)
  assert.equal(write.headers.get('retry-after'), '5')
  assert.equal(f.runtime.calls.length, calls, 'the write was not replayed')
  assert.equal((await f.request('/api/health')).status, 200)
  // An application error is passed through untouched.
  f.runtime.stale = false
})
