import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HF_SPACES_CAP, HfApiError, HfDisabledError, HfGatedError, HfNotFoundError, HfPrivateError, HfRateLimitedError, HfUpstreamError, HfUrlError,
  cleanText, createHfClient, parseHfModelUrl, parseRateLimit,
} from '../src/hf-api.mjs'
import { HfUrlError as UrlModuleError, parseHfModelUrl as parseFromUrlModule } from '../src/hf-url.mjs'
import { recorded, startFakeHf } from './fixtures/hf-server.mjs'

const START = Date.parse('2026-10-02T17:00:00Z')
const GPT2 = '/api/models/openai-community/gpt2'
const EXPAND = ['author', 'private', 'disabled', 'gated', 'createdAt', 'lastModified', 'sha', 'pipeline_tag', 'tags', 'likes', 'downloads',
  'downloadsAllTime', 'trendingScore', 'baseModels', 'childrenModelCount', 'spaces']
const LIMIT_HEADERS = { 'ratelimit-policy': '"fixed window";"api";q=500;w=300' }

// A fresh fake Hub per test, with a fake clock: sleeps are recorded and advance the clock instead of waiting.
async function withHf(work, { routes = {}, ...options } = {}) {
  const server = await startFakeHf()
  for (const [path, reply] of Object.entries(routes)) server.route(path, reply)
  let clock = START
  const sleeps = []
  const hf = createHfClient({ fetchImpl: server.fetchImpl, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms }, ...options })
  try { return await work({ hf, server, sleeps, now: () => clock }) } finally { await server.close() }
}

const recordedBody = name => structuredClone(recorded[name].body)
const json = (body, headers = {}, status = 200) => ({ status, headers: { ...LIMIT_HEADERS, ...headers }, body })
const gpt2With = changes => json({ ...recordedBody('model-gpt2'), ...changes })
const redirect = location => ({ status: 307, headers: { location } })
// Replies in order, repeating the last one.
const sequence = (...replies) => { let index = 0; return () => replies[Math.min(index++, replies.length - 1)] }
const rejects = (promise, type, code) => assert.rejects(promise, error => error instanceof type && error instanceof HfApiError && (!code || error.code === code))

const GPT2_MODEL = {
  hfId: '621ffdc036468d709f17434d', path: 'openai-community/gpt2', owner: { handle: 'openai-community' }, private: false, disabled: false,
  gated: false, createdAt: '2022-03-02T23:29:04.000Z', lastModified: '2024-02-19T10:57:45.000Z', sha: '607a30d783dfa663caf39e06633721c8d4cfcd7e',
  pipelineTag: 'text-generation', license: 'mit', likes: 4194, downloads30d: 15740994, downloadsAllTime: 932329010, trendingScore: 16,
  baseModels: null, childrenCount: 1735 + 11 + 99 + 2278, spacesCount: HF_SPACES_CAP, redirectedFrom: null,
}

test('model() turns the recorded gpt2 response into a typed model from one anonymous, explicitly expanded request', () => withHf(async ({ hf, server }) => {
  assert.deepEqual(await hf.model({ path: 'openai-community/gpt2' }), GPT2_MODEL)
  assert.equal(server.requests.length, 1)
  const [request] = server.requests
  assert.equal(request.path, GPT2)
  assert.deepEqual(new URLSearchParams(request.query).getAll('expand[]'), EXPAND)
  assert.equal(request.headers.accept, 'application/json')
  assert.equal(request.headers['user-agent'], 'repo.ing')
  assert.equal(request.headers.authorization, undefined)
  assert.deepEqual(await hf.model({ path: 'https://huggingface.co/openai-community/gpt2/tree/main' }), GPT2_MODEL)
}))

