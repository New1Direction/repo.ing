// Scratch PostgreSQL and an intentionally non-responsive loopback PG peer only.
// No wallets, signing, RPC, accepted database writes or successful financial stubs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { register } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))
const { POST } = await import('../app/api/hook-lab/local-operations/route.js')
const origin = 'https://localhost:3443'
const databaseConfig = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
function databaseUrl(database, port = databaseConfig.port) {
  const url = new URL('postgresql://127.0.0.1')
  url.port = String(port); url.username = databaseConfig.user; url.password = databaseConfig.password; url.pathname = database
  return url.toString()
}
async function withLocalEnvironment(url, work) {
  const changes = { NODE_ENV: 'development', HOOK_LOCAL_ACCEPTANCE: 'true', HOOK_WALLET_IDENTITY_ORIGIN: origin,
    HOOK_WALLET_IDENTITY_DATABASE_URL: url, HOOK_LOCAL_ACCEPTANCE_GENESIS: 'EZQnEdWBjWRvJnbF9M32QeLaoxYjA5LcJKNtqYcvo7Re',
    HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY: 'https://localhost:18898', HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY: 'https://localhost:18899' }
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]))
  const slot = Symbol.for('repo.ing.hooklab.local-operations'), prior = globalThis[slot]
  Object.assign(process.env, changes)
  // A database failure must precede any runtime action. There is no signing runtime in this test.
  globalThis[slot] = { origin, lifecycle: null }
  try { return await work() } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    if (prior === undefined) delete globalThis[slot]; else globalThis[slot] = prior
  }
}
const request = () => new Request(`${origin}/api/hook-lab/local-operations`, { method: 'POST',
  headers: { origin, 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${'A'.repeat(43)}` },
  body: JSON.stringify({ action: 'get', signingId: randomUUID() }) })
async function scratch(work) {
  const administrator = new pg.Pool(databaseConfig), database = `hooks_local_timeout_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await administrator.query(`create database ${database}`)
    pool = new pg.Pool({ ...databaseConfig, database })
    await pool.query(await readFile(new URL('../src/hooklab-wallet-identity-quota-schema.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../src/hooklab-wallet-principal-schema.sql', import.meta.url), 'utf8'))
    return await work({ pool, database })
  } finally { await pool?.end(); await dropTestDatabase(administrator, database); await administrator.end() }
}

test('a locked quota row fails closed before release and cannot mutate after the denied request', { timeout: 15000 }, async () => {
  await scratch(async ({ pool, database }) => {
    const scope = `local-operations:${origin}`, blocker = await pool.connect()
    await pool.query("insert into hook_lab_wallet_request_limits values($1,1,clock_timestamp()+interval '10 minutes')", [scope])
    const blockerPid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid
    await blocker.query('begin')
    await blocker.query('select scope from hook_lab_wallet_request_limits where scope=$1 for update', [scope])
    let emergencyRelease = false, releasePromise
    const release = () => releasePromise ??= blocker.query('rollback').finally(() => blocker.release())
    const watchdog = setTimeout(() => { emergencyRelease = true; void release() }, 6500)
    try {
      const pending = withLocalEnvironment(databaseUrl(database), () => POST(request()))
      let waiting = false
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await pool.query(`select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'
          and $1=any(pg_blocking_pids(pid))) as waiting`, [blockerPid])
        if (result.rows[0].waiting) { waiting = true; break }
        await delay(25)
      }
      const response = await pending
      assert.equal(waiting, true, 'The real request must reach the held database lock')
      assert.equal(emergencyRelease, false, 'The database lock outlived the request deadline')
      assert.equal(response.status, 409)
      assert.match((await response.json()).error, /Preserve the signing ID and reconcile/)
      const { createHookLabDatabasePool } = await import('../src/hooklab-database.mjs')
      const { walletIdentityQuota } = await import('../app/lib/hooklab-wallet-identity.mjs')
      const bounded = createHookLabDatabasePool({ databaseUrl: databaseUrl(database) })
      try {
        await assert.rejects(walletIdentityQuota(bounded, [[scope, 120]]), error => error.code === '55P03',
          'The server lock deadline, not a generic request failure, must cancel the quota write')
      } finally { await bounded.end() }
      await release()
      assert.equal((await pool.query('select hits from hook_lab_wallet_request_limits where scope=$1', [scope])).rows[0].hits, 1,
        'A denied request must not execute a delayed quota mutation after the lock is released')
    } finally { clearTimeout(watchdog); await release() }
  })
})

