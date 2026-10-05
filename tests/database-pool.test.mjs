import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createDatabasePool, releaseAfterUnlock } from '../src/database-pool.mjs'
import { startFakePostgres } from './fixtures/fake-postgres.mjs'

const until = async (check, ms = 5000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.fail('condition not reached in time')
}
const terminated = () => Object.assign(Error('terminating connection due to administrator command'), { code: '57P01' })

test('a dropped connection is logged by its code, never thrown, idle or checked out', async () => {
  const logs = []
  const pool = createDatabasePool({ connectionString: 'postgres://user:secret@127.0.0.1:1/none' }, { log: line => logs.push(line) })
  try {
    // Idle in the pool: pg-pool discards the connection and reports it on the pool. Unhandled, Node exits the process.
    assert.doesNotThrow(() => pool.emit('error', terminated()))
    // Checked out: pg-pool has removed its own listener, so the connection's error is ours to handle.
    const client = new EventEmitter()
    pool.emit('connect', client)
    assert.doesNotThrow(() => client.emit('error', terminated()))
    assert.doesNotThrow(() => client.emit('error', Error('Connection terminated unexpectedly')))
    assert.deepEqual(logs.map(line => JSON.parse(line)),
      [{ databaseConnectionError: { code: '57P01' } }, { databaseConnectionError: { code: 'Connection terminated unexpectedly' } }])
    assert.doesNotMatch(logs.join('\n'), /secret/)
  } finally { await pool.end() }
})

