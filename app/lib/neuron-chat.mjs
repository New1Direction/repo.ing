import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { neuronCharacterStore } from '../../src/neuron-characters.mjs'
import { neuronChatStore } from '../../src/neuron-chat.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { neuronPublishingConfiguration } from './neuron-publishing.mjs'
import { walletIdentitySessionToken, walletIdentityQuota } from './hooklab-wallet-identity.mjs'
import { servedFromConfiguredOrigin } from './hooklab-origin.mjs'
import { assertSameOrigin } from './auth.mjs'
import { assertNeuronEdge, verifyNeuronBot } from './neuron-bot-protection.mjs'

const input = z.object({ characterId: z.string().uuid(), conversationId: z.string().uuid(), requestId: z.string().uuid(),
  message: z.string().trim().min(1).max(500).refine(text => !/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) }).strict()
const fail = (message, status) => Object.assign(Error(message), { status })
const response = (value, status = 200) => Response.json({ ...value, mode: 'mock', liveInference: false, financialExecutionEnabled: false },
  { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } })

export function neuronChatConfiguration(env = process.env) {
  if (!env.NEURONS_CHAT_MODE || env.NEURONS_CHAT_MODE === 'disabled') return null
  const config = neuronPublishingConfiguration(env)
  if (env.NEURONS_CHAT_MODE !== 'mock' || env.NEURONS_PREVIEW_ONLY !== 'true' || !config
    || !/^[a-f0-9]{40}$/.test(env.NEURONS_CHAT_MODEL_REVISION ?? '')) throw Error('Only explicitly configured mock preview chat is supported')
  return { ...config, modelRevision: env.NEURONS_CHAT_MODEL_REVISION, mode: 'mock' }
}

// Transport contract for the existing Python /chat server and moderation adapter.
// No default fetch: the runtime below supplies ONLY the in-process mock transport.
export function neuronChatServices({ fetcher, revision }) {
  const signal = AbortSignal.timeout(15000)
  async function post(url, body) {
    const result = await fetcher(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mock-only-no-credential' }, body: JSON.stringify(body) })
    if (!result.ok) throw Error('Service unavailable')
    const value = JSON.parse((await readLimitedBody(result, 20000)).toString('utf8'))
    return { value, result }
  }
  return {
    async moderate(text) {
      const { value } = await post('https://moderation.invalid/check', { text })
      if (typeof value?.safe !== 'boolean') throw Error('Invalid moderation verdict')
      return value.safe
    },
    async generate(recipe, messages) {
      const { value, result } = await post('https://steering.invalid/chat', { ...recipe.steering, messages })
      if (result.headers.get('X-Model-Revision') !== revision || typeof value?.reply !== 'string' || !value.reply.trim() || value.reply.length > 4000) throw Error('Invalid inference response')
      return value.reply
    },
  }
}

// Deterministic wiring fixtures, NOT a safety classifier, AI, or neuron steering.
export function mockNeuronChatFetch(revision) {
  return async (url, options) => {
    const body = JSON.parse(options.body)
    if (url === 'https://moderation.invalid/check') return Response.json({ safe: !body.text.includes('[mock-block]') })
    if (url !== 'https://steering.invalid/chat') throw Error('No network transport permitted')
    return Response.json({ reply: `Mock connection confirmed for L${body.layer} / N${body.neuron} (${body.direction}, α ${body.alpha}). Received ${body.messages.length} conversation messages. No model was run.` },
      { headers: { 'X-Model-Revision': revision } })
  }
}

export function createNeuronChatHandler({ env = process.env, database = createHookLabDatabasePool, services = null } = {}) {
  return async request => {
    let pool, chats, reservation
    try {
      const config = neuronChatConfiguration(env)
      if (!config) return response({ error: 'Chat connection is disabled.' }, 404)
      const bot = assertNeuronEdge(request, env)
      if (!servedFromConfiguredOrigin(request, config.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: 'Use the configured site.' }, 403)
      if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405)
      try { assertSameOrigin(request, config.origin) } catch { return response({ error: 'Use the configured site.' }, 403) }
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return response({ error: 'JSON required.' }, 415)
      let body
      try { body = input.parse(JSON.parse((await readLimitedBody(request, 4096)).toString('utf8'))) } catch { return response({ error: 'Invalid or oversized chat request.' }, 400) }
      const token = walletIdentitySessionToken(request)
      if (!token) return response({ error: 'Sign in with your wallet first.' }, 401)
      pool = database(config)
      const ip = createHash('sha256').update(clientAddress(request) ?? 'unknown').digest('hex')
      if (!await walletIdentityQuota(pool, [['neuron-chat:global', 60], [`neuron-chat:ip:${ip}`, 20]])) return response({ error: 'Too many chat requests. Try later.' }, 429)
      const principal = await walletPrincipalStore(pool, { enabled: true, origin: config.origin,
        audience: config.audience, genesisHash: config.genesisHash }).resolve(token)
      const characters = neuronCharacterStore(pool), character = await characters.publicById(body.characterId)
      if (!character?.personality) return response({ error: 'Approved imported recipe not found.' }, 404)
      const recipe = character.personality
      // Import bounds are broader than the existing Python ChatRequest contract.
      if (recipe.model.revision !== config.modelRevision || recipe.steering.alpha > 1.25) return response({ error: 'Recipe is incompatible with the configured chat model or alpha limit (1.25).' }, 409)
      await verifyNeuronBot(request, bot, 'neuron-chat')
      chats = neuronChatStore(pool)
      reservation = await chats.reserve(principal.wallet, body)
      const api = services ?? neuronChatServices({ fetcher: mockNeuronChatFetch(config.modelRevision), revision: config.modelRevision })
      const history = reservation.history ?? []
      for (const message of [...history, { role: 'user', content: body.message }]) {
        if (!await api.moderate(message.content)) throw fail('Message withheld by moderation.', 422)
      }
      const reply = reservation.replay ? reservation.row.reply : await api.generate(recipe, [...history, { role: 'user', content: body.message }])
      if (!await api.moderate(reply)) throw fail('Reply withheld by moderation.', 422)
      if (!await characters.publicById(body.characterId)) throw fail('Character is no longer published.', 404)
      if (!reservation.replay) await chats.finish(reservation.row.id, 'complete', reply)
      return response({ reply, requestId: body.requestId })
    } catch (error) {
      if (reservation && !reservation.replay) await chats.finish(reservation.row.id, error.status === 422 ? 'blocked' : 'failed').catch(() => {})
      const status = [401, 403, 404, 409, 422, 429].includes(error.status) ? error.status : 503
      return response({ error: status === 503 ? 'Mock chat is temporarily unavailable. No live model was called.' : error.message }, status)
    } finally { if (pool) await pool.end().catch(() => {}) }
  }
}
