import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createPrivateKey, sign } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { neuronCharacterStore, characterSubmission } from '../src/neuron-characters.mjs'
import { createNeuronPublishingHandler, neuronPublishingConfiguration } from '../app/lib/neuron-publishing.mjs'
import { walletIdentityQuota } from '../app/lib/hooklab-wallet-identity.mjs'
import { walletPrincipalStore } from '../src/hooklab-wallet-principal.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { parsePersonalityImport, PERSONALITY_IMPORT_TEMPLATE } from '../app/lib/neuron-import.mjs'

if (process.env.NEURONS_RELEASE_REQUIRED === 'true' && !process.env.NEURONS_TEST_DATABASE_URL) {
  throw Error('NEURONS_TEST_DATABASE_URL is required for the publishing release gate; database tests must not be skipped.')
}

const draft = () => ({ personaId: 'crab', name: 'Sideways Club', ticker: 'SIDE', story: 'An ocean explorer with sideways ideas.', consent: true, requestId: randomUUID() })
const imported = () => ({ personality: { ...structuredClone(PERSONALITY_IMPORT_TEMPLATE), model: { id: 'Qwen/Qwen3-8B', revision: 'a'.repeat(40) } }, consent: true, requestId: randomUUID() })
const origin = 'https://neurons-tests.onamp.dev'
test('publishing is explicit opt-in and rejects financial fields, overrides and unapproved content shapes', async () => {
  const handler = createNeuronPublishingHandler({ env: {}, database: () => assert.fail('DB') })
  assert.equal((await handler(new Request(`${origin}/api/neuron-characters`))).status, 404)
  assert.equal(neuronPublishingConfiguration({}), null)
  assert.throws(() => neuronPublishingConfiguration({ NEURONS_PUBLISHING_ENABLED: 'true' }))
  for (const change of [{ mint: 'forged' }, { creatorWallet: 'forged' }, { feeBps: 500 }, { status: 'published' }, { recipe: {} }, { consent: false }, { personaId: 'unknown' }, { ticker: '1BAD' }, { name: '\u202eunsafe' }, { story: 'a'.repeat(281) }]) assert.throws(() => characterSubmission({ ...draft(), ...change }))
  const first = characterSubmission(draft()), second = characterSubmission({ ...draft(), name: 'Different Crab' })
  assert.equal(first.snapshot.recipe.neuron, 4498)
  assert.equal(first.snapshot.chatMode, 'reviewed-scripts-v1')
  assert.equal(first.snapshot.recipe.modelRevision, null)
  assert.notEqual(first.metadataSha256, second.metadataSha256)
})

test('personality imports validate a bounded data-only format without claiming inference or accepting financial overrides', () => {
  const input = imported(), personality = input.personality
  const value = characterSubmission(input)
  assert.equal(value.snapshot.version, 2)
  assert.equal(value.snapshot.chatMode, 'unavailable')
  assert.equal(value.snapshot.personality.model.revision, 'a'.repeat(40))
  assert.deepEqual(parsePersonalityImport(JSON.stringify(value.snapshot.personality, null, 2)), personality)
  const reordered = Object.fromEntries(Object.entries(personality).reverse())
  assert.equal(characterSubmission({ ...input, personality: reordered }).metadataSha256, value.metadataSha256)
  for (const change of [{ name: 'A different name' }, { model: { ...personality.model, revision: 'b'.repeat(40) } },
    { steering: { ...personality.steering, direction: 'down' } }, { examples: [] }]) {
    assert.notEqual(characterSubmission({ ...input, personality: { ...personality, ...change } }).metadataSha256, value.metadataSha256)
  }
  for (const change of [{ format: 'pickle' }, { version: 2 }, { mint: 'forged' }, { code: 'exec()' }, { name: '\u202eunsafe' },
    { model: { id: 'other', revision: 'a'.repeat(40) } }, { model: { ...personality.model, revision: 'main' } },
    { attribution: { author: 'test', url: 'javascript:alert(1)' } }, { attribution: { author: 'test', url: 'not a URL' } },
    { attribution: { author: 'test', url: 'https://user:password@example.com' } },
    { examples: [{ prompt: 'Hello', reply: 'x'.repeat(501) }] }, { examples: Array(4).fill(personality.examples[0]) }]) {
    assert.throws(() => characterSubmission({ ...input, personality: { ...personality, ...change } }))
  }
  for (const steering of [{ layer: -1 }, { layer: 36 }, { layer: 1.5 }, { neuron: -1 }, { neuron: 12288 },
    { alpha: 0 }, { alpha: -1 }, { alpha: 10.01 }, { alpha: Infinity }, { direction: 'sideways' }]) {
    assert.throws(() => characterSubmission({ ...input, personality: { ...personality, steering: { ...personality.steering, ...steering } } }))
  }
  for (const steering of [{ layer: 0, neuron: 0, direction: 'down', alpha: 0.01 }, { layer: 35, neuron: 12287, direction: 'up', alpha: 10 }]) {
    assert.deepEqual(characterSubmission({ ...input, personality: { ...personality, steering } }).snapshot.personality.steering, steering)
  }
  for (const change of [{ personaId: 'crab' }, { status: 'published' }, { mint: 'forged' }, { creatorWallet: 'forged' }, { consent: false }]) assert.throws(() => characterSubmission({ ...input, ...change }))
  assert.throws(() => parsePersonalityImport('{broken'), /valid JSON/)
  assert.throws(() => parsePersonalityImport(' '.repeat(8193)), /8 KiB/)
  assert.throws(() => parsePersonalityImport(JSON.stringify({ ...personality, examples: Array(3).fill({ prompt: '界'.repeat(500), reply: '界'.repeat(500) }) })), /8 KiB/)
})

