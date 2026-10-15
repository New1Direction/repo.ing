import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { hookLabRecipeDrafts } from '../src/hook-lab-recipe-drafts.mjs'
import { createHookLabRecipe, serializeHookLabRecipe, importHookLabRecipe, exportHookLabRecipe,
  resumeHookLabRecipe, saveHookLabRecipe, loadHookLabRecipe, hookLabRecipeSaveSchema } from '../src/hook-lab-recipe.mjs'
import { recipeCases, memoryStorage } from './fixtures/hook-lab-recipes.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Never reads DATABASE_URL or targets an existing application database.
// Uses the CI runner's disposable PostgreSQL, with a uniquely named test DB.
test('PostgreSQL: six-template transport round trips, retries, ownership, conflicts, audit atomicity and expiry', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config)
  const database = `hook_lab_recipe_test_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    const sql = await readFile(new URL('../drizzle/0077_hook_lab_recipes.sql', import.meta.url), 'utf8')
    await pool.query(sql)
    await pool.query(sql) // Adoption DDL can be reapplied without deleting data.
    const store = hookLabRecipeDrafts(pool), owner = '101', other = '202'
    const ids = []
    for (const [template, raw] of recipeCases) {
      const storage = memoryStorage(), id = randomUUID(); ids.push(id)
      saveHookLabRecipe(storage, createHookLabRecipe(raw, template))
      const envelope = loadHookLabRecipe(storage)
      const request = JSON.parse(JSON.stringify({ id, revision: 0, envelope }))
      assert.deepEqual(hookLabRecipeSaveSchema.parse(request), request)
      const saved = await store.save(owner, request)
      const replay = await store.save(owner, request)
      assert.deepEqual(replay, saved)
      assert.equal(saved.revision, 1)
      const resumed = JSON.parse(JSON.stringify(saved)).envelope
      assert.deepEqual(resumed, envelope)
      assert.deepEqual(resumeHookLabRecipe(importHookLabRecipe(exportHookLabRecipe(resumed))), raw)
      const storedText = (await pool.query('select envelope from hook_lab_recipe_drafts where id=$1', [id])).rows[0].envelope
      assert.equal(storedText, serializeHookLabRecipe(envelope))
    }
    const initial = await store.list(owner)
    assert.equal(initial.drafts.length, 6)
    assert.equal(initial.events.length, 6)
    for (const event of initial.events) assert.deepEqual(event.envelope, initial.drafts.find(d => d.id === event.draft_id).envelope)
    assert.deepEqual(await store.list(other), { drafts: [], events: [] })
    const first = initial.drafts.find(d => d.id === ids[0])
    await assert.rejects(store.save(other, { id: first.id, revision: 0, envelope: first.envelope }), { status: 409 })
    await assert.rejects(store.save(other, { id: first.id, revision: 1, envelope: first.envelope }), { status: 409 })
    assert.deepEqual(await store.list(owner), initial)

    // Preserve null, absent, explicit zero, opaque fields and >4096 bytes in DB/audit.
    const changed = structuredClone(first.envelope)
    changed.recipe.blocks.push({ type: 'future_rule', missingIsAbsent: null, explicitZero: 0, nested: { data: ['🪙\u0000\ud800', false] } })
    changed.recipe.blocks.push(JSON.parse('{"type":"extension","__proto__":{"enabled":true}}'))
    changed.recipe.coin.description = '界'.repeat(2000)
    const update = { id: first.id, revision: 1, envelope: changed }
    const concurrent = await Promise.all([store.save(owner, update), store.save(owner, update)])
    assert.deepEqual(concurrent[0], concurrent[1])
    assert.equal(concurrent[0].revision, 2)
    assert.deepEqual(concurrent[0].envelope, changed)
    const after = await store.list(owner)
    assert.equal(after.events.length, 7)
    assert.deepEqual(after.events.find(e => e.draft_id === first.id && e.revision === 1).envelope, first.envelope)
    assert.deepEqual(after.events.find(e => e.draft_id === first.id && e.revision === 2).envelope, changed)
    await assert.rejects(store.save(owner, { id: first.id, revision: 1, envelope: first.envelope }), { status: 409 })
    const competing = [101, 202].map(fee_bps => {
      const envelope = structuredClone(changed); envelope.recipe.blocks[0].fee_bps = fee_bps
      return store.save(owner, { id: first.id, revision: 2, envelope })
    })
    const outcomes = await Promise.allSettled(competing)
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(outcomes.find(r => r.status === 'rejected').reason.status, 409)
    const winner = outcomes.find(r => r.status === 'fulfilled').value
    assert.deepEqual((await store.list(owner)).drafts.find(d => d.id === first.id), winner)

    // Audit failure cannot commit the draft update. This check is test-local only.
    await pool.query('alter table hook_lab_recipe_events add constraint fixture_failure check (revision < 4)')
    await assert.rejects(store.save(owner, { id: first.id, revision: 3, envelope: first.envelope }), /fixture_failure/)
    assert.deepEqual((await store.list(owner)).drafts.find(d => d.id === first.id), winner)
    await pool.query('alter table hook_lab_recipe_events drop constraint fixture_failure')

    for (let i = 0; i < 4; i++) await store.save(owner, { id: randomUUID(), revision: 0, envelope: first.envelope })
    await assert.rejects(store.save(owner, { id: randomUUID(), revision: 0, envelope: first.envelope }), /Ten saved/)
    await store.save(other, { id: randomUUID(), revision: 0, envelope: first.envelope })
    const otherBefore = await store.list(other)
    await pool.query(`update hook_lab_recipe_drafts set updated_at=now() - interval '31 days' where id=$1`, [first.id])
    assert.equal((await store.list(owner)).drafts.length, 9)
    await assert.rejects(store.save(owner, { id: first.id, revision: 3, envelope: first.envelope }), { status: 409 })
    await pool.query(`update hook_lab_recipe_events set created_at=now() - interval '31 days' where draft_id=$1`, [ids[1]])
    await store.save(owner, { id: randomUUID(), revision: 0, envelope: first.envelope })
    assert.equal((await store.list(owner)).drafts.length, 10)
    assert.equal((await pool.query('select id from hook_lab_recipe_events where draft_id=any($1::uuid[])', [[first.id, ids[1]]])).rows.length, 0)
    assert.deepEqual(await store.list(other), otherBefore)

    // Rejections happen before changing any draft or audit event.
    const beforeInvalid = await store.list(owner)
    for (const request of [
      { id: ids[2], revision: 1, envelope: { ...first.envelope, schemaVersion: 'future' } },
      { id: ids[2], revision: 1, envelope: first.envelope, wallet: 'not-authority' },
    ]) await assert.rejects(store.save(owner, request))
    assert.deepEqual(await store.list(owner), beforeInvalid)
    // Simulate a newer writer. This older reader must not narrow or overwrite it.
    const futureId = randomUUID(), future = JSON.stringify({ ...first.envelope, schemaVersion: 'future' })
    await pool.query('insert into hook_lab_recipe_drafts(id,github_user_id,revision,envelope) values($1,202,1,$2)', [futureId, future])
    await assert.rejects(store.list(other))
    await assert.rejects(store.save(other, { id: futureId, revision: 1, envelope: first.envelope }))
    assert.equal((await pool.query('select envelope from hook_lab_recipe_drafts where id=$1', [futureId])).rows[0].envelope, future)
    await assert.rejects(pool.query('insert into hook_lab_recipe_drafts(id,github_user_id,revision,envelope) values($1,101,1,$2)',
      [randomUUID(), '[]']), /check constraint/)
  } finally {
    if (pool) { await pool.end(); await dropTestDatabase(admin, database) }
    await admin.end()
  }
})

test('authenticated API saves and resumes all six complete recipes through the registered migration', async () => {
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { migrate } = await import('drizzle-orm/node-postgres/migrator')
  const { encryptGithubSession } = await import('../app/lib/auth.mjs')
  const { GET, POST } = await import('../app/api/hook-lab/route.js')
  const admin = new pg.Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' })
  const database = `hook_lab_api_test_${randomUUID().replaceAll('-', '')}`
  const keys = ['DATABASE_URL', 'GITHUB_APP_CLIENT_SECRET', 'APP_ORIGIN']
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  let pool
  try {
    await admin.query(`create database ${database}`)
    const url = `postgres://postgres:launchtest@127.0.0.1:55432/${database}`
    pool = new pg.Pool({ connectionString: url })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    Object.assign(process.env, { DATABASE_URL: url, GITHUB_APP_CLIENT_SECRET: randomUUID(), APP_ORIGIN: 'https://repo.ing' })
    const request = (body, owner = '501') => {
      const req = new Request('https://repo.ing/api/hook-lab', { method: body ? 'POST' : 'GET', headers: { origin: 'https://repo.ing', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      req.cookies = { get: () => ({ value: encryptGithubSession({ scope: 'builders', permission: 'identity', repoId: null,
        githubUserId: owner, githubLogin: 'fixture', accessToken: 'ghu_fixture_only', sessionId: 'c'.repeat(48), expiresAt: Date.now() + 60000 }) }) }
      return req
    }
    for (const [template, raw] of recipeCases) {
      const envelope = createHookLabRecipe(raw, template), id = randomUUID()
      const body = { action: 'save', id, revision: 0, envelopeText: serializeHookLabRecipe(envelope) }
      const response = await POST(request(body))
      assert.equal(response.status, 200)
      const { draft } = await response.json()
      assert.deepEqual(draft.envelope, envelope)
      assert.deepEqual((await (await POST(request(body))).json()).draft, draft)
      assert.equal((await POST(request({ ...body, revision: 1 }, '502'))).status, 409)
    }
    const own = await (await GET(request())).json()
    assert.equal(own.drafts.length, 6); assert.equal(own.events.length, 6)
    assert.deepEqual(own.drafts.map(d => d.envelope.template).sort(), recipeCases.map(([t]) => t).sort())
    assert.deepEqual((await (await GET(request(null, '502'))).json()).drafts, [])
  } finally {
    await globalThis.__gitfunPool?.end(); delete globalThis.__gitfunPool
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})

test('production collection migration does not strand Hook Lab recipes or alter recorded collections', async () => {
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { migrate } = await import('drizzle-orm/node-postgres/migrator')
  const { mkdtemp, cp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const admin = new pg.Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' })
  const database = `hook_lab_forward_${randomUUID().replaceAll('-', '')}`
  const folder = await mkdtemp(join(tmpdir(), 'hook-lab-forward-'))
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database })
    await cp('drizzle', join(folder, 'drizzle'), { recursive: true })
    const journalPath = join(folder, 'drizzle/meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter(e => e.idx <= 76) }))
    await migrate(drizzle(pool), { migrationsFolder: join(folder, 'drizzle') })
    await pool.query(await readFile('drizzle/0078_builder_fee_collections.sql', 'utf8'))
    await pool.query(`insert into drizzle.__drizzle_migrations(hash,created_at)
      values('16f99c5629efa80cf599fdb1116fb5b25cbd504c8f4df151beb65d8a89dc8663',1792063200000)`)
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
      values(99881,'fixture','preserved','fixture/preserved',0,0,false,now())`)
    await pool.query(`insert into builder_fee_collections
      (id,github_repo_id,mint,pool,wallet,amount,status,terms,terms_hash,expires_at,signature,signed_transaction,last_valid_block_height,receipt,settled_at)
      values('00000000-0000-0000-0000-000000099881',99881,'mint','pool','wallet',123,'settled','{}',repeat('a',64),now(),'historical-collection','fixture',123,'{}',now())`)
    const before = (await pool.query('select * from builder_fee_collections')).rows
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    const store = hookLabRecipeDrafts(pool), [template, raw] = recipeCases[0]
    const saved = await store.save('101', { id: randomUUID(), revision: 0, envelope: createHookLabRecipe(raw, template) })
    assert.deepEqual((await store.list('101')).drafts, [saved])
    assert.equal((await store.list('101')).events[0].revision, saved.revision)
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    assert.deepEqual((await pool.query('select * from builder_fee_collections')).rows, before)
    assert.equal((await pool.query(`select count(*)::int as n from drizzle.__drizzle_migrations
      where hash='16f99c5629efa80cf599fdb1116fb5b25cbd504c8f4df151beb65d8a89dc8663' and created_at=1792063200000`)).rows[0].n, 1)
    assert.deepEqual((await store.list('101')).drafts, [saved])
  } finally {
    if (pool) { await pool.end(); await dropTestDatabase(admin, database) }
    await admin.end()
    await rm(folder, { recursive: true, force: true })
  }
})
