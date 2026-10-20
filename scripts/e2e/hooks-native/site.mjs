// The website as `next dev` over HTTPS on localhost, in local-acceptance mode, with the PRODUCTION bootstrap
// (instrumentation.js -> src/hooklab-production-bootstrap.mjs) loading the local operator bundle. Every native switch is
// on, launches are owner-approved and USD-priced (the fixed local price), and the two HTTPS proxies are both the
// local-acceptance endpoints and the "production" RPC URLs.
import path from 'node:path'
import { REPO_ROOT, waitFor } from './common.mjs'
import { startProcess } from './process.mjs'

export function siteEnvironment({ base, port, tls, genesisHash, databaseUrl, proxies, bundle, keyRing, ownerTokenSha256, admin, preload, solUsd }) {
  const origin = `https://localhost:${port}`
  return {
    ...base, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', E2E_TELEMETRY_DISABLED: '1', NODE_EXTRA_CA_CERTS: tls.cert,
    NODE_OPTIONS: `--import ${preload}`, HOOKS_E2E_SOL_USD: solUsd,
    // Local acceptance (src/hooklab-local-acceptance.mjs): loopback origin and database, a pinned non-mainnet genesis.
    HOOK_LOCAL_ACCEPTANCE: 'true', HOOK_LOCAL_ACCEPTANCE_GENESIS: genesisHash,
    HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY: proxies[0].origin, HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY: proxies[1].origin,
    HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_WALLET_IDENTITY_ORIGIN: origin, HOOK_WALLET_IDENTITY_DATABASE_URL: databaseUrl, APP_ORIGIN: origin,
    // The native release's switches, as production will set them.
    HOOK_NATIVE_LAUNCH_ENABLED: 'true', HOOK_NATIVE_LAUNCHES_ENABLED: 'true', HOOK_INCLUSIVE_TRADING_ENABLED: 'true', HOOK_NATIVE_TRADING_ENABLED: 'true',
    HOOK_TRADING_PUBLIC: 'true', HOOK_OWNER_APPROVED_LAUNCHES: 'true', HOOK_LAUNCH_USD_PRICING: 'true',
    HOOK_LAUNCH_ADMIN_ADDRESS: admin, HOOK_OWNER_APPROVAL_TOKEN_SHA256: ownerTokenSha256,
    // The production bootstrap with the local bundle.
    HOOK_PRODUCTION_BOOTSTRAP: 'true', HOOKLAB_PRODUCTION_BUNDLE_FILE: bundle.file, HOOKLAB_PRODUCTION_BUNDLE_SHA256: bundle.sha256,
    HOOKLAB_PRODUCTION_RPC_PRIMARY_URL: proxies[0].origin, HOOKLAB_PRODUCTION_RPC_SECONDARY_URL: proxies[1].origin,
    HOOK_NATIVE_KEYRING_JSON: JSON.stringify(keyRing), HOOK_NATIVE_ACTIVE_KEY_ID: Object.keys(keyRing)[0],
  }
}

export async function startSite({ root, env, port, tls, https, log }) {
  const site = startProcess('site', process.execPath, [path.join(REPO_ROOT, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', 'localhost', '--port', String(port),
    // --experimental-https-ca: next dev REPLACES NODE_EXTRA_CA_CERTS with this value for its server, so name our certificate.
    '--experimental-https', '--experimental-https-key', tls.key, '--experimental-https-cert', tls.cert, '--experimental-https-ca', tls.cert],
  { cwd: REPO_ROOT, env, logFile: path.join(root, 'logs', 'site.log') })
  const origin = `https://localhost:${port}`
  try {
    await waitFor('the dev server to answer', async () => {
      if (!site.alive()) throw Error(`next dev exited; see ${path.join(root, 'logs', 'site.log')}`)
      return (await https(`${origin}/api/hook-lab/launch-requests`)).status === 200
    }, { timeoutMs: 240_000, intervalMs: 1000 })
    const refused = site.lines.find(line => /production bootstrap refused/i.test(line))
    if (refused) throw Error(refused)
    // Compile the pages and routes the suite opens once, so a first visit is not a minute-long dev compile.
    for (const route of ['/hooks/launch-review', '/hooks/wallet-identity', `/hooks/token/${'1'.repeat(32)}`, '/api/hook-lab/wallet-identity']) {
      const started = Date.now(), { status } = await https(`${origin}${route}`)
      log?.(`warm ${route}: ${status} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    }
    log?.(`site ${origin} (next dev, pid ${site.pid})`)
    return { ...site, origin }
  } catch (error) { await site.stop(); throw error }
}
