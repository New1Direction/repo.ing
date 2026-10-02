import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { createHfClient } from '../src/hf-api.mjs'
import { HF_MARKET_REF_MIN, MarketIdentityError } from '../src/market-identity.mjs'
import { HF_OAUTH_SCOPES, HfAuthorityError, authorityMessage, createHfOAuth, createHfVerifier, decideModelAuthority, hfMarketsEnabled,
  hfOAuthConfig, parseUserInfo, pkcePair } from '../src/hf-verification.mjs'
import { createGitHubAppVerifier } from '../src/github-verification.mjs'
import { createWalletBinding, modelBindingMessage } from '../src/wallet-binding.mjs'
import { assertBindingAuthority } from '../src/claim.mjs'
import { claimAmounts } from '../src/claim-amounts.mjs'
import { startFakeHf } from './fixtures/hf-server.mjs'

// Hugging Face authority (src/hf-verification.mjs) with no network and no database: the decision matrix, OIDC with PKCE,
// fresh owner resolution against the recorded Hub responses (tests/fixtures/hf-server.mjs), the re-point rule, the
// cross-source refusals, and the sealed cookies. tests/hf-claims-db.test.mjs covers binding, claims and opt-outs on
// PostgreSQL; tests/hf-claim-chain.test.mjs a real payout on the local validator.
const USER = '6426d3f3a7723d62b53c259b' // TheBloke (recorded /api/users/TheBloke/overview)
const OTHER_USER = '5f17f0a0925b9863e28ad517'
const ORG = '659ebc82b61dd9658802f398' // openai-community (recorded /api/organizations/openai-community/overview)
const GPT2 = '621ffdc036468d709f17434d', GGUF = '64f5fd954d3b1dd311d30e28', RUNWAY_2022 = '6304f3f8cb9b1ed0d3d2f8b7'
const HF_MARKET = HF_MARKET_REF_MIN, GITHUB_REPO = 1384142609n
const userOwner = { id: USER, handle: 'TheBloke', kind: 'user' }
const orgOwner = { id: ORG, handle: 'openai-community', kind: 'org' }
const user = (orgs = []) => ({ subject: USER, username: 'TheBloke', orgs })
const membership = (extra = {}) => ({ subject: ORG, handle: 'openai-community', role: 'admin', restrictions: [], pendingSSO: false, missingMFA: false, ...extra })

test('a user-owned model: only the owner, by _id', () => {
  assert.deepEqual(decideModelAuthority(user(), userOwner), { authorized: true, role: 'owner', reason: null })
  assert.deepEqual(decideModelAuthority({ ...user(), subject: OTHER_USER }, userOwner), { authorized: false, role: null, reason: 'not-owner' })
  // A transfer: the model's owner is now someone else, so the previous owner's sign-in no longer qualifies.
  assert.equal(decideModelAuthority(user(), { id: OTHER_USER, handle: 'new-owner', kind: 'user' }).reason, 'not-owner')
  // The name is never enough: same handle, another _id.
  assert.equal(decideModelAuthority({ ...user(), subject: OTHER_USER, username: 'TheBloke' }, userOwner).reason, 'not-owner')
})

test('an org-owned model: an admin of exactly that organization, with no unmet security restrictions', () => {
  assert.deepEqual(decideModelAuthority(user([membership()]), orgOwner), { authorized: true, role: 'admin', reason: null })
  for (const role of ['write', 'contributor', 'read', 'owner', 'Admin', '']) {
    assert.equal(decideModelAuthority(user([membership({ role })]), orgOwner).reason, 'not-admin', role)
  }
  assert.equal(decideModelAuthority(user([membership({ role: null })]), orgOwner).reason, 'org-not-granted')
  for (const restricted of [{ restrictions: ['mfa'] }, { restrictions: ['sso'] }, { restrictions: ['ip', 'token-policy'] }, { pendingSSO: true }, { missingMFA: true }]) {
    assert.equal(decideModelAuthority(user([membership(restricted)]), orgOwner).reason, 'security-restrictions', JSON.stringify(restricted))
  }
  // The org's _id comes from its public overview on every check; a membership under the same name with another id fails.
  assert.equal(decideModelAuthority(user([membership({ subject: OTHER_USER })]), orgOwner).reason, 'org-mismatch')
  assert.equal(decideModelAuthority(user([]), orgOwner).reason, 'not-member')
  assert.equal(decideModelAuthority(user([membership({ handle: 'someone-else', subject: OTHER_USER })]), orgOwner).reason, 'not-member')
  // An admin of an org that owns nothing here, or of the model's user owner, is not an owner.
  assert.equal(decideModelAuthority({ ...user([membership()]), subject: OTHER_USER }, userOwner).reason, 'not-owner')
})