test('associated concepts are optional, bounded provenance claims covered by the immutable hash', () => {
  const input = imported()
  delete input.personality.associatedConcepts
  const legacy = characterSubmission(input)
  assert.equal(Object.hasOwn(legacy.snapshot.personality, 'associatedConcepts'), false)
  assert.deepEqual(parsePersonalityImport(JSON.stringify(legacy.snapshot.personality)), input.personality)
  const concepts = { terms: ['pirate', '海盗'], method: 'j-lens', sourceUrl: 'https://example.com/analysis' }
  const tagged = changes => characterSubmission({ ...input, personality: { ...input.personality, associatedConcepts: { ...concepts, ...changes } } })
  const first = tagged({})
  assert.deepEqual(first.snapshot.personality.associatedConcepts, concepts)
  assert.notEqual(first.metadataSha256, legacy.metadataSha256)
  for (const change of [{ terms: ['horse'] }, { method: 'r-lens' }, { sourceUrl: 'https://example.com/other' }]) assert.notEqual(tagged(change).metadataSha256, first.metadataSha256)
  for (const method of ['j-lens', 'r-lens', 'logit-lens', 'creator']) assert.equal(tagged({ method }).snapshot.personality.associatedConcepts.method, method)
  assert.equal(tagged({ terms: Array.from({ length: 12 }, (_, i) => `${i}${'界'.repeat(38)}`) }).snapshot.personality.associatedConcepts.terms.length, 12)
  for (const change of [{ terms: [] }, { terms: Array.from({ length: 13 }, (_, i) => `${i}`) }, { terms: ['x'.repeat(41)] },
    { terms: [' '] }, { terms: ['pirate', ' Pirate '] }, { terms: ['\u202epirate'] }, { method: 'verified' },
    { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'https://user:password@example.com' }, { verified: true }, { terms: [{ term: 'pirate', rank: 1 }] }]) assert.throws(() => tagged(change))
})

