import test from 'node:test'
import assert from 'node:assert/strict'
import { neuronBotConfiguration, assertNeuronEdge, verifyNeuronBot } from '../app/lib/neuron-bot-protection.mjs'
import { createNeuronPublishingHandler } from '../app/lib/neuron-publishing.mjs'
import { createWalletIdentityHandler } from '../app/lib/hooklab-wallet-identity.mjs'

const origin = 'https://repo.ing'
const env = { NEURONS_PUBLISHING_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true',
  HOOK_WALLET_IDENTITY_ORIGIN: origin, HOOK_WALLET_IDENTITY_DATABASE_URL: 'postgresql://fixture/isolated',
  NEURONS_DATABASE_URL: 'postgresql://fixture/isolated', NEURONS_TURNSTILE_SITE_KEY: 'site-key-fixture',
  NEURONS_TURNSTILE_SECRET_KEY: 'server-key-fixture', NEURONS_EDGE_SECRET: 'e'.repeat(48) }
const request = (token = 'fresh', extra = {}) => new Request(`${origin}/api/neuron-characters`, {
  headers: { 'x-neuron-edge-secret': env.NEURONS_EDGE_SECRET, 'x-neuron-bot-token': token, ...extra } })

test('public publishing cannot start without real bot credentials or use the preview bypass on a public host', () => {
  assert.equal(neuronBotConfiguration({}), null)
  assert.equal(neuronBotConfiguration({ NEURONS_PUBLISHING_ENABLED: 'true', NEURONS_PREVIEW_ONLY: 'true', HOOK_WALLET_IDENTITY_ORIGIN: 'https://example.onamp.dev' }), null)
  for (const change of [{ NEURONS_PREVIEW_ONLY: 'true' }, { NEURONS_EDGE_SECRET: '' }, { NEURONS_TURNSTILE_SITE_KEY: '' },
    { NEURONS_TURNSTILE_SECRET_KEY: '' }, { NEURONS_EDGE_SECRET: 'short' }, { NEURONS_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
    { NEURONS_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }]) assert.throws(() => neuronBotConfiguration({ ...env, ...change }))
})

test('direct-origin and spoofed forwarding headers cannot reach either database boundary', async () => {
  const db = () => assert.fail('Rejected before DB')
  for (const handler of [createNeuronPublishingHandler({ env, database: db }), createWalletIdentityHandler({ env, database: db })]) {
    for (const secret of ['', 'wrong', 'e'.repeat(47), 'x'.repeat(48)]) {
      const response = await handler(request('fresh', { 'x-neuron-edge-secret': secret, 'x-forwarded-host': 'repo.ing', 'cf-connecting-ip': '1.2.3.4' }))
      assert.equal(response.status, 403)
      assert.ok(!(await response.text()).includes(env.NEURONS_EDGE_SECRET))
    }
  }
  assert.equal(assertNeuronEdge(request(), env).hostname, 'repo.ing')
})

test('bot proof is action/hostname bound, single use, bounded and fails closed without leaking secrets', async () => {
  const config = neuronBotConfiguration(env), used = new Set()
  const fetcher = async (_url, options) => {
    const sent = JSON.parse(options.body)
    assert.equal(sent.secret, env.NEURONS_TURNSTILE_SECRET_KEY)
    assert.ok(options.signal); assert.equal(options.redirect, 'error')
    if (sent.response === 'network') throw Error(`private ${sent.secret}`)
    if (sent.response === 'http') return new Response('{}', { status: 503 })
    if (sent.response === 'json') return new Response('{')
    const success = !used.has(sent.response) && sent.response !== 'invalid'
    used.add(sent.response)
    return Response.json({ success, hostname: sent.response === 'host' ? 'evil.invalid' : 'repo.ing',
      action: sent.response === 'action' ? 'neuron-signin' : 'neuron-publish' })
  }
  await verifyNeuronBot(request('fresh'), config, 'neuron-publish', fetcher)
  for (const token of ['fresh', 'invalid', 'host', 'action', '', 'a'.repeat(2049)]) await assert.rejects(verifyNeuronBot(request(token), config, 'neuron-publish', fetcher), { status: 403 })
  for (const token of ['network', 'http', 'json']) await assert.rejects(verifyNeuronBot(request(token), config, 'neuron-publish', fetcher), error => error.status === 503 && !error.message.includes(env.NEURONS_TURNSTILE_SECRET_KEY))
})

test('identity checks human proof before issuing a challenge and respects a global quota before verification calls', async () => {
  const wallet = '11111111111111111111111111111111'
  const req = token => new Request(`${origin}/api/hook-lab/wallet-identity`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-neuron-edge-secret': env.NEURONS_EDGE_SECRET, 'x-neuron-bot-token': token },
    body: JSON.stringify({ action: 'challenge', wallet }) })
  let proofCalls = 0, allow = true, issued = 0
  const handler = createWalletIdentityHandler({ env, database: () => ({ end: async () => {} }),
    store: () => ({ challenge: async () => { issued++; return { nonce: 'a'.repeat(64) } } }),
    quota: async (_pool, scopes) => { assert.deepEqual(scopes[0], ['wallet-identity:global', 300]); return allow },
    fetcher: async (_url, options) => { proofCalls++; return Response.json({ success: JSON.parse(options.body).response === 'good', hostname: 'repo.ing', action: 'neuron-signin' }) } })
  assert.equal((await handler(req('bad'))).status, 403); assert.equal(issued, 0)
  assert.equal((await handler(req('good'))).status, 200); assert.equal(issued, 1)
  allow = false
  assert.equal((await handler(req('good'))).status, 429); assert.equal(issued, 1); assert.equal(proofCalls, 2)
})
