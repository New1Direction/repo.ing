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
const hookFlags = ['HOOK_PRODUCTION_BOOTSTRAP', 'HOOK_NATIVE_LAUNCH_ENABLED', 'HOOK_NATIVE_LAUNCHES_ENABLED', 'HOOK_INCLUSIVE_TRADING_ENABLED', 'HOOK_NATIVE_TRADING_ENABLED', 'HOOK_WALLET_FUNDING_ENABLED', 'HOOK_WALLET_IDENTITY_ENABLED', 'HOOK_SELECTED_HOOKS_ENABLED', 'HOOK_BURN_ENABLED']

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
  const context = createContext({ Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, HTMLRewriter, Container, custodyManifest: bundledManifest, caches: globalThis.__edgeCaches })
  const source = readFileSync(workerUrl, 'utf8')
  const module = new Script(source.replace("import { Container } from '@cloudflare/containers'", '')
    .replace("import custodyManifest from '../config/existing-market-custody.json'", '')
    .replaceAll('export class PublicSite', 'class PublicSite').replace('export default {', 'const worker = {').replace('\nexport default worker\n', '\n')
    + '\n;({ PublicSite, PublicSiteB, worker })').runInContext(context)
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
  return { env, runtime, storage, request, trade, fetch, instance, module }
}

// Slot b as the Worker sees it: its own Durable Object namespace; every call is recorded with the request's headers.
function slotB(f) {
  const calls = []
  f.env.PUBLIC_SITE_B = { getByName(name) {
    assert.equal(name, 'public-readonly')
    return { async fetchWithReviewBindings(request) { calls.push({ url: request.url, headers: Object.fromEntries(request.headers) }); return new Response('slot b') },
      async restartForSlotDeploy() { calls.push({ restart: true }); return true } }
  } }
  return calls
}
const PROBE_TOKEN = 'p'.repeat(40)
const probe = (slot, token = PROBE_TOKEN) => ({ 'x-repoing-slot': slot, 'x-repoing-slot-token': token })

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
  const allowed = ['/', '/launch', '/explore', '/find-repos', '/discoverers', '/referrals', '/agents', '/wallet', '/api/repo-search', '/api/wallet/overview', '/builders', '/ja', '/ja/faq', '/waiting', '/launches', '/opt-out', '/api/v1/launches', '/stats', '/how-it-works', '/about', '/programmable-coins', '/hooks', `/token/${mint}`, ...['trades', 'metrics', 'curve', 'traders', 'activity', 'pulse', 'events'].map(s => `/api/market/${mint}/${s}`), `/api/token-image/${mint}`, '/api/repo-logo/123', '/api/growth', '/favicon.ico', '/brand-cat.webp', '/gitcat.png', '/launch-on-repoing.svg', '/opengraph-image.png', ...['art', 'badges', 'launch-icons', 'hook-icons', 'credits'].map(s => `/${s}/test-image.webp`), '/video/repoing-flywheel-poster.jpg', '/video/repoing-flywheel.mp4', '/_next/static/chunks/test.js']
  for (const path of allowed) for (const method of ['GET', 'HEAD']) assert.equal((await f.request(path, { method })).status, 200, `${method} ${path}`)
  const before = f.runtime.calls.length
  for (const path of ['/api/trade', '/api/trade/', '/api/auth/session', '/api/launch', '/api/hook-lab/native-launch', '/api/hook-lab/inclusive-trade', '/api/builders/claim', '/api/bundles', '/api/replay', '/api/actions/trade', '/api/mcp/', '/builders?owner=x', '/ja/', '/japan', '/ja/a/b/c/d', '/api/opt-out', '/api/builders', '/api/discovery/1', '/api/x/connect', '/api/x/callback', '/admin/restart', '/api/market/not-a-mint/balance', `/api/market/${mint}/balance/`, '/stats/', '/art/image.svg']) {
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
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self' https:\/\/cloudflareinsights\.com; frame-src 'none'/)
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

test('claim routes carry cookies only with valid claims bindings; every other route still strips them', async () => {
  const f = await fixture()
  f.env.EXISTING_MARKET_TRADING_STAGE = 'live'
  Object.assign(f.env, { ORDINARY_LAUNCH_RECOVERY_ENABLED: 'false', GITHUB_APP_CLIENT_ID: 'Iv1.claims-test' })
  const claimPaths = [['GET', '/claim/1278009399'], ['GET', '/api/github/start'], ['GET', '/api/github/callback'], ['POST', '/api/bind'], ['POST', '/api/claim/payout']]
  const send = (method, path, extra = {}) => f.request(path, { method, headers: { cookie: 'repoing_github=session', origin: 'https://repo.ing',
    'content-type': 'application/json', ...extra }, ...(method === 'POST' ? { body: '{"action":"challenge"}' } : {}) })
  // Claims off: the claim routes stay closed.
  for (const [method, path] of claimPaths) assert.equal((await send(method, path)).status, 403, `${method} ${path} closed without claims`)
  Object.assign(f.env, { CLAIMS_RECOVERY_ENABLED: 'true', GITHUB_APP_CLIENT_SECRET: 'client-secret',
    CLAIMS_DATABASE_URL: 'postgres://repoing_builder_claims:x@db.example/repoing_operational?sslmode=verify-full',
    BUILDER_PAYOUT_SECRET_KEY: JSON.stringify(Array.from({ length: 64 }, (_, i) => i)) })
  for (const [method, path] of claimPaths) {
    const response = await send(method, path)
    assert.equal(response.status, 200, `${method} ${path}`)
    assert.equal(response.headers.get('set-cookie'), 'unsafe=session', `${path} may set the session cookie`)
    const call = f.runtime.calls.at(-1)
    assert.equal(call.request.headers.get('cookie'), 'repoing_github=session', `${path} receives the session cookie`)
    if (method === 'POST') assert.equal(call.body, '{"action":"challenge"}')
    assert.equal(call.env.CLAIMS_DATABASE_URL, f.env.CLAIMS_DATABASE_URL)
    assert.equal(call.env.GITHUB_APP_CLIENT_SECRET, 'client-secret')
    assert.ok(call.env.BUILDER_PAYOUT_SECRET_KEY)
  }
  // Same-origin JSON only, and nothing beyond the approved list.
  assert.equal((await send('POST', '/api/claim/payout', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await send('POST', '/api/bind', { 'content-type': 'text/plain' })).status, 403)
  for (const [method, path] of [['POST', '/api/claim'], ['POST', '/api/builders/claim'], ['POST', '/api/payout-address'], ['GET', '/claim/1/x']]) {
    assert.equal((await send(method, path)).status, 403, `${method} ${path} stays closed`)
  }
  // Other routes: no cookie in, no Set-Cookie out.
  const page = await send('GET', '/explore')
  assert.equal(page.headers.get('set-cookie'), null)
  assert.equal(f.runtime.calls.at(-1).request.headers.has('cookie'), false)
  // A claims binding for any other role fails closed for the whole site.
  f.env.CLAIMS_DATABASE_URL = 'postgres://repoing_owner:x@db.example/repoing_operational?sslmode=verify-full'
  assert.equal((await send('GET', '/claim/1278009399')).status, 503)
})

// Hooks on our own stack (owner, 2026-10-26): open launches, native-SOL trading and creator claims, behind HOOKS_RECOVERY_ENABLED.
const hookBindings = () => ({
  HOOKS_RECOVERY_ENABLED: 'true',
  HOOK_WALLET_IDENTITY_DATABASE_URL: 'postgres://repoing_hooks_site:x@db.example/repoing_operational?sslmode=verify-full',
  HOOK_NATIVE_KEYRING_JSON: JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') }), HOOK_NATIVE_ACTIVE_KEY_ID: 'k1',
  HOOKLAB_PRODUCTION_RPC_PRIMARY_URL: 'https://mainnet.helius-rpc.com/?api-key=k', HOOKLAB_PRODUCTION_RPC_SECONDARY_URL: 'https://solana-rpc.publicnode.com',
  HOOKLAB_PRODUCTION_BUNDLE_FILE: '/app/hooklab/production-bundle.json', HOOKLAB_PRODUCTION_BUNDLE_SHA256: 'a'.repeat(64),
  HOOKLAB_STACK_BUNDLE_FILE: '/app/hooklab/stack-bundle.json', HOOKLAB_STACK_BUNDLE_SHA256: 'b'.repeat(64),
  HOOK_LAUNCH_ADMIN_ADDRESS: 'DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5', HOOK_STACK_ADMIN_ADDRESS: 'DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',
  HOOKLAB_PRIORITY_MICROLAMPORTS: '0', HOOK_OPEN_LAUNCHES: 'true', HOOK_NATIVE_LAUNCH_ENABLED: 'true', HOOK_NATIVE_LAUNCHES_ENABLED: 'true',
  HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_INCLUSIVE_TRADING_ENABLED: 'true', HOOK_NATIVE_TRADING_ENABLED: 'true', HOOK_TRADING_PUBLIC: 'false',
})
const coinId = '0f8e3a2c-1b4d-4e5f-8a9b-0c1d2e3f4a5b'
const hookReads = ['/hooks/launch-review', '/hooks/mine', '/hooks/trade', '/hooks/blocks', '/hooks/new', '/hooks/wallet-identity', '/explore/hooks', `/hooks/token/${mint}`,
  `/api/hook-lab/market/${mint}`, `/api/hook-lab/market/${mint}/candles`, `/api/hook-lab/market/${mint}/holders`, `/api/hook-lab/market/${mint}/trades`,
  `/api/hook-lab/wallet/${mint}`, `/api/hook-lab/coins/${coinId}/image`, `/api/hook-lab/coins/${coinId}/metadata`]
const hookPosts = [['/api/hook-lab/wallet-identity', 'challenge'], ['/api/hook-lab/launch-requests', 'create'], ['/api/hook-lab/native-launch', 'reserve'],
  ['/api/hook-lab/native-claim', 'claim'], ['/api/hook-lab/inclusive-trade', 'native-quote'],
  // cosign: the server's mint-key signature in every open launch (app/lib/hooklab-native-launch.mjs:99); a claim's signing
  // lifecycle (app/lib/hooklab-native-claim.mjs:19-24).
  ['/api/hook-lab/native-launch', 'cosign'], ['/api/hook-lab/native-launch', 'complete'], ...['wallet-request', 'submit', 'reconcile', 'retain-wallet'].map(action => ['/api/hook-lab/native-claim', action])]
const HOOK_COOKIE = '__Host-hook-wallet-session=c2Vzc2lvbg; repoing_github=other'

test('Hooks stay closed and every Hook flag false unless HOOKS_RECOVERY_ENABLED is on with valid bindings', async () => {
  const f = await fixture()
  f.env.EXISTING_MARKET_TRADING_STAGE = 'live'
  const fingerprint = async () => { await f.request(); return [...f.storage.values()][0] }
  const before = await fingerprint()
  // Hooks-shaped values without the switch change nothing: not forwarded, not fingerprinted, routes closed.
  Object.assign(f.env, (({ HOOKS_RECOVERY_ENABLED, ...rest }) => rest)(hookBindings()))
  assert.equal(await fingerprint(), before, 'no restart while Hooks are off')
  for (const path of hookReads) assert.equal((await f.request(path)).status, 403, path)
  for (const [path, action] of hookPosts) assert.equal((await f.request(path, { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json' }, body: JSON.stringify({ action }) })).status, 403, path)
  const body = await (await f.request()).json()
  for (const key of hookFlags) assert.equal(body[key], 'false')
  assert.equal(body.HOOK_WALLET_IDENTITY_DATABASE_URL, undefined)
  assert.equal(body.HOOK_NATIVE_KEYRING_JSON, undefined)
  // On outside the live stage, or with any binding wrong: the whole site fails closed.
  f.env.HOOKS_RECOVERY_ENABLED = 'true'; f.env.EXISTING_MARKET_TRADING_STAGE = 'review'
  assert.equal((await f.request('/explore')).status, 503)
  f.env.EXISTING_MARKET_TRADING_STAGE = 'live'
  const wrong = { HOOK_WALLET_IDENTITY_DATABASE_URL: 'postgres://repoing_owner:x@db.example/repoing_operational?sslmode=verify-full',
    HOOK_NATIVE_KEYRING_JSON: '{"k1":"c2hvcnQ="}', HOOK_NATIVE_ACTIVE_KEY_ID: 'k2', HOOKLAB_PRODUCTION_RPC_SECONDARY_URL: 'http://solana-rpc.publicnode.com',
    HOOKLAB_STACK_BUNDLE_FILE: '/app/../etc/passwd', HOOKLAB_STACK_BUNDLE_SHA256: 'xyz', HOOK_STACK_ADMIN_ADDRESS: 'not-base58!',
    HOOKLAB_PRIORITY_MICROLAMPORTS: '-1', HOOK_TRADING_PUBLIC: 'yes', HOOK_OPEN_LAUNCHES: 'true' }
  for (const [name, value] of Object.entries(wrong)) {
    Object.assign(f.env, hookBindings(), { [name]: value }, name === 'HOOK_OPEN_LAUNCHES' ? { HOOK_NATIVE_LAUNCHES_ENABLED: 'false' } : {})
    assert.equal((await f.request('/explore')).status, 503, `${name}=${value}`)
  }
  for (const name of Object.keys(hookBindings())) {
    Object.assign(f.env, hookBindings()); delete f.env[name]
    if (name !== 'HOOKS_RECOVERY_ENABLED') assert.equal((await f.request('/explore')).status, 503, `missing ${name}`)
  }
})

test('Hooks on: exactly the open-launch, native trading and claim routes, with their environment; wallet cookies only where needed', async () => {
  const f = await fixture()
  Object.assign(f.env, { EXISTING_MARKET_TRADING_STAGE: 'live' }, hookBindings())
  for (const path of hookReads) {
    const response = await f.request(path, { headers: { cookie: HOOK_COOKIE } })
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('set-cookie'), null, `${path} sets no cookie`)
    assert.equal(f.runtime.calls.at(-1).request.headers.has('cookie'), false, `${path} receives no cookie`)
  }
  const env = f.runtime.calls.at(-1).env
  for (const [name, value] of Object.entries(hookBindings())) if (name !== 'HOOKS_RECOVERY_ENABLED') assert.equal(env[name], value, name)
  assert.deepEqual([env.HOOK_PRODUCTION_BOOTSTRAP, env.HOOK_WALLET_IDENTITY_ORIGIN], ['true', 'https://repo.ing'])
  assert.deepEqual([env.HOOK_SELECTED_HOOKS_ENABLED, env.HOOK_WALLET_FUNDING_ENABLED, env.HOOK_OWNER_APPROVED_LAUNCHES], ['false', 'false', 'false'],
    'creator-chosen hooks, wallet funding and owner-approved launches stay off')
  const post = (path, payload, headers = {}) => f.request(path, { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json',
    cookie: HOOK_COOKIE, ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  for (const [path, action] of hookPosts) {
    const response = await post(path, { action })
    assert.equal(response.status, 200, path)
    const call = f.runtime.calls.at(-1)
    assert.equal(call.request.headers.get('cookie'), '__Host-hook-wallet-session=c2Vzc2lvbg', `${path} receives only the Hooks wallet cookies`)
    assert.equal(call.body, JSON.stringify({ action }))
    assert.equal(response.headers.get('set-cookie'), path === '/api/hook-lab/wallet-identity' ? 'unsafe=session' : null, `${path} Set-Cookie`)
  }
  for (const path of ['/api/hook-lab/wallet-identity', '/api/hook-lab/launch-requests']) {
    await f.request(path, { headers: { cookie: HOOK_COOKIE } })
    assert.equal(f.runtime.calls.at(-1).request.headers.get('cookie'), '__Host-hook-wallet-session=c2Vzc2lvbg', `GET ${path} carries the session`)
  }
  const image = await f.request('/api/hook-lab/coin-image', { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'image/png' }, body: new Uint8Array(1000) })
  assert.equal(image.status, 200)
  assert.equal(f.runtime.calls.at(-1).body.length, 1000)
  const calls = f.runtime.calls.length
  // Refused even with Hooks on: other origins, other bodies, unknown actions, oversized bodies, selected hooks, funding, the bridged stack.
  const refused = [post('/api/hook-lab/native-launch', { action: 'reserve' }, { origin: 'https://evil.example' }),
    post('/api/hook-lab/native-launch', { action: 'reserve' }, { 'content-type': 'text/plain' }),
    post('/api/hook-lab/native-launch', 'not json'),
    post('/api/hook-lab/native-claim', { action: 'claim', pad: 'x'.repeat(9000) }),
    post('/api/hook-lab/launch-requests', { action: 'create', selectedHook: { program: mint, flags: 1 } }),
    post('/api/hook-lab/launch-requests', { action: 'create', hookPublication: { id: coinId } }),
    post('/api/hook-lab/inclusive-trade', { action: 'native-quote', request: { policyKind: 'selected-hook' } }),
    ...['native-estimate', 'fund', 'withdraw', 'quote'].map(action => post('/api/hook-lab/inclusive-trade', { action })),
    f.request('/api/hook-lab/coin-image', { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'image/png' }, body: new Uint8Array(2 * 1024 * 1024 + 1) }),
    f.request('/api/hook-lab/coin-image', { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'image/svg+xml' }, body: '<svg/>' }),
    ...['/api/hook-lab/owner-approvals', '/api/hook-lab/hook-catalog', '/api/hook-lab/production', '/api/hook-lab/local-operations', '/api/hook-lab/coin-moderation',
      '/api/hook-lab/new-mint-preparation', '/api/hook-lab/wallet-launch-assessment', '/api/hook-lab'].map(path => post(path, { action: 'get' })),
    ...['/hooks/custom', '/hooks/publish', '/h/AAAAAAAAAAAAAAAAAAAAAA', '/api/hook-lab/hook-catalog', '/api/hook-lab/production/receipts',
      `/api/hook-lab/coins/${coinId}/other`, `/api/hook-lab/market/${mint}/other`].map(path => f.request(path))]
  for (const response of await Promise.all(refused)) assert.equal(response.status, 403)
  assert.equal(f.runtime.calls.length, calls, 'nothing refused reached the container')
  // Ordinary pages still get no cookie and set none.
  const page = await f.request('/explore', { headers: { cookie: HOOK_COOKIE } })
  assert.equal(page.headers.get('set-cookie'), null)
  assert.equal(f.runtime.calls.at(-1).request.headers.has('cookie'), false)
})


// Burn (owner design 2026-10-27): an optional switch, off unless 'true'. Forwarded only with Hooks and open launches on (a
// token burn launches only through open creation); a binding that is neither 'true' nor 'false' closes the site.
test('HOOK_BURN_ENABLED is off by default and forwarded only with Hooks and open launches on', async () => {
  const f = await fixture()
  Object.assign(f.env, { EXISTING_MARKET_TRADING_STAGE: 'live' }, hookBindings()); delete f.env.HOOK_BURN_ENABLED
  const forwarded = async () => { const response = await f.request('/hooks/new'); assert.equal(response.status, 200); return f.runtime.calls.at(-1).env.HOOK_BURN_ENABLED }
  assert.equal(await forwarded(), 'false', 'absent: off, and Hooks stay on')
  f.env.HOOK_BURN_ENABLED = 'false'; assert.equal(await forwarded(), 'false')
  f.env.HOOK_BURN_ENABLED = 'true'; assert.equal(await forwarded(), 'true')
  f.env.HOOK_OPEN_LAUNCHES = 'false'; assert.equal(await forwarded(), 'false', 'no open launches, no burn')
  Object.assign(f.env, hookBindings(), { HOOK_BURN_ENABLED: 'yes' })
  assert.equal((await f.request('/explore')).status, 503)
  Object.assign(f.env, { HOOK_BURN_ENABLED: 'true', HOOKS_RECOVERY_ENABLED: 'false' })
  const body = await (await f.request()).json()
  assert.equal(body.HOOK_BURN_ENABLED, 'false', 'Hooks off: off')
})

test('reopened pages (owner, 2026-10-28): launch pages redirect to the live page, refused pages are a page for browsers', async () => {
  const f = await fixture()
  for (const [from, to] of [['/coins/new', '/hooks'], ['/launches/new', '/launch'], ['/launches/manage', '/launch']]) for (const method of ['GET', 'HEAD']) {
    const response = await f.request(from, { method })
    assert.equal(response.status, 302, `${method} ${from}`); assert.equal(response.headers.get('location'), to)
  }
  assert.equal((await f.request('/coins/new', { method: 'POST' })).status, 403, 'only GET/HEAD redirect')
  const before = f.runtime.calls.length
  const page = await f.request('/builders/reminders', { headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.equal(page.status, 403); assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(await page.text(), /isn\u2019t open yet[\s\S]*href="\/"/)
  assert.equal((await f.request('/builders/reminders', { method: 'HEAD', headers: { accept: 'text/html' } })).status, 403)
  const api = await f.request('/builders/reminders')
  assert.deepEqual([api.status, await api.json()], [403, { error: 'RECOVERY_ROUTE_DISABLED' }], 'non-browser callers keep the JSON refusal')
  assert.equal(f.runtime.calls.length, before, 'nothing refused reaches the container')
  await f.request('/ja', { headers: { cookie: 'repoing_github=session' } })
  assert.equal(f.runtime.calls.at(-1).request.headers.has('cookie'), false, 'read-only pages carry no cookies')
})

test('the opt-out record route opens with claims (session cookie, same-origin JSON); every payout, bind, dashboard and X route stays closed', async () => {
  const f = await fixture()
  f.env.EXISTING_MARKET_TRADING_STAGE = 'live'
  const send = (method, path, extra = {}) => f.request(path, { method, headers: { cookie: '__Host-repoing_github=s; repoing_x=other; __Host-hook-wallet-session=h', origin: 'https://repo.ing', 'content-type': 'application/json', ...extra },
    ...(method === 'POST' ? { body: '{"action":"decline","repoId":"1"}' } : {}) })
  for (const method of ['GET', 'POST']) assert.equal((await send(method, '/api/opt-out')).status, 403, `${method} closed without claims`)
  await send('GET', '/opt-out')
  assert.equal(f.runtime.calls.at(-1).request.headers.has('cookie'), false, 'without claims the page renders signed out')
  Object.assign(f.env, { ORDINARY_LAUNCH_RECOVERY_ENABLED: 'false', GITHUB_APP_CLIENT_ID: 'Iv1.claims-test', CLAIMS_RECOVERY_ENABLED: 'true', GITHUB_APP_CLIENT_SECRET: 'client-secret',
    CLAIMS_DATABASE_URL: 'postgres://repoing_builder_claims:x@db.example/repoing_operational?sslmode=verify-full',
    BUILDER_PAYOUT_SECRET_KEY: JSON.stringify(Array.from({ length: 64 }, (_, i) => i)) })
  for (const [method, path] of [['GET', '/opt-out'], ['GET', '/api/opt-out'], ['POST', '/api/opt-out']]) {
    const response = await send(method, path)
    assert.equal(response.status, 200, `${method} ${path}`)
    assert.equal(response.headers.get('set-cookie'), null, `${path} sets no cookie`)
    const call = f.runtime.calls.at(-1)
    assert.equal(call.request.headers.get('cookie'), '__Host-repoing_github=s', `${path} gets only the GitHub session`)
    if (method === 'POST') assert.equal(call.body, '{"action":"decline","repoId":"1"}')
  }
  assert.equal((await send('PUT', '/api/opt-out')).status, 403)
  assert.equal((await send('POST', '/api/opt-out', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await send('POST', '/api/opt-out', { 'content-type': 'text/plain' })).status, 403)
  for (const [method, path] of [['GET', '/api/builders'], ['POST', '/api/builders/claim'], ['POST', '/api/builders/bind'], ['POST', '/api/claim'], ['POST', '/api/hf/claim'],
    ['POST', '/api/participation/1'], ['GET', '/api/participation/1'], ['POST', '/api/contributor-wallet/link'], ['GET', '/api/contributor-wallet'], ['POST', '/api/discovery/1'],
    ['GET', '/api/discovery/1'], ['POST', '/api/x/connect'], ['GET', '/api/x/callback'], ['GET', '/api/x/link'], ['POST', '/api/payout-address'], ['GET', '/builders?owner=x']]) {
    assert.equal((await send(method, path)).status, 403, `${method} ${path} stays closed`)
  }
})

test('slots: the public reaches slot a unless ACTIVE_SLOT is b and slot b is bound', async () => {
  const f = await fixture(), b = slotB(f)
  const a = await f.request('/stats')
  assert.equal(a.headers.get('x-repoing-slot'), 'a'); assert.equal(b.length, 0)
  f.env.ACTIVE_SLOT = 'b'
  const viaB = await f.request('/stats')
  assert.equal(await viaB.text(), 'slot b'); assert.equal(viaB.headers.get('x-repoing-slot'), 'b'); assert.equal(b.length, 1)
  for (const value of ['B', 'c', '', ' b']) {
    f.env.ACTIVE_SLOT = value
    assert.equal((await f.request('/stats')).headers.get('x-repoing-slot'), 'a', `ACTIVE_SLOT=${JSON.stringify(value)}`)
  }
  f.env.ACTIVE_SLOT = 'b'; delete f.env.PUBLIC_SITE_B
  assert.equal((await f.request('/stats')).headers.get('x-repoing-slot'), 'a', 'slot b without its binding falls back to a')
})

test('slots: a probe with the secret reaches the named slot, never the public route, and its headers never reach a container', async () => {
  const f = await fixture(), b = slotB(f)
  f.env.SLOT_PROBE_TOKEN = PROBE_TOKEN
  const viaB = await f.request('/api/health', { headers: probe('b') })
  assert.equal(viaB.headers.get('x-repoing-slot'), 'b'); assert.equal(b.length, 1)
  assert.equal(b[0].headers['x-repoing-slot'], undefined); assert.equal(b[0].headers['x-repoing-slot-token'], undefined)
  assert.equal((await f.request('/api/health')).headers.get('x-repoing-slot'), 'a', 'the public still reaches the active slot')
  f.env.ACTIVE_SLOT = 'b'
  const viaA = await f.request('/stats', { headers: probe('a') })
  assert.equal(viaA.headers.get('x-repoing-slot'), 'a')
  const forwarded = f.runtime.calls.at(-1).request.headers
  assert.equal(forwarded.get('x-repoing-slot'), null); assert.equal(forwarded.get('x-repoing-slot-token'), null)
  // The Worker's own rules still apply to probes: a refused route stays refused.
  assert.equal((await f.request('/api/builders/claim', { method: 'POST', headers: probe('b') })).status, 403)
})

test('slots: a probe without the right secret, slot or binding is refused before any container', async () => {
  const f = await fixture(), b = slotB(f)
  f.env.SLOT_PROBE_TOKEN = PROBE_TOKEN
  const before = f.runtime.calls.length
  const refused = [probe('b', 'q'.repeat(40)), probe('b', PROBE_TOKEN.slice(1)), probe('c'), probe(''), { 'x-repoing-slot': 'b' },
    { 'x-repoing-slot-token': PROBE_TOKEN }, probe('B')]
  for (const headers of refused) {
    const response = await f.request('/api/health', { headers })
    assert.equal(response.status, 403, JSON.stringify(Object.keys(headers)))
    assert.deepEqual(await response.json(), { error: 'SLOT_PROBE_REFUSED' })
  }
  f.env.SLOT_PROBE_TOKEN = 'short'
  assert.equal((await f.request('/api/health', { headers: probe('b', 'short') })).status, 403, 'a secret under 32 characters disables probes')
  delete f.env.SLOT_PROBE_TOKEN
  assert.equal((await f.request('/api/health', { headers: probe('b') })).status, 403, 'no secret, no probes')
  f.env.SLOT_PROBE_TOKEN = PROBE_TOKEN; delete f.env.PUBLIC_SITE_B
  assert.equal((await f.request('/api/health', { headers: probe('b') })).status, 403, 'probing an unbound slot b')
  assert.equal(f.runtime.calls.length, before); assert.equal(b.length, 0)
})

test('slots: flipping ACTIVE_SLOT or the probe secret never restarts a container', async () => {
  const f = await fixture(); slotB(f)
  await f.request('/stats')
  const starts = f.runtime.starts, destroys = f.runtime.destroys ?? 0, identity = f.storage.get('review-bindings-sha256')
  for (const [key, value] of [['ACTIVE_SLOT', 'b'], ['ACTIVE_SLOT', 'a'], ['SLOT_PROBE_TOKEN', PROBE_TOKEN]]) {
    f.env[key] = value
    await f.request('/stats', { headers: key === 'SLOT_PROBE_TOKEN' ? probe('a') : {} })
  }
  assert.equal(f.runtime.starts, starts); assert.equal(f.runtime.destroys ?? 0, destroys)
  assert.equal(f.storage.get('review-bindings-sha256'), identity)
})

test('slots: slot b is the same container class under its own name', async () => {
  const f = await fixture()
  assert.equal(Object.getPrototypeOf(f.module.PublicSiteB), f.module.PublicSite)
})

test('slots: only a probe may restart a slot, only the inactive one, and only by POST', async () => {
  const f = await fixture(), b = slotB(f)
  f.env.SLOT_PROBE_TOKEN = PROBE_TOKEN
  const restart = (slot, options = {}) => f.request('/__slot/restart', { method: 'POST', headers: probe(slot), ...options })
  const done = await restart('b')
  assert.equal(done.status, 200); assert.deepEqual(await done.json(), { restarted: 'b' }); assert.deepEqual(b.at(-1), { restart: true })
  const live = await restart('a')
  assert.equal(live.status, 409); assert.deepEqual(await live.json(), { error: 'SLOT_IS_LIVE' })
  assert.equal((await f.request('/__slot/restart', { method: 'POST' })).status, 403, 'no probe headers')
  assert.equal((await restart('b', { method: 'GET' })).status, 403, 'GET')
  assert.equal((await restart('b', { headers: probe('b', 'q'.repeat(40)) })).status, 403, 'wrong secret')
  assert.equal(b.filter(call => call.restart).length, 1)
  // Slot a restarts for real when b is live: the next request starts a fresh container with the same environment.
  await f.request('/stats', { headers: probe('a') })
  const starts = f.runtime.starts
  f.env.ACTIVE_SLOT = 'b'
  assert.equal((await restart('a')).status, 200)
  assert.equal(f.runtime.env, null)
  await f.request('/stats', { headers: probe('a') })
  assert.equal(f.runtime.starts, starts + 1)
})

// Holders Earn (owner, 2026-10-27): an optional switch like Burn, off unless 'true'; forwarded only with Hooks and open
// launches on; a binding that is neither 'true' nor 'false' closes the site.
test('HOOK_HOLDERS_ENABLED is off by default and forwarded only with Hooks and open launches on', async () => {
  const f = await fixture()
  Object.assign(f.env, { EXISTING_MARKET_TRADING_STAGE: 'live' }, hookBindings())
  const forwarded = async () => { const response = await f.request('/hooks/new'); assert.equal(response.status, 200); return f.runtime.calls.at(-1).env.HOOK_HOLDERS_ENABLED }
  assert.equal(await forwarded(), 'false', 'absent: off, and Hooks stay on')
  f.env.HOOK_HOLDERS_ENABLED = 'false'; assert.equal(await forwarded(), 'false')
  f.env.HOOK_HOLDERS_ENABLED = 'true'; assert.equal(await forwarded(), 'true')
  f.env.HOOK_OPEN_LAUNCHES = 'false'; assert.equal(await forwarded(), 'false', 'no open launches, no Holders Earn')
  Object.assign(f.env, hookBindings(), { HOOK_HOLDERS_ENABLED: 'yes' })
  assert.equal((await f.request('/explore')).status, 503)
  Object.assign(f.env, { HOOK_HOLDERS_ENABLED: 'true', HOOKS_RECOVERY_ENABLED: 'false' })
  assert.equal((await (await f.request()).json()).HOOK_HOLDERS_ENABLED, 'false', 'Hooks off: off')
})

test('slots: an unset Holders switch leaves a running container\'s identity as it was (no restart)', async () => {
  const f = await fixture()
  Object.assign(f.env, { EXISTING_MARKET_TRADING_STAGE: 'live' }, hookBindings())
  await f.request('/hooks/new')
  const starts = f.runtime.starts, identity = f.storage.get('review-bindings-sha256')
  for (const name of ['HOOK_HOLDERS_ENABLED_A', 'HOOK_HOLDERS_ENABLED_B', 'HOOKLAB_STACK_BUNDLE_SHA256_B']) {
    f.env[name] = name.startsWith('HOOKLAB') ? 'c'.repeat(64) : 'true'
    if (name.endsWith('_A')) { delete f.env[name]; continue }
    await f.request('/hooks/new')
  }
  assert.equal(f.runtime.starts, starts, 'slot b names never touch slot a'); assert.equal(f.storage.get('review-bindings-sha256'), identity)
})

// A release that carries a new stack bundle (or a new switch) names it for its own slot. The live slot's bindings stay
// byte-for-byte as they were, so the deploy never restarts it; the release slot starts with its own.
test('slots: a slot-scoped bundle hash and Holders switch reach only their slot; the other slot is not restarted', async () => {
  const f = await fixture()
  Object.assign(f.env, { EXISTING_MARKET_TRADING_STAGE: 'live' }, hookBindings(), { SLOT_PROBE_TOKEN: PROBE_TOKEN })
  const seen = []
  f.env.PUBLIC_SITE_B = { getByName() { return { async fetchWithReviewBindings(request, bindings) { seen.push(bindings); return new Response('slot b') } } } }
  await f.request('/hooks/new')
  const starts = f.runtime.starts, destroys = f.runtime.destroys ?? 0, identity = f.storage.get('review-bindings-sha256')
  Object.assign(f.env, { HOOKLAB_STACK_BUNDLE_SHA256_B: 'c'.repeat(64), HOOK_HOLDERS_ENABLED_B: 'true' })
  const live = await f.request('/hooks/new')
  assert.equal(live.headers.get('x-repoing-slot'), 'a')
  assert.equal(f.runtime.starts, starts); assert.equal(f.runtime.destroys ?? 0, destroys); assert.equal(f.storage.get('review-bindings-sha256'), identity)
  const env = f.runtime.calls.at(-1).env
  assert.equal(env.HOOKLAB_STACK_BUNDLE_SHA256, 'b'.repeat(64)); assert.equal(env.HOOK_HOLDERS_ENABLED, 'false')
  assert.equal((await f.request('/hooks/new', { headers: probe('b') })).headers.get('x-repoing-slot'), 'b')
  assert.equal(seen.at(-1).HOOKLAB_STACK_BUNDLE_SHA256, 'c'.repeat(64)); assert.equal(seen.at(-1).HOOK_HOLDERS_ENABLED, 'true')
  // Flip to b and back: slot a's identity is still the same, so it is still not restarted.
  f.env.ACTIVE_SLOT = 'b'
  assert.equal((await f.request('/hooks/new')).headers.get('x-repoing-slot'), 'b')
  assert.equal(seen.at(-1).HOOKLAB_STACK_BUNDLE_SHA256, 'c'.repeat(64))
  f.env.ACTIVE_SLOT = 'a'; await f.request('/hooks/new')
  assert.equal(f.runtime.starts, starts); assert.equal(f.storage.get('review-bindings-sha256'), identity)
  // A slot-a name restarts slot a with it (that slot's own release), and a bad value closes only that slot.
  f.env.HOOKLAB_STACK_BUNDLE_SHA256_A = 'd'.repeat(64)
  await f.request('/hooks/new', { headers: probe('a') })
  assert.equal(f.runtime.starts, starts + 1); assert.equal(f.runtime.calls.at(-1).env.HOOKLAB_STACK_BUNDLE_SHA256, 'd'.repeat(64))
  f.env.HOOKLAB_STACK_BUNDLE_SHA256_A = 'not-a-hash'
  assert.equal((await f.request('/hooks/new', { headers: probe('a') })).status, 503)
  assert.equal((await f.request('/hooks/new', { headers: probe('b') })).status, 200)
})

test('read-only public data the pages link to: GET/HEAD reach the site with their query, without cookies; nothing else does', async () => {
  const f = await fixture()
  const paths = [`/api/v1/markets/${mint}/liquidity`, `/api/v1/markets/${mint}/transparency`, '/api/v1/launches/events?after=5', '/launches.atom', '/launches.ics?repos=1278009399']
  for (const path of paths) for (const method of ['GET', 'HEAD']) {
    assert.equal((await f.request(path, { method, headers: { cookie: 'repoing_github=session; __Host-hook-wallet-session=x' } })).status, 200, `${method} ${path}`)
    const upstream = f.runtime.calls.at(-1).request
    assert.equal(new URL(upstream.url).pathname + new URL(upstream.url).search, path); assert.equal(upstream.headers.get('cookie'), null)
  }
  const before = f.runtime.calls.length
  for (const path of paths) for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await f.request(path, { method })).status, 403, `${method} ${path}`)
  for (const path of ['/api/v1/markets/notamint/liquidity', `/api/v1/markets/${mint}/quote`, '/launches.atomx', '/api/v1/launches/events/x', '/api/v1/webhooks/signing-key'])
    assert.equal((await f.request(path)).status, 403, path)
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await f.request('/launches/manage', { method })).status, 403, `${method} /launches/manage`)
  assert.equal(f.runtime.calls.length, before, 'nothing refused reaches the container')
})

// An in-memory Cache API: what the edge would keep (body, headers, the stored-at time) per key URL.
function fakeEdgeCache() {
  const entries = new Map()
  return { entries, default: {
    async match(key) { const e = entries.get(key.url); return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined },
    async put(key, response) { entries.set(key.url, { body: await response.text(), status: response.status, headers: Object.fromEntries(response.headers) }) },
  } }
}
async function edgeFixture() {
  globalThis.__edgeCaches = fakeEdgeCache()
  try { const f = await fixture(); f.env.EXISTING_MARKET_TRADING_STAGE = 'live'; return { ...f, cache: globalThis.__edgeCaches } }
  finally { delete globalThis.__edgeCaches }
}
const age = (cache, url, seconds) => { const e = cache.entries.get(url); e.headers['x-edge-stored-at'] = String(Date.now() - seconds * 1000) }

test('edge cache: public pages and build assets answer from the edge after the first view; the browser still never caches pages', async () => {
  const f = await edgeFixture()
  const first = await f.request('/explore'), calls = f.runtime.calls.length, firstBody = await first.clone().text()
  assert.equal(first.status, 200); assert.equal(first.headers.get('x-edge-cache'), 'MISS'); assert.equal(first.headers.get('cache-control'), 'no-store')
  const second = await f.request('/explore')
  assert.equal(second.headers.get('x-edge-cache'), 'HIT'); assert.equal(second.headers.get('cache-control'), 'no-store')
  assert.equal(await second.text(), firstBody)
  assert.equal(f.runtime.calls.length, calls, 'a hit never reaches the container')
  assert.equal(second.headers.get('x-repoing-slot'), 'a'); assert.equal(second.headers.get('set-cookie'), null)
  const head = await f.request('/explore', { method: 'HEAD' })
  assert.equal(head.headers.get('x-edge-cache'), 'HIT'); assert.equal(await head.text(), '')
  await f.request('/_next/static/chunks/app-1a2b.js')
  const asset = await f.request('/_next/static/chunks/app-1a2b.js')
  assert.equal(asset.headers.get('x-edge-cache'), 'HIT'); assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.ok([...f.cache.entries.keys()].includes('https://repo.ing/__edge/a/explore'))
  assert.ok([...f.cache.entries.keys()].includes('https://repo.ing/__edge/any/_next/static/chunks/app-1a2b.js'))
})

test('edge cache: live, private and navigation requests are never stored or served from the edge', async () => {
  const f = await edgeFixture()
  for (const [path, options] of [['/api/health', {}], [`/api/market/${mint}/curve`, {}], ['/api/wallet/overview', {}], ['/explore', { headers: { rsc: '1' } }],
    ['/explore?_rsc=abc', {}], ['/explore', { headers: { range: 'bytes=0-10' } }], ['/api/repo-search?q=x', {}]]) {
    await f.request(path, options); await f.request(path, options)
  }
  assert.deepEqual([...f.cache.entries.keys()], [])
  const before = f.runtime.calls.length
  await f.request('/stats'); await f.request('/stats')
  assert.equal(f.runtime.calls.length, before + 1)
  const posted = await f.request('/stats', { method: 'POST' })
  assert.notEqual(posted.headers.get('x-edge-cache'), 'HIT')
})

test('edge cache: a stale copy answers at once while one request refreshes it; an old copy covers a site error', async () => {
  const f = await edgeFixture()
  await f.request('/stats')
  age(f.cache, 'https://repo.ing/__edge/a/stats', 30)
  const calls = f.runtime.calls.length
  const stale = await f.request('/stats')
  assert.equal(stale.headers.get('x-edge-cache'), 'STALE'); assert.equal(f.runtime.calls.length, calls + 1, 'one background refresh')
  assert.ok(Number(f.cache.entries.get('https://repo.ing/__edge/a/stats').headers['x-edge-stored-at']) > Date.now() - 5000, 'refreshed copy stored')
  age(f.cache, 'https://repo.ing/__edge/a/stats', 300)
  f.env.PUBLIC_SITE = { getByName() { return { async fetchWithReviewBindings() { throw Error('container down') } } } }
  const covered = await f.request('/stats')
  assert.equal(covered.status, 200); assert.equal(covered.headers.get('x-edge-cache'), 'STALE-IF-ERROR')
  age(f.cache, 'https://repo.ing/__edge/a/stats', 3600)
  assert.equal((await f.request('/stats')).status, 503, 'too old: the error shows')
})

test('edge cache: pages are kept per slot, so a flip never serves the other build; probes always reach their slot', async () => {
  const f = await edgeFixture()
  await f.request('/explore')
  f.env.PUBLIC_SITE_B = { getByName() { return { async fetchWithReviewBindings() { return new Response('slot b page') } } } }
  f.env.ACTIVE_SLOT = 'b'
  const flipped = await f.request('/explore')
  assert.equal(flipped.headers.get('x-edge-cache'), 'MISS'); assert.equal(await flipped.text(), 'slot b page')
  f.env.SLOT_PROBE_TOKEN = 's'.repeat(40)
  const probed = await f.request('/explore', { headers: { 'x-repoing-slot': 'a', 'x-repoing-slot-token': 's'.repeat(40) } })
  assert.equal(probed.headers.get('x-edge-cache'), null); assert.equal(probed.headers.get('x-repoing-slot'), 'a')
})

test('read-only views the pages poll answer GET/HEAD without cookies; their writes stay closed; beacons are dropped', async () => {
  const f = await fixture()
  const reads = [`/api/holder-notes/${mint}`, `/api/holder-notes/${mint}?wallet=${mint}`, `/api/holder-notes/${mint}?offset=20`]
  for (const path of reads) for (const method of ['GET', 'HEAD']) {
    assert.equal((await f.request(path, { method, headers: { cookie: 'repoing_github=session' } })).status, 200, `${method} ${path}`)
    const upstream = f.runtime.calls.at(-1).request
    assert.equal(upstream.headers.get('cookie'), null); assert.equal(upstream.method, method)
  }
  const before = f.runtime.calls.length
  for (const path of reads.slice(0, 1)) for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await f.request(path, { method, headers: { origin: 'https://repo.ing', 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' })).status, 403, `${method} ${path}`)
  for (const path of ['/api/participation/1278009399', '/api/allocation/1278009399', '/api/discovery/1265419522', '/api/holder-notes/x']) assert.equal((await f.request(path)).status, 403, path)
  const beacon = await f.request('/api/funnel', { method: 'POST', body: '{"step":"view"}' })
  assert.equal(beacon.status, 204)
  assert.equal((await f.request('/api/funnel')).status, 403)
  assert.equal(f.runtime.calls.length, before, 'no write, refusal or beacon reaches the container')
  const csp = (await f.request('/')).headers.get('content-security-policy')
  assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/static\.cloudflareinsights\.com;/); assert.match(csp, /connect-src 'self' https:\/\/cloudflareinsights\.com;/)
})

test('the browser tab and home-screen icons every page links answer, and are kept at the edge as images', async () => {
  const f = await fixture()
  for (const path of ['/icon.png?icon.2hpvt1fxt-cib.png', '/apple-icon.png?apple-icon.172--m10t-r9q.png']) for (const method of ['GET', 'HEAD'])
    assert.equal((await f.request(path, { method })).status, 200, `${method} ${path}`)
  assert.equal((await f.request('/icon.png', { method: 'POST' })).status, 403)
})
