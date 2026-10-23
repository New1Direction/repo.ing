import { Container } from '@cloudflare/containers'
// Wrangler Text module: preserve exact bytes without a >5KB environment binding.
import custodyManifest from '../config/existing-market-custody.json'

// Review/test-only successor to the accepted recovery wrapper. Keep the existing
// PublicSite/PUBLIC_SITE/public-readonly migration identity. This module is not
// a live activation mechanism: changing a binding to `live` fails closed.
const pages = new Set(['/', '/launch', '/explore', '/find-repos', '/discoverers', '/referrals', '/agents', '/wallet', '/builders', '/stats', '/how-it-works', '/about', '/programmable-coins', '/hooks'])
const mint = '[1-9A-HJ-NP-Za-km-z]{32,44}'
const tokenPage = new RegExp(`^/token/${mint}$`)
const publicMarketApi = new RegExp(`^/api/market/${mint}/(trades|metrics|curve|traders|activity|pulse)$`)
const tokenImage = new RegExp(`^/api/token-image/${mint}$`)
const marketBalance = new RegExp(`^/api/market/${mint}/balance$`)
const custodyDigest = '2c31354ba8009acb0da1319b068f479216b0615120328510cba50665f0ecd888'
// Public config identities from the reviewed inputs.json; never caller-selected.
const primaryConfig = '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M'
const legacyConfigs = ['8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3', '261xpZVAz5k3ZfwfxXdgkgLowiH6NUzFEHtihhD4YMq1', 'D7oz8xQ4seaNaEgiDS4fu3YJfmUvR5iPuznxuqKV4u1c']
const bindingNames = ['PUBLIC_DATABASE_URL', 'TRADING_DATABASE_URL', 'DBC_CONFIG', 'DBC_LEGACY_CONFIGS', 'TRADING_CUSTODY_RECOVERY_SHA256', 'TRADING_CUSTODY_RECOVERY_JSON', 'EXISTING_MARKET_TRADING_ONLY', 'EXISTING_MARKET_TRADING_STAGE']
const testBindingNames = ['EXISTING_MARKET_TEST_PLAN', 'EXISTING_MARKET_TEST_SUBMISSION', 'EXISTING_MARKET_TEST_ACCESS_TOKEN']

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

function snapshotBindings(env) {
  return Object.fromEntries([...bindingNames, ...testBindingNames].map(name => [name, env[name]]))
}

async function validateBindings(bindings) {
  if (bindings.EXISTING_MARKET_TRADING_STAGE === 'test' &&
    (bindings.EXISTING_MARKET_TEST_PLAN !== 'existing-markets-six-swaps-v1' ||
      !['false', 'true'].includes(bindings.EXISTING_MARKET_TEST_SUBMISSION) ||
      !/^[a-f0-9]{64}$/.test(bindings.EXISTING_MARKET_TEST_ACCESS_TOKEN ?? ''))) throw Error('Test bindings missing or mismatched')
  if (bindingNames.some(name => typeof bindings[name] !== 'string' || !bindings[name].trim())
    || bindings.PUBLIC_DATABASE_URL === bindings.TRADING_DATABASE_URL
    || bindings.EXISTING_MARKET_TRADING_ONLY !== 'true'
    || !['review', 'test'].includes(bindings.EXISTING_MARKET_TRADING_STAGE)
    || bindings.DBC_CONFIG !== primaryConfig
    || bindings.DBC_LEGACY_CONFIGS.split(',').sort().join(',') !== [...legacyConfigs].sort().join(',')
    || bindings.TRADING_CUSTODY_RECOVERY_SHA256 !== custodyDigest
    || await sha256(bindings.TRADING_CUSTODY_RECOVERY_JSON) !== custodyDigest) {
    throw Error('Review bindings missing or mismatched')
  }
}

