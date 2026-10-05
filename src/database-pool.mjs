import pg from 'pg'

// The PostgreSQL pool of a long-lived process: the site (app/lib/server.mjs database()) and the worker (scripts/run-worker.mjs).
// When the server ends a connection (a restart, a failover, a network cut), pg emits 'error' on it. Unhandled, Node exits
// the process:
// - idle in the pool: pg-pool discards the connection and re-emits the error on the pool;
// - checked out with pool.connect(): pg-pool has removed its own listener, so the error is the caller's. No caller here
//   listens per checkout, so every connection gets one listener for its whole life.
// A statement in flight still rejects to its caller, and the next query opens a new connection. Logged by code only.
export function createDatabasePool(options, { log = console.error } = {}) {
  const pool = new pg.Pool(options)
  const report = error => log(JSON.stringify({ databaseConnectionError: { code: String(error?.code ?? error?.message ?? 'error').slice(0, 60) } }))
  pool.on('connect', client => client.on('error', report))
  // Already logged by the connection's own listener.
  pool.on('error', () => {})
  return pool
}
