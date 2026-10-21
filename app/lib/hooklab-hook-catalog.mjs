import { z } from 'zod'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { hookCatalogStore, hookPublicationInputSchema, publicHookPublication, revalidateHookPublication } from '../../src/hooklab-hook-catalog.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { assertSameOrigin } from './auth.mjs'
import { walletIdentityConfiguration, walletIdentitySessionToken, walletIdentityQuota } from './hooklab-wallet-identity.mjs'
import { servedFromConfiguredOrigin } from './hooklab-origin.mjs'
import { nativeLaunchRuntime } from './hooklab-native-launch-runtime.mjs'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('publish'), publication: hookPublicationInputSchema }).strict(),
  z.object({ action: z.literal('select'), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
])
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } })
// Runtime integration contract: observeSelectedHookCompatibility({program,expectedEvidence?})
// must bind server-owned policy, role exclusions, network and independent RPC readers. Never
// forward browser executable claims. Missing runtime support fails closed, not to an allowlist.
const runtimeObserve = async input => {
  const runtime = nativeLaunchRuntime()
  if (typeof runtime?.observeSelectedHookCompatibility !== 'function') throw Error('Compatibility observer unavailable')
  return runtime.observeSelectedHookCompatibility(input)
}
export function createHookCatalogHandler({ env = process.env, configuration = walletIdentityConfiguration, database = createHookLabDatabasePool,
  store = hookCatalogStore, principalStore = walletPrincipalStore, quota = walletIdentityQuota, observe = runtimeObserve } = {}) {
  return async request => {
    if (env.HOOK_WALLET_IDENTITY_ENABLED !== 'true') return reply({ error: 'Hook publication unavailable.' }, 503)
    let pool
    try {
      const config = configuration(env)
      if (new URL(request.url).search) return reply({ error: 'Query parameters unavailable.' }, 400)
      if (!['GET','POST'].includes(request.method)) return reply({ error: 'Method unavailable.' }, 405)
      if (request.method === 'POST') {
        try { assertSameOrigin(request, config.origin); if (!servedFromConfiguredOrigin(request, config.origin)) throw Error() }
        catch { return reply({ error: 'Open the configured launcher origin.' }, 403) }
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply({ error: 'JSON required.' }, 415)
        if (!walletIdentitySessionToken(request)) return reply({ error: 'Sign in with your wallet first.' }, 401)
      }
      pool = database(config)
      if (!await quota(pool, [[`hook-catalog:${request.method}:${clientAddress(request) ?? 'unknown'}`, request.method === 'GET' ? 120 : 10]])) return reply({ error: 'Too many requests. Try again later.' }, 429)
      const catalog = store(pool)
      if (request.method === 'GET') return reply({ publications: await catalog.list(), notice: 'Publication is not endorsement. Publisher wallet is not verified authorship. Compatibility is rechecked on selection and execution.' })
      const owner = await principalStore(pool, { enabled: true, origin: config.origin, audience: config.audience, genesisHash: config.genesisHash }).resolve(walletIdentitySessionToken(request))
      let input
      try { input = inputSchema.parse(JSON.parse((await readLimitedBody(request, 65536)).toString('utf8'))) }
      catch { return reply({ error: 'Invalid hook publication or selection.' }, 400) }
      if (!await quota(pool, [[`hook-catalog:wallet:${owner.wallet}`, 10]])) return reply({ error: 'Too many requests. Try again later.' }, 429)
      if (input.action === 'select') return reply({ publication: publicHookPublication(await revalidateHookPublication({ store: catalog, digest: input.digest, observe })) })
      const evidence = await observe({ program: input.publication.selectedHook.program })
      return reply({ publication: publicHookPublication(await catalog.publish(owner.wallet, input.publication, evidence)) }, 201)
    } catch (error) {
      if (error?.status === 401) return reply({ error: 'Wallet session expired. Sign in again.' }, 401)
      return reply({ error: 'Publication or compatibility unavailable. Versions cannot be replaced; publish changes under a new version.' }, 409)
    } finally { await pool?.end().catch(() => {}) }
  }
}
