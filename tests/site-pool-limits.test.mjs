import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createDatabasePool } from '../src/database-pool.mjs'

// 2026-10-27: a connection the database dropped silently hung one page query forever, and the single-flight market
// memos made every page wait on it. The site pools now carry keep-alive and connect/query time limits.
test('the site pools carry keep-alive and connect and query time limits', async () => {
  process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:1/db'
  const { database, SITE_POOL_LIMITS } = await import('../app/lib/server.mjs')
  const { options } = database()
  assert.equal(options.keepAlive, true)
  assert.equal(options.connectionTimeoutMillis, SITE_POOL_LIMITS.connectionTimeoutMillis)
  assert.equal(options.query_timeout, SITE_POOL_LIMITS.query_timeout)
  await database().end()
})

test('a database that accepts but never answers fails the query instead of hanging', async () => {
  const silent = net.createServer(socket => socket.on('data', () => {}))
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve))
  const pool = createDatabasePool({ connectionString: `postgres://u:p@127.0.0.1:${silent.address().port}/db`, keepAlive: true,
    connectionTimeoutMillis: 300, query_timeout: 300 }, { log() {} })
  const started = Date.now()
  await assert.rejects(pool.query('select 1'), /timeout/i)
  assert.ok(Date.now() - started < 3000)
  await pool.end().catch(() => {}); silent.close()
})
