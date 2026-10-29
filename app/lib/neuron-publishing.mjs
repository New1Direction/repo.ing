import { createHash } from 'node:crypto'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { neuronCharacterStore, characterSubmission } from '../../src/neuron-characters.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { walletIdentityConfiguration, walletIdentitySessionToken, walletIdentityQuota } from './hooklab-wallet-identity.mjs'
import { servedFromConfiguredOrigin } from './hooklab-origin.mjs'
import { assertSameOrigin } from './auth.mjs'
import { assertNeuronEdge, neuronBotConfiguration, verifyNeuronBot } from './neuron-bot-protection.mjs'
import { PERSONALITY_IMPORT_BYTES } from './neuron-import.mjs'

export function neuronPublishingConfiguration(env = process.env) {
  if (env.NEURONS_PUBLISHING_ENABLED !== 'true') return null
  const identity = walletIdentityConfiguration(env)
  if (env.HOOK_WALLET_IDENTITY_ENABLED !== 'true' || !env.NEURONS_DATABASE_URL
    || env.NEURONS_DATABASE_URL !== identity.databaseUrl || env.NEURONS_DATABASE_URL === env.DATABASE_URL) throw Error('Isolated publishing configuration required')
  const bot = neuronBotConfiguration(env)
  return { ...identity, botSiteKey: bot?.siteKey ?? null }
}
const response = (value, status = 200) => Response.json({ ...value, financialExecutionEnabled: false }, { status,
  headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } })

export function createNeuronPublishingHandler({ env = process.env, database = createHookLabDatabasePool, fetcher = fetch } = {}) {
  return async request => {
    let pool
    try {
      const config = neuronPublishingConfiguration(env)
      if (!config) return response({ error: 'Character publishing is disabled.' }, 404)
      const bot = assertNeuronEdge(request, env)
      if (!servedFromConfiguredOrigin(request, config.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: 'Use the configured site.' }, 403)
      if (!['GET', 'POST'].includes(request.method)) return response({ error: 'Method not allowed.' }, 405)
      const url = new URL(request.url), mine = url.searchParams.get('scope') === 'mine'
      let body
      if (request.method === 'POST') {
        try { assertSameOrigin(request, config.origin) } catch { return response({ error: 'Use the configured site.' }, 403) }
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return response({ error: 'JSON required.' }, 415)
        try { body = JSON.parse((await readLimitedBody(request, PERSONALITY_IMPORT_BYTES + 1024)).toString('utf8')); characterSubmission(body) }
        catch { return response({ error: 'Invalid character details or oversized request.' }, 400) }
      }
      const token = mine || body ? walletIdentitySessionToken(request) : null
      if ((mine || body) && !token) return response({ error: 'Sign in with your wallet first.' }, 401)
      pool = database(config)
      const ip = createHash('sha256').update(clientAddress(request) ?? 'unknown').digest('hex')
      if (!await walletIdentityQuota(pool, [['neurons:global', 600], [`neurons:ip:${ip}`, 90]])) return response({ error: 'Too many requests. Try later.' }, 429)
      const principal = token ? await walletPrincipalStore(pool, { enabled: true, origin: config.origin,
        audience: config.audience, genesisHash: config.genesisHash }).resolve(token) : null
      const store = neuronCharacterStore(pool)
      if (body) {
        await verifyNeuronBot(request, bot, 'neuron-publish', fetcher)
        return response({ character: await store.submit(principal.wallet, body) }, 201)
      }
      if (url.searchParams.has('export')) {
        const character = await store.publicById(url.searchParams.get('export'))
        if (!character?.personality) return response({ error: 'Published personality import not found.' }, 404)
        return new Response(JSON.stringify(character.personality, null, 2), { headers: {
          'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${character.ticker}-personality.json"`,
          'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff',
        } })
      }
      return response({ characters: await store.list(mine ? principal.wallet : null) })
    } catch (error) {
      const status = [400, 401, 403, 409, 429].includes(error.status) ? error.status : 503
      return response({ error: status === 503 ? 'Publishing is temporarily unavailable. Your draft is safe; try again later.'
        : status === 401 ? 'Your sign-in expired. Sign in again.' : error.message }, status)
    } finally { if (pool) await pool.end().catch(() => {}) }
  }
}

// Server routes read fresh moderation state; never bake approval into static HTML.
export async function publishedNeuronCharacters(id = null) {
  const config = neuronPublishingConfiguration()
  if (!config) return id ? null : []
  const pool = createHookLabDatabasePool(config)
  try { const store = neuronCharacterStore(pool); return id ? await store.publicById(id) : await store.list() }
  finally { await pool.end() }
}