test('derivatives carry their base model ids, gated models resolve, disabled models throw', () => withHf(async ({ hf }) => {
  const gguf = await hf.model({ path: 'TheBloke/Llama-2-7B-GGUF' })
  assert.deepEqual([gguf.hfId, gguf.owner, gguf.license, gguf.childrenCount, gguf.spacesCount, gguf.baseModels],
    ['64f5fd954d3b1dd311d30e28', { handle: 'TheBloke' }, 'llama2', 0, 93,
      { relation: 'quantized', models: [{ hfId: '64b0234d53bd91402e6ad49c', path: 'meta-llama/Llama-2-7b-hf' }] }])
  const llama = await hf.model({ path: 'meta-llama/Llama-3.1-8B' })
  assert.deepEqual([llama.hfId, llama.gated, llama.license, llama.private, llama.disabled], ['66944f1fe0c5c2e493a804f5', 'manual', 'llama3.1', false, false])
  await assert.rejects(hf.model({ path: 'ykilcher/gpt-4chan' }), error => error instanceof HfDisabledError &&
    error.hfId === '6283a9b7806a1feb9fbacf18' && error.path === 'ykilcher/gpt-4chan' && error.code === 'HF_DISABLED')
}))

test('private models throw; missing ones are "not found" anonymously; a rejected token is not mistaken for a missing model', async () => {
  await withHf(async ({ hf }) => {
    await assert.rejects(hf.model({ path: 'openai-community/gpt2' }), error => error instanceof HfPrivateError && error.hfId === GPT2_MODEL.hfId)
  }, { routes: { [GPT2]: gpt2With({ private: true }) } })
  await withHf(async ({ hf, server }) => {
    await rejects(hf.model({ path: 'openai-community/no-such-model-repoing-x9' }), HfNotFoundError, 'HF_NOT_FOUND')
    await rejects(hf.model({ path: 'openai-community/gpt2' }), HfNotFoundError, 'HF_NOT_FOUND')
    assert.equal(server.requests.length, 2)
  }, { routes: { [GPT2]: json({ error: 'Repository not found' }, { 'x-error-code': 'RepoNotFound' }, 404) } })
  const token = 'hf_unit_test_token_value'
  await withHf(async ({ hf, server }) => {
    const error = await hf.model({ path: 'openai-community/gpt2' }).catch(error => error)
    assert.ok(error instanceof HfUpstreamError && error.code === 'HF_UNAUTHORIZED')
    assert.equal(server.requests[0].headers.authorization, `Bearer ${token}`)
    assert.ok(!`${error.message} ${JSON.stringify(error)} ${error.stack}`.includes(token))
  }, { token, routes: { [GPT2]: json({ error: 'Invalid credentials in Authorization header' }, { 'x-error-message': 'Invalid credentials in Authorization header' }, 401) } })
  // With a token, only an explicit RepoNotFound (or a 404) means "not found"; any other 401 is the token being refused.
  for (const [reply, type, code] of [[recorded['model-not-found'], HfUpstreamError, 'HF_UNAUTHORIZED'],
    [json({ error: 'Unauthorized' }, {}, 401), HfUpstreamError, 'HF_UNAUTHORIZED'],
    [json({ error: 'Repository not found' }, { 'x-error-code': 'RepoNotFound' }, 401), HfNotFoundError, 'HF_NOT_FOUND'],
    [json({ error: 'Repository not found' }, { 'x-error-code': 'RepoNotFound' }, 404), HfNotFoundError, 'HF_NOT_FOUND']]) {
    await withHf(({ hf }) => rejects(hf.model({ path: 'openai-community/gpt2' }), type, code), { token, routes: { [GPT2]: reply } })
  }
  await withHf(async ({ hf }) => {
    await rejects(hf.model({ path: 'openai-community/gpt2' }), HfDisabledError, 'HF_DISABLED')
  }, { routes: { [GPT2]: json({ error: 'disabled' }, { 'x-error-message': 'Access to this resource is disabled.' }, 403) } })
  assert.throws(() => createHfClient({ token: 'hf_x\r\nInjected: header' }), TypeError)
  assert.throws(() => createHfClient({ token: '' }), TypeError)
  assert.throws(() => createHfClient({ reserve: 1 }), TypeError)
})

