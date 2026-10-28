import { Container } from '@cloudflare/containers'
// Wrangler Text module: preserve exact bytes without a >5KB environment binding.
import custodyManifest from '../config/existing-market-custody.json'

// Existing-market recovery wrapper. Keep PublicSite/PUBLIC_SITE/public-readonly (slot b: PublicSiteB/PUBLIC_SITE_B)
// identity and the closed launch/claim/replay boundaries in every stage.
// /ja (and its sub-pages), /waiting, /launches and /opt-out (owner, 2026-10-28): read-only pages, with the launch calendar's
// own read-only JSON. /opt-out's record route rides with the claim routes (it needs the GitHub session cookie).
const pages = new Set(['/', '/launch', '/explore', '/find-repos', '/discoverers', '/referrals', '/agents', '/wallet', '/builders', '/stats', '/how-it-works', '/about',
  '/programmable-coins', '/hooks', '/ja', '/waiting', '/launches', '/opt-out', '/api/v1/launches'])
const jaPage = /^\/ja(\/[a-z0-9-]{1,64}){1,3}$/
// Pages that start a launch through a route that is not open: sent to the live launch page instead of a refusal.
const redirects = { '/coins/new': '/hooks', '/launches/new': '/launch' }
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
// A maintainer's opt-out or decline (owner, 2026-10-28): a decision record, never a payment. The page and its route get the
// GitHub session cookie only (the page renders signed in from it), never set a cookie, and the POST keeps the claim routes'
// same-origin JSON bound.
const GITHUB_SESSION_COOKIES = new Set(['__Host-repoing_github'])
const optOutRoute = (url, method) => (url.pathname === '/opt-out' && ['GET', 'HEAD'].includes(method))
  || (url.pathname === '/api/opt-out' && ['GET', 'HEAD', 'POST'].includes(method))
// Hooks on our own stack (owner, 2026-10-26): self-serve open launches, native-SOL trading and creator claims. Off unless
// HOOKS_RECOVERY_ENABLED is 'true' on the live stage with every binding below valid; off, none of them is read or forwarded.
// Creator-chosen (selected) hooks, wallet funding, owner-approved launches and the retired bridged stack stay off whatever
// the bindings say.
const hookSwitchNames = ['HOOK_OPEN_LAUNCHES', 'HOOK_NATIVE_LAUNCH_ENABLED', 'HOOK_NATIVE_LAUNCHES_ENABLED', 'HOOK_WALLET_IDENTITY_ENABLED',
  'HOOK_INCLUSIVE_TRADING_ENABLED', 'HOOK_NATIVE_TRADING_ENABLED', 'HOOK_TRADING_PUBLIC']
const hookBindingNames = ['HOOKS_RECOVERY_ENABLED', 'HOOK_WALLET_IDENTITY_DATABASE_URL', 'HOOK_NATIVE_KEYRING_JSON', 'HOOK_NATIVE_ACTIVE_KEY_ID',
  'HOOKLAB_PRODUCTION_RPC_PRIMARY_URL', 'HOOKLAB_PRODUCTION_RPC_SECONDARY_URL', 'HOOKLAB_PRODUCTION_BUNDLE_FILE', 'HOOKLAB_PRODUCTION_BUNDLE_SHA256',
  'HOOKLAB_STACK_BUNDLE_FILE', 'HOOKLAB_STACK_BUNDLE_SHA256', 'HOOK_LAUNCH_ADMIN_ADDRESS', 'HOOK_STACK_ADMIN_ADDRESS', 'HOOKLAB_PRIORITY_MICROLAMPORTS',
  ...hookSwitchNames]