// Integrated from the prepared edge-policy.mjs, narrowed to review only.
// A null result MUST fall back to the unchanged public GET/HEAD allowlist.
// A Request is the only result allowed to bypass that read-only list.
async function tradeBoundary(request, bindings) {
  const stage = bindings.EXISTING_MARKET_TRADING_STAGE
  const url = new URL(request.url)
  const deny = () => Response.json({ error: 'TRADING_EXECUTION_DISABLED' }, { status: 403 })
  if (request.headers.has('upgrade')) return deny()
  const active = ['review', 'test'].includes(stage)
  const balance = url.pathname === '/api/wallet/balance' || marketBalance.test(url.pathname)
  const search = url.pathname === '/api/repo-search'
  const mcp = url.pathname === '/api/mcp/readonly'
  if (['GET', 'HEAD'].includes(request.method) && !(active && balance)) return null
  if (!search && !mcp && (!active || (!balance && url.pathname !== '/api/trade') || (balance && !['GET', 'HEAD'].includes(request.method)))) return deny()
  if (!search && !mcp && stage === 'test' && (!/^[a-f0-9]{64}$/.test(bindings.EXISTING_MARKET_TEST_ACCESS_TOKEN ?? '') ||
    request.headers.get('authorization') !== `Bearer ${bindings.EXISTING_MARKET_TEST_ACCESS_TOKEN}`)) return deny()
  let body
  if (!balance) {
    if (request.method !== 'POST' || (request.headers.get('origin') !== url.origin && !(mcp && !request.headers.has('origin')))
      || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return deny()
    const reader = request.body?.getReader()
    if (!reader) return deny()
    let size = 0
    const chunks = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > (search ? 2048 : 16384)) { await reader.cancel(); return deny() }
        chunks.push(value)
      }
    } catch { return deny() } finally { reader.releaseLock() }
    body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    let payload
    try { payload = JSON.parse(new TextDecoder().decode(body)) } catch { return deny() }
    const actions = stage === 'test' ? ['prepare', 'status', ...(bindings.EXISTING_MARKET_TEST_SUBMISSION === 'true' ? ['submit'] : [])]
      : ['depth', 'quote', 'costs', 'prepare', 'status']
    if (!payload || (!search && !mcp && !actions.includes(payload.action))) return deny()
  }
  const headers = new Headers()
  // cf-connecting-ip is set by Cloudflare at ingress; never trust caller-supplied
  // x-forwarded-for, x-real-ip, cookies, auth or arbitrary internal headers.
  for (const name of ['accept', 'content-type', 'origin', 'cf-connecting-ip']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  }
  if (mcp) {
    if (request.headers.has('mcp-protocol-version')) headers.set('mcp-protocol-version', request.headers.get('mcp-protocol-version'))
    if (request.headers.has('cf-connecting-ip')) headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip'))
  }
  if (!search && !mcp && stage === 'test') headers.set('authorization', request.headers.get('authorization'))
  return new Request(request.url, { method: request.method, headers, body, redirect: 'manual' })
}

export class PublicSite extends Container {
  defaultPort = 3000
  sleepAfter = '2m'
  enableInternet = true

  // Do not let accidental raw binding fetches bypass environment validation.
  async fetch() {
    return Response.json({ error: 'TRADING_REVIEW_BINDINGS_REQUIRED' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
    })
  }