test('PostgreSQL publishing enforces authenticated ownership, review visibility, replay and concurrent caps', { skip: !process.env.NEURONS_TEST_DATABASE_URL }, async t => {
  const databaseUrl = process.env.NEURONS_TEST_DATABASE_URL
  if (!new URL(databaseUrl).pathname.endsWith('_test')) throw Error('Use a dedicated *_test database')
  const schema = `neuron_test_${randomUUID().replaceAll('-', '')}`, admin = new pg.Pool({ connectionString: databaseUrl })
  const roles = { schema, runtime_role: `${schema}_runtime`, review_role: `${schema}_reviewer` }
  let pool
  try {
    await admin.query(`create schema ${schema}`)
    const database = () => new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
    pool = database()
    for (const file of ['hooklab-wallet-principal-schema.sql', 'hooklab-wallet-identity-quota-schema.sql', 'neuron-characters-schema.sql']) await pool.query(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
    const env = { NEURONS_PUBLISHING_ENABLED: 'true', NEURONS_PREVIEW_ONLY: 'true', NEURONS_DATABASE_URL: databaseUrl,
      HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_WALLET_IDENTITY_DATABASE_URL: databaseUrl, HOOK_WALLET_IDENTITY_ORIGIN: origin }
    const handler = createNeuronPublishingHandler({ env, database }), store = neuronCharacterStore(pool)
    const cfg = { enabled: true, origin, audience: 'general-launcher', genesisHash: HOOK_MAINNET_GENESIS }
    const principal = walletPrincipalStore(pool, cfg)
    async function identity(seedByte, identities = principal) {
      const seed = Buffer.alloc(32, seedByte), wallet = Keypair.fromSeed(seed).publicKey.toBase58()
      const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
      const binding = Buffer.alloc(32, seedByte).toString('base64url'), challenge = await identities.challenge(wallet, binding)
      const session = await identities.verify({ wallet, nonce: challenge.nonce, signature: sign(null, Buffer.from(challenge.message), key).toString('base64') }, binding)
      return { wallet, token: session.sessionToken }
    }
    const alice = await identity(31), bob = await identity(32)
    const call = (body, owner = alice, extra = {}) => handler(new Request(`${origin}/api/neuron-characters${extra.query ?? ''}`, {
      method: body ? 'POST' : 'GET', headers: { origin, 'content-type': 'application/json', ...(owner ? { cookie: `__Host-hook-wallet-session=${owner.token}` } : {}), ...extra.headers },
      ...(body ? { body: JSON.stringify(body) } : {}) }))
    const reset = () => pool.query('truncate neuron_character_reviews, neuron_characters, hook_lab_wallet_request_limits restart identity')
    await t.test('only signed-in owner sees pending; approve makes public; removal hides it without erasing history', async () => {
      const submission = draft()
      assert.equal((await call(submission, null)).status, 401)
      assert.equal((await call(submission, alice, { headers: { origin: 'https://evil.invalid' } })).status, 403)
      assert.equal((await call({ ...submission, creatorWallet: bob.wallet })).status, 400)
      const result = await call(submission), value = await result.json(), character = value.character
      assert.equal(result.status, 201); assert.equal(character.status, 'pending'); assert.equal(character.creatorWallet, alice.wallet)
      assert.equal(value.financialExecutionEnabled, false); assert.equal(character.mint, null)
      assert.equal(await store.publicById(character.id), null)
      assert.deepEqual((await (await call(null, null)).json()).characters, [])
      assert.equal((await (await call(null, alice, { query: '?scope=mine' })).json()).characters.length, 1)
      assert.deepEqual((await (await call(null, bob, { query: '?scope=mine' })).json()).characters, [])
      const approved = await store.review(character.id, 'published', 'Reviewed name, story and source attribution.')
      assert.equal(approved.metadataSha256, character.metadataSha256)
      assert.equal((await store.publicById(character.id)).name, submission.name)
      assert.equal((await (await call(null, null)).json()).characters[0].id, character.id)
      await store.review(character.id, 'rejected', 'Removed following an ownership review request.')
      assert.equal(await store.publicById(character.id), null)
      assert.equal((await store.list(alice.wallet))[0].status, 'rejected')
      assert.equal((await pool.query('select count(*)::int as count from neuron_character_reviews')).rows[0].count, 2)
    })
    await reset()
    await t.test('imported recipes remain private until review; exports round-trip and removal revokes downloads', async () => {
      const input = imported()
      // Valid UTF-8 import above the previous 4 KiB cap must survive HTTP and export.
      input.personality.examples = Array.from({ length: 3 }, () => ({ prompt: 'é'.repeat(400), reply: 'ç'.repeat(400) }))
      assert.ok(Buffer.byteLength(JSON.stringify(input)) > 4096)
      assert.equal((await call({ ...input, mint: 'forged' }, bob)).status, 400)
      assert.equal((await handler(new Request(`${origin}/api/neuron-characters`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: ' '.repeat(9217) }))).status, 400)
      const submitted = await call(input, bob), { character } = await submitted.json()
      assert.equal(submitted.status, 201)
      assert.equal(character.status, 'pending'); assert.equal(character.chatMode, 'unavailable')
      assert.equal(character.mint, null); assert.equal(character.financialExecutionEnabled, false)
      const download = () => call(null, null, { query: `?export=${character.id}` })
      assert.equal((await download()).status, 404)
      assert.deepEqual((await (await call(null, alice, { query: '?scope=mine' })).json()).characters, [])
      await store.review(character.id, 'published', 'Reviewed all imported fields and creator supplied examples.')
      const exported = await download()
      assert.equal(exported.status, 200)
      assert.match(exported.headers.get('content-disposition'), /attachment; filename="TIDE-personality.json"/)
      const roundTrip = parsePersonalityImport(await exported.text())
      assert.deepEqual(roundTrip, input.personality)
      assert.equal(characterSubmission({ ...input, personality: roundTrip }).metadataSha256, character.metadataSha256)
      assert.equal((await (await call(input, bob)).json()).character.id, character.id)
      assert.equal((await call({ ...input, personality: { ...roundTrip, steering: { ...roundTrip.steering, neuron: 123 } } }, bob)).status, 409)
      const another = await store.submit(bob.wallet, { ...input, requestId: randomUUID(), personality: { ...roundTrip, name: 'New version' } })
      assert.equal(another.status, 'pending'); assert.notEqual(another.metadataSha256, character.metadataSha256)
      assert.equal((await store.publicById(character.id)).name, input.personality.name)
      await store.review(character.id, 'rejected', 'Removed following source attribution review.')
      assert.equal((await download()).status, 404)
      await pool.query("update neuron_characters set snapshot=jsonb_set(snapshot,'{personality,steering,neuron}','123') where id=$1", [another.id])
      await assert.rejects(store.review(another.id, 'published', 'Corrupted imports must not pass review.'))
    })
    await reset()
    await t.test('public submissions require a fresh valid publishing proof; rejects never persist a character', async () => {
      const publicEnv = { ...env, NEURONS_PREVIEW_ONLY: 'false', NEURONS_TURNSTILE_SITE_KEY: 'site-key-fixture',
        NEURONS_TURNSTILE_SECRET_KEY: 'server-key-fixture', NEURONS_EDGE_SECRET: 'e'.repeat(48) }
      const consumed = new Set()
      const publicHandler = createNeuronPublishingHandler({ env: publicEnv, database, fetcher: async (_url, options) => {
        const token = JSON.parse(options.body).response
        if (token === 'unavailable') throw Error('Verifier unavailable')
        const success = token === 'valid-once' && !consumed.has(token); consumed.add(token)
        return Response.json({ success, hostname: new URL(origin).hostname, action: 'neuron-publish' })
      } })
      const submit = token => publicHandler(new Request(`${origin}/api/neuron-characters`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${alice.token}`,
          'x-neuron-edge-secret': publicEnv.NEURONS_EDGE_SECRET, 'x-neuron-bot-token': token }, body: JSON.stringify(imported()) }))
      for (const token of ['', 'forged', 'unavailable']) assert.equal((await submit(token)).status, token === 'unavailable' ? 503 : 403)
      assert.equal((await store.list(alice.wallet)).length, 0)
      assert.equal((await submit('valid-once')).status, 201)
      assert.equal((await submit('valid-once')).status, 403)
      assert.equal((await store.list(alice.wallet)).length, 1)
    })
    await reset()
    await t.test('identical concurrent retries create once; changed retry returns conflict; fresh process reads durable data', async () => {
      const input = draft(), results = await Promise.all([call(input), call(input)])
      assert.deepEqual(results.map(r => r.status), [201, 201])
      const values = await Promise.all(results.map(r => r.json()))
      assert.equal(values[0].character.id, values[1].character.id)
      assert.equal((await call({ ...input, story: 'Different story with the same submission key.' })).status, 409)
      const other = database()
      try { assert.equal((await neuronCharacterStore(other).list(alice.wallet)).length, 1) } finally { await other.end() }
      await principal.revoke(alice.token)
      assert.equal((await call(draft())).status, 401)
    })
    await reset()
    await t.test('parallel submissions cannot exceed pending, daily wallet, or global caps', async () => {
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => store.submit(bob.wallet, draft())))
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 2)
      assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 429))
      for (const character of await store.list(bob.wallet)) await store.review(character.id, 'published', 'Reviewed safe bounded fixture content.')
      const third = await store.submit(bob.wallet, draft())
      await store.review(third.id, 'published', 'Reviewed safe bounded fixture content.')
      await assert.rejects(store.submit(bob.wallet, draft()), { status: 429 })
      // 99 global submissions: two distinct new wallets race for the final slot.
      const value = characterSubmission(draft())
      await pool.query(`insert into neuron_characters(id,creator_wallet,request_id,snapshot,metadata_sha256,status)
        select gen_random_uuid(),'fixture',gen_random_uuid(),$1,$2,'rejected' from generate_series(1,96)`, [value.snapshot, value.metadataSha256])
      const last = await Promise.allSettled([store.submit('fixture-wallet-a', draft()), store.submit('fixture-wallet-b', draft())])
      assert.equal(last.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(last.find(r => r.status === 'rejected').reason.status, 429)
    })
    await reset()
    await t.test('release database roles permit publishing and review but refuse web self-approval and history edits', async () => {
      for (const role of [roles.runtime_role, roles.review_role]) await admin.query(`create role ${role} nologin`)
      const grants = (await readFile(new URL('../src/neuron-publishing-grants.sql', import.meta.url), 'utf8'))
        .replace(/:"(schema|runtime_role|review_role)"/g, (_match, name) => `"${roles[name]}"`)
      await pool.query(grants)
      // Startup roles apply to EVERY connection, including replacements after SQL errors.
      const runtime = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c role=${roles.runtime_role}` })
      const reviewer = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c role=${roles.review_role}` })
      try {
        const identities = walletPrincipalStore(runtime, cfg), owner = await identity(33, identities)
        assert.equal((await identities.resolve(owner.token)).wallet, owner.wallet)
        assert.equal(await walletIdentityQuota(runtime, [['release-role-quota', 2]]), true)
        assert.equal(await walletIdentityQuota(runtime, [['release-role-quota', 2]]), true)
        assert.equal(await walletIdentityQuota(runtime, [['release-role-quota', 2]]), false)
        const published = neuronCharacterStore(runtime), review = neuronCharacterStore(reviewer)
        const character = await published.submit(owner.wallet, draft())
        assert.equal(character.status, 'pending'); assert.equal(await published.publicById(character.id), null)
        await assert.rejects(published.review(character.id, 'published', 'The web role must never approve its own submissions.'), { code: '42501' })
        await assert.rejects(runtime.query("update neuron_characters set status='published' where id=$1", [character.id]), { code: '42501' })
        const value = characterSubmission(draft())
        await assert.rejects(runtime.query(`insert into neuron_characters(id,creator_wallet,request_id,snapshot,metadata_sha256,status)
          values($1,$2,$3,$4,$5,'published')`, [randomUUID(), owner.wallet, value.requestId, value.snapshot, value.metadataSha256]), { code: '42501' })
        await assert.rejects(runtime.query('create table forbidden (id int)'), { code: '42501' })
        await review.review(character.id, 'published', 'Reviewed safe fixture content with the operator role.')
        assert.equal((await published.publicById(character.id)).status, 'published')
        await assert.rejects(reviewer.query("update neuron_characters set creator_wallet='forged' where id=$1", [character.id]), { code: '42501' })
        await assert.rejects(reviewer.query('select * from hook_lab_wallet_sessions'), { code: '42501' })
        await assert.rejects(reviewer.query('delete from neuron_character_reviews'), { code: '42501' })
        await review.review(character.id, 'rejected', 'Removed fixture following the moderation rehearsal.')
        assert.equal(await published.publicById(character.id), null)
        assert.equal((await reviewer.query('select count(*)::int as count from neuron_character_reviews')).rows[0].count, 2)
        await identities.revoke(owner.token)
        await assert.rejects(identities.resolve(owner.token), { status: 401 })
      } finally { await runtime.end(); await reviewer.end() }
    })
    await reset()
    await t.test('metadata corruption and exhausted shared quotas fail closed', async () => {
      const character = await store.submit(bob.wallet, draft())
      await pool.query("update neuron_characters set snapshot=jsonb_set(snapshot,'{recipe,neuron}','123') where id=$1", [character.id])
      await assert.rejects(store.review(character.id, 'published', 'This corrupted snapshot must not be approved.'))
      assert.equal(await store.publicById(character.id), null)
      await pool.query("insert into hook_lab_wallet_request_limits(scope,hits,expires_at) values('neurons:global',600,clock_timestamp()+interval '10 minutes')")
      assert.equal((await call(null, null)).status, 429)
    })
  } finally {
    if (pool) await pool.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    for (const role of [roles.runtime_role, roles.review_role]) await admin.query(`drop role if exists ${role}`)
    await admin.end()
  }
})
