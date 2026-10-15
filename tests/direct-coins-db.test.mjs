import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { directCoinDrafts } from '../src/direct-coin-drafts.mjs'
import { defaultDirectPlan } from '../src/direct-coins.mjs'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import { GET, POST } from '../app/api/direct-coins/route.js'

const url = process.env.DIRECT_COINS_TEST_DATABASE_URL
test('PostgreSQL: private versioned drafts, concurrent edits, atomic audit and retention', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/repoing_direct_coins_test', 'Disposable database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await pool.query('truncate direct_coin_events, direct_coin_drafts restart identity cascade')
    const store = directCoinDrafts(pool), plan = { ...defaultDirectPlan(), name: 'First', symbol: 'ONE' }
    const draft = await store.save('501', { action: 'save', plan })
    assert.equal(draft.revision, 1)
    assert.deepEqual(await store.list('502'), { drafts: [], events: [] })
    await assert.rejects(store.save('502', { action: 'save', plan, id: draft.id, revision: 1 }), { status: 409 })
    const edits = await Promise.allSettled(['Second', 'Third'].map(name => store.save('501', { action: 'save', plan: { ...plan, name }, id: draft.id, revision: 1 })))
    assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(edits.find(r => r.status === 'rejected').reason.status, 409)
    const saved = await store.list('501')
    assert.equal(saved.drafts[0].revision, 2)
    assert.equal(saved.events.length, 2)
    assert.notEqual(saved.events[0].plan_hash, saved.events[1].plan_hash)
    assert.equal(saved.events[0].revision, 2)
    await store.recordInspection('501', plan, 'refused')
    assert.equal((await store.list('501')).events[0].outcome, 'refused')
    // Failed audit insertion must roll back the draft update too.
    await pool.query(`alter table direct_coin_events add constraint direct_test_refuse check (action <> 'save') not valid`)
    await assert.rejects(store.save('501', { action: 'save', plan: { ...plan, name: 'Must rollback' }, id: draft.id, revision: 2 }))
    assert.equal((await store.list('501')).drafts[0].revision, 2)
    await pool.query('alter table direct_coin_events drop constraint direct_test_refuse')
    await pool.query(`update direct_coin_drafts set updated_at=now()-interval '31 days'; update direct_coin_events set created_at=now()-interval '31 days'`)
    assert.deepEqual(await store.list('501'), { drafts: [], events: [] })
    await store.save('501', { action: 'save', plan })
    assert.equal((await store.list('501')).drafts.length, 1)
    assert.equal((await pool.query('select count(*)::int as n from direct_coin_events')).rows[0].n, 1)
    const native = { ...defaultDirectPlan('programmable'), name: 'Native', symbol: 'NATIVE', recipe: 'kit', creatorFeeBps: 137, kitMaxWalletBps: 850 }
    await store.save('502', { action: 'save', plan: native })
    const nativeSaved = await store.list('502')
    assert.deepEqual(nativeSaved.drafts[0].plan, native)
    assert.equal(nativeSaved.events[0].adapter, 'hooklab')
    assert.equal(nativeSaved.events[0].outcome, 'saved')
  } finally { await pool.end() }
})

test('API: authenticated drafts, CSRF, payload limits, network refusals and no send action', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/repoing_direct_coins_test')
  const keys = ['DATABASE_URL', 'GITHUB_APP_CLIENT_SECRET', 'APP_ORIGIN']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { DATABASE_URL: url, GITHUB_APP_CLIENT_SECRET: 'disposable-direct-coin-test', APP_ORIGIN: 'https://repo.ing' })
  const session = owner => encryptGithubSession({ scope: 'builders', permission: 'identity', repoId: null, githubUserId: owner,
    githubLogin: 'test', accessToken: 'ghu_test_only', sessionId: 'b'.repeat(48), expiresAt: Date.now() + 60_000 })
  const request = (body, { owner = '701', origin = 'https://repo.ing' } = {}) => {
    const req = new Request('https://repo.ing/api/direct-coins', { method: body ? 'POST' : 'GET',
      headers: { origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    req.cookies = { get: () => owner ? { value: session(owner) } : undefined }
    return req
  }
  try {
    const plan = defaultDirectPlan()
    assert.equal((await POST(request({ action: 'save', plan }, { owner: null }))).status, 401)
    assert.equal((await POST(request({ action: 'save', plan }, { origin: 'https://evil.invalid' }))).status, 403)
    assert.equal((await POST(request({ action: 'send', plan }))).status, 400)
    assert.equal((await POST(request({ action: 'save', plan, extra: 'x'.repeat(5000) }))).status, 400)
    const saved = await POST(request({ action: 'save', plan }))
    assert.equal(saved.status, 200)
    const { draft } = await saved.json()
    assert.equal((await POST(request({ action: 'save', plan, id: draft.id, revision: draft.revision }, { owner: '702' }))).status, 409)
    const denied = await POST(request({ action: 'inspect', plan: { ...plan, network: 'mainnet-beta' }, confirmedNetwork: 'devnet' }))
    assert.equal(denied.status, 422)
    const own = await GET(request())
    assert.equal(own.headers.get('Cache-Control'), 'private, no-store')
    assert.ok((await own.json()).events.some(e => e.outcome === 'refused'))
    assert.equal((await (await GET(request(null, { owner: '702' }))).json()).drafts.length, 0)
  } finally {
    await globalThis.__gitfunPool?.end(); delete globalThis.__gitfunPool
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
  }
})