  // Binding-only RPC; no public route, header, query or body selects env values.
  async fetchWithReviewBindings(request, suppliedBindings) {
    const bindings = snapshotBindings(suppliedBindings)
    const appOrigin = 'https://repo.ing'
    // Keep dispatch inside the same concurrency gate as refresh: releasing it
    // first permits a second RPC to replace envVars before this fetch starts.
    return this.ctx.blockConcurrencyWhile(async () => {
      await validateBindings(bindings)
      const fingerprint = await sha256(JSON.stringify({ ...bindings, APP_ORIGIN: appOrigin }))
      if (await this.ctx.storage.get('review-bindings-sha256') !== fingerprint
        || await this.ctx.storage.get('database-binding-sha256') !== undefined) {
        // Unknown state (including the old database-only key) forces restart.
        // A process retains startup env across Worker/image updates.
        await this.destroy()
        // Force the accepted wrapper to restart on rollback even when its
        // reader binding is unchanged. Its key also detects re-entry to review.
        await this.ctx.storage.delete('database-binding-sha256')
        await this.ctx.storage.put('review-bindings-sha256', fingerprint)
      }
      this.envVars = {
        DATABASE_URL: bindings.PUBLIC_DATABASE_URL,
        TRADING_DATABASE_URL: bindings.TRADING_DATABASE_URL,
        APP_ORIGIN: appOrigin,
        DBC_CONFIG: bindings.DBC_CONFIG,
        DBC_LEGACY_CONFIGS: bindings.DBC_LEGACY_CONFIGS,
        TRADING_CUSTODY_RECOVERY_SHA256: bindings.TRADING_CUSTODY_RECOVERY_SHA256,
        EXISTING_MARKET_TRADING_ONLY: bindings.EXISTING_MARKET_TRADING_ONLY,
        EXISTING_MARKET_TRADING_STAGE: bindings.EXISTING_MARKET_TRADING_STAGE,
        EXISTING_MARKET_TEST_PLAN: bindings.EXISTING_MARKET_TRADING_STAGE === 'test' ? bindings.EXISTING_MARKET_TEST_PLAN : '',
        EXISTING_MARKET_TEST_SUBMISSION: bindings.EXISTING_MARKET_TRADING_STAGE === 'test' ? bindings.EXISTING_MARKET_TEST_SUBMISSION : 'false',
        EXISTING_MARKET_TEST_ACCESS_TOKEN: bindings.EXISTING_MARKET_TRADING_STAGE === 'test' ? bindings.EXISTING_MARKET_TEST_ACCESS_TOKEN : '',
        SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
        HOOK_PRODUCTION_BOOTSTRAP: 'false',
        HOOK_NATIVE_LAUNCH_ENABLED: 'false',
        HOOK_NATIVE_LAUNCHES_ENABLED: 'false',
        HOOK_INCLUSIVE_TRADING_ENABLED: 'false',
        HOOK_NATIVE_TRADING_ENABLED: 'false',
        HOOK_WALLET_FUNDING_ENABLED: 'false',
        HOOK_WALLET_IDENTITY_ENABLED: 'false',
        HOOK_SELECTED_HOOKS_ENABLED: 'false',
      }
      const upstream = await super.fetch(request)
      const response = new Response(upstream.body, upstream)
      response.headers.set('X-Repoing-Runtime-Policy', 'discovery-origin-v1')
      return response
    })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    // During recovery the legacy MCP path is an alias, never the launch-review handler.
    if (url.pathname === '/api/mcp') {
      url.pathname = '/api/mcp/readonly'
      request = new Request(url, request)
    }
    const headers = {
      'Cache-Control': 'no-store',
      'X-Repoing-Mode': 'existing-market-trading-review',
      'X-Repoing-Snapshot': '2026-10-22T14:48:06Z',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
    }
    if (url.hostname.endsWith('.workers.dev')) headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    const bindings = snapshotBindings({ ...env, TRADING_CUSTODY_RECOVERY_JSON: custodyManifest })
    const boundary = await tradeBoundary(request, bindings)
    if (boundary instanceof Response) {
      for (const [key, value] of Object.entries(headers)) boundary.headers.set(key, value)
      return boundary
    }
    let upstream = boundary
    if (boundary === null) {
      const allowed = pages.has(url.pathname) || tokenPage.test(url.pathname)
        || publicMarketApi.test(url.pathname) || tokenImage.test(url.pathname)
        || /^\/api\/repo-logo\/\d+$/.test(url.pathname)
        || ['/api/health', '/api/mcp/readonly', '/api/growth', '/api/repo-search', '/api/wallet/overview'].includes(url.pathname)
        || ['/favicon.ico', '/brand-cat.webp', '/gitcat.png', '/launch-on-repoing.svg', '/opengraph-image.png'].includes(url.pathname)
        || /^\/(art|badges|launch-icons|hook-icons|credits)\/[a-z0-9-]+\.(webp|png)$/.test(url.pathname)
        || ['/video/repoing-flywheel-poster.jpg', '/video/repoing-flywheel.mp4'].includes(url.pathname)
        || url.pathname.startsWith('/_next/static/')
      if (!allowed || (url.pathname === '/builders' && url.searchParams.has('owner'))) {
        return Response.json({ error: 'RECOVERY_ROUTE_DISABLED' }, { status: 403, headers })
      }
      const upstreamHeaders = new Headers()
      for (const name of ['accept', 'accept-language', 'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url', 'range', 'if-none-match', 'if-modified-since']) {
        if (request.headers.has(name)) upstreamHeaders.set(name, request.headers.get(name))
      }
      upstream = new Request(request.url, { method: request.method, headers: upstreamHeaders, redirect: 'manual' })
    }
    let response
    let failureStage = 'bindings'
    try {
      await validateBindings(bindings)
      failureStage = 'dispatch'
      response = await env.PUBLIC_SITE.getByName('public-readonly').fetchWithReviewBindings(upstream, bindings)
    } catch (error) {
      // Includes missing RPC during propagation, invalid bindings and failed
      // restart/storage/boot. Never fall back to raw fetch or the old DB-only RPC.
      // Only fixed categories are public; never expose exception text or bindings.
      const reason = error?.message?.includes('RPC receiver does not implement') ? 'rpc-version' : failureStage
      return Response.json({ error: 'TRADING_REVIEW_UNAVAILABLE', reason }, { status: 503, headers: { ...headers, 'Retry-After': '5' } })
    }
    const safe = new Response(response.body, response)
    safe.headers.delete('set-cookie')
    for (const [key, value] of Object.entries(headers)) safe.headers.set(key, value)
    if (safe.headers.get('Content-Type')?.includes('text/html')) {
      return new HTMLRewriter().on('body', {
        element(body) {
          body.setAttribute('style', `${body.getAttribute('style') || ''};padding-bottom:80px`)
          const notice = bindings.EXISTING_MARKET_TRADING_STAGE === 'test'
            ? `Authorized six-swap test only · ${bindings.EXISTING_MARKET_TEST_SUBMISSION === 'true' ? 'Operator-gated wallet test.' : 'Unsigned preparation only. Do not sign.'} Public trading, launches, claims and replay are paused.`
            : 'Existing-market trading review · Unsigned preparation only. Do not sign. Submission, launches, claims and replay are paused.'
          body.append(`<aside role="note" id="recovery-notice" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#fff3cd;color:#332500;border-top:1px solid #b89b46;font:600 13px/1.4 system-ui;text-align:center">${notice} Market history snapshot through Oct 22, 14:48 UTC — not live accounting.</aside>`, { html: true })
        },
      }).transform(safe)
    }
    return safe
  },
}