// Optional: the wallets that may trade before HOOK_TRADING_PUBLIC is 'true'; the Burn switch (absent is off, so an unset
// binding leaves the container's identity as it was).
const hookOptionalNames = ['HOOK_TRADING_TESTER_WALLETS', 'HOOK_BURN_ENABLED']
// Burn (owner design 2026-10-27): optional, off unless 'true'; on only with open launches (a token burn launches only through
// open creation).
const burnSwitch = bindings => bindings.HOOK_BURN_ENABLED === 'true' && bindings.HOOK_OPEN_LAUNCHES === 'true' ? 'true' : 'false'
const hooksEnabled = bindings => bindings.EXISTING_MARKET_TRADING_STAGE === 'live' && bindings.HOOKS_RECOVERY_ENABLED === 'true'
const base58Key = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
// /explore/hooks: Explore's Hooks coins tab (the listed coins and their trade figures, read only).
const hookPages = new Set(['/hooks/launch-review', '/hooks/mine', '/hooks/trade', '/hooks/blocks', '/hooks/new', '/hooks/wallet-identity', '/explore/hooks'])
const hookReadRoute = new RegExp(`^(/hooks/token/${mint}|/api/hook-lab/market/${mint}(/(candles|holders|trades))?|/api/hook-lab/wallet/${mint}` +
  '|/api/hook-lab/coins/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(image|metadata))$')
// The wallet-session routes: the only Hooks routes that receive the two wallet cookies, each with its POST actions and body
// bound (the app's own limits). Only wallet-identity may set them. cosign is the server's mint-key signature of an open
// launch (the server holds no admin key). fund, withdraw and quote (the bridged stack) and native-estimate (selected hooks)
// are never forwarded.
const hookSessionRoutes = {
  '/api/hook-lab/wallet-identity': { get: true, limit: 2048, actions: ['challenge', 'verify', 'logout'], setsCookie: true },
  '/api/hook-lab/launch-requests': { get: true, limit: 540_000, actions: ['create', 'get', 'cancel'] },
  '/api/hook-lab/native-launch': { limit: 65_536, actions: ['reserve', 'review', 'get', 'refresh-review', 'wallet-request', 'cosign', 'complete', 'submit', 'reconcile', 'expire', 'retain-wallet'] },
  '/api/hook-lab/native-claim': { limit: 8192, actions: ['status', 'claim', 'get', 'wallet-request', 'submit', 'reconcile', 'retain-wallet'] },
  '/api/hook-lab/inclusive-trade': { limit: 8192, actions: ['native-quote', 'get', 'refresh-review', 'wallet-request', 'submit', 'reconcile', 'expire', 'retain-wallet'] },
}
const hookCoinImage = '/api/hook-lab/coin-image'
const HOOK_COOKIES = new Set(['__Host-hook-wallet-binding', '__Host-hook-wallet-session'])
const hookRoute = (url, method) => ['GET', 'HEAD'].includes(method)
  ? hookPages.has(url.pathname) || hookReadRoute.test(url.pathname) || hookSessionRoutes[url.pathname]?.get === true
  : method === 'POST' && (Object.hasOwn(hookSessionRoutes, url.pathname) || url.pathname === hookCoinImage)
