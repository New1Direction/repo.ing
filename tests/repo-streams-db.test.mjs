import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createRepoStreams, readRepoStream } from '../src/repo-streams.mjs'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import * as route from '../app/api/builders/stream/route.js'

// Real PostgreSQL, drizzle/0046_repo_streams.sql applied in a scratch schema: the store's writes, the six-hour live
// window and expiry, and the table's own link and window constraints. The second test drives the HTTP route on a
// throwaway database with every migration, with only GitHub's API stubbed.
const url = process.env.TEST_DATABASE_URL
const target = url ? new URL(url) : null
const local = target?.hostname === '127.0.0.1' && ['55441', '55443'].includes(target.port)
test('real PostgreSQL: stream link, six-hour live window, expiry, constraints and removal', { skip: !local }, async () => {
  const db = new pg.Pool({ connectionString: url, max: 1 }), schema = `repo_streams_${randomBytes(5).toString('hex')}`
  const client = await db.connect()
  try {
    await client.query(`create schema ${schema}; set search_path to ${schema}`)
    await client.query('create table repositories(github_repo_id bigint primary key)')
    const migration = await readFile(new URL('../drizzle/0046_repo_streams.sql', import.meta.url), 'utf8')
    await client.query(migration)
    await client.query(migration) // idempotent: a second run is a no-op
    await client.query('insert into repositories values (77), (78)')
    const pool = { query: (...args) => client.query(...args) }
    const admin = async ({ githubRepoId }) => ({ verified: true, permission: 'admin', githubRepoId, githubUserId: 9001n, verifiedAt: new Date() })
    const streams = createRepoStreams({ pool }), args = { githubRepoId: '77', verifyAuthority: admin }
    assert.equal(await streams.read('77'), null)
    await assert.rejects(streams.setLive({ ...args, live: true }), /Add a stream link first/)

    assert.deepEqual(await streams.save({ ...args, url: 'https://twitch.tv/builder' }), { url: 'https://twitch.tv/builder', platform: 'Twitch', live: false, liveUntil: null })
    let stream = await streams.setLive({ ...args, live: true })
    const window = Date.parse(stream.liveUntil) - Date.now()
    assert.ok(stream.live && window > 6 * 3_600_000 - 60_000 && window <= 6 * 3_600_000 + 5_000, `live window ${window} ms`)
    stream = await streams.save({ ...args, url: 'https://kick.com/builder' })
    assert.deepEqual([stream.platform, stream.live], ['Kick', true], 'a new link keeps the unexpired window')

    await client.query("update repo_streams set live_until = now() - interval '1 second' where github_repo_id = 77")
    assert.deepEqual(await readRepoStream(pool, '77'), { url: 'https://kick.com/builder', platform: 'Kick', live: false, liveUntil: null })
    await streams.save({ ...args, url: 'https://kick.com/builder' })
    let { rows: [row] } = await client.query('select live_until, updated_by_github_user_id::text as "by" from repo_streams where github_repo_id = 77')
    assert.deepEqual([row.live_until, row.by], [null, '9001'], 'an expired window is cleared')
    await streams.setLive({ ...args, live: true })
    assert.deepEqual(await streams.setLive({ ...args, live: false }), { url: 'https://kick.com/builder', platform: 'Kick', live: false, liveUntil: null })

    const insert = (link, extra = '') => client.query(`insert into repo_streams(github_repo_id, url, updated_by_github_user_id${extra ? ', live_until' : ''})
      values (78, $1, 1${extra ? `, ${extra}` : ''})`, [link])
    for (const link of ['http://twitch.tv/builder', 'https://evil.example/live', 'https://twitch.tv.evil.example/live', 'https://twitch.tv/',
      'https://twitch.tv/a b', 'https://m.youtube.com/watch?v=1']) await assert.rejects(insert(link), /repo_streams_url_check/, link)
    await assert.rejects(insert('https://kick.com/builder', "now() + interval '6 hours 1 second'"), /repo_streams_live_window/)
    await insert('https://kick.com/builder', "now() + interval '6 hours'")
    await assert.rejects(client.query("insert into repo_streams(github_repo_id, url, updated_by_github_user_id) values (79, 'https://kick.com/x', 1)"), /foreign key/)

    assert.equal(await streams.remove(args), null)
    assert.equal(await streams.read('77'), null)
    ;({ rows: [row] } = await client.query('select count(*)::int as n from repo_streams'))
    assert.equal(row.n, 1, 'removal touches only its repository')
  } finally {
    await client.query(`drop schema ${schema} cascade`).catch(() => {})
    client.release(); await db.end()
  }
})