test('a redirect can land on a different repository: it is followed by hand, recorded, and the new _id is reported', () => withHf(async ({ hf, server }) => {
  const moved = await hf.model({ path: 'runwayml/stable-diffusion-v1-5' })
  assert.deepEqual([moved.hfId, moved.path, moved.redirectedFrom, moved.createdAt],
    ['66d19580e2632490a6bc5829', 'stable-diffusion-v1-5/stable-diffusion-v1-5', 'runwayml/stable-diffusion-v1-5', '2024-08-30T09:48:48.000Z'])
  assert.deepEqual(server.requests.map(request => request.path),
    ['/api/models/runwayml/stable-diffusion-v1-5', '/api/models/stable-diffusion-v1-5/stable-diffusion-v1-5'])
  assert.deepEqual(new URLSearchParams(server.requests[1].query).getAll('expand[]'), EXPAND)
  // The _id embeds its creation time: this is a 2024 repository, not the 2022 runwayml one the old path used to serve.
  assert.equal(new Date(parseInt(moved.hfId.slice(0, 8), 16) * 1000).toISOString(), moved.createdAt)
  const renamed = await hf.model({ path: 'meta-llama/Meta-Llama-3.1-8B' })
  assert.deepEqual([renamed.hfId, renamed.path, renamed.redirectedFrom], ['66944f1fe0c5c2e493a804f5', 'meta-llama/Llama-3.1-8B', 'meta-llama/Meta-Llama-3.1-8B'])
  const recased = await hf.model({ path: 'OpenAI-Community/GPT2' })
  assert.deepEqual(recased, { ...GPT2_MODEL, redirectedFrom: 'OpenAI-Community/GPT2' })
}))

test('redirects off the host, to another endpoint, beyond two hops or in a loop are refused; the Location query is never used', () => withHf(async ({ hf, server }) => {
  for (const location of ['https://evil.example/api/models/o/target', '//evil.example/api/models/o/target', 'http://huggingface.co/api/models/o/target',
    'https://huggingface.co:8443/api/models/o/target', 'https://user@huggingface.co/api/models/o/target', '/api/users/o/overview',
    '/api/models/o/target/commits/main', '/api/models/o/../../users/o/overview', '/api/models/o/tar%2Fget', '/api/models/o/target..x', '/api/datasets/o/target', '']) {
    server.route('/api/models/o/start', redirect(location))
    await rejects(hf.model({ path: 'o/start' }), HfUpstreamError, 'HF_REDIRECT_REFUSED')
  }
  server.route('/api/models/o/one', redirect('/api/models/o/two'))
  server.route('/api/models/o/two', redirect('https://huggingface.co/api/models/o/three'))
  server.route('/api/models/o/three', redirect('/api/models/o/four'))
  await rejects(hf.model({ path: 'o/one' }), HfUpstreamError, 'HF_TOO_MANY_REDIRECTS')
  server.route('/api/models/o/loop-a', redirect('/api/models/o/loop-b'))
  server.route('/api/models/o/loop-b', redirect('/api/models/o/loop-a'))
  await rejects(hf.model({ path: 'o/loop-a' }), HfUpstreamError, 'HF_REDIRECT_REFUSED')
  server.route('/api/models/o/query', redirect('/api/models/openai-community/gpt2?expand[]=siblings'))
  server.requests.length = 0
  assert.equal((await hf.model({ path: 'o/query' })).redirectedFrom, 'o/query')
  assert.deepEqual(new URLSearchParams(server.requests[1].query).getAll('expand[]'), EXPAND)
  server.route('/api/models/openai-community/gpt2/commits/main', redirect('/api/models/someone-else/gpt2/commits/main'))
  await rejects(hf.commitsCount('openai-community/gpt2'), HfUpstreamError, 'HF_MOVED')
}))

test('a response for a different model than the one requested is refused', async () => {
  for (const changes of [{ id: 'openai-community/gpt-3' }, { author: 'someone-else' }]) {
    await withHf(({ hf }) => rejects(hf.model({ path: 'openai-community/gpt2' }), HfUpstreamError, 'HF_IDENTITY_MISMATCH'), { routes: { [GPT2]: gpt2With(changes) } })
  }
})