const ordinaryLaunchEnabled = bindings => bindings.EXISTING_MARKET_TRADING_STAGE === 'live' && bindings.ORDINARY_LAUNCH_RECOVERY_ENABLED === 'true'
const ordinaryRepoPath = path => {
  const id = /^\/(?:launch|api\/repo-images)\/([1-9]\d{0,15})$/.exec(path)?.[1]
  return Boolean(id && BigInt(id) <= 4503599627370495n)
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// Hooks bindings are read only with the switch on, so Hooks-shaped values left in the environment never change the
// container's identity (no restart) while Hooks are off.
function snapshotBindings(env) {
  const hooks = env.HOOKS_RECOVERY_ENABLED === 'true' ? [...hookBindingNames, ...hookOptionalNames] : []
  return Object.fromEntries([...bindingNames, ...testBindingNames, ...launchBindingNames, ...accountingBindingNames, ...claimBindingNames, ...hooks, 'SOLANA_RPC_URL'].map(name => [name, env[name]]))
}

// Why the Hooks bindings are not a set the reviewed bootstrap accepts (src/hooklab-production-bootstrap.mjs), or ''.
function hookBindingProblem(bindings) {
  if (!hooksEnabled(bindings)) return 'Hooks run only on the live stage'
  if (hookBindingNames.some(name => typeof bindings[name] !== 'string' || !bindings[name].trim())) return 'a Hooks binding is missing'
  if (hookSwitchNames.some(name => !['true', 'false'].includes(bindings[name])) || ![undefined, 'true', 'false'].includes(bindings.HOOK_BURN_ENABLED))
    return 'a Hooks switch is not true or false'
  if (bindings.HOOK_NATIVE_LAUNCH_ENABLED !== 'true' || bindings.HOOK_WALLET_IDENTITY_ENABLED !== 'true') return 'native launch and wallet identity must be on'
  if (bindings.HOOK_OPEN_LAUNCHES === 'true' && bindings.HOOK_NATIVE_LAUNCHES_ENABLED !== 'true') return 'open launches are native SOL only'
  if (bindings.HOOK_NATIVE_TRADING_ENABLED === 'true' && bindings.HOOK_INCLUSIVE_TRADING_ENABLED !== 'true') return 'native trading rides on the trade runtime'
  let db
  try { db = new URL(bindings.HOOK_WALLET_IDENTITY_DATABASE_URL) } catch { /* Refuse without logging credentials. */ }
  if (!db || !['postgres:', 'postgresql:'].includes(db.protocol) || db.username !== 'repoing_hooks_site' || db.pathname !== '/repoing_operational' ||
      db.searchParams.get('sslmode') !== 'verify-full' || db.searchParams.size !== 1) return 'Hooks database binding mismatched'
  let ring = null
  try { ring = JSON.parse(bindings.HOOK_NATIVE_KEYRING_JSON) } catch { /* refused below */ }
  const keys = ring && typeof ring === 'object' && !Array.isArray(ring) ? Object.entries(ring) : []
  if (!keys.length || keys.length > 4 || !keys.every(([id, key]) => /^[a-z0-9-]{1,32}$/.test(id) && typeof key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(key)) ||
      !Object.hasOwn(ring, bindings.HOOK_NATIVE_ACTIVE_KEY_ID)) return 'Hooks key ring mismatched'
  const rpcs = ['HOOKLAB_PRODUCTION_RPC_PRIMARY_URL', 'HOOKLAB_PRODUCTION_RPC_SECONDARY_URL'].map(name => { try { return new URL(bindings[name]) } catch { return null } })
  if (rpcs.some(u => !u || u.protocol !== 'https:' || u.username || u.password || u.hash) || rpcs[0].hostname === rpcs[1].hostname) return 'Hooks RPC bindings mismatched'
  for (const name of ['HOOKLAB_PRODUCTION_BUNDLE', 'HOOKLAB_STACK_BUNDLE']) {
    if (!/^\/app\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\.json$/.test(bindings[`${name}_FILE`]) || bindings[`${name}_FILE`].includes('..') ||
        !/^[a-f0-9]{64}$/.test(bindings[`${name}_SHA256`])) return 'Hooks bundle bindings mismatched'
  }
  if (!base58Key.test(bindings.HOOK_LAUNCH_ADMIN_ADDRESS) || !base58Key.test(bindings.HOOK_STACK_ADMIN_ADDRESS)) return 'Hooks admin bindings mismatched'
  if (!/^(0|[1-9][0-9]{0,6})$/.test(bindings.HOOKLAB_PRIORITY_MICROLAMPORTS)) return 'Hooks priority binding mismatched'
  const testers = bindings.HOOK_TRADING_TESTER_WALLETS
  if (testers !== undefined && (testers.split(',').length > 20 || !testers.split(',').every(wallet => base58Key.test(wallet.trim())))) return 'Hooks tester wallets mismatched'
  return ''
}

// The container environment for Hooks: the validated bindings, the bootstrap switch and the fixed origin.
const hookEnvironment = (bindings, appOrigin) => ({
  ...Object.fromEntries([...hookBindingNames.slice(1), ...hookOptionalNames].filter(name => bindings[name] !== undefined).map(name => [name, bindings[name]])),
  HOOK_PRODUCTION_BOOTSTRAP: 'true', HOOK_WALLET_IDENTITY_ORIGIN: appOrigin, HOOK_BURN_ENABLED: burnSwitch(bindings),
})

// A Hooks request: only the two Hooks wallet cookies, and only on the wallet-session routes; same-origin bodies within each
// route's bound; listed actions only; nothing that names a creator-chosen hook. null refuses it.
const SELECTED_KEYS = new Set(['selectedHook', 'hookPublication', 'quoteCut', 'authorShareBps'])
function namesSelectedHook(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, v]) => SELECTED_KEYS.has(key) || (key === 'policyKind' && v === 'selected-hook') || namesSelectedHook(v, depth + 1))
}
async function hookRequest(request, url) {
  const session = hookSessionRoutes[url.pathname]
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'content-type', 'origin', 'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url',
    'if-none-match', 'if-modified-since', 'cf-connecting-ip']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  }
  const cookies = session ? (request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => HOOK_COOKIES.has(part.split('=')[0])) : []
  if (cookies.length) headers.set('cookie', cookies.join('; '))
  if (request.method !== 'POST') return new Request(request.url, { method: request.method, headers, redirect: 'manual' })
  const type = request.headers.get('content-type')?.split(';')[0].trim()
  const image = url.pathname === hookCoinImage
  if (request.headers.get('origin') !== url.origin || (image ? !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type) : type !== 'application/json')) return null
  const limit = image ? 2 * 1024 * 1024 : session.limit
  if (Number(request.headers.get('content-length')) > limit) return null
  const body = await request.arrayBuffer().catch(() => null)
  if (!body || body.byteLength > limit) return null
  if (!image) {
    let payload
    try { payload = JSON.parse(new TextDecoder().decode(body)) } catch { return null }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !session.actions.includes(payload.action) || namesSelectedHook(payload)) return null
  }
  return new Request(request.url, { method: 'POST', headers, body, redirect: 'manual' })
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
  if (bindings.HOOKS_RECOVERY_ENABLED === 'true' && hookBindingProblem(bindings)) throw Error('Hooks bindings missing or mismatched')
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
// cookies: only these cookie names cross; null forwards the claim routes' cookies as before.
async function claimRequest(request, url, cookies = null) {
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'content-type', 'origin', 'rsc', 'next-router-state-tree',
    'next-router-prefetch', 'next-url', 'cf-connecting-ip']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  }
  const cookie = request.headers.get('cookie')
  const kept = cookie && cookies ? cookie.split(';').map(part => part.trim()).filter(part => cookies.has(part.split('=')[0])).join('; ') : cookie
  if (kept) headers.set('cookie', kept)
  if (request.method !== 'POST') return new Request(request.url, { method: request.method, headers, redirect: 'manual' })
  if (request.headers.get('origin') !== url.origin || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return null
  const body = await request.arrayBuffer().catch(() => null)
  if (!body || body.byteLength > 16384) return null
  return new Request(request.url, { method: 'POST', headers, body, redirect: 'manual' })
}

