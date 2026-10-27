import { createDatabasePool } from './database-pool.mjs'
import { timedDatabasePool } from './hooklab-rpc-timing.mjs'

// Server cancellation precedes the client deadline. A denied HTTP request must
// not leave a blocked SQL write queued behind a lock or a dead connection.
const overrides = new Set(['options', 'statement_timeout', 'lock_timeout', 'query_timeout',
  'idle_in_transaction_session_timeout', 'connectiontimeoutmillis', 'connect_timeout'])
const deadlines = Object.freeze({ request: 5000, runtime: 15000 })
export function createHookLabDatabasePool({ databaseUrl }, max = 2, profile = 'request') {
  if (!Object.hasOwn(deadlines, profile)) throw Error('Unknown Hook Lab database deadline profile')
  const queryTimeout = deadlines[profile], statementTimeout = queryTimeout - 1000
  const url = new URL(databaseUrl)
  if ([...url.searchParams.keys()].some(key => overrides.has(key.toLowerCase()))) {
    throw Error('Hook Lab database settings must not override safety timeouts')
  }
  return timedDatabasePool(createDatabasePool({ connectionString: databaseUrl, max,
    connectionTimeoutMillis: 5000, statement_timeout: statementTimeout, lock_timeout: 2000,
    query_timeout: queryTimeout, idle_in_transaction_session_timeout: 30000,
    // Explicit startup options also prevent PGOPTIONS from removing the limits.
    options: `-c statement_timeout=${statementTimeout} -c lock_timeout=2000 -c idle_in_transaction_session_timeout=30000` }))
}
