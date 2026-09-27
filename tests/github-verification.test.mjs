import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { markets, repoVerifications, repositories } from '../src/db/schema.mjs'
import { createGitHubAppVerifier } from '../src/github-verification.mjs'
import { createCallbackHandler } from '../scripts/github-live-callback.mjs'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_verify'
const pool = new pg.Pool({ connectionString: databaseUrl })
const repoId = 1296269n
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
function githubFixture({ permission = 'admin', returnedRepoId = Number(repoId) } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname
    calls.push({ path, token: options?.headers?.Authorization })
    if (path === '/login/oauth/access_token') {
      const body = JSON.parse(options.body)
      assert.equal(body.client_id, 'Iv1.test')
      assert.equal(body.client_secret, 'test-secret')
      return response(200, { token_type: 'bearer', access_token: 'ghu_fixture_user_token' })
    }
    assert.equal(options.headers.Authorization, 'Bearer ghu_fixture_user_token')
    if (path === '/user') return response(200, { id: 42, login: 'current-admin' })
    if (path === `/repositories/${repoId}`) return response(200, {
      id: returnedRepoId, owner: { login: 'new-owner' }, name: 'renamed-repo', private: false, archived: false,
    })
    if (path === '/repos/new-owner/renamed-repo/collaborators/current-admin/permission') {
      return permission === 'none' ? response(404, {}) : response(200, {
        permission, role_name: permission, user: { id: 42, login: 'current-admin' },
      })
    }
    throw new Error(`Unexpected GitHub endpoint: ${path}`)
  }
  return { fetchImpl, calls }
}

const makeVerifier = fixture => createGitHubAppVerifier({ pool, clientId: 'Iv1.test',
  clientSecret: 'test-secret', redirectUri: 'http://127.0.0.1:3000/github/callback', fetchImpl: fixture.fetchImpl })
const verify = verifier => verifier.verifyCallback({ githubRepoId: repoId, code: 'one-time-code',
  expectedGithubRepoId: repoId, state: 'test-state', expectedState: 'test-state' })

test.before(async () => {
  await pool.query('truncate repo_verifications, fee_events, markets, repositories restart identity cascade')
  const db = drizzle(pool)
  await db.insert(repositories).values({ githubRepoId: repoId, owner: 'old-owner', name: 'old-repo',
    fullName: 'old-owner/old-repo', stars: 0, forks: 0, archived: false, githubUpdatedAt: new Date() })
  await db.insert(markets).values({ githubRepoId: repoId, status: 'confirmed', mint: 'test-mint', pool: 'test-pool',
    launcherWallet: 'test-launcher', creatorWallet: 'test-creator', tokenName: 'Test', tokenSymbol: 'TEST',
    launchSignature: 'test-launch-signature', launchSlot: 1n, launchFinality: 'finalized', indexedAt: new Date(),
    lastVerifiedAt: new Date() })
})
test.after(async () => { await pool.end() })

test('authenticated admin of current repository verifies', async () => {
  const fixture = githubFixture()
  const verifier = makeVerifier(fixture)
  const authorization = verifier.authorizationUrl({ githubRepoId: repoId })
  assert.equal(new URL(authorization.url).searchParams.get('state'), authorization.state)
  assert.equal(authorization.githubRepoId, repoId)
  const result = await verify(verifier)
  assert.equal(result.verified, true)
  assert.equal(result.githubRepoId, repoId)
  assert.equal(result.githubUserId, 42n)
  assert.equal(result.permission, 'admin')
  assert.ok(result.verifiedAt instanceof Date)
  assert.ok(fixture.calls.some(call => call.path === '/repos/new-owner/renamed-repo/collaborators/current-admin/permission'))
  const rows = await drizzle(pool).select().from(repoVerifications)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].githubRepoId, repoId)
  assert.equal(rows[0].githubLogin, 'current-admin')
})

test('authenticated non-admin is rejected without a verification record', async () => {
  const result = await verify(makeVerifier(githubFixture({ permission: 'write' })))
  assert.equal(result.verified, false)
  assert.equal(result.permission, 'write')
  assert.equal((await drizzle(pool).select().from(repoVerifications)).length, 1)
})