test('malformed identities never authorize', () => {
  for (const [who, owner] of [[user(), { ...userOwner, id: 'TheBloke' }], [{ ...user(), subject: '1384142609' }, userOwner], [{ ...user(), orgs: null }, orgOwner],
    [user([membership()]), { ...orgOwner, kind: 'team' }], [user([membership()]), { ...orgOwner, id: USER }], [null, userOwner], [user(), null]]) {
    assert.equal(decideModelAuthority(who, owner).authorized, false)
  }
  for (const reason of ['not-owner', 'not-member', 'org-not-granted', 'not-admin', 'security-restrictions', 'org-mismatch', 'invalid']) {
    assert.ok(authorityMessage(reason, { username: 'TheBloke', owner: orgOwner }).length > 20)
  }
})

test('userinfo is validated: a malformed org entry is dropped and so can never grant authority', () => {
  const parsed = parseUserInfo({ sub: USER, preferred_username: 'TheBloke', name: 'Tom', email: 'never-used@example.com', orgs: [
    { sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin', securityRestrictions: 'mfa' },
    { sub: 'not-an-id', roleInOrg: 'admin' },
    { sub: '648323b1ce52171cce6a00ea', preferred_username: 'TheBlokeAI', roleInOrg: 'write', securityRestrictions: [] },
  ] })
  assert.deepEqual(parsed, { subject: USER, username: 'TheBloke', name: 'Tom', orgs: [
    { subject: '648323b1ce52171cce6a00ea', handle: 'TheBlokeAI', role: 'write', restrictions: [], pendingSSO: false, missingMFA: false }] })
  assert.equal(decideModelAuthority(parsed, orgOwner).reason, 'not-member')
  for (const bad of [null, {}, { sub: USER }, { sub: 'x', preferred_username: 'TheBloke' }, { sub: USER, preferred_username: 'bad name' }]) {
    assert.throws(() => parseUserInfo(bad), error => error instanceof HfAuthorityError && error.code === 'HF_SIGN_IN_FAILED')
  }
})

test('configuration: with any of the three variables missing, sign-in is refused cleanly', () => {
  const env = { HF_OAUTH_CLIENT_ID: 'repoing-client', HF_OAUTH_CLIENT_SECRET: 'test-only-hf-secret', HF_OAUTH_REDIRECT_URI: 'https://repo.ing/api/hf/callback' }
  assert.deepEqual(hfOAuthConfig(env), { clientId: 'repoing-client', clientSecret: 'test-only-hf-secret', redirectUri: 'https://repo.ing/api/hf/callback' })
  for (const key of Object.keys(env)) assert.equal(hfOAuthConfig({ ...env, [key]: '' }), null, key)
  for (const redirect of ['http://repo.ing/api/hf/callback', 'https://repo.ing/api/github/callback', 'https://repo.ing/api/hf/callback?x=1', 'not a url']) {
    assert.equal(hfOAuthConfig({ ...env, HF_OAUTH_REDIRECT_URI: redirect }), null, redirect)
  }
  assert.ok(hfOAuthConfig({ ...env, HF_OAUTH_REDIRECT_URI: 'http://localhost:3001/api/hf/callback' }))
  assert.equal(hfOAuthConfig({ ...env, HF_OAUTH_REDIRECT_URI: 'http://localhost:3001/api/hf/callback', NODE_ENV: 'production' }), null)
  assert.throws(() => createHfOAuth({ clientId: 'x', redirectUri: 'https://repo.ing/api/hf/callback' }), error => error.code === 'HF_NOT_CONFIGURED' && error.status === 503)
  assert.equal(hfMarketsEnabled({}), false)
  assert.equal(hfMarketsEnabled({ HF_MARKETS_ENABLED: '1' }), false)
  assert.equal(hfMarketsEnabled({ HF_MARKETS_ENABLED: 'true' }), true)
})

const config = { clientId: 'repoing-client', clientSecret: 'test-only-hf-secret', redirectUri: 'https://repo.ing/api/hf/callback' }

test('the authorization URL: PKCE S256, the three scopes, a fresh state, and the owning organization when known', () => {
  const oauth = createHfOAuth({ ...config, fetchImpl: () => assert.fail('no request') })
  const first = oauth.authorizationUrl(), second = oauth.authorizationUrl({ orgId: ORG })
  const url = new URL(first.url), params = url.searchParams
  assert.equal(`${url.origin}${url.pathname}`, 'https://huggingface.co/oauth/authorize')
  assert.deepEqual(Object.fromEntries(params), { client_id: 'repoing-client', redirect_uri: config.redirectUri, response_type: 'code',
    scope: 'openid profile read-memberships', state: first.state, code_challenge: params.get('code_challenge'), code_challenge_method: 'S256' })
  assert.deepEqual([...HF_OAUTH_SCOPES], ['openid', 'profile', 'read-memberships'])
  assert.match(first.state, /^[0-9a-f]{64}$/)
  assert.match(first.codeVerifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(params.get('code_challenge'), createHash('sha256').update(first.codeVerifier).digest('base64url'))
  assert.notEqual(first.state, second.state); assert.notEqual(first.codeVerifier, second.codeVerifier)
  assert.equal(new URL(second.url).searchParams.get('orgIds'), ORG)
  assert.equal(params.get('orgIds'), null)
  assert.throws(() => oauth.authorizationUrl({ orgId: 'openai-community' }), TypeError)
  const pair = pkcePair()
  assert.equal(pair.challenge, createHash('sha256').update(pair.verifier).digest('base64url'))
})

async function withHub(work) {
  const server = await startFakeHf()
  const exchanges = []
  let token = { access_token: 'hf_oauth_test_only_token_value', token_type: 'Bearer', expires_in: 28800, scope: 'openid profile read-memberships' }
  let info = { sub: USER, preferred_username: 'TheBloke', orgs: [] }
  server.route('/oauth/token', async (url, request) => {
    let body = ''
    for await (const chunk of request) body += chunk
    exchanges.push({ method: request.method, authorization: request.headers.authorization, type: request.headers['content-type'], body: new URLSearchParams(body) })
    return typeof token === 'function' ? token() : { status: 200, headers: {}, body: token }
  })
  server.route('/oauth/userinfo', (url, request) => request.headers.authorization === 'Bearer hf_oauth_test_only_token_value'
    ? { status: 200, headers: {}, body: info } : { status: 401, headers: {}, body: { error: 'invalid_token' } })
  const oauth = createHfOAuth({ ...config, fetchImpl: server.fetchImpl })
  const hf = createHfClient({ fetchImpl: server.fetchImpl, sleep: async () => {} })
  try {
    return await work({ server, oauth, hf, exchanges, setToken: value => { token = value }, setInfo: value => { info = value } })
  } finally { await server.close() }
}

test('the code exchange: state checked first (no request), then PKCE verifier and client secret; tokens capped at an hour', () => withHub(async ({ server, oauth, exchanges, setToken }) => {
  const { state, codeVerifier } = oauth.authorizationUrl()
  for (const bad of [{ state: 'f'.repeat(64) }, { state: undefined }, { codeVerifier: 'short' }, { code: '' }]) {
    await assert.rejects(oauth.exchangeCode({ code: 'abc', state, expectedState: state, codeVerifier, ...bad }), error => error.code === 'HF_STATE_INVALID')
  }
  assert.equal(server.requests.length, 0, 'nothing is sent for a mismatched or malformed callback')
  const before = Date.now()
  const token = await oauth.exchangeCode({ code: 'code-from-hf', state, expectedState: state, codeVerifier })
  assert.equal(token.accessToken, 'hf_oauth_test_only_token_value')
  assert.ok(token.expiresAt >= before + 3_600_000 - 1000 && token.expiresAt <= Date.now() + 3_600_000, 'an 8-hour token is kept for at most an hour')
  const [sent] = exchanges
  assert.equal(sent.method, 'POST')
  assert.equal(sent.authorization, `Basic ${Buffer.from('repoing-client:test-only-hf-secret').toString('base64')}`)
  assert.match(sent.type, /^application\/x-www-form-urlencoded/)
  assert.deepEqual(Object.fromEntries(sent.body), { grant_type: 'authorization_code', code: 'code-from-hf', redirect_uri: config.redirectUri,
    client_id: 'repoing-client', code_verifier: codeVerifier })
  for (const reply of [{ access_token: 'hf_oauth_test_only_token_value', token_type: 'mac' }, { token_type: 'Bearer' },
    { access_token: 'hf_oauth_test_only_token_value', token_type: 'Bearer', scope: 'profile' }]) {
    setToken(reply)
    await assert.rejects(oauth.exchangeCode({ code: 'c', state, expectedState: state, codeVerifier }), error => error.code === 'HF_SIGN_IN_FAILED')
  }
  setToken(() => ({ status: 400, headers: {}, body: { error: 'invalid_grant' } }))
  await assert.rejects(oauth.exchangeCode({ code: 'c', state, expectedState: state, codeVerifier }), error => error.code === 'HF_SIGN_IN_FAILED')
}))

test('userinfo: the access token names the user; a refused token is an expired session', () => withHub(async ({ oauth, setInfo }) => {
  assert.deepEqual(await oauth.userInfo('hf_oauth_test_only_token_value'), { subject: USER, username: 'TheBloke', name: null, orgs: [] })
  await assert.rejects(oauth.userInfo('hf_oauth_revoked_token_value'), error => error.code === 'HF_SESSION_EXPIRED' && error.status === 401)
  await assert.rejects(oauth.userInfo('x'), error => error.code === 'HF_SESSION_EXPIRED')
  setInfo({ sub: 'nope', preferred_username: 'TheBloke' })
  await assert.rejects(oauth.userInfo('hf_oauth_test_only_token_value'), error => error.code === 'HF_SIGN_IN_FAILED')
}))

// The registry (hf_models) and model_verifications, scripted: enough of PostgreSQL for the verifier.
function registry(rows) {
  const statements = [], verifications = []
  return { statements, verifications, rows, async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim()
    statements.push(text)
    if (text.startsWith('select market_ref::text as "marketId", hf_id as "hfId"')) {
      const row = rows.get(params[0])
      return { rows: row ? [{ marketId: params[0], ...row }] : [] }
    }
    if (text.startsWith('update hf_models set repo_path')) {
      const row = rows.get(params[0])
      if (row?.hfId === params[1]) Object.assign(row, { path: params[2], ownerHandle: params[3], ownerKind: params[4], ownerSubject: params[5] })
      return { rows: [] }
    }
    if (text.startsWith('insert into model_verifications')) {
      verifications.push(params)
      return { rows: [{ verifiedAt: new Date() }] }
    }
    throw new Error(`unexpected statement: ${text}`)
  } }
}
const MARKET = String(HF_MARKET)

test('the market model is resolved fresh by its registered _id; a path now serving another model is "moved"', () => withHub(async ({ hf, server }) => {
  const pool = registry(new Map([[MARKET, { hfId: GPT2, path: 'openai-community/gpt2', ownerHandle: 'openai-community', ownerKind: 'org', ownerSubject: null }]]))
  const verifier = createHfVerifier({ pool, hf })
  const resolved = await verifier.resolveMarketModel(MARKET)
  assert.deepEqual(resolved, { marketId: HF_MARKET, hfId: GPT2, path: 'openai-community/gpt2', gated: false, owner: orgOwner })
  assert.deepEqual(server.requests.map(r => r.path), ['/api/models/openai-community/gpt2', '/api/users/openai-community/overview', '/api/organizations/openai-community/overview'])
  assert.equal(pool.rows.get(MARKET).ownerSubject, ORG, 'the confirmed owner is recorded')

  // runwayml/stable-diffusion-v1-5 now redirects to a repository created in 2024: a different _id, never the market's model.
  const moved = registry(new Map([[MARKET, { hfId: RUNWAY_2022, path: 'runwayml/stable-diffusion-v1-5', ownerHandle: 'runwayml', ownerKind: 'org', ownerSubject: null }]]))
  await assert.rejects(createHfVerifier({ pool: moved, hf }).resolveMarketModel(MARKET), error => error.code === 'HF_MODEL_MOVED' && error.status === 409)
  assert.equal(moved.rows.get(MARKET).path, 'runwayml/stable-diffusion-v1-5', 'nothing recorded for another model')
  const gone = registry(new Map([[MARKET, { hfId: GPT2, path: 'openai-community/no-such-model-repoing-x9', ownerHandle: 'openai-community', ownerKind: 'org', ownerSubject: null }]]))
  await assert.rejects(createHfVerifier({ pool: gone, hf }).resolveMarketModel(MARKET), error => error.code === 'HF_MODEL_MOVED')
  const disabled = registry(new Map([[MARKET, { hfId: '6283a9b7806a1feb9fbacf18', path: 'ykilcher/gpt-4chan', ownerHandle: 'ykilcher', ownerKind: 'user', ownerSubject: null }]]))
  await assert.rejects(createHfVerifier({ pool: disabled, hf }).resolveMarketModel(MARKET), error => error.code === 'HF_MODEL_UNAVAILABLE')
  await assert.rejects(createHfVerifier({ pool: registry(new Map()), hf }).resolveMarketModel(MARKET), error => error.code === 'HF_MODEL_UNREGISTERED')
}))

test('"Model moved?": a new URL is accepted only when it is the same model (_id)', () => withHub(async ({ hf, server }) => {
  server.route('/api/organizations/meta-llama/overview', { status: 200, headers: {}, body: { _id: '64aa62fec05da19ca8539776', name: 'meta-llama', fullname: 'Meta Llama', avatarUrl: null } })
  server.route('/api/users/meta-llama/overview', { status: 404, headers: {}, body: { error: 'This user does not exist' } })
  const pool = registry(new Map([[MARKET, { hfId: '66944f1fe0c5c2e493a804f5', path: 'meta-llama/Meta-Llama-3.1-8B', ownerHandle: 'meta-llama', ownerKind: 'org', ownerSubject: null }]]))
  const verifier = createHfVerifier({ pool, hf })
  await assert.rejects(verifier.repoint({ marketId: MARKET, url: 'https://huggingface.co/openai-community/gpt2' }), error => error.code === 'HF_REPOINT_MISMATCH')
  await assert.rejects(verifier.repoint({ marketId: MARKET, url: 'https://huggingface.co/datasets/x/y' }), error => error.code === 'HF_MODEL_INVALID' && error.status === 400)
  assert.equal(pool.rows.get(MARKET).path, 'meta-llama/Meta-Llama-3.1-8B')
  const moved = await verifier.repoint({ marketId: MARKET, url: 'huggingface.co/meta-llama/Llama-3.1-8B' })
  assert.deepEqual([moved.path, moved.previousPath, moved.owner.id], ['meta-llama/Llama-3.1-8B', 'meta-llama/Meta-Llama-3.1-8B', '64aa62fec05da19ca8539776'])
  assert.equal(pool.rows.get(MARKET).path, 'meta-llama/Llama-3.1-8B')
}))

test('the full check: fresh userinfo and owner, a second model read, then a recorded verification', () => withHub(async ({ hf, oauth, setInfo, server }) => {
  const pool = registry(new Map([[MARKET, { hfId: GGUF, path: 'TheBloke/Llama-2-7B-GGUF', ownerHandle: 'TheBloke', ownerKind: 'user', ownerSubject: null }],
    [String(HF_MARKET + 1n), { hfId: GPT2, path: 'openai-community/gpt2', ownerHandle: 'openai-community', ownerKind: 'org', ownerSubject: null }]]))
  const verifier = createHfVerifier({ pool, hf, oauth })
  const check = (marketId = MARKET, extra = {}) => verifier.verifyMarketAuthority({ marketId, accessToken: 'hf_oauth_test_only_token_value', expectedSubject: USER, ...extra })
  const result = await check()
  assert.deepEqual({ ...result, verifiedAt: typeof result.verifiedAt }, { source: 'huggingface', verified: true, permission: 'admin', role: 'owner',
    githubRepoId: HF_MARKET, hfId: GGUF, path: 'TheBloke/Llama-2-7B-GGUF', subject: USER, username: 'TheBloke', ownerSubject: USER, ownerKind: 'user',
    ownerHandle: 'TheBloke', verifiedAt: 'object' })
  assert.deepEqual(pool.verifications, [[MARKET, GGUF, USER, 'TheBloke', 'user', USER, 'owner']])
  assert.equal(server.requests.filter(r => r.path === '/api/models/TheBloke/Llama-2-7B-GGUF').length, 2, 'the model is read again after the decision')

  // Not the owner of an org's model until userinfo shows an unrestricted admin membership of that org.
  await assert.rejects(check(String(HF_MARKET + 1n)), error => error.code === 'HF_NOT_AUTHORIZED' && error.reason === 'not-member' && error.status === 403)
  setInfo({ sub: USER, preferred_username: 'TheBloke', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'write' }] })
  await assert.rejects(check(String(HF_MARKET + 1n)), error => error.reason === 'not-admin')
  setInfo({ sub: USER, preferred_username: 'TheBloke', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin', securityRestrictions: ['sso'] }] })
  await assert.rejects(check(String(HF_MARKET + 1n)), error => error.reason === 'security-restrictions')
  setInfo({ sub: USER, preferred_username: 'TheBloke', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin' }] })
  const admin = await check(String(HF_MARKET + 1n))
  assert.deepEqual([admin.role, admin.ownerSubject, admin.ownerKind], ['admin', ORG, 'org'])
  assert.equal(pool.verifications.length, 2, 'refusals record nothing')
  // A display-only check records nothing.
  await check(MARKET, { record: false, recheck: false })
  assert.equal(pool.verifications.length, 2)
  // The session's user must still be the account signed in.
  await assert.rejects(verifier.verifyMarketAuthority({ marketId: MARKET, accessToken: 'hf_oauth_test_only_token_value', expectedSubject: OTHER_USER }),
    error => error.code === 'HF_SESSION_CHANGED')
}))

test('cross-source: a GitHub id never reaches the Hugging Face verifier, and a model id never reaches GitHub', async () => {
  const calls = []
  const pool = { query: async sql => { calls.push(sql); throw Error('database reached') }, connect: async () => { calls.push('connect'); throw Error('database reached') } }
  const fetchImpl = async url => { calls.push(String(url)); throw Error('network reached') }
  const verifier = createHfVerifier({ pool, hf: createHfClient({ fetchImpl }), oauth: createHfOAuth({ ...config, fetchImpl }) })
  for (const id of [GITHUB_REPO, String(GITHUB_REPO), Number(GITHUB_REPO)]) {
    await assert.rejects(verifier.verifyMarketAuthority({ marketId: id, accessToken: 'hf_oauth_test_only_token_value', expectedSubject: USER }), MarketIdentityError)
    await assert.rejects(verifier.resolveMarketModel(id), MarketIdentityError)
    await assert.rejects(verifier.repoint({ marketId: id, url: 'openai-community/gpt2' }), MarketIdentityError)
  }
  const github = createGitHubAppVerifier({ pool, clientId: 'Iv23test', clientSecret: 'secret', redirectUri: 'https://repo.ing/api/github/callback', fetchImpl })
  for (const id of [HF_MARKET, String(HF_MARKET)]) {
    await assert.rejects(github.verifyAccessToken({ githubRepoId: id, accessToken: 'ghu_test' }), MarketIdentityError)
    await assert.rejects(github.verifyRepositoryAdmin({ githubRepoId: id, accessToken: 'ghu_test' }), MarketIdentityError)
    assert.throws(() => github.authorizationUrl({ githubRepoId: id }), MarketIdentityError)
  }
  // Wallet binding: a Hugging Face authority for a repository, or an incomplete one for a model, is refused before the database.
  const binder = createWalletBinding({ pool }), wallet = Keypair.generate().publicKey.toBase58()
  const authority = { source: 'huggingface', subject: USER, ownerSubject: USER, hfId: GGUF }
  await assert.rejects(binder.requestChallenge({ githubRepoId: GITHUB_REPO, wallet, authority }), /A huggingface authority cannot act for a github market/)
  await assert.rejects(binder.bindWallet({ githubRepoId: GITHUB_REPO, wallet, nonce: 'a'.repeat(48), signature: Buffer.alloc(64), authority }), MarketIdentityError)
  for (const partial of [{ ...authority, ownerSubject: undefined }, { ...authority, hfId: 'gpt2' }, { ...authority, subject: '285551516' }]) {
    await assert.rejects(binder.requestChallenge({ githubRepoId: HF_MARKET, wallet, authority: partial }), /Fresh Hugging Face owner verification required/)
  }
  assert.deepEqual(calls, [])
})

test('the model binding message has its own domain and names the market, the model and the signer', () => {
  const message = modelBindingMessage({ githubRepoId: HF_MARKET, hfId: GGUF, authoritySubject: USER, wallet: '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
    nonce: 'a'.repeat(48), expiresAt: new Date('2026-10-02T12:05:00.000Z') })
  assert.equal(message, ['repo.ing model beneficiary v1', 'I bind this Solana wallet as beneficiary for the Hugging Face model.', 'Chain: Solana',
    `Market ID: ${HF_MARKET}`, `Model ID: ${GGUF}`, `Hugging Face user ID: ${USER}`, 'Wallet: 4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
    `Nonce: ${'a'.repeat(48)}`, 'Expires: 2026-10-02T12:05:00.000Z'].join('\n'))
  assert.ok(!message.startsWith('repo.ing repository beneficiar'), 'never a GitHub binding message')
})

// The claim wiring itself (refusal before any chain read, under the market's lock) is in tests/hf-claims-db.test.mjs.
test('assertBindingAuthority: a model binding counts only for the owner it was made for', () => {
  const binding = { wallet: 'W', authoritySource: 'huggingface', authorityOwnerSubject: USER }
  assert.doesNotThrow(() => assertBindingAuthority(binding, 'huggingface', { ownerSubject: USER }))
  assert.throws(() => assertBindingAuthority(binding, 'huggingface', { ownerSubject: OTHER_USER }), /owner changed since this payout wallet was set/)
  assert.throws(() => assertBindingAuthority({ ...binding, authorityOwnerSubject: null }, 'huggingface', { ownerSubject: USER }), /owner changed/)
  assert.throws(() => assertBindingAuthority({ wallet: 'W', authoritySource: 'github' }, 'huggingface', { ownerSubject: USER }), /authority mismatch/)
  assert.throws(() => assertBindingAuthority(binding, 'github', {}), /authority mismatch/)
  // GitHub bindings are unchanged: rows read before the column existed count as GitHub's.
  assert.doesNotThrow(() => assertBindingAuthority({ wallet: 'W' }, 'github', {}))
  assert.doesNotThrow(() => assertBindingAuthority({ wallet: 'W', authoritySource: 'github' }, 'github', {}))
})

test('a graduated model market is claimable: its sealed review carries includeGraduatedFees through to claimAmounts', async () => {
  const saved = process.env.HF_OAUTH_CLIENT_SECRET
  process.env.HF_OAUTH_CLIENT_SECRET = 'test-only-hf-review-secret'
  try {
    const auth = await import('../app/lib/hf-auth.mjs')
    const session = auth.newHfSession({ subject: USER, username: 'TheBloke', accessToken: 'hf_oauth_test_only_token_value', expiresAt: Date.now() + 600_000,
      mode: 'claim', marketId: HF_MARKET })
    const seal = includeGraduatedFees => auth.readHfClaimReview(auth.sealHfClaimReview(session, { repoId: HF_MARKET, wallet: 'W',
      boundAt: '2026-10-01T00:00:00Z', amount: '1000', paid: '0', includeGraduatedFees }), session)
    const graduated = { dbcFee: 300n, dammFee: 700n, outstanding: 1000n }
    assert.equal(claimAmounts({ ...graduated, review: seal(true) }).payoutAmount, 1000n, 'a graduated market pays its DBC and DAMM fees')
    assert.throws(() => claimAmounts({ ...graduated, review: seal(false) }), /Graduated fees require an updated claim review/)
    assert.equal(claimAmounts({ dbcFee: 1000n, dammFee: 0n, outstanding: 1000n, review: seal(false) }).payoutAmount, 1000n, 'a curve-only market is unaffected')
  } finally { if (saved === undefined) delete process.env.HF_OAUTH_CLIENT_SECRET; else process.env.HF_OAUTH_CLIENT_SECRET = saved }
})

test('the do-not-promote list resolves "hf:" entries to registry ids on the same read, and fails closed with it', async () => {
  const { createPromotionExclusions, excludedModelMarketIds, promotionExcludedModels, promotionExcludedRepoIds } = await import('../app/lib/promotion-exclusions.mjs')
  const env = { PROMOTION_EXCLUDED_REPO_IDS: ` 7, hf:${GPT2}, hf:OpenAI-Community/GPT2, hf:datasets/x, hf:not a path, hf:${GPT2.toUpperCase()}, 8` }
  assert.deepEqual(promotionExcludedModels(env), { ids: [GPT2], paths: ['openai-community/gpt2'] })
  assert.deepEqual([...promotionExcludedRepoIds(env)], ['7', '8'], 'the synchronous GitHub list is unchanged')
  // No query at all without model entries; a database without the registry has none registered.
  assert.deepEqual(await excludedModelMarketIds({ query: () => assert.fail('no query') }, { ids: [], paths: [] }), [])
  const missing = { query: async () => { throw Object.assign(Error('relation "hf_models" does not exist'), { code: '42P01' }) } }
  assert.deepEqual(await excludedModelMarketIds(missing, { ids: [GPT2], paths: [] }), [])
  const asked = []
  const excluded = createPromotionExclusions({ pool: {}, env, read: async () => ['501'], resolveModels: async (pool, models) => { asked.push(models); return [MARKET] } })
  assert.deepEqual([...await excluded()].sort(), ['501', '7', '8', MARKET].sort())
  assert.deepEqual(asked, [{ ids: [GPT2], paths: ['openai-community/gpt2'] }])
  // A failed model resolution is a failed read: with no good list yet, the set is unavailable rather than incomplete.
  const warn = console.warn
  console.warn = () => {}
  try {
    const failing = createPromotionExclusions({ pool: {}, env, read: async () => ['501'], resolveModels: async () => { throw Error('connection refused') } })
    await assert.rejects(failing(), /unavailable/)
  } finally { console.warn = warn }
})

test('Hugging Face cookies: their own key, purpose-bound, at most an hour, and unreadable with the GitHub secret', async () => {
  const saved = { hf: process.env.HF_OAUTH_CLIENT_SECRET, github: process.env.GITHUB_APP_CLIENT_SECRET }
  process.env.HF_OAUTH_CLIENT_SECRET = 'test-only-hf-session-secret'
  process.env.GITHUB_APP_CLIENT_SECRET = 'test-only-hf-session-secret'
  try {
    const auth = await import('../app/lib/hf-auth.mjs')
    const github = await import('../app/lib/auth.mjs')
    const session = auth.newHfSession({ subject: USER, username: 'TheBloke', accessToken: 'hf_oauth_test_only_token_value', expiresAt: Date.now() + 8 * 3600_000,
      mode: 'claim', marketId: HF_MARKET })
    assert.ok(session.expiresAt <= Date.now() + 3600_000, 'capped at an hour whatever the token allows')
    const sealed = auth.encryptHfSession(session)
    assert.deepEqual(auth.readHfSession(sealed), session)
    assert.ok(!sealed.includes('hf_oauth_test_only_token_value'))
    assert.equal(github.readGithubSession(sealed), null, 'a Hugging Face cookie is never a GitHub session, even with the same secret')
    assert.equal(auth.readHfSession(github.encryptGithubSession({ ...session, accessToken: 'ghu_x' })), null)
    assert.equal(auth.readHfState(sealed), null, 'nor an OAuth state')
    const parts = sealed.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
    assert.equal(auth.readHfSession(parts.join('.')), null)
    assert.equal(auth.readHfSession(auth.encryptHfSession({ ...session, expiresAt: Date.now() + 2 * 3600_000 })), null, 'longer than an hour is refused')
    assert.equal(auth.readHfSession(auth.encryptHfSession({ ...session, expiresAt: Date.now() - 1 })), null)
    assert.equal(auth.readHfSession(auth.encryptHfSession({ ...session, mode: 'claim', marketId: null })), null)
    const models = auth.newHfSession({ subject: USER, username: 'TheBloke', accessToken: 'hf_oauth_test_only_token_value', expiresAt: Date.now() + 600_000, mode: 'models' })
    assert.deepEqual(auth.readHfSession(auth.encryptHfSession(models)), models)
    assert.deepEqual(auth.publicHfUser(session), { username: 'TheBloke', expiresAt: session.expiresAt })
    const state = auth.sealHfState({ state: 'a'.repeat(64), codeVerifier: 'v'.repeat(43), mode: 'models', model: 'openai-community/gpt2' })
    assert.deepEqual({ ...auth.readHfState(state), expiresAt: 0 }, { state: 'a'.repeat(64), codeVerifier: 'v'.repeat(43), mode: 'models', marketId: null, model: 'openai-community/gpt2', expiresAt: 0 })
    const review = auth.sealHfClaimReview(session, { repoId: HF_MARKET, wallet: 'W', boundAt: '2026-10-01T00:00:00Z', amount: '5', paid: '0' })
    assert.equal(auth.readHfClaimReview(review, session).wallet, 'W')
    // GCM accepts a truncated tag unless its length is pinned: only the full 16-byte tag (and the 12-byte IV) opens.
    const [v, iv, body, tag] = sealed.split('.')
    for (const bytes of [4, 8, 12, 15]) {
      const short = Buffer.from(tag, 'base64url').subarray(0, bytes).toString('base64url')
      assert.equal(auth.readHfSession([v, iv, body, short].join('.')), null, `a ${bytes}-byte tag`)
    }
    assert.equal(auth.readHfSession([v, Buffer.alloc(16).toString('base64url'), body, tag].join('.')), null, 'a 16-byte IV')
    assert.throws(() => auth.readHfClaimReview(review, { ...session, sessionId: 'b'.repeat(48) }), /review expired/)
    assert.throws(() => auth.readHfClaimReview(review, { ...session, marketId: String(HF_MARKET + 1n) }), /review expired/)
    process.env.HF_OAUTH_CLIENT_SECRET = 'rotated-hf-secret'
    assert.equal(auth.readHfSession(sealed), null, 'rotating the secret ends every session')
  } finally {
    for (const [key, value] of [['HF_OAUTH_CLIENT_SECRET', saved.hf], ['GITHUB_APP_CLIENT_SECRET', saved.github]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})
