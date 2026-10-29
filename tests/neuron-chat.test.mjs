import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createPrivateKey, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { Keypair } from '@solana/web3.js'
import { createNeuronChatHandler, neuronChatConfiguration, neuronChatServices, mockNeuronChatFetch } from '../app/lib/neuron-chat.mjs'
import { neuronCharacterStore } from '../src/neuron-characters.mjs'
import { neuronChatStore } from '../src/neuron-chat.mjs'
import { walletPrincipalStore } from '../src/hooklab-wallet-principal.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { PERSONALITY_IMPORT_TEMPLATE } from '../app/lib/neuron-import.mjs'

const origin = 'https://neuron-chat-tests.onamp.dev', revision = 'a'.repeat(40)
const environment = databaseUrl => ({ NEURONS_CHAT_MODE: 'mock', NEURONS_CHAT_MODEL_REVISION: revision,
  NEURONS_PUBLISHING_ENABLED: 'true', NEURONS_PREVIEW_ONLY: 'true', NEURONS_DATABASE_URL: databaseUrl,
  HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_WALLET_IDENTITY_DATABASE_URL: databaseUrl, HOOK_WALLET_IDENTITY_ORIGIN: origin })
const message = characterId => ({ characterId, conversationId: randomUUID(), requestId: randomUUID(), message: 'Hello ocean explorer' })
if (process.env.NEURONS_RELEASE_REQUIRED === 'true' && !process.env.NEURONS_TEST_DATABASE_URL) throw Error('NEURONS_TEST_DATABASE_URL is required for chat release tests')

test('chat defaults off; live execution, public bypass and unpinned revisions cannot be configured', async () => {
  assert.equal(neuronChatConfiguration({}), null)
  const env = environment('postgresql://localhost/isolated_test')
  assert.equal(neuronChatConfiguration(env).mode, 'mock')
  for (const change of [{ NEURONS_CHAT_MODE: 'live' }, { NEURONS_PREVIEW_ONLY: 'false' }, { NEURONS_CHAT_MODEL_REVISION: 'main' },
    { HOOK_WALLET_IDENTITY_ORIGIN: 'https://repo.ing' }, { NEURONS_PUBLISHING_ENABLED: 'false' }]) assert.throws(() => neuronChatConfiguration({ ...env, ...change }))
  const response = await createNeuronChatHandler({ env: {}, database: () => assert.fail('Unexpected DB') })(new Request(`${origin}/api/neuron-chat`))
  assert.equal(response.status, 404)
})

test('steering wire contract pins revision, bounds replies and fails closed on invalid moderation', async () => {
  const recipe = { steering: { layer: 9, neuron: 7601, direction: 'down', alpha: 0.73 } }, history = [{ role: 'user', content: 'Hi' }]
  const calls = [], fixture = mockNeuronChatFetch(revision)
  const api = neuronChatServices({ revision, fetcher: async (url, options) => { calls.push({ url, options }); return fixture(url, options) } })
  assert.equal(await api.moderate('hello'), true); assert.equal(await api.moderate('[mock-block]'), false)
  assert.match(await api.generate(recipe, history), /L9 \/ N7601 \(down, α 0.73\).*1 conversation messages.*No model was run/)
  assert.deepEqual(JSON.parse(calls[2].options.body), { ...recipe.steering, messages: history })
  assert.equal(calls[0].options.signal, calls[2].options.signal) // One deadline covers the whole pipeline.
  const bad = fetcher => neuronChatServices({ revision, fetcher })
  for (const verdict of [{}, { safe: 'false' }]) await assert.rejects(bad(async () => Response.json(verdict)).moderate('hi'))
  for (const reply of ['', 'x'.repeat(4001)]) await assert.rejects(bad(async () => Response.json({ reply }, { headers: { 'X-Model-Revision': revision } })).generate(recipe, history))
  await assert.rejects(bad(async () => Response.json({ reply: 'hi' }, { headers: { 'X-Model-Revision': 'b'.repeat(40) } })).generate(recipe, history))
  await assert.rejects(bad(async () => new Response('x'.repeat(20001))).moderate('hi'))
  await assert.rejects(bad(async () => { throw Error('transport failed') }).generate(recipe, history))
})