test('malformed model responses are rejected by the schema instead of guessed at', async () => {
  const body = recordedBody('model-gpt2')
  const { _id, ...noId } = body, { private: _private, ...noPrivate } = body, { disabled, ...noDisabled } = body
  const malformed = [noId, noPrivate, noDisabled, { ...body, _id: 'not-an-object-id' }, { ...body, _id: body._id.toUpperCase() },
    { ...body, gated: 'sometimes' }, { ...body, gated: true }, { ...body, private: 'false' }, { ...body, likes: -1 }, { ...body, downloads: 1.5 },
    { ...body, downloadsAllTime: '932329010' }, { ...body, downloads: 2 ** 60 }, { ...body, createdAt: 'yesterday' }, { ...body, sha: 'xyz' },
    { ...body, id: 'openai-community/gpt2/extra' }, { ...body, author: 'bad--handle' }, { ...body, tags: 'license:mit' },
    { ...body, baseModels: { relation: 'quantized', models: [{ id: 'meta-llama/Llama-2-7b-hf' }] } },
    { ...body, baseModels: { relation: 'Quantized!', models: [] } }, { ...body, childrenModelCount: { finetune: -1 } },
    { ...body, childrenModelCount: 4123 }, { ...body, spaces: 'many' }, [body], 'gpt2', 0]
  for (const reply of malformed) {
    await withHf(({ hf }) => rejects(hf.model({ path: 'openai-community/gpt2' }), HfUpstreamError, 'HF_INVALID_RESPONSE'), { routes: { [GPT2]: json(reply) } })
  }
  const raw = (text, headers = { 'content-type': 'application/json' }) => ({ status: 200, headers, raw: text })
  for (const [reply, code] of [[raw('null'), 'HF_INVALID_RESPONSE'], [raw('{"_id": '), 'HF_INVALID_RESPONSE'], [raw(''), 'HF_INVALID_RESPONSE'],
    [raw('<html>maintenance</html>', { 'content-type': 'text/html' }), 'HF_INVALID_RESPONSE'], [raw('{}', {}), 'HF_INVALID_RESPONSE'],
    [raw(`"${'x'.repeat(1_100_000)}"`), 'HF_TOO_LARGE'], [raw('{}', { 'content-type': 'application/json', 'content-length': '2000000' }), 'HF_TOO_LARGE'],
    [{ status: 418, headers: {}, body: null }, 'HF_HTTP_418'], [{ status: 410, headers: {}, body: null }, 'HF_HTTP_410']]) {
    await withHf(({ hf }) => rejects(hf.model({ path: 'openai-community/gpt2' }), HfUpstreamError, code), { routes: { [GPT2]: reply } })
  }
})

test('unknown fields are dropped and Hub text is sanitized and length-capped', async () => {
  await withHf(async ({ hf }) => {
    const model = await hf.model({ path: 'openai-community/gpt2' })
    assert.deepEqual(model, { ...GPT2_MODEL, pipelineTag: 'text generation', license: 'mit, apache-2.0' })
  }, { routes: { [GPT2]: gpt2With({ siblings: [{ rfilename: 'config.json' }], cardData: { license: 'other' }, evil: '<script>', modelId: 'x/y',
    pipeline_tag: 'text\u0000generation\u202e', tags: ['license:mit\u200b', 'license:apache-2.0', 'license:mit', 'region:us'] }) } })
  assert.equal(cleanText('  Tom\u0000\nJobbins\u202e\u200b\u2066 ', 100), 'Tom Jobbins')
  assert.equal(cleanText(`${'😀'.repeat(150)}`, 100), '😀'.repeat(100))
  // Joiners stay (Persian words, emoji sequences); tag characters and blank Hangul fillers go.
  const persian = String.fromCodePoint(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645)
  const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
  assert.equal(cleanText(persian, 20), persian)
  assert.equal(cleanText(family, 10), family)
  assert.equal(cleanText(`a${String.fromCodePoint(0xe0041, 0xe0042, 0xe007f)}b`, 10), 'ab')
  assert.equal(cleanText(String.fromCodePoint(0x3164, 0x115f, 0x1160, 0xffa0, 0x34f), 10), null)
  assert.equal(cleanText('a\ud800b', 10), 'ab')
  assert.equal(cleanText('\u0000\u200b ', 10), null)
  const user = { ...recordedBody('user-thebloke'), fullname: `\u202eTom\u0000 ${'J'.repeat(300)}`, avatarUrl: 'https://evil.example/a.png' }
  await withHf(async ({ hf }) => {
    const found = await hf.userOverview('TheBloke')
    assert.equal(found.fullname, `Tom ${'J'.repeat(96)}`)
    assert.equal(found.avatarUrl, null)
  }, { routes: { '/api/users/TheBloke/overview': json(user) } })
  const cdn = 'https://cdn-avatars.huggingface.co/v1/production/uploads/6426d3f3a7723d62b53c259b/tvPikpAzKTKGN5wrpadOJ.jpeg'
  const gravatar = 'https://www.gravatar.com/avatar/0d37081b4a297db9a79d2ffa2985d819'
  for (const [avatar, expected] of [['/avatars/0238dfe072bf70b8478b9201744585da.svg', 'https://huggingface.co/avatars/0238dfe072bf70b8478b9201744585da.svg'],
    [`${cdn}?w=64#x`, cdn], [`${gravatar}?d=retro&size=100`, `${gravatar}?d=retro`], [`${gravatar}?d=https%3A%2F%2Fevil.example%2Fa.png`, `${gravatar}?d=retro`],
    ['https://huggingface.co/api/avatars/openai-community', null], ['https://cdn-avatars.huggingface.co/../avatars/x.png', null],
    ['https://www.gravatar.com/avatar/not-a-hash', null], ['javascript:alert(1)', null], ['http://cdn-avatars.huggingface.co/a.png', null], [42, null]]) {
    await withHf(async ({ hf }) => assert.equal((await hf.userOverview('TheBloke')).avatarUrl, expected),
      { routes: { '/api/users/TheBloke/overview': json({ ...recordedBody('user-thebloke'), avatarUrl: avatar }) } })
  }
})