test('real PostgreSQL route: claim and builders sessions change a stream only with a current GitHub admin check', { skip: !local }, async t => {
  const name = `repo_streams_route_${randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  await admin.query(`create database ${name}`)
  const databaseUrl = new URL(url); databaseUrl.pathname = `/${name}`
  const pool = new pg.Pool({ connectionString: databaseUrl.href })
  const saved = { env: { ...process.env }, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  t.after(async () => {
    for (const key of ['DATABASE_URL', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'APP_ORIGIN']) {
      if (saved.env[key] === undefined) delete process.env[key]; else process.env[key] = saved.env[key]
    }
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
    await pool.end(); await admin.query(`drop database ${name} with (force)`); await admin.end()
  })
  await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at) values (77, 'octo', 'widget', 'octo/widget', 1, 0, false, now())`)
  await pool.query(`insert into markets(github_repo_id, status, mint, pool, launcher_wallet, creator_wallet, token_name, token_symbol, launch_signature,
    launch_slot, launch_finality, indexed_at, last_verified_at) values (77, 'confirmed', 'Mint77', 'Pool77', 'w', 'c', 'Widget', 'WID', 'Sig77', 1, 'finalized', now(), now())`)
  Object.assign(process.env, { DATABASE_URL: databaseUrl.href, GITHUB_APP_CLIENT_ID: 'Iv1.test-only',
    GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex'), APP_ORIGIN: 'https://repo.ing' })
  globalThis.__gitfunPool = pool
  // GitHub, as the verifier calls it: the user, the repository (twice) and the user's permission on it.
  let permission = 'admin'
  const calls = []
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    const body = path === '/user' ? { id: 583231, login: 'octocat' } : path === '/repositories/77' ? { id: 77, owner: { login: 'octo' }, name: 'widget', private: false, archived: false }
      : path === '/repos/octo/widget/collaborators/octocat/permission' ? { permission, user: { id: 583231 } } : null
    return body ? Response.json(body) : new Response('not found', { status: 404 })
  }
  const session = extra => encryptGithubSession({ githubUserId: '583231', githubLogin: 'octocat', accessToken: 'ghu_test_only',
    sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000, ...extra })
  const builders = session({ scope: 'builders', repoId: null, permission: 'identity' }), claim = session({ repoId: '77', permission: 'admin' })
  const post = async (cookie, body) => {
    const response = await route.POST({ url: 'https://repo.ing/api/builders/stream', headers: new Headers({ origin: 'https://repo.ing' }),
      cookies: { get: () => ({ value: cookie }) }, json: async () => body })
    return { status: response.status, body: await response.json() }
  }

  let result = await post(builders, { action: 'save', repoId: '77', url: 'https://www.twitch.tv/octo' })
  assert.deepEqual(result, { status: 200, body: { stream: { url: 'https://www.twitch.tv/octo', platform: 'Twitch', live: false, liveUntil: null } } })
  assert.ok(calls.includes('/repos/octo/widget/collaborators/octocat/permission'), 'the builders session was checked against GitHub for this repository')
  result = await post(claim, { action: 'live', repoId: '77', live: true })
  assert.equal(result.status, 200); assert.equal(result.body.stream.live, true)
  const { rows: [row] } = await pool.query(`select updated_by_github_user_id::text as "by", live_until > now() + interval '5 hours 59 minutes' as fresh from repo_streams`)
  assert.deepEqual(row, { by: '583231', fresh: true })
  assert.equal((await pool.query(`select count(*)::int as n from repo_verifications where github_repo_id = 77 and permission = 'admin'`)).rows[0].n, 2)

  permission = 'write'
  for (const cookie of [builders, claim]) {
    result = await post(cookie, { action: 'remove', repoId: '77' })
    assert.equal(result.status, 403); assert.match(result.body.error, /Current GitHub admin/)
  }
  calls.length = 0
  result = await post(session({ repoId: '78', permission: 'admin' }), { action: 'remove', repoId: '77' })
  assert.equal(result.status, 403); assert.equal(calls.length, 0, 'a claim session for another repository never reaches GitHub')
  assert.equal((await readRepoStream(pool, '77')).live, true, 'refused requests change nothing')

  permission = 'admin'
  result = await post(claim, { action: 'remove', repoId: '77' })
  assert.deepEqual(result, { status: 200, body: { stream: null } })
  assert.equal(await readRepoStream(pool, '77'), null)
})