test('an accepted TCP connection that never completes PostgreSQL startup cannot hold the route open', { timeout: 15000 }, async () => {
  const sockets = new Set(), server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let emergencyClose = false, accepted = false
  server.on('connection', () => { accepted = true })
  const watchdog = setTimeout(() => { emergencyClose = true; for (const socket of sockets) socket.destroy() }, 7000)
  try {
    const response = await withLocalEnvironment(databaseUrl('hooks_local_stalled_startup', server.address().port), () => POST(request()))
    assert.equal(accepted, true, 'The probe must exercise a real connection, not reject configuration early')
    assert.equal(emergencyClose, false, 'PostgreSQL startup had no bounded connection deadline')
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /Preserve the signing ID and reconcile/)
  } finally {
    clearTimeout(watchdog)
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})

test('server cancellation aborts blocked work atomically and the pool remains usable', { timeout: 15000 }, async () => {
  const { createHookLabDatabasePool } = await import('../src/hooklab-database.mjs')
  await scratch(async ({ pool, database }) => {
    await pool.query("insert into hook_lab_wallet_request_limits values('atomic-timeout',1,clock_timestamp()+interval '10 minutes')")
    const bounded = createHookLabDatabasePool({ databaseUrl: databaseUrl(database) }, 1)
    try {
      const client = await bounded.connect()
      try {
        await client.query('begin')
        await client.query("update hook_lab_wallet_request_limits set hits=2 where scope='atomic-timeout'")
        await assert.rejects(client.query(`with waited as materialized (select pg_sleep(6))
          update hook_lab_wallet_request_limits set hits=3 from waited where scope='atomic-timeout'`),
        error => error.code === '57014', 'The server must cancel before the client loses the query outcome')
      } finally { try { await client.query('rollback') } finally { client.release() } }
      assert.equal((await bounded.query("select hits from hook_lab_wallet_request_limits where scope='atomic-timeout'")).rows[0].hits, 1)
      const next = await bounded.query("update hook_lab_wallet_request_limits set hits=hits+1 where scope='atomic-timeout' returning hits")
      assert.equal(next.rows[0].hits, 2, 'Recovery must execute a new transaction, not the cancelled write')
    } finally { await bounded.end() }
  })
})

test('the signing runtime retains its longer SQL allowance and cancels before its client deadline', { timeout: 30000 }, async () => {
  const { createHookLabDatabasePool } = await import('../src/hooklab-database.mjs')
  await scratch(async ({ pool, database }) => {
    await pool.query("insert into hook_lab_wallet_request_limits values('runtime-timeout',1,clock_timestamp()+interval '10 minutes')")
    const bounded = createHookLabDatabasePool({ databaseUrl: databaseUrl(database) }, 10, 'runtime')
    try {
      const client = await bounded.connect()
      try {
        await client.query('begin')
        const changed = await client.query(`with waited as materialized (select pg_sleep(6))
          update hook_lab_wallet_request_limits set hits=2 from waited where scope='runtime-timeout' returning hits`)
        assert.equal(changed.rows[0].hits, 2, 'Runtime SQL must not inherit the shorter HTTP request deadline')
        await assert.rejects(client.query('select pg_sleep(16)'), error => error.code === '57014',
          'Runtime cancellation must be server-side, before the existing 15-second client deadline')
      } finally { try { await client.query('rollback') } finally { client.release() } }
      assert.equal((await bounded.query("select hits from hook_lab_wallet_request_limits where scope='runtime-timeout'")).rows[0].hits, 1)
    } finally { await bounded.end() }
  })
})

test('database URL overrides cannot disable or reorder signing-path timeouts', async () => {
  const { createHookLabDatabasePool } = await import('../src/hooklab-database.mjs')
  for (const key of ['statement_timeout', 'lock_timeout', 'query_timeout', 'idle_in_transaction_session_timeout',
    'connectionTimeoutMillis', 'connect_timeout', 'options']) {
    const url = new URL(databaseUrl('hooks_local_override'))
    url.searchParams.set(key, key === 'options' ? '-c statement_timeout=0' : '0')
    assert.throws(() => createHookLabDatabasePool({ databaseUrl: url.toString() }), /must not override safety timeouts/)
  }
})
