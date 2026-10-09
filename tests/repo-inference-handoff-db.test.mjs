import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { HANDOFF_REFUSED, assertionMessage, createHandoff, redeemHandoff } from '../src/repo-inference-handoff.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// The route modules import next/server the way Next resolves it (tests/fixtures/jsx-hooks.mjs).
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))

// The repo.ing AI credits sign-in handoff on real PostgreSQL (src/repo-inference-handoff.mjs): migration 0062, single-use
// codes with PKCE, and the start, approve and token routes, with GitHub's answers scripted (no network).
const DATABASE = 'repoing_handoff_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DATABASE}`
const CLIENT = 'handoff-client-secret-for-tests-only-0123', ASSERT = 'handoff-assertion-secret-for-tests-only-01'
const verifier = () => randomBytes(32).toString('base64url')
const challengeOf = value => createHash('sha256').update(value).digest('base64url')
const request = (extra = {}) => ({ audience: 'repo-inference', repoId: '77', challenge: challengeOf('v'.repeat(43)), port: 54321, state: 's'.repeat(22), ...extra })

test('the repo.ing AI credits handoff on PostgreSQL: migration 0062, single-use codes, the routes', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DATABASE}$`), 'postgres') })
  let pool
  const saved = { env: { ...process.env }, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  try {
    await admin.query(`drop database if exists ${DATABASE}`)
    await admin.query(`create database ${DATABASE}`)
    pool = new pg.Pool({ connectionString: URL_, max: 6 })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    for (const statement of (await readFile('drizzle/0062_auth_handoffs.sql', 'utf8')).split('--> statement-breakpoint')) await pool.query(statement)
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values (77,'octo','widget','octo/widget',5,0,false,now())`)
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at)
      values (77,'confirmed','MintWidget','PoolWidget','L','C','Widget','WIDGET','Sig',1,'finalized',now(),now())`)
    const settings = { clientSecret: CLIENT, assertionSecret: ASSERT }

    await t.test('a code is redeemed once, with the verifier that matches its challenge, and the assertion is signed', async () => {
      const v = verifier()
      const { code, handoffId } = await createHandoff(pool, { request: request({ challenge: challengeOf(v) }), githubUserId: '583231', login: 'octocat' })
      const { rows: [row] } = await pool.query('select code_hash, expires_at - created_at as ttl from auth_handoffs where handoff_id=$1', [handoffId])
      assert.equal(row.code_hash, createHash('sha256').update(code).digest('hex'), 'only the hash is stored')
      assert.equal(row.ttl.minutes, 3)
      const assertion = await redeemHandoff(pool, { audience: 'repo-inference', code, codeVerifier: v }, settings)
      assert.deepEqual({ ...assertion, verified_at: undefined, signature: undefined }, { audience: 'repo-inference', handoff_id: handoffId, github_user_id: '583231',
        login: 'octocat', repo_id: '77', permission: 'admin', verified_at: undefined, signature: undefined })
      const message = assertionMessage({ handoffId, githubUserId: '583231', login: 'octocat', repoId: '77', permission: 'admin', verifiedAt: assertion.verified_at })
      assert.equal(assertion.signature, createHmac('sha256', ASSERT).update(message).digest('hex'))
      assert.equal(await redeemHandoff(pool, { audience: 'repo-inference', code, codeVerifier: v }, settings), null, 'used')
      // A wrong verifier consumes the code: the right one cannot follow.
      const w = verifier(), second = await createHandoff(pool, { request: request({ challenge: challengeOf(w) }), githubUserId: '583231', login: 'octocat' })
      assert.equal(await redeemHandoff(pool, { audience: 'repo-inference', code: second.code, codeVerifier: verifier() }, settings), null)
      assert.equal(await redeemHandoff(pool, { audience: 'repo-inference', code: second.code, codeVerifier: w }, settings), null)
      // Expired, another audience, malformed: nothing.
      const x = verifier(), third = await createHandoff(pool, { request: request({ challenge: challengeOf(x) }), githubUserId: '583231', login: 'octocat' })
      await pool.query(`update auth_handoffs set created_at=now()-interval '5 minutes', expires_at=now()-interval '1 second' where handoff_id=$1`, [third.handoffId])
      assert.equal(await redeemHandoff(pool, { audience: 'repo-inference', code: third.code, codeVerifier: x }, settings), null, 'expired')
      assert.equal(await redeemHandoff(pool, { audience: 'other', code: third.code, codeVerifier: x }, settings), null)
      assert.equal(await redeemHandoff(pool, { audience: 'repo-inference', code: 'short', codeVerifier: x }, settings), null)
      await assert.rejects(pool.query(`insert into auth_handoffs(handoff_id,code_hash,audience,github_repo_id,github_user_id,github_login,code_challenge,verified_at,expires_at)
        values('AbCdEfGhIjKlMnOpQrStUvWx',repeat('a',64),'repo-inference',77,1,'x',repeat('c',43),now(),now()+interval '11 minutes')`), /auth_handoffs_expiry_check/)
    })

    // The routes, with the configured secrets and GitHub scripted.
    Object.assign(process.env, { DATABASE_URL: URL_, GITHUB_APP_CLIENT_ID: 'Iv1.test-only', GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex'),
      APP_ORIGIN: 'https://repo.ing', REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: CLIENT, HANDOFF_ASSERTION_SECRET: ASSERT })
    globalThis.__gitfunPool = pool
    let permission = 'admin'
    const calls = []
    globalThis.fetch = async input => {
      const target = new URL(String(input))
      calls.push(target.pathname)
      const body = target.pathname === '/user' ? { id: 583231, login: 'octocat' }
        : target.pathname === '/repositories/77' ? { id: 77, owner: { login: 'octo' }, name: 'widget', private: false, archived: false }
          : target.pathname === '/repos/octo/widget/collaborators/octocat/permission' ? { permission, user: { id: 583231 } } : null
      return body ? Response.json(body) : new Response('not found', { status: 404 })
    }
    const { NextRequest } = await import('next/server')
    const { encryptGithubSession, githubSessionCookie } = await import('../app/lib/auth.mjs')
    const { HANDOFF_COOKIE, sealConsent, sealHandoffRequest } = await import('../app/lib/handoff.mjs')
    const callback = (await import('../app/api/github/callback/route.js')).GET
    const start = (await import('../app/api/handoff/start/route.js')).GET
    const approve = (await import('../app/api/handoff/approve/route.js')).POST
    const token = (await import('../app/api/handoff/token/route.js')).POST
    const buildersSession = { scope: 'builders', repoId: null, permission: 'identity', githubUserId: '583231', githubLogin: 'octocat',
      accessToken: 'ghu_test_only', sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 }
    const builders = encryptGithubSession(buildersSession)
    const redeem = (body, authorization = `Bearer ${CLIENT}`) => token(new NextRequest('https://repo.ing/api/handoff/token', { method: 'POST',
      headers: { authorization, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }))

    await t.test('start keeps the request in a sealed cookie and signs the builder in (or goes to the consent page)', async () => {
      const query = new URLSearchParams({ audience: 'repo-inference', repo: '77', challenge: challengeOf('v'.repeat(43)), port: '54321', state: 's'.repeat(22) })
      const fresh = await start(new NextRequest(`https://repo.ing/api/handoff/start?${query}`))
      assert.equal(new URL(fresh.headers.get('location')).pathname + new URL(fresh.headers.get('location')).search, '/api/github/start?mode=handoff')
      assert.ok(fresh.cookies.get(HANDOFF_COOKIE)?.value)
      assert.equal(fresh.headers.get('cache-control'), 'no-store')
      const signedIn = await start(new NextRequest(`https://repo.ing/api/handoff/start?${query}`, { headers: { cookie: `${githubSessionCookie}=${builders}` } }))
      assert.equal(new URL(signedIn.headers.get('location')).pathname, '/handoff')
      const bad = await start(new NextRequest(`https://repo.ing/api/handoff/start?${query.toString().replace('54321', '80')}`))
      assert.equal(bad.status, 400)
    })

    await t.test('approve: same origin only; deny or approve goes back to the CLI with the state; approve checks admin live', async () => {
      const v = verifier(), shown = request({ challenge: challengeOf(v) }), cookie = sealHandoffRequest(shown)
      const consent = sealConsent(shown, buildersSession)
      const post = (decision, { origin = 'https://repo.ing', session = builders, handoff = cookie, seal = consent } = {}) => approve(new NextRequest('https://repo.ing/api/handoff/approve', {
        method: 'POST', body: new URLSearchParams({ decision, ...seal ? { consent: seal } : {} }), headers: { origin, 'content-type': 'application/x-www-form-urlencoded',
          cookie: [handoff && `${HANDOFF_COOKIE}=${handoff}`, session && `${githubSessionCookie}=${session}`].filter(Boolean).join('; ') } }))
      assert.equal((await post('approve', { origin: 'https://evil.example' })).status, 403)
      const noRequest = await post('approve', { handoff: null })
      assert.deepEqual([noRequest.status, new URL(noRequest.headers.get('location')).pathname], [303, '/handoff'])
      const denied = await post('deny')
      assert.equal(denied.headers.get('location'), `http://127.0.0.1:54321/callback?error=access_denied&state=${'s'.repeat(22)}`)
      const noSession = await post('approve', { session: null })
      assert.equal(new URL(noSession.headers.get('location')).pathname, '/handoff')
      // Only the request the page showed, to this session: no consent, another request (swapped in by another tab), another
      // session: back to the page, and no code is made.
      const swapped = sealConsent(request({ challenge: challengeOf(verifier()) }), buildersSession)
      const otherSession = sealConsent(shown, { ...buildersSession, sessionId: randomBytes(24).toString('hex') })
      for (const seal of [null, swapped, otherSession, 'not-sealed']) {
        const refused = await post('approve', { seal })
        assert.deepEqual([refused.status, new URL(refused.headers.get('location')).pathname], [303, '/handoff'], String(seal))
      }
      const { rows: [{ made }] } = await pool.query(`select count(*)::int as made from auth_handoffs where code_challenge=$1`, [shown.challenge])
      assert.equal(made, 0)
      permission = 'write'
      const writer = await post('approve')
      assert.equal(writer.headers.get('location'), `http://127.0.0.1:54321/callback?error=not_admin&state=${'s'.repeat(22)}`)
      assert.ok(calls.includes('/repos/octo/widget/collaborators/octocat/permission'))
      permission = 'admin'
      const approved = await post('approve')
      const back = new URL(approved.headers.get('location'))
      assert.deepEqual([approved.status, back.origin, back.pathname, back.searchParams.get('state')], [303, 'http://127.0.0.1:54321', '/callback', 's'.repeat(22)])
      assert.equal(approved.cookies.get(HANDOFF_COOKIE)?.value, '', 'the request is spent')
      // The credit service redeems the code with the CLI's verifier and its client secret.
      const code = back.searchParams.get('code')
      assert.equal((await redeem({ audience: 'repo-inference', code, code_verifier: v }, `Bearer ${ASSERT}`)).status, 401)
      const ok = await redeem({ audience: 'repo-inference', code, code_verifier: v })
      assert.equal(ok.status, 200)
      const assertion = await ok.json()
      assert.deepEqual([assertion.login, assertion.repo_id, assertion.github_user_id, assertion.permission], ['octocat', '77', '583231', 'admin'])
      assert.equal(ok.headers.get('cache-control'), 'no-store')
      const again = await redeem({ audience: 'repo-inference', code, code_verifier: v })
      assert.deepEqual([again.status, (await again.json()).error], [410, HANDOFF_REFUSED])
      assert.equal((await redeem('{bad')).status, 400)
      assert.equal((await redeem('x'.repeat(3000))).status, 413)
    })

    await t.test('the GitHub callback never takes a sealed handoff request for its OAuth state', async () => {
      const planted = await callback(new NextRequest('https://repo.ing/api/github/callback?code=x&state=y', { headers: { cookie: `gitfun_oauth=${sealHandoffRequest(request())}` } }))
      assert.equal(new URL(planted.headers.get('location')).pathname, '/explore')
    })

    await t.test('dark: every route answers 404 without the handoff secrets', async () => {
      delete process.env.HANDOFF_ASSERTION_SECRET
      assert.equal((await redeem({})).status, 404)
      assert.equal((await start(new NextRequest('https://repo.ing/api/handoff/start'))).status, 404)
      assert.equal((await approve(new NextRequest('https://repo.ing/api/handoff/approve', { method: 'POST' }))).status, 404)
      process.env.HANDOFF_ASSERTION_SECRET = CLIENT
      assert.equal((await redeem({})).status, 404, 'the same secret twice is refused')
      process.env.HANDOFF_ASSERTION_SECRET = ASSERT
    })

    await t.test('dark: every route answers 404 with the secrets set while the switch is off', async () => {
      const query = new URLSearchParams({ audience: 'repo-inference', repo: '77', challenge: challengeOf('v'.repeat(43)), port: '54321', state: 's'.repeat(22) })
      const startNow = () => start(new NextRequest(`https://repo.ing/api/handoff/start?${query}`))
      for (const enabled of [undefined, 'false', 'TRUE']) {
        if (enabled === undefined) delete process.env.REPO_INFERENCE_HANDOFF_ENABLED
        else process.env.REPO_INFERENCE_HANDOFF_ENABLED = enabled
        assert.equal((await redeem({})).status, 404, String(enabled))
        assert.equal((await startNow()).status, 404, String(enabled))
        assert.equal((await approve(new NextRequest('https://repo.ing/api/handoff/approve', { method: 'POST' }))).status, 404, String(enabled))
      }
      process.env.REPO_INFERENCE_HANDOFF_ENABLED = 'true'
      assert.equal((await startNow()).status, 307, 'the same request starts the sign-in once the switch is on')
    })
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key]
    Object.assign(process.env, saved.env)
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
    await pool?.end()
    await dropTestDatabase(admin, DATABASE)
    await admin.end()
  }
})