// A refused page shows a short page with a way home; API callers keep the JSON refusal.
const REFUSED_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Not available · repo.ing</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#101213;color:#f4f6fa;' +
  'font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px"><main><h1 style="font-size:28px;margin:0 0 8px">This page isn\u2019t open yet</h1>' +
  '<p style="color:#aeb6c1;margin:0 0 20px">It\u2019s switched off while repo.ing finishes its recovery.</p>' +
  '<a href="/" style="color:#101713;background:#81e6ad;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Go to repo.ing</a></main></body></html>'
function refusedPage(request, headers) {
  const page = ['GET', 'HEAD'].includes(request.method) && (request.headers.get('accept') ?? '').includes('text/html')
  return page ? new Response(request.method === 'HEAD' ? null : REFUSED_HTML, { status: 403, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } })
    : Response.json({ error: 'RECOVERY_ROUTE_DISABLED' }, { status: 403, headers })
}

const STALE_CONTAINER = /^(Error proxying request to container|Container suddenly disconnected)/

// <container-slots> Blue/green container slots (owner, 2026-10-28): two container applications, PublicSite (slot a) and
// PublicSiteB (slot b). ACTIVE_SLOT picks the slot the public reaches; a deploy puts a new image on the other slot only,
// checks it through the probe, then flips ACTIVE_SLOT with a Worker-only deploy (no container rollout); rollback flips
// back. Neither ACTIVE_SLOT nor SLOT_PROBE_TOKEN is a container binding, so a flip never restarts a container.
// The probe: x-repoing-slot (a|b) with x-repoing-slot-token equal to the SLOT_PROBE_TOKEN secret (32+ characters).
const SLOT_HEADER = 'x-repoing-slot', SLOT_TOKEN_HEADER = 'x-repoing-slot-token', MIN_PROBE_TOKEN = 32
const activeSlot = env => env.ACTIVE_SLOT === 'b' && env.PUBLIC_SITE_B ? 'b' : 'a'
async function sameSecret(given, secret) {
  const [x, y] = await Promise.all([given, secret].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
  const p = new Uint8Array(x), q = new Uint8Array(y)
  let diff = 0
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i]
  return diff === 0
}
// The slot a request goes to, or null to refuse it: a probe needs both headers, a bound slot and the right secret.
async function requestSlot(request, env) {
  const named = request.headers.get(SLOT_HEADER), token = request.headers.get(SLOT_TOKEN_HEADER)
  if (named === null && token === null) return activeSlot(env)
  const secret = env.SLOT_PROBE_TOKEN
  if (!['a', 'b'].includes(named) || typeof token !== 'string' || typeof secret !== 'string' || secret.length < MIN_PROBE_TOKEN) return null
  if (!await sameSecret(token, secret)) return null
  return named === 'b' && !env.PUBLIC_SITE_B ? null : named
}
const slotSite = (env, slot) => slot === 'b' ? env.PUBLIC_SITE_B : env.PUBLIC_SITE
// POST /__slot/restart with the probe: stops the INACTIVE slot's container so its next start runs the slot's current
// image (a completed rollout can leave the old process answering). The live slot is never restarted from here.
async function slotRestart(request, env, slot) {
  const headers = { 'Cache-Control': 'no-store' }
  if (request.method !== 'POST' || !request.headers.has(SLOT_HEADER)) return Response.json({ error: 'SLOT_PROBE_REFUSED' }, { status: 403, headers })
  if (slot === activeSlot(env)) return Response.json({ error: 'SLOT_IS_LIVE' }, { status: 409, headers })
  await slotSite(env, slot).getByName('public-readonly').restartForSlotDeploy()
  return Response.json({ restarted: slot }, { headers })
}
// </container-slots>