test('the site and the worker open their pool through createDatabasePool', async () => {
  const saved = { url: process.env.DATABASE_URL, pool: globalThis.__gitfunPool }
  process.env.DATABASE_URL = 'postgres://test-only@127.0.0.1:1/none'
  delete globalThis.__gitfunPool
  try {
    const { database } = await import('../app/lib/server.mjs')
    const pool = database()
    assert.equal(pool.listenerCount('error'), 1)
    assert.equal(pool.listenerCount('connect'), 1)
    assert.equal(database(), pool, 'one pool per process')
    await pool.end()
  } finally {
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url
    if (saved.pool === undefined) delete globalThis.__gitfunPool; else globalThis.__gitfunPool = saved.pool
  }
  // The worker is a script and cannot be imported: its pool is read from the source.
  const worker = readFileSync(new URL('../scripts/run-worker.mjs', import.meta.url), 'utf8')
  assert.match(worker, /const pool = createDatabasePool\(/)
  assert.doesNotMatch(worker, /new pg\.Pool\(/)
})

const settled = promise => promise.then(() => 'resolved', error => error.code ?? error.message)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// The real pg client against a fake server (tests/fixtures/fake-postgres.mjs), so the required pre-merge suite covers what
// the real-PostgreSQL test below covers after merge. A plain pg.Pool ends the process in each of these cases.
test('the pg client: a connection the server ends is survived idle, checked out and with a statement in flight', async () => {
  const server = await startFakePostgres(), logs = []
  const pool = createDatabasePool({ connectionString: server.url, max: 3 }, { log: line => logs.push(JSON.parse(line).databaseConnectionError.code) })
  try {
    // Idle in the pool.
    await pool.query('select 1')
    server.terminateAll()
    await until(() => pool.totalCount === 0)
    assert.deepEqual(logs, ['57P01'])
    // Checked out, between statements.
    const held = await pool.connect()
    try {
      await held.query('select 1')
      server.terminateAll()
      await until(() => logs.length >= 2)
      assert.notEqual(await settled(held.query('select 1')), 'resolved')
    } finally { held.release() }
    // Checked out, with a statement in flight: the statement rejects to its caller.
    const busy = await pool.connect()
    try {
      const statement = settled(busy.query('select pg_sleep(30)'))
      await pause(20)
      server.terminateAll()
      assert.equal(await statement, '57P01')
    } finally { busy.release() }
    // Released in the instant between the server's message and its socket closing, that connection is briefly idle in the
    // pool again; it leaves when the socket closes.
    await until(() => pool.totalCount === 0)
    // A network cut, with no message from the server.
    await pool.query('select 1')
    server.cutAll()
    await until(() => pool.totalCount === 0)
    // Every lost connection has left the pool, and it still serves.
    assert.equal((await pool.query('select 1')).rows[0].v, 1)
    assert.equal(pool.totalCount, 1)
  } finally { await pool.end(); await server.close() }
})

test('a session lock whose unlock fails destroys its connection instead of leaking the pool slot', async () => {
  // The helper alone: released either way, destroyed only when the unlock failed, and the failure is not hidden.
  const released = []
  const db = { release: broken => released.push(broken) }
  await releaseAfterUnlock(db, async () => {})
  await releaseAfterUnlock(db, () => null)
  await assert.rejects(releaseAfterUnlock(db, async () => { throw Error('Connection terminated unexpectedly') }), /terminated/)
  assert.deepEqual(released, [undefined, undefined, true])

  // A job that loses its connection while it holds the lock, twice, on a pool of two. Without the helper both slots stay
  // taken by dead connections and the next query waits forever.
  const server = await startFakePostgres()
  const pool = createDatabasePool({ connectionString: server.url, max: 2 }, { log: () => {} })
  const job = async () => {
    const db = await pool.connect()
    try { await db.query('select pg_advisory_lock(1)'); await pause(40) }
    finally { await releaseAfterUnlock(db, () => db.query('select pg_advisory_unlock(1)')) }
  }
  try {
    for (let i = 0; i < 2; i++) {
      const run = settled(job())
      await pause(15)
      server.terminateAll()
      assert.notEqual(await run, 'resolved')
    }
    await until(() => pool.totalCount === 0)
    assert.equal((await pool.query('select 1')).rows[0].v, 1)
  } finally { await pool.end(); await server.close() }

  // The three jobs that unlocked and released in one flat finally block.
  for (const file of ['src/chart-ordering.mjs', 'src/builder-reinvest.mjs', 'src/trend-intake.mjs']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(source, /releaseAfterUnlock\(/, `${file} releases through releaseAfterUnlock`)
  }
})

const url = process.env.TEST_DATABASE_URL

test('real PostgreSQL: the server ending a connection never ends the process, and the pool keeps serving', { skip: !url }, async () => {
  const target = new URL(url)
  assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, '55441', 'Disposable scratch database required')
  const logs = []
  const pool = createDatabasePool({ connectionString: url, max: 3 }, { log: line => logs.push(JSON.parse(line)) })
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  const end = pid => admin.query('select pg_terminate_backend($1)', [pid])
  const backend = async db => (await db.query('select pg_backend_pid() as pid')).rows[0].pid
  try {
    // Checked out and between statements, as a job is while it reads the chain under a lock. Each checkout is released in
    // its own finally: pool.end() below waits for every client, so a failed assertion would otherwise hang the test.
    const held = await pool.connect()
    try {
      await end(await backend(held))
      await until(() => logs.length > 0)
      assert.equal(logs[0].databaseConnectionError.code, '57P01')
      await assert.rejects(held.query('select 1'))
    } finally { held.release() }

    // Checked out with a statement in flight: the statement rejects to its caller. Its rejection is awaited before the
    // connection is ended, since the two sockets answer in no fixed order.
    const busy = await pool.connect()
    try {
      const pid = await backend(busy)
      const rejected = assert.rejects(busy.query('select pg_sleep(30)'), error => error.code === '57P01')
      await end(pid)
      await rejected
    } finally { busy.release() }
    // As above: released before its socket has closed, that connection is idle in the pool for an instant.
    await until(() => pool.totalCount === 0)

    // Idle in the pool.
    await end(await backend(pool))
    await until(() => pool.totalCount === 0)

    // New connections are opened as needed.
    assert.equal((await pool.query('select 1 as ok')).rows[0].ok, 1)
  } finally { await admin.end(); await pool.end() }
})
