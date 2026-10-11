import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { register } from 'node:module'
import { Keypair } from '@solana/web3.js'
import { encryptGithubSession, githubSessionCookie } from '../app/lib/auth.mjs'
import { CREDITS_SESSION_COOKIE, sealCreditsSession } from '../src/credits-web.mjs'
import { DEFAULT_INFERENCE_ORIGIN, MIN_LIMIT_MICRO, createCreditsKeys, creditsKeysSettings, inferenceOriginOf, parseAccount, parseKeys, parseMadeKey,
  readKeyId, readLabel, readLimit } from '../src/credits-keys.mjs'
import { LABEL_PATTERN, MIN_LIMIT_MICRO as CLIENT_MIN, usdToMicro } from '../app/components/credit-keys-model.mjs'

// The route imports next/server the way Next resolves it (tests/fixtures/jsx-hooks.mjs).
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))
const route = await import('../app/api/credits/keys/route.js')

// "Make a key" on repo.ing/credits (src/credits-keys.mjs) without services: the settings, the checks on every answer from the
// credit service, the steps against a scripted credit service and the route's refusals. The shapes are the CLI's
// (cli/src/credits.mjs, tests/repoing-cli-credits.test.mjs).
const TREASURY = Keypair.generate().publicKey.toBase58()
const HANDOFF = { REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'c'.repeat(40), HANDOFF_ASSERTION_SECRET: 'a'.repeat(40) }
const ON = { ...HANDOFF, CREDITS_WEB_PACKS_ENABLED: 'true', REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing', CREDITS_TREASURY_ADDRESS: TREASURY }
const SETTINGS = { origin: 'https://credits.repo.ing', treasury: TREASURY, network: 'mainnet', inferenceOrigin: 'https://inference.repo.ing' }
const KEY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER_ID = '1f8fad5b-d9cb-469f-a165-70867728950e'
const TOKEN = `rik_${'cd'.repeat(32)}`
const SESSION_TOKEN = `ses_${'y'.repeat(40)}`
const NEW_SESSION_TOKEN = `ses_${'n'.repeat(40)}`
const FUTURE = '2099-01-01T00:00:00Z'

test('dark unless packs are on; the AI gateway is https (this computer may use http); a bad one turns the keys off', () => {
  assert.equal(DEFAULT_INFERENCE_ORIGIN, 'https://inference.repo.ing')
  assert.equal(creditsKeysSettings({}), null)
  assert.equal(creditsKeysSettings({ ...ON, CREDITS_WEB_PACKS_ENABLED: 'false' }), null, 'no switch of its own: packs on is keys on')
  assert.deepEqual(creditsKeysSettings(ON), SETTINGS)
  assert.equal(creditsKeysSettings({ ...ON, CREDITS_INFERENCE_ORIGIN: 'https://ai.example' }).inferenceOrigin, 'https://ai.example')
  assert.equal(inferenceOriginOf({}), 'https://inference.repo.ing')
  assert.equal(inferenceOriginOf({ CREDITS_INFERENCE_ORIGIN: 'http://127.0.0.1:8788' }), 'http://127.0.0.1:8788')
  assert.equal(inferenceOriginOf({ CREDITS_INFERENCE_ORIGIN: 'http://localhost:8788' }), 'http://localhost:8788')
  for (const bad of ['http://ai.example', 'ftp://ai.example', 'https://ai.example/v1', 'https://ai.example/?x=1', 'https://user:pw@ai.example', 'not a url']) {
    assert.equal(inferenceOriginOf({ CREDITS_INFERENCE_ORIGIN: bad }), null, bad)
    assert.equal(creditsKeysSettings({ ...ON, CREDITS_INFERENCE_ORIGIN: bad }), null, `${bad}: the keys are off, not pointed somewhere else`)
  }
  assert.equal(inferenceOriginOf({ CREDITS_INFERENCE_ORIGIN: 'http://127.0.0.1:8788', NODE_ENV: 'production' }), null, 'no http in production')
  assert.equal(inferenceOriginOf({ CREDITS_INFERENCE_ORIGIN: '' }), 'https://inference.repo.ing')
})

test('the account: credits_available, else paid_available, as the CLI reads it; anything else is refused', () => {
  assert.equal(parseAccount({ credits_available: 75_000_000, paid_available: 1 }), 75_000_000)
  assert.equal(parseAccount({ paid_available: 5_000_000 }), 5_000_000)
  assert.equal(parseAccount({ credits_available: 0, paid_available: 9 }), 0, 'zero is an answer')
  assert.equal(parseAccount({}), 0)
  assert.equal(parseAccount({ credits_available: '12000000' }), 12_000_000)
  for (const bad of [null, 'x', [], { credits_available: -1 }, { credits_available: 1.5 }, { credits_available: 'lots' }, { credits_available: 2 ** 60 },
    { credits_available: NaN }, { credits_available: true }, { credits_available: {} }]) {
    assert.throws(() => parseAccount(bad), /invalid account/, JSON.stringify(bad))
  }
})

test('the key list: well-formed ids only, a label only if it is a label, a state, no extra fields', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  const listed = parseKeys({ keys: [
    { id: KEY_ID, label: 'cursor', budget_micro: 20_000_000, spent_micro: 1_500_000, revoked: false, expires_at: FUTURE, token: TOKEN, secret: 'x' },
    { id: OTHER_ID, label: 'evil\u001b[2Jlabel', budget_micro: 1, spent_micro: 0, revoked: true, expires_at: FUTURE },
    { id: '2f8fad5b-d9cb-469f-a165-70867728950e', label: 'old', budget_micro: 5_000_000, spent_micro: 5_000_000, expires_at: '2026-10-01T00:00:00Z' },
    { id: '3f8fad5b-d9cb-469f-a165-70867728950e', label: 'gone', budget_micro: 5_000_000, spent_micro: 0, revoked_at: '2026-10-05T00:00:00Z', expires_at: FUTURE },
    { id: '4F8FAD5B-D9CB-469F-A165-70867728950E', label: 'upper', budget_micro: '3000000', expires_at: FUTURE },
    { id: 'not-an-id', label: 'x' }, null, 'x'] }, now)
  assert.deepEqual(listed.map(key => [key.id, key.label, key.state]), [[KEY_ID, 'cursor', 'live'], [OTHER_ID, '?', 'revoked'],
    ['2f8fad5b-d9cb-469f-a165-70867728950e', 'old', 'expired'], ['3f8fad5b-d9cb-469f-a165-70867728950e', 'gone', 'revoked'],
    ['4f8fad5b-d9cb-469f-a165-70867728950e', 'upper', 'live']])
  assert.deepEqual(listed[0], { id: KEY_ID, label: 'cursor', budgetMicro: 20_000_000, spentMicro: 1_500_000, expiresAt: '2099-01-01T00:00:00.000Z', state: 'live' })
  assert.equal(listed[4].spentMicro, 0, 'a missing figure reads as 0, as in the CLI')
  assert.equal(JSON.stringify(listed).includes('rik_'), false, 'no token field is ever passed on')
  assert.equal(JSON.stringify(listed).includes('secret'), false)
  assert.deepEqual(parseKeys({ keys: [{ id: KEY_ID, label: 'bad', budget_micro: -4, spent_micro: 'x', expires_at: 'soon' }] }, now),
    [{ id: KEY_ID, label: 'bad', budgetMicro: null, spentMicro: null, expiresAt: null, state: 'live' }], 'odd figures and dates are shown as unknown')
  for (const bad of [null, {}, { keys: 'x' }, []]) assert.deepEqual(parseKeys(bad, now), [])
  const many = parseKeys({ keys: Array.from({ length: 80 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-d9cb-469f-a165-70867728950e`, label: 'k', budget_micro: 1, expires_at: FUTURE })) }, now)
  assert.equal(many.length, 50, 'at most 50 keys')
})

test('a new key: the token, the id and a whole-number limit, all well-formed; nothing else is passed on', () => {
  const answer = (extra = {}, key = {}) => ({ token: TOKEN, replayed: false, key: { id: KEY_ID, scope: 'inference', label: 'cursor', budget_micro: 20_000_000, expires_at: '2026-11-06T19:00:00Z', ...key }, ...extra })
  assert.deepEqual(parseMadeKey(answer()), { token: TOKEN, key: { id: KEY_ID, label: 'cursor', budgetMicro: 20_000_000, expiresAt: '2026-11-06T19:00:00.000Z' } })
  assert.equal(parseMadeKey(answer({}, { id: KEY_ID.toUpperCase() })).key.id, KEY_ID)
  assert.equal(parseMadeKey(answer({}, { expires_at: 'tomorrow' })).key.expiresAt, null)
  assert.equal(parseMadeKey(answer({}, { label: 'a\u001b[2J' })).key.label, '?')
  const refused = (value, name) => assert.throws(() => parseMadeKey(value), /invalid key.*If a key was made, revoke it below\./, name)
  refused(answer({ token: 'rik_x\nOPENAI_BASE_URL=https://evil.example' }), 'injected token')
  refused(answer({ token: `rik_${'AB'.repeat(32)}` }), 'upper-case hex')
  refused(answer({ token: `rik_${'ab'.repeat(31)}` }), 'short token')
  refused(answer({ token: `${TOKEN}\n` }), 'trailing newline')
  refused(answer({ token: `ses_${'ab'.repeat(32)}` }), 'a session token is not a key')
  refused(answer({ token: undefined }), 'no token')
  refused(answer({}, { id: 'nope' }), 'bad id')
  refused(answer({}, { budget_micro: 1.5 }), 'fraction')
  refused(answer({}, { budget_micro: '20000000' }), 'a limit that is text')
  refused(answer({}, { budget_micro: undefined }), 'no limit')
  refused(answer({ key: null }), 'no key')
  refused(null, 'nothing')
})

test('what a visitor may send: a name, a limit in micro-USD, a key id', () => {
  assert.equal(readLabel(undefined), 'coding-tool')
  for (const ok of ['cursor laptop', 'a', 'A.b_c-d 9', 'x'.repeat(64)]) assert.equal(readLabel(ok), ok)
  for (const bad of ['', ' x', '-x', '_x', 'a\tb', 'a\nb', 'x'.repeat(65), 'naïve', 5, null, {}, ['a']]) assert.throws(() => readLabel(bad), /name is 1 to 64/, JSON.stringify(bad))
  assert.equal(readLimit(undefined), null, 'no limit: all the credits')
  assert.equal(readLimit('20000000'), 20_000_000)
  assert.equal(readLimit(String(MIN_LIMIT_MICRO)), 10_000)
  assert.equal(MIN_LIMIT_MICRO, 10_000)
  for (const bad of ['9999', '0', '-5', '1.5', '20000000.0', ' 20000000', '0x10', 'abc', '', 20_000_000, null, '9'.repeat(16), [], {}]) {
    assert.throws(() => readLimit(bad), /limit/i, JSON.stringify(bad))
  }
  assert.equal(readKeyId(KEY_ID.toUpperCase()), KEY_ID)
  for (const bad of ['nope', '', undefined, null, 5, `${KEY_ID}/../x`, `${KEY_ID}\n`, `../${KEY_ID}`]) assert.throws(() => readKeyId(bad), /key/i, String(bad))
})

test('the browser form and the server agree on names and the smallest limit', () => {
  assert.equal(CLIENT_MIN, MIN_LIMIT_MICRO)
  for (const label of ['cursor', 'a b', 'x'.repeat(64), 'x'.repeat(65), '', ' x', '-x', 'a\tb', '.x', 'ok.name_1-2']) {
    let server = true
    try { readLabel(label) } catch { server = false }
    assert.equal(LABEL_PATTERN.test(label), server, JSON.stringify(label))
  }
  assert.deepEqual([usdToMicro('20'), usdToMicro('$20.5'), usdToMicro('0.01'), usdToMicro(' 75.00 ')], [20_000_000, 20_500_000, 10_000, 75_000_000])
  for (const bad of ['', '0', '0.001', '1.005', '-1', 'abc', '1e3', '12345678']) assert.equal(usdToMicro(bad), null, bad)
})

// The credit service, scripted; every request is recorded.
function creditService({ available = 75_000_000, keys, refuseMake = null, failMake = 0, token = TOKEN, expired = [], afterRevoke = null, breakList = false } = {}) {
  const requests = []
  const list = keys ?? [{ id: KEY_ID, label: 'cursor', budget_micro: 20_000_000, spent_micro: 1_500_000, revoked: false, expires_at: FUTURE }]
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url), body = init.body ? JSON.parse(init.body) : null
    const bearer = init.headers.authorization?.slice('Bearer '.length)
    requests.push({ path: target.pathname, method: init.method ?? 'GET', body, headers: init.headers })
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
    if (target.pathname === '/sessions') return json({ token: NEW_SESSION_TOKEN, login: 'octocat', expires_at: new Date(Date.now() + 3600_000).toISOString() })
    if (expired.includes(bearer)) return json({ error: 'Sign in again.' }, 401)
    if (target.pathname === '/account') return json({ account_id: 'a', paid_available: available, credits_available: available })
    if (target.pathname === '/keys' && init.method === 'POST' && failMake) return json({ error: 'upstream down' }, failMake)
    if (target.pathname === '/keys' && init.method === 'POST') return refuseMake ? json({ error: refuseMake }, 400)
      : json({ key: { id: KEY_ID, scope: 'inference', label: body.label, budget_micro: body.budget_micro, expires_at: '2026-11-06T19:00:00Z' }, token, replayed: false })
    if (target.pathname === '/keys') return breakList && requests.some(r => r.path.endsWith('/revoke')) ? json({ error: 'down' }, 503) : json({ keys: afterRevoke && requests.some(r => r.path.endsWith('/revoke')) ? afterRevoke : list })
    if (target.pathname === `/keys/${KEY_ID}/revoke`) return json({ id: KEY_ID, revoked: true })
    return json({ error: 'not found' }, 404)
  }
  return { fetchImpl, requests }
}
// A database that only counts: the quota table answers once per call (or refuses), the handoff rows are recorded.
function fakePool({ limited = false } = {}) {
  const queries = []
  return { queries, query: async (text, params) => { queries.push([text, params]); return { rows: /agent_request_limits/.test(text) && !limited ? [{ hits: 1 }] : [] } } }
}
const identity = (githubLogin = 'octocat') => ({ currentIdentity: async () => ({ githubLogin }) })
const current = (token = SESSION_TOKEN) => ({ token, githubUserId: '123', expiresAt: Date.now() + 30 * 60_000 })
function steps(overrides = {}) {
  const credit = creditService(overrides.credit), pool = overrides.pool ?? fakePool()
  return { ...credit, pool, service: createCreditsKeys({ pool, settings: SETTINGS, githubVerifier: overrides.githubVerifier ?? identity(), fetchImpl: credit.fetchImpl }) }
}

test('the overview needs a session and never signs in; a session the service no longer knows asks to sign in again', async () => {
  const none = steps()
  assert.deepEqual(await none.service.overview({ current: null }), { needsSignIn: true })
  assert.equal(none.requests.length, 0, 'nothing is asked without a session')
  assert.equal(none.pool.queries.length, 0)
  const live = steps()
  const overview = await live.service.overview({ current: current() })
  assert.deepEqual(overview, { needsSignIn: false, availableMicro: 75_000_000,
    keys: [{ id: KEY_ID, label: 'cursor', budgetMicro: 20_000_000, spentMicro: 1_500_000, expiresAt: '2099-01-01T00:00:00.000Z', state: 'live' }] })
  assert.deepEqual(live.requests.map(r => [r.method, r.path, r.headers.authorization]).sort(), [['GET', '/account', `Bearer ${SESSION_TOKEN}`], ['GET', '/keys', `Bearer ${SESSION_TOKEN}`]])
  assert.equal(live.requests.some(r => r.path === '/sessions'), false)
  const gone = steps({ credit: { expired: [SESSION_TOKEN] } })
  assert.deepEqual(await gone.service.overview({ current: current() }), { needsSignIn: true })
  assert.equal(gone.requests.some(r => r.path === '/sessions'), false, 'still no sign-in on a read')
  await assert.rejects(steps({ credit: { available: -1 } }).service.overview({ current: current() }), /invalid account/)
})

test('a key with a session: the balance is read again, the limit checked, one POST with an idempotency key, the token returned once', async () => {
  const { service, requests, pool } = steps()
  const made = await service.make({ githubUserId: '123', login: 'octocat', current: current(), label: 'cursor', limitMicro: '20000000' })
  assert.deepEqual(made.key, { id: KEY_ID, label: 'cursor', budgetMicro: 20_000_000, expiresAt: '2026-11-06T19:00:00.000Z' })
  assert.equal(made.token, TOKEN)
  assert.equal(made.session, null, 'the cookie keeps its session')
  assert.deepEqual(requests.map(r => `${r.method} ${r.path}`), ['GET /account', 'POST /keys'], 'no sign-in, and the balance before the key')
  const post = requests[1]
  assert.deepEqual([post.body, post.headers.authorization], [{ label: 'cursor', budget_micro: 20_000_000 }, `Bearer ${SESSION_TOKEN}`])
  assert.match(post.headers['idempotency-key'], /^[A-Za-z0-9_-]{22}$/)
  assert.deepEqual(Object.keys(post.body), ['label', 'budget_micro'], 'the body is exactly these two')
  const quota = pool.queries.filter(([text]) => /agent_request_limits/.test(text)).map(([, params]) => params[0])
  assert.deepEqual(quota, ['credits:keys:123', 'credits:keys'])
  const second = await service.make({ githubUserId: '123', login: 'octocat', current: current(), label: 'cursor', limitMicro: '20000000' })
  assert.notEqual(requests.filter(r => r.method === 'POST')[1].headers['idempotency-key'], post.headers['idempotency-key'], 'a fresh key each time')
  assert.equal(second.token, TOKEN)
})

test('the limit: all the credits by default, never more than the credits, never below one cent; no credits means no request', async () => {
  const all = steps()
  await all.service.make({ githubUserId: '123', login: 'octocat', current: current() })
  assert.deepEqual(all.requests.find(r => r.method === 'POST').body, { label: 'coding-tool', budget_micro: 75_000_000 })
  const over = steps()
  await assert.rejects(over.service.make({ githubUserId: '123', login: 'octocat', current: current(), limitMicro: '80000000' }), error => /at most \$75\.00/.test(error.message) && error.status === 400)
  assert.equal(over.requests.some(r => r.method === 'POST'), false)
  const none = steps({ credit: { available: 5_000 } })
  await assert.rejects(none.service.make({ githubUserId: '123', login: 'octocat', current: current() }), error => /no AI credits/i.test(error.message) && error.status === 400)
  assert.equal(none.requests.some(r => r.method === 'POST'), false)
  for (const input of [{ label: 'a\tb' }, { limitMicro: '5' }, { limitMicro: 20_000_000 }]) {
    const bad = steps()
    await assert.rejects(bad.service.make({ githubUserId: '123', login: 'octocat', current: current(), ...input }), error => error.status === 400)
    assert.equal(bad.requests.length, 0, 'refused before any request')
    assert.equal(bad.pool.queries.length, 0, 'and before the quota')
  }
})

test('a key without a session signs in with an identity handoff first and gives the new session back for the cookie', async () => {
  const { service, requests, pool } = steps()
  const made = await service.make({ githubUserId: '123', login: 'octo', current: null, label: 'laptop', limitMicro: '10000000' })
  const insert = pool.queries.find(([text]) => /insert into auth_handoffs/.test(text))[1]
  assert.deepEqual([insert[2], insert[3], insert[4], insert[5], insert[9]], ['repo-inference', null, '123', 'octocat', 'identity'], 'no repository, the live GitHub login')
  assert.deepEqual(requests.map(r => `${r.method} ${r.path}`), ['POST /sessions', 'GET /account', 'POST /keys'])
  assert.equal(requests[2].headers.authorization, `Bearer ${NEW_SESSION_TOKEN}`)
  assert.deepEqual([made.session.token, made.session.githubUserId], [NEW_SESSION_TOKEN, '123'])
  assert.ok(made.session.expiresAt > Date.now())
  assert.equal(made.token, TOKEN)
  // A GitHub sign-in that no longer works signs nobody in.
  const refused = steps({ githubVerifier: { currentIdentity: async () => { throw new Error('token revoked ghu_secret') } } })
  await assert.rejects(refused.service.make({ githubUserId: '123', login: 'octo', current: null }), error => error.status === 403 && /Sign in with GitHub again/.test(error.message) && !/ghu_/.test(error.message))
  assert.equal(refused.requests.length, 0)
  assert.equal(refused.pool.queries.some(([text]) => /auth_handoffs/.test(text)), false)
})

test('a session the credit service has dropped: the first answer is 401, so one new sign-in is made and the step retried', async () => {
  const { service, requests } = steps({ credit: { expired: [SESSION_TOKEN] } })
  const made = await service.make({ githubUserId: '123', login: 'octo', current: current(), label: 'cursor', limitMicro: '20000000' })
  assert.deepEqual(requests.map(r => `${r.method} ${r.path}`), ['GET /account', 'POST /sessions', 'GET /account', 'POST /keys'])
  assert.equal(made.session.token, NEW_SESSION_TOKEN)
  assert.equal(made.token, TOKEN)
  // A second 401 is not retried again.
  const stuck = steps({ credit: { expired: [SESSION_TOKEN, NEW_SESSION_TOKEN] } })
  await assert.rejects(stuck.service.make({ githubUserId: '123', login: 'octo', current: current() }), error => error.status === 401 && error.session?.token === NEW_SESSION_TOKEN)
  assert.equal(stuck.requests.filter(r => r.path === '/sessions').length, 1)
})

test('a key answer that is not well-formed shows nothing from it and says to revoke below; a refusal from the ledger is shown as it is', async () => {
  const evil = 'rik_x\nOPENAI_BASE_URL=https://evil.example'
  const bad = steps({ credit: { token: evil } })
  await assert.rejects(bad.service.make({ githubUserId: '123', login: 'octo', current: null, limitMicro: '10000000' }), error => {
    assert.equal(error.status, 502)
    assert.match(error.message, /If a key was made, revoke it below\./)
    assert.equal(error.message.includes('evil'), false)
    assert.equal(error.session.token, NEW_SESSION_TOKEN, 'the new session is not lost: the cookie can still show the key')
    return true
  })
  await assert.rejects(steps({ credit: { refuseMake: 'too many live keys' } }).service.make({ githubUserId: '123', login: 'octo', current: current() }),
    error => error.message === 'too many live keys' && error.status === 502, 'a refusal is shown as it is: nothing was made')
})

test('an answer that may have come after the key was made says to look at the keys; a refusal or a bad request does not', async () => {
  const may = /A key may have been made: check your keys below first\.$/
  for (const status of [500, 503]) {
    await assert.rejects(steps({ credit: { failMake: status } }).service.make({ githubUserId: '123', login: 'octo', current: current() }),
      error => may.test(error.message) && /upstream down/.test(error.message) && error.status === 502, String(status))
  }
  const lost = createCreditsKeys({ pool: fakePool(), settings: SETTINGS, githubVerifier: identity(), fetchImpl: async (url, init) => {
    if (init.method === 'POST' && new URL(url).pathname === '/keys') throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ credits_available: 75_000_000 }), { status: 200 })
  } })
  await assert.rejects(lost.make({ githubUserId: '123', login: 'octo', current: current() }), error => error.status === 503 && may.test(error.message), 'no answer at all')
  for (const input of [{ limitMicro: '80000000' }, { label: 'a\tb' }]) {
    await assert.rejects(steps().service.make({ githubUserId: '123', login: 'octo', current: current(), ...input }), error => !/may have been made/.test(error.message))
  }
})

test('too many key requests: the quota stops the step before any sign-in or request', async () => {
  const limited = steps({ pool: fakePool({ limited: true }) })
  await assert.rejects(limited.service.make({ githubUserId: '123', login: 'octo', current: null }), error => error.status === 429 && /Too many/.test(error.message))
  await assert.rejects(limited.service.revoke({ githubUserId: '123', login: 'octo', current: current(), keyId: KEY_ID }), error => error.status === 429)
  await assert.rejects(limited.service.check({ githubUserId: '123', login: 'octo', current: null }), error => error.status === 429)
  assert.equal(limited.requests.length, 0)
  assert.equal(limited.pool.queries.some(([text]) => /auth_handoffs/.test(text)), false)
})

test('revoke: one POST for that key, then the refreshed overview; a refresh that fails does not undo or hide the revoke', async () => {
  const afterRevoke = [{ id: KEY_ID, label: 'cursor', budget_micro: 20_000_000, spent_micro: 1_500_000, revoked: true, expires_at: FUTURE }]
  const { service, requests } = steps({ credit: { afterRevoke } })
  const result = await service.revoke({ githubUserId: '123', login: 'octo', current: current(), keyId: KEY_ID.toUpperCase() })
  const call = requests.find(r => r.path.endsWith('/revoke'))
  assert.deepEqual([call.method, call.path, call.body, call.headers.authorization], ['POST', `/keys/${KEY_ID}/revoke`, {}, `Bearer ${SESSION_TOKEN}`])
  assert.equal(result.session, null)
  assert.equal(result.overview.keys[0].state, 'revoked')
  assert.equal(result.overview.availableMicro, 75_000_000)
  const broken = steps({ credit: { breakList: true } })
  const partial = await broken.service.revoke({ githubUserId: '123', login: 'octo', current: current(), keyId: KEY_ID })
  assert.equal(partial.overview, null, 'the page asks again')
  // Without a session it signs in, as a key does.
  const fresh = steps()
  const signed = await fresh.service.revoke({ githubUserId: '123', login: 'octo', current: null, keyId: KEY_ID })
  assert.equal(signed.session.token, NEW_SESSION_TOKEN)
  assert.equal(fresh.requests[0].path, '/sessions')
  // A bad id is refused before anything is asked.
  const bad = steps()
  await assert.rejects(bad.service.revoke({ githubUserId: '123', login: 'octo', current: current(), keyId: `${KEY_ID}/../x` }), error => error.status === 400)
  assert.equal(bad.requests.length, 0)
  assert.equal(bad.pool.queries.length, 0)
})

test('check: a click that shows the credits and keys, signing in only when the cookie has no session', async () => {
  const withSession = steps()
  const shown = await withSession.service.check({ githubUserId: '123', login: 'octo', current: current() })
  assert.equal(shown.session, null)
  assert.equal(shown.overview.availableMicro, 75_000_000)
  assert.equal(withSession.requests.some(r => r.path === '/sessions'), false)
  assert.equal(withSession.pool.queries.length, 0, 'no quota use when it does not sign in')
  const without = steps()
  const signedIn = await without.service.check({ githubUserId: '123', login: 'octo', current: null })
  assert.equal(signedIn.session.token, NEW_SESSION_TOKEN)
  assert.equal(signedIn.overview.keys.length, 1)
  assert.deepEqual(without.pool.queries.filter(([text]) => /agent_request_limits/.test(text)).map(([, params]) => params[0]), ['credits:keys:123', 'credits:keys'])
})

// The route, with the GitHub session and the credit session sealed as production does, a counting database and one scripted fetch
// for both GitHub (the live identity check) and the credit service.
test('the route: 404 while dark; GET and POST need the GitHub session; POST needs the same origin and exact fields', async t => {
  const names = [...Object.keys(ON), 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_CLIENT_ID', 'APP_ORIGIN', 'DATABASE_URL', 'CREDITS_INFERENCE_ORIGIN']
  const old = Object.fromEntries(names.map(key => [key, process.env[key]])), oldPool = globalThis.__gitfunPool, oldFetch = globalThis.fetch
  t.after(() => {
    for (const key of names) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]
    if (oldPool === undefined) delete globalThis.__gitfunPool; else globalThis.__gitfunPool = oldPool
    globalThis.fetch = oldFetch
  })
  process.env.GITHUB_APP_CLIENT_SECRET = randomBytes(32).toString('hex')
  process.env.GITHUB_APP_CLIENT_ID = 'Iv1.test'
  process.env.APP_ORIGIN = 'https://repo.ing'
  process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none'
  const pool = fakePool(), credit = creditService(), calls = []
  globalThis.__gitfunPool = pool
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    if (String(url) === 'https://api.github.com/user') return new Response(JSON.stringify({ id: 123, login: 'octocat', type: 'User' }), { status: 200 })
    return credit.fetchImpl(url, init)
  }
  const githubSession = encryptGithubSession({ scope: 'builders', repoId: null, permission: 'identity', githubUserId: '123', githubLogin: 'octo', accessToken: 'ghu_test_only',
    sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 })
  const creditSession = sealCreditsSession({ token: SESSION_TOKEN, githubUserId: '123', expiresAt: Date.now() + 30 * 60_000 })
  const anotherAccount = sealCreditsSession({ token: SESSION_TOKEN, githubUserId: '999', expiresAt: Date.now() + 30 * 60_000 })
  const make = (cookies = {}, { origin = 'https://repo.ing', body = { action: 'check' }, length } = {}) => ({ url: 'https://repo.ing/api/credits/keys',
    headers: new Headers({ origin, ...length ? { 'content-length': String(length) } : {} }), json: async () => body,
    cookies: { get: name => name === githubSessionCookie && cookies.github ? { value: cookies.github } : name === CREDITS_SESSION_COOKIE && cookies.credit ? { value: cookies.credit } : undefined } })
  const asJson = async response => ({ status: response.status, body: await response.json(), headers: response.headers, response })

  for (const key of Object.keys(ON)) delete process.env[key]
  for (const method of ['GET', 'POST']) assert.equal((await route[method](make({ github: githubSession }))).status, 404, 'dark')
  Object.assign(process.env, ON)
  process.env.CREDITS_INFERENCE_ORIGIN = 'http://not-allowed.example'
  assert.equal((await route.GET(make({ github: githubSession }))).status, 404, 'a bad AI gateway origin turns the keys off')
  delete process.env.CREDITS_INFERENCE_ORIGIN

  const signedOut = await asJson(await route.GET(make()))
  assert.deepEqual([signedOut.status, signedOut.body], [200, { enabled: true, signedIn: false }])
  assert.match(signedOut.headers.get('cache-control'), /private, no-store/)
  assert.equal(signedOut.headers.get('referrer-policy'), 'no-referrer')

  // No credit session in the cookie: nothing is asked, nothing signed in.
  const noCredit = await asJson(await route.GET(make({ github: githubSession })))
  assert.deepEqual(noCredit.body, { enabled: true, signedIn: true, login: 'octo', baseUrl: 'https://inference.repo.ing/v1', needsSignIn: true })
  assert.equal(calls.length, 0)
  const otherAccount = await asJson(await route.GET(make({ github: githubSession, credit: anotherAccount })))
  assert.equal(otherAccount.body.needsSignIn, true, 'another account’s credit session is not used')

  // With one: the balance and the keys, and no token field anywhere.
  const listed = await asJson(await route.GET(make({ github: githubSession, credit: creditSession })))
  assert.equal(listed.status, 200)
  assert.deepEqual([listed.body.needsSignIn, listed.body.availableMicro, listed.body.keys.map(key => [key.id, key.label, key.state])], [false, 75_000_000, [[KEY_ID, 'cursor', 'live']]])
  assert.match(listed.headers.get('cache-control'), /private, no-store/)
  assert.equal(/token|rik_|ses_/.test(JSON.stringify(listed.body)), false, 'a list never carries a token')

  // Refusals: all before the credit service or the quota.
  const before = [calls.length, pool.queries.length]
  const refusals = [
    [make({}, { body: { action: 'check' } }), 403],
    [make({ github: githubSession }, { origin: 'https://evil.invalid' }), 403],
    [make({ github: githubSession }, { body: { action: 'make', treasury: TREASURY } }), 403],
    [make({ github: githubSession }, { body: { action: 'make', keyId: KEY_ID } }), 403],
    [make({ github: githubSession }, { body: { action: 'revoke', keyId: KEY_ID, label: 'x' } }), 403],
    [make({ github: githubSession }, { body: { action: 'check', label: 'x' } }), 403],
    [make({ github: githubSession }, { body: { action: 'make', label: 'x' }, length: 8001 }), 403],
    [make({ github: githubSession }, { body: [] }), 403],
    [make({ github: githubSession }, { body: null }), 403],
    [make({ github: githubSession }, { body: { action: 'drain' } }), 400],
    [make({ github: githubSession }, { body: { action: '__proto__' } }), 400],
    [make({ github: githubSession }, { body: {} }), 400],
    [make({ github: githubSession }, { body: { action: 'make', label: 'a\tb' } }), 400],
    [make({ github: githubSession }, { body: { action: 'make', label: 7 } }), 400],
    [make({ github: githubSession }, { body: { action: 'make', limitMicro: '5' } }), 400],
    [make({ github: githubSession }, { body: { action: 'make', limitMicro: 20_000_000 } }), 400],
    [make({ github: githubSession }, { body: { action: 'revoke' } }), 400],
    [make({ github: githubSession }, { body: { action: 'revoke', keyId: 'nope' } }), 400],
  ]
  for (const [request, status] of refusals) {
    const refused = await asJson(await route.POST(request))
    assert.equal(refused.status, status, JSON.stringify(refused.body))
    assert.match(refused.headers.get('cache-control'), /private, no-store/)
  }
  assert.deepEqual([calls.length, pool.queries.length], before, 'nothing reached the credit service or the database')

  // A key, with the session in the cookie: the token comes back once, in this answer only, with no cookie change.
  const made = await asJson(await route.POST(make({ github: githubSession, credit: creditSession }, { body: { action: 'make', label: 'cursor', limitMicro: '20000000' } })))
  assert.equal(made.status, 200)
  assert.deepEqual(made.body, { key: { id: KEY_ID, label: 'cursor', budgetMicro: 20_000_000, expiresAt: '2026-11-06T19:00:00.000Z' }, token: TOKEN, baseUrl: 'https://inference.repo.ing/v1' })
  assert.match(made.headers.get('cache-control'), /private, no-store/)
  assert.equal(made.response.cookies.get(CREDITS_SESSION_COOKIE), undefined)
  assert.equal(JSON.stringify(pool.queries).includes('rik_'), false, 'the token is never stored')

  // Without the credit cookie: a live GitHub check, an identity handoff, and the new session sealed into the cookie.
  const fresh = await asJson(await route.POST(make({ github: githubSession }, { body: { action: 'make', label: 'laptop' } })))
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body.token, TOKEN)
  assert.equal(calls.includes('https://api.github.com/user'), true)
  const cookie = fresh.response.cookies.get(CREDITS_SESSION_COOKIE)
  assert.ok(cookie?.value && !cookie.value.includes(NEW_SESSION_TOKEN) && !cookie.value.includes(TOKEN), 'sealed: neither token is readable in the cookie')
  assert.equal(cookie.httpOnly, true)
  assert.equal(cookie.sameSite, 'strict')

  // A service error is shown in its own plain words; an unexpected one is not echoed.
  credit.requests.length = 0
  globalThis.fetch = async url => String(url) === 'https://api.github.com/user' ? new Response(JSON.stringify({ id: 123, login: 'octocat' }), { status: 200 })
    : new Response(JSON.stringify({ error: 'too many live keys' }), { status: 400 })
  const refused = await asJson(await route.POST(make({ github: githubSession, credit: creditSession }, { body: { action: 'make' } })))
  assert.deepEqual([refused.status, refused.body.error], [502, 'too many live keys'])
  pool.query = async () => { throw new Error('connect ECONNREFUSED postgres://user:hunter2@db.internal/x') }
  const broken = await asJson(await route.POST(make({ github: githubSession, credit: creditSession }, { body: { action: 'make' } })))
  assert.equal(broken.status, 409)
  assert.equal(/hunter2|postgres|ECONNREFUSED/.test(JSON.stringify(broken.body)), false)
  assert.match(broken.body.error, /Look at your keys/)

  // A revoke and a check answer with the overview.
  pool.query = async text => ({ rows: /agent_request_limits/.test(text) ? [{ hits: 1 }] : [] })
  globalThis.fetch = credit.fetchImpl
  const revoked = await asJson(await route.POST(make({ github: githubSession, credit: creditSession }, { body: { action: 'revoke', keyId: KEY_ID } })))
  assert.deepEqual([revoked.status, revoked.body.revoked, revoked.body.overview.keys.length], [200, KEY_ID, 1])
  const checked = await asJson(await route.POST(make({ github: githubSession, credit: creditSession }, { body: { action: 'check' } })))
  assert.deepEqual([checked.status, checked.body.needsSignIn, checked.body.availableMicro], [200, false, 75_000_000])
  assert.equal(/token|rik_/.test(JSON.stringify([revoked.body, checked.body])), false)
})