test('429s honor RateLimit and Retry-After, back off exponentially without them, and give up with retryAt', async () => {
  const limited = headers => json({ error: 'Too many requests' }, headers, 429)
  const ok = recorded['model-gpt2']
  for (const [headers, waits] of [[{ ratelimit: '"api";r=0;t=7' }, [7000]], [{ ratelimit: '"api";r=0;t=3', 'retry-after': '9' }, [9000]],
    [{ 'retry-after': new Date(START + 4000).toUTCString() }, [4000]], [{}, [1000]]]) {
    await withHf(async ({ hf, server, sleeps }) => {
      assert.deepEqual(await hf.model({ path: 'openai-community/gpt2' }), GPT2_MODEL)
      assert.deepEqual(sleeps, waits)
      assert.equal(server.requests.length, 2)
    }, { routes: { [GPT2]: sequence(limited(headers), ok) } })
  }
  await withHf(async ({ hf, server, sleeps }) => {
    await assert.rejects(hf.model({ path: 'openai-community/gpt2' }), error => error instanceof HfRateLimitedError && error.retryAt === START + 3000 + 200_000)
    assert.deepEqual(sleeps, [1000, 2000])
    assert.equal(server.requests.length, 3)
  }, { routes: { [GPT2]: sequence(limited({}), limited({}), limited({ ratelimit: '"api";r=0;t=200' })) } })
  await withHf(async ({ hf, server, sleeps }) => {
    await assert.rejects(hf.model({ path: 'openai-community/gpt2' }), error => error instanceof HfRateLimitedError && error.retryAt === START + 200_000)
    assert.deepEqual(sleeps, [])
    assert.equal(server.requests.length, 1)
  }, { routes: { [GPT2]: limited({ ratelimit: '"api";r=0;t=200' }) } })
  // A 429 is remembered even without RateLimit headers: the next call waits for it, or throws, instead of asking again.
  await withHf(async ({ hf, server }) => {
    await assert.rejects(hf.model({ path: 'openai-community/gpt2' }), error => error instanceof HfRateLimitedError && error.retryAt === START + 30_000)
    assert.deepEqual(hf.rateLimit(), { bucket: null, quota: null, windowSeconds: null, remaining: 0, resetAt: START + 30_000 })
    await assert.rejects(hf.model({ path: 'openai-community/gpt2' }), error => error instanceof HfRateLimitedError && error.retryAt === START + 30_000)
    assert.equal(server.requests.length, 1)
  }, { routes: { [GPT2]: { status: 429, headers: { 'retry-after': '30' }, body: { error: 'Too many requests' } } } })
  await withHf(async ({ hf, server, sleeps }) => {
    await rejects(hf.model({ path: 'openai-community/gpt2' }), HfRateLimitedError, 'HF_RATE_LIMITED')
    assert.deepEqual(await hf.model({ path: 'openai-community/gpt2' }), GPT2_MODEL)
    assert.deepEqual([sleeps, server.requests.length], [[5000, 5000, 5000], 4])
  }, { routes: { [GPT2]: sequence(limited({ 'retry-after': '5' }), limited({ 'retry-after': '5' }), limited({ 'retry-after': '5' }), ok) } })
})

