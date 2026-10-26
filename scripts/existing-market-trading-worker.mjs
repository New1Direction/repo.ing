import { Container } from '@cloudflare/containers'
// Wrangler Text module: preserve exact bytes without a >5KB environment binding.
import custodyManifest from '../config/existing-market-custody.json'

// Existing-market recovery wrapper. Keep PublicSite/PUBLIC_SITE/public-readonly
// identity and the closed launch/claim/replay boundaries in every stage.
const pages = new Set(['/', '/launch', '/explore', '/find-repos', '/discoverers', '/referrals', '/agents', '/wallet', '/builders', '/stats', '/how-it-works', '/about', '/programmable-coins', '/hooks'])
const mint = '[1-9A-HJ-NP-Za-km-z]{32,44}'
const tokenPage = new RegExp(`^/token/${mint}$`)
// events: the read-only live hint stream (app/api/market/[mint]/events) that tells an open chart a trade was indexed.
const publicMarketApi = new RegExp(`^/api/market/${mint}/(trades|metrics|curve|traders|activity|pulse|events)$`)
const tokenImage = new RegExp(`^/api/token-image/${mint}$`)
const tokenMetadata = new RegExp(`^/api/token-metadata/${mint}$`)
const marketBalance = new RegExp(`^/api/market/${mint}/balance$`)
const custodyDigest = '2c31354ba8009acb0da1319b068f479216b0615120328510cba50665f0ecd888'
// Public config identities; never caller-selected. DBC_CONFIG is the custody-safe config new launches use (fee claimer: the
// multisig vault; 3ZESQ, the 20%-extra early fee). The previous custody config Fy2bh and every config of the reviewed trading
// manifest, the retired 2YbBp included, are legacy: read and traded, never the current config again. Any other pair of values
// fails closed. The trading manifest itself is unchanged.
const primaryConfig = '3ZESQPHgao8ZyyEU4tJSwDmrVC3nunhGnTFVGdarRDbZ'
const legacyConfigs = ['Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7', '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M', '8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3',
  '261xpZVAz5k3ZfwfxXdgkgLowiH6NUzFEHtihhD4YMq1', 'D7oz8xQ4seaNaEgiDS4fu3YJfmUvR5iPuznxuqKV4u1c']
// Public, keyless second provider for new-market admission (app/lib/trading-recovery.mjs). Empty when it would not be
// independent of the primary RPC, which keeps rule-admitted markets refused.
const PUBLIC_VERIFIER = 'https://api.mainnet-beta.solana.com'
const verificationRpc = primary => {
  try { return new URL(primary).hostname === new URL(PUBLIC_VERIFIER).hostname ? '' : PUBLIC_VERIFIER } catch { return '' }
}
const bindingNames = ['PUBLIC_DATABASE_URL', 'TRADING_DATABASE_URL', 'DBC_CONFIG', 'DBC_LEGACY_CONFIGS', 'TRADING_CUSTODY_RECOVERY_SHA256', 'TRADING_CUSTODY_RECOVERY_JSON', 'EXISTING_MARKET_TRADING_ONLY', 'EXISTING_MARKET_TRADING_STAGE']
const testBindingNames = ['EXISTING_MARKET_TEST_PLAN', 'EXISTING_MARKET_TEST_SUBMISSION', 'EXISTING_MARKET_TEST_ACCESS_TOKEN']
const launchBindingNames = ['ORDINARY_LAUNCH_RECOVERY_ENABLED', 'ORDINARY_LAUNCH_DATABASE_URL', 'ORDINARY_LAUNCH_CONFIG', 'ORDINARY_LAUNCH_BOOTSTRAP_SECRET_KEY',
  'GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_INSTALLATION_ID']
