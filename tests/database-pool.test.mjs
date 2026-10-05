import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createDatabasePool } from '../src/database-pool.mjs'

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

const url = process.env.TEST_DATABASE_URL
const until = async (check, ms = 5000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.fail('condition not reached in time')
}

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
    // Checked out and between statements, as a job is while it reads the chain under a lock.
    const held = await pool.connect()
    await end(await backend(held))
    await until(() => logs.length > 0)
    assert.equal(logs[0].databaseConnectionError.code, '57P01')
    await assert.rejects(held.query('select 1'))
    held.release(true)

    // Checked out with a statement in flight: the statement rejects to its caller.
    const busy = await pool.connect()
    const pid = await backend(busy)
    const statement = busy.query('select pg_sleep(30)')
    await end(pid)
    await assert.rejects(statement, error => error.code === '57P01')
    busy.release(true)

    // Idle in the pool.
    const idle = await backend(pool)
    const seen = logs.length
    await end(idle)
    await until(() => logs.length > seen && pool.totalCount === 0)

    // New connections are opened as needed.
    assert.equal((await pool.query('select 1 as ok')).rows[0].ok, 1)
  } finally { await admin.end(); await pool.end() }
})