test('RateLimit headers pace later requests: the reserve is left unspent and the client waits for the window reset', async () => {
  const lowWindow = remaining => sequence(json(recordedBody('model-gpt2'), { ratelimit: `"api";r=${remaining};t=40` }), recorded['model-gpt2'])
  await withHf(async ({ hf, server, sleeps }) => {
    await hf.model({ path: 'openai-community/gpt2' })
    assert.deepEqual(hf.rateLimit(), { bucket: 'api', remaining: 50, resetAt: START + 40_000, quota: 500, windowSeconds: 300 })
    await assert.rejects(hf.model({ path: 'openai-community/gpt2' }), error => error instanceof HfRateLimitedError && error.retryAt === START + 40_000)
    assert.deepEqual([sleeps, server.requests.length], [[], 1])
  }, { routes: { [GPT2]: lowWindow(50) } })
  await withHf(async ({ hf, server, sleeps }) => {
    await hf.model({ path: 'openai-community/gpt2' })
    await hf.model({ path: 'openai-community/gpt2' })
    assert.deepEqual([sleeps, server.requests.length], [[40_000], 2])
  }, { routes: { [GPT2]: lowWindow(50) }, maxWaitMs: 60_000 })
  await withHf(async ({ hf, sleeps }) => {
    await hf.model({ path: 'openai-community/gpt2' })
    await hf.model({ path: 'openai-community/gpt2' })
    assert.deepEqual(sleeps, [])
  }, { routes: { [GPT2]: lowWindow(51) } })
  await withHf(async ({ hf }) => {
    await hf.model({ path: 'openai-community/gpt2' })
    await rejects(hf.model({ path: 'openai-community/gpt2' }), HfRateLimitedError, 'HF_RATE_LIMITED')
  }, { routes: { [GPT2]: lowWindow(300) }, reserve: 0.6 })
  // A reading from earlier in the same window (out-of-order responses) cannot raise the count; a new window replaces it.
  await withHf(async ({ hf }) => {
    await hf.model({ path: 'openai-community/gpt2' })
    await hf.model({ path: 'openai-community/gpt2' })
    assert.equal(hf.rateLimit().remaining, 99)
    await hf.model({ path: 'openai-community/gpt2' })
    assert.equal(hf.rateLimit().remaining, 492)
  }, { routes: { [GPT2]: sequence(json(recordedBody('model-gpt2'), { ratelimit: '"api";r=100;t=40' }),
    json(recordedBody('model-gpt2'), { ratelimit: '"api";r=200;t=40' }), recorded['model-gpt2']) } })
  assert.deepEqual(parseRateLimit(new Headers({ ratelimit: '"api";r=498;t=246', 'ratelimit-policy': '"fixed window";"api";q=500;w=300' })),
    { bucket: 'api', remaining: 498, resetSeconds: 246, quota: 500, windowSeconds: 300 })
  assert.deepEqual(parseRateLimit(new Headers({ ratelimit: '"pages";r=99;t=236' })), { bucket: 'pages', remaining: 99, resetSeconds: 236, quota: null, windowSeconds: null })
  for (const value of ['', 'api;r=1;t=2', '"api";r=-1;t=2', '"api";r=1']) assert.equal(parseRateLimit(new Headers({ ratelimit: value })), null)
})

test('server errors are retried with backoff; timeouts and exhausted retries are upstream errors', async () => {
  await withHf(async ({ hf, sleeps }) => {
    assert.deepEqual(await hf.model({ path: 'openai-community/gpt2' }), GPT2_MODEL)
    assert.deepEqual(sleeps, [1000])
  }, { routes: { [GPT2]: sequence(json({ error: 'bad gateway' }, {}, 503), recorded['model-gpt2']) } })
  await withHf(async ({ hf, server, sleeps }) => {
    await assert.rejects(hf.model({ path: 'openai-community/gpt2' }), error => error instanceof HfUpstreamError && error.status === 500 && error.code === 'HF_HTTP_500')
    assert.deepEqual([sleeps, server.requests.length], [[1000, 2000], 3])
  }, { routes: { [GPT2]: json({ error: 'internal' }, {}, 500) } })
  await withHf(({ hf }) => rejects(hf.model({ path: 'openai-community/gpt2' }), HfUpstreamError, 'HF_TIMEOUT'),
    { routes: { [GPT2]: { ...recorded['model-gpt2'], delayMs: 400 } }, timeoutMs: 50 })
  // The timeout also covers a body that stalls after the headers arrive.
  await withHf(({ hf }) => rejects(hf.model({ path: 'openai-community/gpt2' }), HfUpstreamError, 'HF_TIMEOUT'),
    { routes: { [GPT2]: { ...recorded['model-gpt2'], stallMs: 400 } }, timeoutMs: 100 })
  await rejects(createHfClient({ fetchImpl: async () => { throw new TypeError('fetch failed') } }).model({ path: 'openai-community/gpt2' }), HfUpstreamError, 'HF_NETWORK')
})