export class PublicSite extends Container {
  defaultPort = 3000
  sleepAfter = '2m'
  enableInternet = true
  pendingDispatches = new Set()
  generation = 0

  // Slot deploys only (POST /__slot/restart on the inactive slot): drain, stop; the next request starts the current image.
  async restartForSlotDeploy() {
    await this.ctx.blockConcurrencyWhile(async () => {
      await Promise.allSettled([...this.pendingDispatches])
      try { await this.destroy() } catch { /* Not running: the next start uses the current image anyway. */ }
      this.generation++
    })
    return true
  }

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
        HOOK_WALLET_IDENTITY_ENABLED: 'false',
        HOOK_BURN_ENABLED: 'false',
        ...hooksEnabled(bindings) ? hookEnvironment(bindings, appOrigin) : {},
        // Never on from here: creator-chosen hooks, wallet funding and owner-approved launches.
        HOOK_WALLET_FUNDING_ENABLED: 'false',
        HOOK_SELECTED_HOOKS_ENABLED: 'false',
        ...hooksEnabled(bindings) ? { HOOK_OWNER_APPROVED_LAUNCHES: 'false' } : {},
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

// Slot b: the same container under its own name, so it is its own container application with its own image.
export class PublicSiteB extends PublicSite {}

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
    const slot = await requestSlot(request, env)
    if (slot === null) return Response.json({ error: 'SLOT_PROBE_REFUSED' }, { status: 403, headers })
    if (url.pathname === '/__slot/restart') return slotRestart(request, env, slot)
    const bindings = snapshotBindings({ ...env, TRADING_CUSTODY_RECOVERY_JSON: custodyManifest })
    if (Object.hasOwn(redirects, url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
      return new Response(null, { status: 302, headers: { ...headers, Location: redirects[url.pathname] } })
    }
    const optOut = claimsEnabled(bindings) && optOutRoute(url, request.method) && !request.headers.has('upgrade')
    const claim = optOut || (claimsEnabled(bindings) && claimRoute(url, request.method) && !request.headers.has('upgrade'))
    const hook = !claim && hooksEnabled(bindings) && hookRoute(url, request.method) && !request.headers.has('upgrade')
    const boundary = claim ? (await claimRequest(request, url, optOut ? GITHUB_SESSION_COOKIES : null) ?? Response.json({ error: 'CLAIM_REQUEST_REFUSED' }, { status: 403 }))
      : hook ? (await hookRequest(request, url) ?? Response.json({ error: 'HOOKS_REQUEST_REFUSED' }, { status: 403 }))
      : await tradeBoundary(request, bindings)
    if (boundary instanceof Response) {
      for (const [key, value] of Object.entries(headers)) boundary.headers.set(key, value)
      return boundary
    }
    let upstream = boundary
    if (boundary === null) {
      const allowed = pages.has(url.pathname) || jaPage.test(url.pathname) || tokenPage.test(url.pathname)
        || (ordinaryLaunchEnabled(bindings) && (ordinaryRepoPath(url.pathname) || url.pathname === '/api/launch'))
        || publicMarketApi.test(url.pathname) || tokenImage.test(url.pathname) || tokenMetadata.test(url.pathname)
        || /^\/m\/[1-9]\d{0,15}$/.test(url.pathname)
        || /^\/api\/repo-logo\/\d+$/.test(url.pathname)
        || ['/api/health', '/api/mcp/readonly', '/api/growth', '/api/repo-search', '/api/wallet/overview'].includes(url.pathname)
        || ['/favicon.ico', '/brand-cat.webp', '/gitcat.png', '/launch-on-repoing.svg', '/opengraph-image.png'].includes(url.pathname)
        || /^\/(art|badges|launch-icons|hook-icons|credits)\/[a-z0-9-]+\.(webp|png)$/.test(url.pathname)
        || ['/video/repoing-flywheel-poster.jpg', '/video/repoing-flywheel.mp4'].includes(url.pathname)
        || url.pathname.startsWith('/_next/static/')
      if (!allowed || (url.pathname === '/builders' && url.searchParams.has('owner'))) return refusedPage(request, headers)
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
      response = await slotSite(env, slot).getByName('public-readonly').fetchWithReviewBindings(upstream, bindings)
    } catch (error) {
      // Includes missing RPC during propagation, invalid bindings and failed
      // restart/storage/boot. Never fall back to raw fetch or the old DB-only RPC.
      // Only fixed categories are public; never expose exception text or bindings.
      const reason = error?.message?.includes('RPC receiver does not implement') ? 'rpc-version' : failureStage
      return Response.json({ error: 'TRADING_REVIEW_UNAVAILABLE', reason }, { status: 503, headers: { ...headers, 'Retry-After': '5' } })
    }
    const safe = new Response(response.body, response)
    // Only the claim routes may set the GitHub session cookies, and only wallet-identity the Hooks wallet cookies.
    if (optOut || (!claim && !(hook && hookSessionRoutes[url.pathname]?.setsCookie))) safe.headers.delete('set-cookie')
    for (const [key, value] of Object.entries(headers)) safe.headers.set(key, value)
    safe.headers.set('X-Repoing-Slot', slot)
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