test('GitHub authentication alone does not establish repository authority', async () => {
  const fixture = githubFixture({ permission: 'none' })
  const result = await verify(makeVerifier(fixture))
  assert.equal(result.verified, false)
  assert.equal(result.permission, 'none')
  assert.ok(fixture.calls.some(call => call.path === '/user'))
  assert.ok(fixture.calls.some(call => call.path.endsWith('/permission')))
  assert.equal((await drizzle(pool).select().from(repoVerifications)).length, 1)
})

test('verification is bound to the canonical numeric repository ID', async () => {
  const fixture = githubFixture({ returnedRepoId: 777 })
  await assert.rejects(verify(makeVerifier(fixture)), /repository identity could not be confirmed/)
  assert.ok(!fixture.calls.some(call => call.path.endsWith('/permission')))
  await assert.rejects(makeVerifier(fixture).verifyCallback({ githubRepoId: repoId,
    expectedGithubRepoId: 777n, code: 'one-time-code', state: 'test-state', expectedState: 'test-state' }),
  /OAuth repository ID is invalid/)
  assert.equal((await drizzle(pool).select().from(repoVerifications)).length, 1)
})

test('local callback passes the one-time code to verification and returns only the decision', async () => {
  const calls = []
  const verifier = { verifyCallback: async args => {
    calls.push(args)
    return { githubRepoId: repoId, githubUserId: 42n, githubLogin: 'current-admin',
      permission: 'admin', verified: true }
  } }
  const server = http.createServer(createCallbackHandler({ verifier, githubRepoId: repoId, expectedState: 'saved-state' }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const missing = await fetch(`${base}/api/github/callback`)
    assert.equal(missing.status, 400)
    const accepted = await fetch(`${base}/api/github/callback?code=one-time-code&state=saved-state`)
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { githubRepoId: repoId.toString(), githubUserId: '42',
      githubLogin: 'current-admin', permission: 'admin', adminAccepted: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].code, 'one-time-code')
    assert.equal(calls[0].expectedState, 'saved-state')
    const replay = await fetch(`${base}/api/github/callback?code=one-time-code&state=saved-state`)
    assert.equal(replay.status, 400)
  } finally { server.close() }
})


test('retained session checks current authority without another OAuth exchange', async () => {
  const fixture = githubFixture()
  const verifier = makeVerifier(fixture)
  const saved = await verifier.verifyCallback({ githubRepoId: repoId, expectedGithubRepoId: repoId,
    code: 'one-time-code', state: 's', expectedState: 's', retainCredential: true })
  assert.equal(saved.accessToken, 'ghu_fixture_user_token')
  assert.ok(saved.accessTokenExpiresAt <= Date.now() + 3600_000)
  const before = fixture.calls.length
  const checked = await verifier.verifyAccessToken({ githubRepoId: repoId, accessToken: saved.accessToken, expectedGithubUserId: 42 })
  assert.equal(checked.verified, true)
  assert.ok(!fixture.calls.slice(before).some(call => call.path === '/login/oauth/access_token'))
  assert.equal(fixture.calls.slice(before).filter(call => call.path === `/repositories/${repoId}`).length, 2)
  assert.equal(checked.accessToken, undefined)
  const revoked = await makeVerifier(githubFixture({ permission: 'write' })).verifyAccessToken({
    githubRepoId: repoId, accessToken: saved.accessToken, expectedGithubUserId: 42 })
  assert.equal(revoked.verified, false)
  await assert.rejects(verifier.verifyAccessToken({ githubRepoId: repoId, accessToken: saved.accessToken, expectedGithubUserId: 999 }), /identity changed/)
  await assert.rejects(makeVerifier({ fetchImpl: async () => response(401, {}) }).verifyAccessToken({
    githubRepoId: repoId, accessToken: saved.accessToken, expectedGithubUserId: 42 }), /could not be resolved/)
})