test('user and organization overviews give the stable _id; owner() tells users from organizations', () => withHf(async ({ hf, server }) => {
  const thebloke = { id: '6426d3f3a7723d62b53c259b', handle: 'TheBloke', kind: 'user', fullname: 'Tom Jobbins',
    avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/6426d3f3a7723d62b53c259b/tvPikpAzKTKGN5wrpadOJ.jpeg', redirectedFrom: null }
  assert.deepEqual(await hf.userOverview('TheBloke'), thebloke)
  assert.deepEqual(await hf.userOverview('thebloke'), { ...thebloke, redirectedFrom: 'thebloke' })
  const openai = { id: '659ebc82b61dd9658802f398', handle: 'openai-community', kind: 'org', fullname: 'OpenAI community',
    avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/5dd96eb166059660ed1ee413/9NY4jfufqo1uyv8oNXQju.png', redirectedFrom: null }
  assert.deepEqual(await hf.orgOverview('openai-community'), openai)
  await rejects(hf.userOverview('openai-community'), HfNotFoundError, 'HF_NOT_FOUND')
  await rejects(hf.orgOverview('repoing-spike-no-such-org-x9'), HfNotFoundError, 'HF_NOT_FOUND')
  server.requests.length = 0
  assert.deepEqual(await hf.owner('openai-community'), openai)
  assert.deepEqual(server.requests.map(request => request.path), ['/api/users/openai-community/overview', '/api/organizations/openai-community/overview'])
  assert.deepEqual(await hf.owner('TheBloke'), thebloke)
  server.route('/api/users/repoing-spike-no-such-org-x9/overview', recorded['user-not-found'])
  await rejects(hf.owner('repoing-spike-no-such-org-x9'), HfNotFoundError, 'HF_NOT_FOUND')
  server.requests.length = 0
  await assert.rejects(hf.userOverview('bad--name'), HfUrlError)
  await assert.rejects(hf.owner('../users'), HfUrlError)
  assert.equal(server.requests.length, 0)
  server.route('/api/users/TheBloke/overview', json({ ...recordedBody('user-thebloke'), type: 'org' }))
  await rejects(hf.userOverview('TheBloke'), HfUpstreamError, 'HF_INVALID_RESPONSE')
  server.route('/api/users/TheBloke/overview', json({ ...recordedBody('user-thebloke'), user: 'SomeoneElse' }))
  await rejects(hf.userOverview('TheBloke'), HfUpstreamError, 'HF_IDENTITY_MISMATCH')
}))

test('commit and discussion counts come from the recorded headers and bodies; gated and missing revisions are typed', () => withHf(async ({ hf, server }) => {
  assert.equal(await hf.commitsCount('openai-community/gpt2'), 26)
  assert.deepEqual([server.requests[0].path, server.requests[0].query], ['/api/models/openai-community/gpt2/commits/main', '?limit=1'])
  await rejects(hf.commitsCount('meta-llama/Llama-3.1-8B'), HfGatedError, 'HF_GATED')
  await rejects(hf.commitsCount('openai-community/gpt2', { revision: 'no-such-branch-x9' }), HfNotFoundError, 'HF_REVISION_NOT_FOUND')
  for (const revision of ['../../users', '.', '.hidden', 'refs/pr/1', '', 7]) await assert.rejects(hf.commitsCount('openai-community/gpt2', { revision }), HfUrlError)
  await assert.rejects(hf.commitsCount('https://huggingface.co/openai-community/gpt2'), HfUrlError)
  for (const headers of [{ 'x-total-count': '' }, { 'x-total-count': 'many' }, { 'x-total-count': '-1' }, {}]) {
    server.route('/api/models/openai-community/gpt2/commits/main', json(recordedBody('commits-gpt2'), headers))
    await rejects(hf.commitsCount('openai-community/gpt2'), HfUpstreamError, 'HF_INVALID_RESPONSE')
  }
  assert.deepEqual(await hf.discussionsCount('openai-community/gpt2'), { total: 183, open: 106, closed: 77 })
  const discussions = recordedBody('discussions-gpt2')
  server.route('/api/models/openai-community/gpt2/discussions', json({ ...discussions, numClosedDiscussions: undefined }))
  assert.deepEqual(await hf.discussionsCount('openai-community/gpt2'), { total: 183, open: null, closed: null })
  for (const changes of [{ numClosedDiscussions: 184 }, { count: -1 }, { count: '183' }]) {
    server.route('/api/models/openai-community/gpt2/discussions', json({ ...discussions, ...changes }))
    await rejects(hf.discussionsCount('openai-community/gpt2'), HfUpstreamError, 'HF_INVALID_RESPONSE')
  }
  await rejects(hf.discussionsCount('repoing-spike-no-such-owner-x9/no-such-model-x9'), HfUpstreamError, 'HF_HTTP_599')
}))

test('trending models come back ranked with their owner _id and kind; foreign entries are dropped, mismatches refused', () => withHf(async ({ hf, server }) => {
  const trending = await hf.trendingModels()
  assert.equal(server.requests[0].query, '?type=model&limit=20')
  const items = recordedBody('trending-models').recentlyTrending
  assert.deepEqual(trending.map(item => [item.rank, item.path, item.owner.kind]),
    items.map((item, index) => [index + 1, item.repoData.id, item.repoData.authorData.type]))
  assert.deepEqual(trending[0], { rank: 1, path: 'convaiinnovations/laya', owner: { handle: 'convaiinnovations', kind: 'user', id: '64c213a5ec3c61813527cad5' },
    private: false, gated: false, likes: 4939, downloads30d: 0, lastModified: '2026-09-24T05:39:22.000Z', pipelineTag: 'text-classification' })
  assert.deepEqual(trending.find(item => item.path === 'Lightricks/LTX-2.5').owner, { handle: 'Lightricks', kind: 'org', id: '628378625d21028fbbddddf8' })
  assert.equal(trending.find(item => item.path === 'Lightricks/LTX-2.5').gated, 'auto')
  const dataset = { repoType: 'dataset', repoData: { id: 'openai/gsm8k' } }
  server.route('/api/trending', json({ recentlyTrending: [dataset, ...items.slice(0, 2)] }))
  assert.deepEqual((await hf.trendingModels({ limit: 3 })).map(item => [item.rank, item.path]), [[1, 'convaiinnovations/laya'], [2, 'Cloudflare/clef']])
  const { authorData, ...noAuthorData } = items[1].repoData
  server.route('/api/trending', json({ recentlyTrending: [{ ...items[1], repoData: noAuthorData }] }))
  assert.deepEqual((await hf.trendingModels())[0].owner, { handle: 'Cloudflare' })
  server.route('/api/trending', json({ recentlyTrending: [{ ...items[1], repoData: { ...items[1].repoData, authorData: { ...authorData, name: 'Other' } } }] }))
  await rejects(hf.trendingModels(), HfUpstreamError, 'HF_IDENTITY_MISMATCH')
  server.route('/api/trending', json({ recentlyTrending: [{ ...items[1], repoData: { ...items[1].repoData, likes: 'lots' } }] }))
  await rejects(hf.trendingModels(), HfUpstreamError, 'HF_INVALID_RESPONSE')
  for (const limit of [0, 21, 1.5, '20']) await assert.rejects(hf.trendingModels({ limit }), RangeError)
}))

test('invalid model inputs are refused before any request', () => withHf(async ({ hf, server }) => {
  for (const path of ['datasets/openai/gsm8k', 'https://huggingface.co/spaces/a/b', 'gpt2', 'a/b--c', undefined]) await assert.rejects(hf.model({ path }), HfUrlError)
  await assert.rejects(hf.model(), HfUrlError)
  assert.equal(server.requests.length, 0)
  assert.deepEqual([HfUrlError, parseHfModelUrl], [UrlModuleError, parseFromUrlModule])
}))