const accountingBindingNames = ['ACCOUNTING_RECOVERY_ENABLED', 'ACCOUNTING_DATABASE_URL', 'ACCOUNTING_CUSTODY_SHA256']
// Builder claims (owner-approved, 2026-10-26): the claims-only database role, the GitHub OAuth client secret and the capped
// payout wallet. Present together or not at all; the claim routes below open only with them.
const claimBindingNames = ['CLAIMS_RECOVERY_ENABLED', 'CLAIMS_DATABASE_URL', 'GITHUB_APP_CLIENT_SECRET', 'BUILDER_PAYOUT_SECRET_KEY']
const claimsEnabled = bindings => bindings.EXISTING_MARKET_TRADING_STAGE === 'live' && bindings.CLAIMS_RECOVERY_ENABLED === 'true'
// The only routes that carry cookies, in and out (owner-approved list). Every other route keeps stripping both.
const claimPage = /^\/claim\/[1-9]\d{0,15}$/
const claimRoute = (url, method) => ['GET', 'HEAD'].includes(method)
  ? claimPage.test(url.pathname) || ['/api/github/start', '/api/github/callback'].includes(url.pathname)
  : method === 'POST' && ['/api/bind', '/api/claim/payout'].includes(url.pathname)
const ordinaryLaunchEnabled = bindings => bindings.EXISTING_MARKET_TRADING_STAGE === 'live' && bindings.ORDINARY_LAUNCH_RECOVERY_ENABLED === 'true'
const ordinaryRepoPath = path => {
  const id = /^\/(?:launch|api\/repo-images)\/([1-9]\d{0,15})$/.exec(path)?.[1]
  return Boolean(id && BigInt(id) <= 4503599627370495n)
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

function snapshotBindings(env) {
  return Object.fromEntries([...bindingNames, ...testBindingNames, ...launchBindingNames, ...accountingBindingNames, ...claimBindingNames, 'SOLANA_RPC_URL'].map(name => [name, env[name]]))
}

async function validateBindings(bindings) {
  if (bindings.SOLANA_RPC_URL !== undefined) {
    let url
    try { url = new URL(bindings.SOLANA_RPC_URL) } catch { /* Never log provider credentials. */ }
    if (!url || url.protocol !== 'https:' || url.hostname !== 'mainnet.helius-rpc.com' || url.port ||
        url.pathname !== '/' || url.username || url.password || url.hash ||
        url.searchParams.size !== 1 || !url.searchParams.get('api-key')) throw Error('Mainnet RPC binding mismatched')
  }
  if (bindings.ACCOUNTING_RECOVERY_ENABLED === 'true') {
    let url
    try { url = new URL(bindings.ACCOUNTING_DATABASE_URL) } catch { /* Never log credentials. */ }
    if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'repoing_ledger_reader' ||
        url.pathname !== '/repoing_operational' || url.searchParams.get('sslmode') !== 'verify-full' ||
        url.searchParams.size !== 1 || bindings.ACCOUNTING_CUSTODY_SHA256 !== custodyDigest) {
      throw Error('Accounting reader bindings missing or mismatched')
    }
  }
  if (bindings.ORDINARY_LAUNCH_RECOVERY_ENABLED === 'true') {
    let url
    try { url = new URL(bindings.ORDINARY_LAUNCH_DATABASE_URL) } catch { /* Refuse without logging credentials. */ }
    if (launchBindingNames.some(name => typeof bindings[name] !== 'string' || !bindings[name].trim()) ||
        !ordinaryLaunchEnabled(bindings) || bindings.ORDINARY_LAUNCH_CONFIG !== primaryConfig ||
        !url || !['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'repoing_ordinary_launcher' ||
        url.pathname !== '/repoing_operational' || url.searchParams.get('sslmode') !== 'verify-full' ||
        !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(bindings.ORDINARY_LAUNCH_BOOTSTRAP_SECRET_KEY ?? '')) {
      throw Error('Ordinary launch bindings missing or mismatched')
    }
  }
  if (bindings.CLAIMS_RECOVERY_ENABLED === 'true') {
    let url
    try { url = new URL(bindings.CLAIMS_DATABASE_URL) } catch { /* Refuse without logging credentials. */ }
    let payout = null
    try { payout = bindings.BUILDER_PAYOUT_SECRET_KEY?.trim().startsWith('[') ? JSON.parse(bindings.BUILDER_PAYOUT_SECRET_KEY) : null } catch { /* refused below */ }
    if (claimBindingNames.some(name => typeof bindings[name] !== 'string' || !bindings[name].trim()) || !claimsEnabled(bindings) ||
        !url || !['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'repoing_builder_claims' ||
        url.pathname !== '/repoing_operational' || url.searchParams.get('sslmode') !== 'verify-full' ||
        typeof bindings.GITHUB_APP_CLIENT_ID !== 'string' || !bindings.GITHUB_APP_CLIENT_ID.trim() ||
        !(Array.isArray(payout) ? payout.length === 64 && payout.every(b => Number.isInteger(b) && b >= 0 && b < 256)
          : /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(bindings.BUILDER_PAYOUT_SECRET_KEY))) {
      throw Error('Claims bindings missing or mismatched')
    }
  }
  if (bindings.EXISTING_MARKET_TRADING_STAGE === 'test' &&
    (bindings.EXISTING_MARKET_TEST_PLAN !== 'existing-markets-six-swaps-v1' ||
      !['false', 'true'].includes(bindings.EXISTING_MARKET_TEST_SUBMISSION) ||
      !/^[a-f0-9]{64}$/.test(bindings.EXISTING_MARKET_TEST_ACCESS_TOKEN ?? ''))) throw Error('Test bindings missing or mismatched')
  if (bindingNames.some(name => typeof bindings[name] !== 'string' || !bindings[name].trim())
    || bindings.PUBLIC_DATABASE_URL === bindings.TRADING_DATABASE_URL
    || bindings.EXISTING_MARKET_TRADING_ONLY !== 'true'
    || !['review', 'test', 'live'].includes(bindings.EXISTING_MARKET_TRADING_STAGE)
    || bindings.DBC_CONFIG !== primaryConfig
    || bindings.DBC_LEGACY_CONFIGS.split(',').sort().join(',') !== [...legacyConfigs].sort().join(',')
    || bindings.TRADING_CUSTODY_RECOVERY_SHA256 !== custodyDigest
    || await sha256(bindings.TRADING_CUSTODY_RECOVERY_JSON) !== custodyDigest) {
    throw Error('Review bindings missing or mismatched')
  }
}

// Only explicit trade actions bypass the public read-only policy.
// A null result MUST fall back to the unchanged public GET/HEAD allowlist.
// A Request is the only result allowed to bypass that read-only list.
async function tradeBoundary(request, bindings) {
  const stage = bindings.EXISTING_MARKET_TRADING_STAGE
  const url = new URL(request.url)
  const deny = () => Response.json({ error: 'TRADING_EXECUTION_DISABLED' }, { status: 403 })
  if (request.headers.has('upgrade')) return deny()
  const active = ['review', 'test', 'live'].includes(stage)
  const balance = url.pathname === '/api/wallet/balance' || marketBalance.test(url.pathname)
  const search = url.pathname === '/api/repo-search'
  const mcp = url.pathname === '/api/mcp/readonly'
  const imageUpload = ordinaryLaunchEnabled(bindings) && url.pathname.startsWith('/api/repo-images/') && ordinaryRepoPath(url.pathname)
  const launch = ordinaryLaunchEnabled(bindings) && (imageUpload || ['/api/launch', '/api/resolve'].includes(url.pathname))
  if (['GET', 'HEAD'].includes(request.method) && !(active && balance)) return null
  if (!search && !mcp && !launch && (!active || (!balance && url.pathname !== '/api/trade') || (balance && !['GET', 'HEAD'].includes(request.method)))) return deny()
  if (!search && !mcp && stage === 'test' && (!/^[a-f0-9]{64}$/.test(bindings.EXISTING_MARKET_TEST_ACCESS_TOKEN ?? '') ||
    request.headers.get('authorization') !== `Bearer ${bindings.EXISTING_MARKET_TEST_ACCESS_TOKEN}`)) return deny()
  let body
  if (!balance) {
    if (request.method !== 'POST' || (request.headers.get('origin') !== url.origin && !(mcp && !request.headers.has('origin')))
      || (!imageUpload && request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')) return deny()
    const reader = request.body?.getReader()
    if (!reader) return deny()
    let size = 0
    const chunks = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > (imageUpload ? 4_000_000 : launch && url.pathname === '/api/launch' ? 600_000 : search || launch ? 2048 : 16384)) { await reader.cancel(); return deny() }
        chunks.push(value)
      }
    } catch { return deny() } finally { reader.releaseLock() }
    body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    let payload
    if (!imageUpload) {
      try { payload = JSON.parse(new TextDecoder().decode(body)) } catch { return deny() }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return deny()
    }
    const actions = stage === 'test' ? ['prepare', 'status', ...(bindings.EXISTING_MARKET_TEST_SUBMISSION === 'true' ? ['submit'] : [])]
      : ['depth', 'quote', 'costs', 'prepare', 'status', ...(stage === 'live' ? ['submit'] : [])]
    if (launch) {
      // quote is read-only: the first-buy preview, itself gated by the new-market buy switch in the app.
      if (url.pathname === '/api/launch' && !['quote', 'prepare', 'submit', 'cancel'].includes(payload.action)) return deny()
    } else if (!search && !mcp && !actions.includes(payload.action)) return deny()
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

// A claim route request: the session cookie in, same-origin JSON bodies of at most 16 KB for the two POSTs. null refuses it.
async function claimRequest(request, url) {
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'cookie', 'content-type', 'origin', 'rsc', 'next-router-state-tree',
    'next-router-prefetch', 'next-url', 'cf-connecting-ip']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  }
  if (request.method !== 'POST') return new Request(request.url, { method: request.method, headers, redirect: 'manual' })
  if (request.headers.get('origin') !== url.origin || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return null
  const body = await request.arrayBuffer().catch(() => null)
  if (!body || body.byteLength > 16384) return null
  return new Request(request.url, { method: 'POST', headers, body, redirect: 'manual' })
}

const STALE_CONTAINER = /^(Error proxying request to container|Container suddenly disconnected)/
// Two interchangeable containers (max_instances 2, rollout steps [50, 100]): a deploy replaces one at a time.
const SITE_NAMES = ['public-readonly', 'public-readonly-b']
const RESTARTING = 'X-Repoing-Restarting'

export class PublicSite extends Container {
  defaultPort = 3000
  sleepAfter = '2m'
  enableInternet = true
  pendingDispatches = new Set()
  generation = 0

  // Do not let accidental raw binding fetches bypass environment validation.
  async fetch() {
    return Response.json({ error: 'TRADING_REVIEW_BINDINGS_REQUIRED' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
    })
  }

  // Binding-only RPC; no public route, header, query or body selects env values.
  // failFast: the caller can send this read to the other container, so a restart here is reported, not waited for.
  async fetchWithReviewBindings(request, suppliedBindings, { failFast = false } = {}) {
    const bindings = snapshotBindings(suppliedBindings)
    const appOrigin = 'https://repo.ing'
    // Start dispatch under the binding gate, but do not serialize unrelated
    // requests behind its network response. A changed binding drains those
    // dispatches before destroying their process or replacing its environment.
    const { dispatched, generation } = await this.ctx.blockConcurrencyWhile(async () => {
      await validateBindings(bindings)
      const fingerprint = await sha256(JSON.stringify({ ...bindings, APP_ORIGIN: appOrigin }))
      if (await this.ctx.storage.get('review-bindings-sha256') !== fingerprint
        || await this.ctx.storage.get('database-binding-sha256') !== undefined) {
        await Promise.allSettled([...this.pendingDispatches])
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
        ORDINARY_LAUNCH_RECOVERY_ENABLED: ordinaryLaunchEnabled(bindings) ? 'true' : 'false',
        ...ordinaryLaunchEnabled(bindings) ? Object.fromEntries(launchBindingNames.slice(1).map(name => [name, bindings[name]])) : {},
        ACCOUNTING_RECOVERY_ENABLED: bindings.ACCOUNTING_RECOVERY_ENABLED === 'true' ? 'true' : 'false',
        ...bindings.ACCOUNTING_RECOVERY_ENABLED === 'true' ? Object.fromEntries(accountingBindingNames.slice(1).map(name => [name, bindings[name]])) : {},
        ...claimsEnabled(bindings) ? { ...Object.fromEntries(claimBindingNames.slice(1).map(name => [name, bindings[name]])),
          GITHUB_APP_CLIENT_ID: bindings.GITHUB_APP_CLIENT_ID } : {},
        SOLANA_RPC_URL: bindings.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
        GRADUATION_VERIFICATION_RPC_URL: verificationRpc(bindings.SOLANA_RPC_URL),
        HOOK_PRODUCTION_BOOTSTRAP: 'false',
        HOOK_NATIVE_LAUNCH_ENABLED: 'false',
        HOOK_NATIVE_LAUNCHES_ENABLED: 'false',
        HOOK_INCLUSIVE_TRADING_ENABLED: 'false',
        HOOK_NATIVE_TRADING_ENABLED: 'false',
        HOOK_WALLET_FUNDING_ENABLED: 'false',
        HOOK_WALLET_IDENTITY_ENABLED: 'false',
        HOOK_SELECTED_HOOKS_ENABLED: 'false',
      }
      const dispatched = super.fetch(request)
      this.pendingDispatches.add(dispatched)
      const settled = () => this.pendingDispatches.delete(dispatched)
      dispatched.then(settled, settled)
      return { dispatched, generation: this.generation }
    })
    let upstream = await dispatched
    // A container rollout can replace the process under this Durable Object without telling it: every request then
    // answers "Error proxying request to container" until something restarts it. Restart once (one restart shared by
    // concurrent requests) and retry reads; a write is never replayed and is asked to retry instead.
    if (upstream.status === 500 && STALE_CONTAINER.test((await upstream.clone().text()).slice(0, 120))) {
      // Only a request sent to the container that is still current restarts it; later ones just retry.
      if (this.generation === generation) {
        this.healing ??= this.ctx.blockConcurrencyWhile(async () => {
          try { await this.destroy() } catch { /* Start replaces it. */ }
          this.generation++
        }).finally(() => { this.healing = null })
      }
      if (failFast && ['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 503, headers: { [RESTARTING]: '1' } })
      await this.healing
      if (!['GET', 'HEAD'].includes(request.method)) {
        return Response.json({ error: 'TRADING_REVIEW_UNAVAILABLE', reason: 'restarting' }, { status: 503, headers: { 'Retry-After': '5' } })
      }
      upstream = await super.fetch(request)
    }
    const response = new Response(upstream.body, upstream)
    response.headers.set('X-Repoing-Runtime-Policy', 'discovery-origin-v1')
    return response
  }
}

// Requests are spread over both containers so both stay warm. A read that meets a restarting container goes to the
// other at once; the second try waits for its container as before. A write goes to one container and is never replayed.
async function dispatchSite(env, request, bindings) {
  const [first, second] = Math.random() < 0.5 ? SITE_NAMES : [...SITE_NAMES].reverse()
  if (!['GET', 'HEAD'].includes(request.method)) return env.PUBLIC_SITE.getByName(first).fetchWithReviewBindings(request, bindings)
  try {
    const response = await env.PUBLIC_SITE.getByName(first).fetchWithReviewBindings(request, bindings, { failFast: true })
    if (!response.headers.has(RESTARTING)) return response
  } catch { /* The other container answers; its own failure is reported as before. */ }
  return env.PUBLIC_SITE.getByName(second).fetchWithReviewBindings(request, bindings)
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
      'X-Repoing-Mode': env.EXISTING_MARKET_TRADING_STAGE === 'live' ? 'existing-market-trading-live' : 'existing-market-trading-review',
      'X-Repoing-Snapshot': '2026-10-22T14:48:06Z',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
    }
    if (url.hostname.endsWith('.workers.dev')) headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    const bindings = snapshotBindings({ ...env, TRADING_CUSTODY_RECOVERY_JSON: custodyManifest })
    const claim = claimsEnabled(bindings) && claimRoute(url, request.method) && !request.headers.has('upgrade')
    const boundary = claim ? (await claimRequest(request, url) ?? Response.json({ error: 'CLAIM_REQUEST_REFUSED' }, { status: 403 }))
      : await tradeBoundary(request, bindings)
    if (boundary instanceof Response) {
      for (const [key, value] of Object.entries(headers)) boundary.headers.set(key, value)
      return boundary
    }
    let upstream = boundary
    if (boundary === null) {
      const allowed = pages.has(url.pathname) || tokenPage.test(url.pathname)
        || (ordinaryLaunchEnabled(bindings) && (ordinaryRepoPath(url.pathname) || url.pathname === '/api/launch'))
        || publicMarketApi.test(url.pathname) || tokenImage.test(url.pathname) || tokenMetadata.test(url.pathname)
        || /^\/m\/[1-9]\d{0,15}$/.test(url.pathname)
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
      response = await dispatchSite(env, upstream, bindings)
    } catch (error) {
      // Includes missing RPC during propagation, invalid bindings and failed
      // restart/storage/boot. Never fall back to raw fetch or the old DB-only RPC.
      // Only fixed categories are public; never expose exception text or bindings.
      const reason = error?.message?.includes('RPC receiver does not implement') ? 'rpc-version' : failureStage
      return Response.json({ error: 'TRADING_REVIEW_UNAVAILABLE', reason }, { status: 503, headers: { ...headers, 'Retry-After': '5' } })
    }
    const safe = new Response(response.body, response)
    if (!claim) safe.headers.delete('set-cookie') // Only the claim routes may set the GitHub session cookies.
    for (const [key, value] of Object.entries(headers)) safe.headers.set(key, value)
    // Only build assets and explicit public illustrations are cacheable. Pages,
    // APIs (including token images), errors and financial responses stay no-store.
    if (request.method === 'GET' && safe.status === 200) {
      if (/^\/_next\/static\/[a-zA-Z0-9_./-]+\.(js|css|woff2?)$/.test(url.pathname)) {
        safe.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      } else if (['/favicon.ico', '/brand-cat.webp', '/gitcat.png', '/launch-on-repoing.svg', '/opengraph-image.png', '/video/repoing-flywheel-poster.jpg'].includes(url.pathname)
        || /^\/(art|badges|launch-icons|hook-icons|credits)\/[a-z0-9-]+\.(webp|png)$/.test(url.pathname)) {
        safe.headers.set('Cache-Control', 'public, max-age=300')
      }
    }
    // Live recovery notices belong to the React root and survive hydration.
    if (bindings.EXISTING_MARKET_TRADING_STAGE !== 'live' && safe.headers.get('Content-Type')?.includes('text/html')) {
      return new HTMLRewriter().on('body', {
        element(body) {
          body.setAttribute('style', `${body.getAttribute('style') || ''};padding-bottom:80px`)
          const notice = bindings.EXISTING_MARKET_TRADING_STAGE === 'test'
            ? `Authorized six-swap test only · ${bindings.EXISTING_MARKET_TEST_SUBMISSION === 'true' ? 'Operator-gated wallet test.' : 'Unsigned preparation only. Do not sign.'} Public trading, launches, claims and replay are paused.`
            : 'Existing-market trading review · Unsigned preparation only. Do not sign. Submission, launches, claims and replay are paused.'
          body.append(`<aside role="note" id="recovery-notice" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#fff3cd;color:#332500;border-top:1px solid #b89b46;font:600 13px/1.4 system-ui;text-align:center">${notice} Charts use read-only finalized-chain indexing. Fee accounting and payouts remain under verification.</aside>`, { html: true })
        },
      }).transform(safe)
    }
    return safe
  },
}
