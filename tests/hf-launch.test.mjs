import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { startFakeHf, recorded } from './fixtures/hf-server.mjs'
import { createHfClient } from '../src/hf-api.mjs'
import { HF_MARKET_REF_MIN, MarketIdentityError } from '../src/market-identity.mjs'
import { HF_DISCLAIMER, HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'
import { HF_CONFIG_RESERVE_ERROR, HF_MARKETS_UNAVAILABLE, HF_MODEL_MOVED, HF_OPT_OUT_ERROR, HfLaunchError, hfLaunchGuard, hfLaunchSource,
  hfMarketsEnabled, isHfMarketId, modelDescription, modelLookupError, modelTokenDefaults, namesHuggingFace, resolveModel } from '../src/hf-launch.mjs'
import { defaultTokenName, defaultTokenSymbol } from '../app/lib/launch-defaults.mjs'
import { fetchHfAvatar, modelImageSuggestions, safeHfAvatarUrl } from '../app/lib/hf-launch.mjs'
import { modelLaunchPostText, modelLaunchPostUrl } from '../app/lib/model-share.mjs'
import { launchPostUrl } from '../app/lib/builder-share.mjs'
import { POST as resolveRoute } from '../app/api/resolve/route.js'
import { POST as launchRoute } from '../app/api/launch/route.js'
import { GET as repoImages, POST as uploadImage } from '../app/api/repo-images/[repo]/route.js'

const HF = String(HF_MARKET_REF_MIN)
const GPT2 = recorded['model-gpt2'].body, GGUF = recorded['model-llama-2-7b-gguf'].body, LLAMA = recorded['model-llama-3.1-8b'].body
const ORG = recorded['org-openai-community'].body
const notFound = { status: 404, headers: { 'x-error-message': 'not found' }, body: { error: 'not found' } }
const ok = body => ({ status: 200, headers: {}, body })

// An in-memory hf_models registry with the same contract as the real one (tests/hf-launch-db.test.mjs runs it on
// PostgreSQL): one market id per hf_id, ever; later sightings update the row.
function fakeRegistry() {
  const rows = new Map(), queries = []
  let next = HF_MARKET_REF_MIN
  const pool = {
    async query(sql, params) {
      queries.push(sql)
      if (!/^insert into hf_models/.test(sql)) throw Error(`unexpected query: ${sql.slice(0, 40)}`)
      const [hfId, path, ownerHandle, ownerKind, ownerSubject, isPrivate, disabled, gated, baseModels] = params
      const marketRef = rows.get(hfId)?.marketRef ?? String(next++)
      rows.set(hfId, { marketRef, path, ownerHandle, ownerKind, ownerSubject, isPrivate, disabled, gated, baseModels: JSON.parse(baseModels) })
      return { rows: [{ marketRef }] }
    },
  }
  return { pool, rows, queries }
}

async function withHf(work) {
  const server = await startFakeHf()
  server.route('/api/users/meta-llama/overview', notFound)
  server.route('/api/organizations/meta-llama/overview', ok({ _id: '6533b8bd2d1b2a5d8ec9ae8a', name: 'meta-llama', fullname: 'Meta Llama',
    avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/646cf8084eefb026fb8fd8bc/oCTqufkdTkjyGodsx1vo1.png' }))
  try { return await work({ server, hf: createHfClient({ fetchImpl: server.fetchImpl, retries: 0, sleep: async () => {} }) }) }
  finally { await server.close() }
}

function withEnv(values, work) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value
  const restore = () => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value }
  try { const result = work(); return result?.finally ? result.finally(restore) : (restore(), result) } catch (error) { restore(); throw error }
}

// Route handlers read the shared pool and fetch; these record every touch so a refusal can prove it read nothing.
function withRouteGlobals({ pool = null, fetchImpl = null } = {}, work) {
  const saved = { pool: globalThis.__gitfunPool, fetch: globalThis.fetch, hf: globalThis.__repoingHfClient }
  const touched = []
  globalThis.__gitfunPool = pool ?? { query: async sql => { touched.push(`query ${sql}`); throw Error('database reached') },
    connect: async () => { touched.push('connect'); throw Error('database reached') } }
  globalThis.fetch = fetchImpl ?? (async url => { touched.push(`fetch ${url}`); throw Error('network reached') })
  globalThis.__repoingHfClient = createHfClient({ fetchImpl: async url => { touched.push(`hf ${url}`); throw Error('network reached') } })
  return Promise.resolve(work(touched)).finally(() => {
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch; globalThis.__repoingHfClient = saved.hf
  })
}

test('the flag is on only for HF_MARKETS_ENABLED=true; model ids are recognized by range alone', () => {
  assert.equal(hfMarketsEnabled({}), false)
  for (const value of ['', '1', 'TRUE', 'yes', 'true ']) assert.equal(hfMarketsEnabled({ HF_MARKETS_ENABLED: value }), false, value)
  assert.equal(hfMarketsEnabled({ HF_MARKETS_ENABLED: 'true' }), true)
  assert.equal(isHfMarketId(HF), true)
  assert.equal(isHfMarketId(BigInt(HF)), true)
  for (const id of ['1296269', '4503599627370496', '7000000000000001', 'abc', '', null, undefined, '-1', '1e16']) assert.equal(isHfMarketId(id), false, String(id))
})

test('only huggingface.co, www.huggingface.co and hf.co values take the model path', () => {
  for (const value of ['https://huggingface.co/openai-community/gpt2', 'huggingface.co/openai-community/gpt2', 'hf.co/openai-community/gpt2',
    'https://www.huggingface.co/a/b', ' HTTPS://HuggingFace.co/a/b ', 'http://huggingface.co/a/b', 'https://huggingface.co', 'huggingface.co/datasets/x/y',
    'https://hf.co:443/a/b', 'https://huggingface.co?x=1']) assert.equal(namesHuggingFace(value), true, value)
  for (const value of ['https://github.com/openai/gpt-2', 'github.com/huggingface/transformers', 'openai-community/gpt2',
    'https://huggingface.co.evil.test/a/b', 'https://evil.test/huggingface.co/a/b', 'https://user@huggingface.co/a/b', 'hf.com/a/b',
    'https://xhf.co/a/b', '', null, 42]) assert.equal(namesHuggingFace(value), false, String(value))
})

test("token defaults follow the launch form's rule: model name up to 32 characters, ticker A-Z/0-9 up to 10", () => {
  for (const [name, tokenName, tokenSymbol] of [['gpt2', 'gpt2', 'GPT2'], ['Llama-3.1-8B-Instruct', 'Llama-3.1-8B-Instruct', 'LLAMA318BI'],
    ['Llama-2-7B-GGUF', 'Llama-2-7B-GGUF', 'LLAMA27BGG'], ['bert_base.v2', 'bert_base.v2', 'BERTBASEV2'], ['___', '___', ''],
    ['a'.repeat(40), 'a'.repeat(32), 'AAAAAAAAAA'], ['Qwen2.5-Coder-32B-Instruct-GPTQ-Int4-extra', 'Qwen2.5-Coder-32B-Instruct-GPTQ-', 'QWEN25CODE']]) {
    assert.deepEqual(modelTokenDefaults(name), { tokenName, tokenSymbol }, name)
    // The browser form uses exactly these helpers for a model's name.
    assert.deepEqual([defaultTokenName(name), defaultTokenSymbol(name)], [tokenName, tokenSymbol])
    assert.ok(tokenName.length <= 32 && /^[A-Z0-9]{0,10}$/.test(tokenSymbol))
  }
})

test('a model description states what the Hub reports, derivatives included', () => {
  assert.equal(modelDescription({ pipelineTag: 'text-generation', license: 'mit' }), 'Text generation · License: mit')
  assert.equal(modelDescription({ pipelineTag: 'text-generation', license: 'llama2', baseModels: { relation: 'quantized',
    models: [{ hfId: '64b0234d53bd91402e6ad49c', path: 'meta-llama/Llama-2-7b-hf' }] } }),
  'Text generation · License: llama2 · Quantized from meta-llama/Llama-2-7b-hf')
  assert.equal(modelDescription({ baseModels: { relation: 'merge', models: [{ path: 'a/b' }, { path: 'c/d' }, { path: 'e/f' }] } }), 'Merged from a/b and 2 more')
  assert.equal(modelDescription({}), null)
})

test('resolving a public model registers it by _id and returns its repository row (org owner, avatar, description)', () => withHf(async ({ hf, server }) => {
  const { pool, rows } = fakeRegistry()
  const repo = await resolveModel({ pool, hf, input: 'https://huggingface.co/openai-community/gpt2/tree/main' })
  assert.deepEqual(repo, { githubRepoId: HF_MARKET_REF_MIN, source: 'huggingface', hfId: GPT2._id, owner: 'openai-community', name: 'gpt2',
    fullName: 'openai-community/gpt2', description: 'Text generation · License: mit', avatarUrl: ORG.avatarUrl, ownerKind: 'org', gated: false,
    baseModels: [], createdAt: repo.createdAt, updatedAt: GPT2.lastModified, redirectedFrom: null })
  assert.deepEqual(rows.get(GPT2._id), { marketRef: HF, path: 'openai-community/gpt2', ownerHandle: 'openai-community', ownerKind: 'org',
    ownerSubject: ORG._id, isPrivate: false, disabled: false, gated: false, baseModels: [] })
  // Users and organizations share a namespace: the user lookup misses, the organization answers.
  assert.deepEqual(server.requests.map(request => request.path), ['/api/models/openai-community/gpt2', '/api/users/openai-community/overview',
    '/api/organizations/openai-community/overview'])
}))

test('gated models and quantized re-uploads are allowed; the base model is kept for the derivative badge', () => withHf(async ({ hf }) => {
  const { pool, rows } = fakeRegistry()
  const gated = await resolveModel({ pool, hf, input: 'hf.co/meta-llama/Llama-3.1-8B' })
  assert.equal(gated.gated, 'manual')
  assert.equal(rows.get(LLAMA._id).gated, true)
  assert.equal(gated.ownerKind, 'org')
  const quantized = await resolveModel({ pool, hf, input: 'TheBloke/Llama-2-7B-GGUF' })
  assert.equal(quantized.ownerKind, 'user')
  assert.deepEqual(quantized.baseModels, [{ hfId: '64b0234d53bd91402e6ad49c', path: 'meta-llama/Llama-2-7b-hf', relation: 'quantized' }])
  assert.deepEqual(rows.get(GGUF._id).baseModels, quantized.baseModels)
  assert.equal(quantized.description, 'Text generation · License: llama2 · Quantized from meta-llama/Llama-2-7b-hf')
  assert.notEqual(gated.githubRepoId, quantized.githubRepoId)
}))

test('one market per _id: a renamed or differently cased path finds the same market id', () => withHf(async ({ hf }) => {
  const { pool, rows } = fakeRegistry()
  const first = await resolveModel({ pool, hf, input: 'openai-community/gpt2' })
  const moved = await resolveModel({ pool, hf, input: 'https://huggingface.co/OpenAI-Community/GPT2' })
  assert.equal(moved.githubRepoId, first.githubRepoId)
  assert.equal(moved.redirectedFrom, 'OpenAI-Community/GPT2')
  assert.equal(rows.size, 1)
}))

test('every refusal: missing, private, disabled, other Hub sections, a moved path, an unknown owner and outages', () => withHf(async ({ hf, server }) => {
  const { pool, queries } = fakeRegistry()
  const refused = async (input, code, status, options = {}) => {
    const before = server.requests.length
    await assert.rejects(resolveModel({ pool, hf, input, ...options }), error => {
      assert.ok(error instanceof HfLaunchError, error.message)
      assert.equal(error.code, code, `${input}: ${error.message}`)
      assert.equal(error.status, status)
      return true
    })
    return server.requests.slice(before)
  }
  await refused('openai-community/no-such-model-repoing-x9', 'HF_NOT_FOUND', 404)
  server.route('/api/models/someone/secret', ok({ ...GPT2, _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', id: 'someone/secret', author: 'someone', private: true }))
  await refused('someone/secret', 'HF_PRIVATE', 400)
  await refused('https://huggingface.co/ykilcher/gpt-4chan', 'HF_DISABLED', 400)
  for (const input of ['https://huggingface.co/datasets/openai/gsm8k', 'https://huggingface.co/spaces/a/b', 'https://hf.co/openai-community', 'http://huggingface.co/a/b']) {
    assert.deepEqual(await refused(input, 'HF_INVALID_URL', 400), [], `${input} reaches nothing`)
  }
  // runwayml/stable-diffusion-v1-5 now redirects to a repository created in 2024: a different _id than the one under review.
  await refused('runwayml/stable-diffusion-v1-5', 'HF_MODEL_MOVED', 409, { expected: { hfId: '6305a8ec1e2b8c6a5b8a7e2d' } })
  server.route('/api/models/ghost/model', ok({ ...GPT2, _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', id: 'ghost/model', author: 'ghost' }))
  server.route('/api/users/ghost/overview', notFound)
  server.route('/api/organizations/ghost/overview', notFound)
  await refused('ghost/model', 'HF_OWNER_UNAVAILABLE', 503)
  server.route('/api/models/down/model', { status: 503, headers: {}, body: null })
  await refused('down/model', 'HF_UNAVAILABLE', 503)
  // Last: a 429 holds this client's later requests until the window resets.
  server.route('/api/models/busy/model', { status: 429, headers: { ratelimit: '"api";r=0;t=290', 'ratelimit-policy': '"fixed window";"api";q=500;w=300' }, body: null })
  await refused('busy/model', 'HF_RATE_LIMITED', 503)
  assert.deepEqual(queries, [], 'nothing refused is registered')
}))

test('a source or guard with the flag off refuses before Hugging Face or the database', async () => {
  const touched = []
  const pool = { query: async sql => { touched.push(sql); throw Error('database reached') } }
  const hf = { model: async () => { touched.push('model'); throw Error('network reached') }, owner: async () => { touched.push('owner') } }
  const off = () => false
  await assert.rejects(hfLaunchSource({ pool, hf, enabled: off }).resolve('openai-community/gpt2'), { code: 'HF_MARKETS_UNAVAILABLE', message: HF_MARKETS_UNAVAILABLE })
  await assert.rejects(hfLaunchGuard({ pool, hf, enabled: off })({ market: { githubRepoId: HF_MARKET_REF_MIN } }), { code: 'HF_MARKETS_UNAVAILABLE' })
  assert.deepEqual(touched, [])
  // The default reads HF_MARKETS_ENABLED, which tests leave unset.
  await withEnv({ HF_MARKETS_ENABLED: undefined }, () => assert.rejects(hfLaunchSource({ pool, hf }).resolve('a/b'), { code: 'HF_MARKETS_UNAVAILABLE' }))
  assert.deepEqual(touched, [])
})

test('the guard rechecks _id, private, disabled and opt-out against the registry, and refuses repository ids', () => withHf(async ({ hf, server }) => {
  let registered = { hfId: GPT2._id, repoPath: 'openai-community/gpt2' }, decision = null
  const pool = { async query(sql, params) {
    if (/from hf_models/.test(sql)) { assert.deepEqual(params, [HF]); return { rows: registered ? [registered] : [] } }
    if (/from maintainer_opt_outs/.test(sql)) { assert.deepEqual(params, [HF]); return { rows: decision ? [decision] : [] } }
    throw Error(`unexpected query: ${sql}`)
  } }
  const guard = hfLaunchGuard({ pool, hf, enabled: () => true }), market = { githubRepoId: HF_MARKET_REF_MIN }
  await guard({ market, stage: 'prepare' })
  await guard({ market: { githubRepoId: HF }, stage: 'submit' })
  await assert.rejects(guard({ market: { githubRepoId: 1296269n }, stage: 'prepare' }), MarketIdentityError)
  decision = { repoId: HF, kind: 'opt_out', note: null, createdAt: new Date() }
  await assert.rejects(guard({ market, stage: 'submit' }), { code: 'MAINTAINER_OPTED_OUT', message: HF_OPT_OUT_ERROR, status: 403 })
  decision = null
  registered = { hfId: '6305a8ec1e2b8c6a5b8a7e2d', repoPath: 'runwayml/stable-diffusion-v1-5' }
  await assert.rejects(guard({ market, stage: 'submit' }), { code: 'HF_MODEL_MOVED', message: HF_MODEL_MOVED })
  registered = { hfId: '6283a9b7806a1feb9fbacf18', repoPath: 'ykilcher/gpt-4chan' }
  await assert.rejects(guard({ market, stage: 'submit' }), { code: 'HF_DISABLED' })
  server.route('/api/models/someone/went-private', { status: 401, headers: {}, body: { error: 'Invalid username or password.' } })
  registered = { hfId: 'cccccccccccccccccccccccc', repoPath: 'someone/went-private' }
  await assert.rejects(guard({ market, stage: 'submit' }), { code: 'HF_NOT_FOUND' })
  registered = null
  await assert.rejects(guard({ market, stage: 'prepare' }), { code: 'HF_NOT_REGISTERED' })
}))

test('lookup errors keep Hugging Face wording and turn anything else into a retryable message', () => {
  assert.equal(modelLookupError(Error('password=secret host=db')).message, 'Model lookup is temporarily unavailable. Try again shortly.')
  assert.equal(modelLookupError(Error('x')).status, 503)
  const own = new HfLaunchError('mine', { status: 418, code: 'MINE' })
  assert.equal(modelLookupError(own), own)
})

test('with the flag off, /api/resolve answers "not available yet" for Hugging Face URLs without touching anything', () =>
  withEnv({ HF_MARKETS_ENABLED: undefined, DATABASE_URL: 'postgres://test-only' }, () => withRouteGlobals({}, async touched => {
    for (const url of ['https://huggingface.co/openai-community/gpt2', 'huggingface.co/openai-community/gpt2', 'hf.co/a/b', 'https://huggingface.co/datasets/a/b']) {
      const response = await resolveRoute(new Request('https://repo.ing/api/resolve', { method: 'POST', body: JSON.stringify({ url }) }))
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: HF_MARKETS_UNAVAILABLE, code: 'HF_MARKETS_UNAVAILABLE' })
    }
    assert.deepEqual(touched, [])
    // A GitHub URL still takes the GitHub path (the database first, as before).
    await resolveRoute(new Request('https://repo.ing/api/resolve', { method: 'POST', body: JSON.stringify({ url: 'github.com/octocat/Hello-World' }) }))
    assert.match(touched[0], /^query select r\.github_repo_id/)
  })))

test('with the flag off, a model prepare is refused before the database, Hugging Face or the chain', () =>
  withEnv({ HF_MARKETS_ENABLED: undefined, DATABASE_URL: 'postgres://test-only' }, () => withRouteGlobals({}, async touched => {
    const response = await launchRoute(new Request('https://repo.ing/api/launch', { method: 'POST', body: JSON.stringify({ action: 'prepare',
      repoId: HF, hfId: GPT2._id, tokenName: 'gpt2', tokenSymbol: 'GPT2', tokenImage: 'data:image/png;base64,AAAA', launcherWallet: '11111111111111111111111111111111' }) }))
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.equal(body.error, HF_MARKETS_UNAVAILABLE)
    assert.equal(body.canRetry, true)
    assert.deepEqual(touched, [])
  })))

test('a model prepare is refused on a launch config that reserves the builder allocation, before anything is read', () => {
  const config = 'So11111111111111111111111111111111111111112'
  return withEnv({ HF_MARKETS_ENABLED: 'true', DATABASE_URL: 'postgres://test-only', DBC_CONFIG: config, BUILDER_ALLOCATION_CONFIGS: config },
    () => withRouteGlobals({}, async touched => {
      const response = await launchRoute(new Request('https://repo.ing/api/launch', { method: 'POST', body: JSON.stringify({ action: 'prepare',
        repoId: HF, hfId: GPT2._id, tokenName: 'gpt2', tokenSymbol: 'GPT2', tokenImage: 'data:image/png;base64,AAAA', launcherWallet: '11111111111111111111111111111111' }) }))
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error, HF_CONFIG_RESERVE_ERROR)
      assert.deepEqual(touched, [])
    }))
})

test('avatar suggestions run at most eight fetches at once', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3355ff' } }).png().toBuffer()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const fetchImpl = async () => { await gate; return new Response(png, { status: 200 }) }
  const row = i => ({ avatar_url: `https://cdn-avatars.huggingface.co/v1/production/uploads/inflight/${i}.png` })
  const running = Array.from({ length: 8 }, (_, i) => modelImageSuggestions(row(i), { fetchImpl }))
  await assert.rejects(modelImageSuggestions(row(8), { fetchImpl }), /busy/)
  release()
  for (const images of await Promise.all(running)) assert.equal(images[0].label, 'Owner avatar')
  assert.equal((await modelImageSuggestions(row(8), { fetchImpl })).length, 1, 'room again once they finish')
})

test('the launch picker suggests the owner avatar for a model market and uploads still work; the flag gates both', async () => {
  const png = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#ff9d00' } }).png().toBuffer()
  const avatar = ORG.avatarUrl, row = { owner: 'openai-community', name: 'gpt2', avatar_url: avatar, archived: false, source: 'huggingface' }
  const pool = { query: async (sql, params) => {
    assert.match(sql, /source='huggingface'/)
    assert.deepEqual(params, [HF])
    return { rows: [row] }
  } }
  const fetched = []
  const fetchImpl = async (url, init) => {
    fetched.push(String(url))
    assert.equal(init.redirect, 'manual')
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  const params = { params: Promise.resolve({ repo: HF }) }
  await withEnv({ HF_MARKETS_ENABLED: undefined, DATABASE_URL: 'postgres://test-only', APP_ORIGIN: 'https://repo.ing' }, () => withRouteGlobals({ pool, fetchImpl }, async () => {
    assert.equal((await repoImages(new Request(`https://repo.ing/api/repo-images/${HF}`), params)).status, 503)
    const upload = await uploadImage(new Request(`https://repo.ing/api/repo-images/${HF}`, { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'image/png' }, body: png }), params)
    assert.equal(upload.status, 400)
    assert.deepEqual(fetched, [])
  }))
  await withEnv({ HF_MARKETS_ENABLED: 'true', DATABASE_URL: 'postgres://test-only', APP_ORIGIN: 'https://repo.ing' }, () => withRouteGlobals({ pool, fetchImpl }, async () => {
    const response = await repoImages(new Request(`https://repo.ing/api/repo-images/${HF}`), params)
    const { images } = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(images.map(({ label, source }) => ({ label, source })), [{ label: 'Owner avatar', source: avatar }])
    assert.match(images[0].image, /^data:image\/png;base64,/)
    assert.deepEqual(fetched, [avatar])
    const upload = await uploadImage(new Request(`https://repo.ing/api/repo-images/${HF}`, { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'image/png' }, body: png }), params)
    assert.equal(upload.status, 200)
    assert.equal((await upload.json()).label, 'Your upload')
  }))
})

test('avatars are fetched only from the Hub avatar hosts, once, without following redirects', async () => {
  for (const url of ['https://cdn-avatars.huggingface.co/v1/production/uploads/5dd96eb166059660ed1ee413/9NY4jfufqo1uyv8oNXQju.png',
    'https://huggingface.co/avatars/0f2fb4d7bd1d7b2bb2e2d7d8a5f6d3a0.svg', `https://www.gravatar.com/avatar/${'a'.repeat(32)}?d=retro`]) assert.equal(safeHfAvatarUrl(url), url)
  for (const url of ['http://cdn-avatars.huggingface.co/v1/production/uploads/a.png', 'https://cdn-avatars.huggingface.co/v1/production/uploads/../../x.png',
    'https://cdn-avatars.huggingface.co/v1/production/uploads/a.png?x=1', 'https://evil.test/avatars/a.png', `https://www.gravatar.com/avatar/${'a'.repeat(32)}?d=https://evil.test`,
    'https://huggingface.co/api/avatars/openai', null, 42]) assert.equal(safeHfAvatarUrl(url), null, String(url))
  const calls = []
  await assert.rejects(fetchHfAvatar('https://evil.test/a.png', async url => { calls.push(url) }), /Unsupported image source/)
  await assert.rejects(fetchHfAvatar(ORG.avatarUrl, async url => { calls.push(url); return new Response(null, { status: 302, headers: { location: 'https://evil.test/a.png' } }) }), /could not be loaded/)
  assert.deepEqual(calls, [ORG.avatarUrl])
})

test('the model launch post carries the disclaimer and fits owner names a repository post would refuse', () => {
  const mint = 'So11111111111111111111111111111111111111112', path = `${'o'.repeat(60)}/model`
  assert.equal(launchPostUrl({ mint, symbol: 'MODEL', fullName: path }), null)
  const url = new URL(modelLaunchPostUrl({ mint, symbol: 'MODEL', path }))
  assert.equal(url.searchParams.get('text'), modelLaunchPostText({ symbol: 'MODEL', path }))
  assert.ok(url.searchParams.get('text').endsWith(HF_DISCLAIMER_SHORT))
  assert.equal(url.searchParams.get('url'), `https://repo.ing/token/${mint}`)
  assert.equal(modelLaunchPostUrl({ mint, symbol: 'X', path: 'datasets/x/y' }), null)
})

test('every model launch surface shows the disclaimer, and model ids never reach the GitHub launch page', () => {
  const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  for (const file of ['app/components/hf/model-launch.jsx', 'app/components/launch-form.jsx', 'app/components/launch-success.jsx', 'app/lib/model-share.mjs']) {
    assert.match(source(file), /HF_DISCLAIMER/, file)
  }
  assert.match(source('app/components/launch-form.jsx'), /\{model && <p className="launch-review-disclaimer" role="note"><strong>\{HF_DISCLAIMER\}<\/strong><\/p>\}/)
  const page = source('app/(site)/launch/[repo]/page.jsx')
  assert.ok(page.indexOf('if (isHfMarketId(repoId)) return <ModelLaunch') < page.indexOf('marketByRepo(repoId)'), 'the model branch returns before any repository read')
  assert.doesNotMatch(source('app/components/hf/model-launch.jsx'), /repositoryById|GitHubLink|RepoAvatar|huggingface\.(svg|png)/)
  assert.equal(HF_DISCLAIMER, "Community launch — not endorsed by the model's creators. Not affiliated with Hugging Face.")
})