test('authenticated PostgreSQL mock chat: ownership, moderation, replay and bounded admission', { skip: !process.env.NEURONS_TEST_DATABASE_URL }, async t => {
  const databaseUrl = process.env.NEURONS_TEST_DATABASE_URL
  if (!new URL(databaseUrl).pathname.endsWith('_test')) throw Error('Use an isolated *_test database')
  const schema = `chat_test_${randomUUID().replaceAll('-', '')}`, admin = new pg.Pool({ connectionString: databaseUrl })
  let pool
  try {
    await admin.query(`create schema ${schema}`)
    const database = () => new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
    pool = database()
    for (const file of ['hooklab-wallet-principal-schema.sql', 'hooklab-wallet-identity-quota-schema.sql', 'neuron-characters-schema.sql', 'neuron-chat-schema.sql']) await pool.query(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
    const env = environment(databaseUrl), characters = neuronCharacterStore(pool), chats = neuronChatStore(pool)
    const identities = walletPrincipalStore(pool, { enabled: true, origin, audience: 'general-launcher', genesisHash: HOOK_MAINNET_GENESIS })
    async function identity(seedByte) {
      const seed = Buffer.alloc(32, seedByte), wallet = Keypair.fromSeed(seed).publicKey.toBase58()
      const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
      const binding = seed.toString('base64url'), challenge = await identities.challenge(wallet, binding)
      const session = await identities.verify({ wallet, nonce: challenge.nonce, signature: sign(null, Buffer.from(challenge.message), key).toString('base64') }, binding)
      return { wallet, token: session.sessionToken }
    }
    const alice = await identity(71), bob = await identity(72)
    const personality = { ...structuredClone(PERSONALITY_IMPORT_TEMPLATE), model: { id: 'Qwen/Qwen3-8B', revision }, steering: { layer: 9, neuron: 7601, direction: 'down', alpha: 0.73 } }
    async function imported(change = {}) {
      const row = await characters.submit(alice.wallet, { personality: { ...personality, ...change }, requestId: randomUUID(), consent: true })
      await characters.review(row.id, 'published', 'Local mock fixture content reviewed.')
      return row.id
    }
    const id = await imported(), otherId = await imported({ ticker: 'OTHER' })
    await pool.query("update neuron_characters set created_at=clock_timestamp()-interval '2 days'")
    const seen = [], api = neuronChatServices({ revision, fetcher: async (url, options) => { seen.push({ url, body: JSON.parse(options.body) }); return mockNeuronChatFetch(revision)(url, options) } })
    const handler = createNeuronChatHandler({ env, database, services: api })
    const call = (body, owner = alice, custom = handler, headers = {}) => custom(new Request(`${origin}/api/neuron-chat`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(owner ? { cookie: `__Host-hook-wallet-session=${owner.token}` } : {}), ...headers }, body: JSON.stringify(body) }))
    const reset = async () => { seen.length = 0; await pool.query('truncate neuron_chat_attempts, hook_lab_wallet_request_limits') }
    await t.test('rejects unsigned, forged recipes/history, cross-origin, revoked and incompatible profiles before generation', async () => {
      assert.equal((await call(message(id), null)).status, 401)
      assert.equal((await call(message(id), { token: Buffer.alloc(32, 9).toString('base64url') })).status, 401)
      assert.equal((await call(message(id), alice, handler, { origin: 'https://evil.invalid' })).status, 403)
      for (const override of [{ layer: 1 }, { messages: [] }, { wallet: bob.wallet }, { modelRevision: revision }, { message: 'x'.repeat(501) }]) assert.equal((await call({ ...message(id), ...override })).status, 400)
      const pending = await characters.submit(alice.wallet, { personality, requestId: randomUUID(), consent: true })
      assert.equal((await call(message(pending.id))).status, 404)
      await characters.review(pending.id, 'rejected', 'Not available for chat in this test.')
      assert.equal((await call(message(pending.id))).status, 404)
      await pool.query("update neuron_characters set created_at=clock_timestamp()-interval '2 days'")
      for (const change of [{ model: { id: 'Qwen/Qwen3-8B', revision: 'b'.repeat(40) } }, { steering: { ...personality.steering, alpha: 1.26 } }]) {
        const incompatible = await imported(change)
        assert.equal((await call(message(incompatible))).status, 409)
        await pool.query("update neuron_characters set created_at=clock_timestamp()-interval '2 days'")
      }
      assert.equal(seen.length, 0)
    })
    await reset()
    await t.test('uses saved recipe/history; replay is free of generation and context never crosses wallet, character or conversation', async () => {
      const body = message(id), first = await call(body)
      assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'private, no-store')
      const value = await first.json(); assert.match(value.reply, /N7601/); assert.equal(value.liveInference, false)
      assert.equal((await call(body)).status, 200)
      assert.equal(seen.filter(c => c.url.endsWith('/chat')).length, 1)
      assert.equal((await call({ ...body, message: 'Changed details' })).status, 409)
      assert.equal((await call({ ...body, requestId: randomUUID(), message: 'Second question' })).status, 200)
      const sent = seen.filter(c => c.url.endsWith('/chat')).at(-1).body
      assert.deepEqual(sent.messages, [{ role: 'user', content: body.message }, { role: 'assistant', content: value.reply }, { role: 'user', content: 'Second question' }])
      assert.deepEqual([sent.layer, sent.neuron, sent.direction, sent.alpha], [9, 7601, 'down', 0.73])
      for (const [change, owner] of [[{}, bob], [{ characterId: otherId }, bob], [{ conversationId: randomUUID() }, alice]]) {
        assert.equal((await call({ ...body, ...change, requestId: randomUUID() }, owner)).status, 200)
        assert.equal(seen.filter(c => c.url.endsWith('/chat')).at(-1).body.messages.length, 1)
      }
      assert.equal((await call(message(id))).status, 429)
      assert.equal((await call(body)).status, 200)
    })
    await reset()
    await t.test('input/output moderation and outages withhold replies, persist failures, and consume daily attempts', async () => {
      assert.equal((await call({ ...message(id), message: '[mock-block]' })).status, 422)
      assert.equal(seen.some(c => c.url.endsWith('/chat')), false)
      for (const services of [{ moderate: async text => text !== 'UNSAFE OUTPUT', generate: async () => 'UNSAFE OUTPUT' },
        { moderate: async () => { throw Error('secret upstream details') }, generate: async () => assert.fail('generation') }]) {
        const result = await call(message(id), alice, createNeuronChatHandler({ env, database, services }))
        assert.ok([422, 503].includes(result.status)); assert.doesNotMatch(await result.text(), /UNSAFE OUTPUT|secret upstream details/)
      }
      assert.equal((await call(message(id))).status, 429)
      const { rows } = await pool.query('select status,reply from neuron_chat_attempts order by created_at')
      assert.deepEqual(rows.map(row => row.status), ['blocked', 'blocked', 'failed'])
      assert.ok(rows.every(row => row.reply === null))
    })
    await reset()
    await t.test('removing publication during generation withholds output and prevents replay after removal', async () => {
      const body = message(id)
      assert.equal((await call(body)).status, 200)
      const removal = createNeuronChatHandler({ env, database, services: { moderate: async () => true, generate: async () => {
        await characters.review(id, 'rejected', 'Removed while mock generation was pending.'); return 'hidden'
      } } })
      assert.equal((await call(message(id), alice, removal)).status, 404)
      assert.equal((await call(body)).status, 404)
      await characters.review(id, 'published', 'Restored for remaining mock-only tests.')
    })
    await reset()
    await t.test('parallel admission, expired leases, UTC rollover, global daily and storage ceilings', async () => {
      const attempts = await Promise.allSettled([chats.reserve(alice.wallet, message(id)), chats.reserve(bob.wallet, message(id))])
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 429)
      const first = attempts.find(result => result.status === 'fulfilled').value
      await assert.rejects(chats.reserve(first.row.wallet, { ...message(id), requestId: first.row.request_id, conversationId: first.row.conversation_id, message: first.row.message }), { status: 409 })
      await pool.query("update neuron_chat_attempts set created_at=clock_timestamp()-interval '2 days'")
      const next = await chats.reserve(alice.wallet, message(id))
      await assert.rejects(chats.finish(first.row.id, 'complete', 'too late'), { status: 409 })
      await chats.finish(next.row.id, 'complete', 'okay')
      await pool.query('truncate neuron_chat_attempts')
      const seed = async (count, age) => pool.query(`insert into neuron_chat_attempts(id,wallet,request_id,conversation_id,character_id,message,status,created_at)
        select gen_random_uuid(),'fixture-'||i,gen_random_uuid(),gen_random_uuid(),$1,'fixture','failed',clock_timestamp()-$3::interval from generate_series(1,$2) i`, [id, count, age])
      await seed(100, '0 seconds')
      await assert.rejects(chats.reserve(alice.wallet, message(id)), { status: 429 })
      await pool.query('truncate neuron_chat_attempts')
      await seed(10000, '2 days')
      await assert.rejects(chats.reserve(alice.wallet, message(id)), { status: 429 })
    })
    await reset()
    await t.test('least-privilege runtime can chat but cannot change ownership, reset quotas or publish', async () => {
      const runtime = `${schema}_web`, reviewer = `${schema}_review`
      let restricted
      try {
        await admin.query(`create role ${runtime} nologin; create role ${reviewer} nologin`)
        for (const file of ['neuron-publishing-grants.sql', 'neuron-chat-grants.sql']) {
          const sql = (await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
            .replaceAll(':"schema"', schema).replaceAll(':"runtime_role"', runtime).replaceAll(':"review_role"', reviewer)
          await pool.query(sql)
        }
        restricted = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c role=${runtime}` })
        const store = neuronChatStore(restricted), reserved = await store.reserve(alice.wallet, message(id))
        await store.finish(reserved.row.id, 'complete', 'A bounded safe mock reply')
        assert.equal((await store.reserve(alice.wallet, { ...message(id), requestId: reserved.row.request_id,
          conversationId: reserved.row.conversation_id, message: reserved.row.message })).replay, true)
        for (const sql of ["update neuron_chat_attempts set wallet='forged'", "update neuron_chat_attempts set created_at=clock_timestamp()",
          'delete from neuron_chat_attempts', "update neuron_characters set status='published'"]) await assert.rejects(restricted.query(sql), { code: '42501' })
      } finally {
        if (restricted) await restricted.end()
        await admin.query(`drop owned by ${runtime},${reviewer}; drop role ${runtime}; drop role ${reviewer}`)
      }
    })
  } finally {
    if (pool) await pool.end()
    await admin.query(`drop schema ${schema} cascade`); await admin.end()
  }
})
