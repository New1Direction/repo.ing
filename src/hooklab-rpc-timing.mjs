// Where a Hooks request's chain time goes (owner 2026-10-27): launch-stage reviews took 14–16 s in the container against
// ~0.5 s for the same reads from a Mac. Every RPC call made inside withRpcTiming is recorded by provider hostname and
// method (never the URL or its key), with account count, response bytes, status and milliseconds; one summary line per
// request: totals per provider and per method, the slowest calls, 429s and catch-up retries.
import { AsyncLocalStorage } from 'node:async_hooks'

// One store per process: the bootstrap that builds the connections and the route that opens the scope are separate Next
// bundles, each with its own copy of this module.
const scopes = globalThis.__hooklabRpcTimingScopes ??= new AsyncLocalStorage()
const SLOWEST = 5

const describe = init => {
  try {
    const { method, params } = JSON.parse(String(init?.body ?? ''))
    const count = method === 'getMultipleAccounts' && Array.isArray(params?.[0]) ? params[0].length : null
    return { method: String(method ?? '-').slice(0, 40), count }
  } catch { return { method: 'batch', count: null } }
}
const hostOf = url => { try { return new URL(String(url)).hostname } catch { return '-' } }

// A fetch for web3.js Connections that records each call in the current request's scope, if any.
export function timedFetch(fetchImpl = globalThis.fetch) {
  return async (url, init) => {
    const scope = scopes.getStore(), started = performance.now()
    const response = await fetchImpl(url, init)
    if (!scope) return response
    const bytes = Number(response.headers?.get?.('content-length')) || (await response.clone().arrayBuffer()).byteLength
    scope.calls.push({ host: hostOf(url), ...describe(init), status: response.status, bytes, ms: performance.now() - started })
    return response
  }
}

export const rpcLabel = label => { const scope = scopes.getStore(); if (scope) scope.label = String(label).slice(0, 60) }
export const noteRpcRetry = () => { const scope = scopes.getStore(); if (scope) scope.retries++ }
const noteDb = (kind, ms) => { const scope = scopes.getStore(); if (scope) { scope.db[kind].ms += ms; scope.db[kind].n++ } }
const timed = async (kind, work) => { const started = performance.now(); try { return await work() } finally { noteDb(kind, performance.now() - started) } }

// The same record for a pg pool: query time and connection checkout time (a new connection includes its TLS handshake).
// pg's pool.query checks out through pool.connect(callback), so both the promise and the callback forms pass through.
export function timedDatabasePool(pool) {
  const connect = pool.connect.bind(pool)
  const timeClient = client => {
    if (client && !client.__hooklabTimed) {
      const q = client.query.bind(client)
      client.query = (...args) => typeof args.at(-1) === 'function' ? q(...args) : timed('query', () => q(...args))
      client.__hooklabTimed = true
    }
    return client
  }
  pool.connect = callback => {
    const started = performance.now()
    if (typeof callback === 'function') return connect((error, client, done) => { noteDb('connect', performance.now() - started); callback(error, timeClient(client), done) })
    return connect().then(client => { noteDb('connect', performance.now() - started); return timeClient(client) })
  }
  return pool
}

export function rpcSummaryLine({ label, calls, retries, totalMs, db = { query: { ms: 0, n: 0 }, connect: { ms: 0, n: 0 } } }) {
  const ms = value => `${Math.round(value)}ms`
  const group = key => Object.entries(calls.reduce((all, call) => {
    const entry = all[call[key]] ??= { ms: 0, n: 0, bytes: 0 }
    entry.ms += call.ms; entry.n++; entry.bytes += call.bytes
    return all
  }, {})).sort((a, b) => b[1].ms - a[1].ms)
  const hosts = group('host').map(([host, v]) => `${host} ${ms(v.ms)}/${v.n} ${Math.round(v.bytes / 1024)}KB`).join(', ')
  const methods = group('method').map(([method, v]) => `${method} ${ms(v.ms)}/${v.n}`).join(', ')
  const slowest = [...calls].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST)
    .map(c => `${c.method}${c.count === null ? '' : `(${c.count})`}@${c.host.split('.')[0]} ${ms(c.ms)} ${c.status}`).join(', ')
  const throttled = calls.filter(c => c.status === 429).length
  return `Hook Lab rpc ${label}: ${calls.length} calls ${ms(calls.reduce((n, c) => n + c.ms, 0))} in ${ms(totalMs)} | hosts ${hosts}`
    + ` | methods ${methods} | slowest ${slowest} | 429s ${throttled} retries ${retries}`
    + ` | db queries ${ms(db.query.ms)}/${db.query.n} connect ${ms(db.connect.ms)}/${db.connect.n}`
}

// Runs one request with its own call record and logs its summary line when it ends, however it ends.
export async function withRpcTiming(work, log = line => console.error(line)) {
  const scope = { label: '-', calls: [], retries: 0, db: { query: { ms: 0, n: 0 }, connect: { ms: 0, n: 0 } } }, started = performance.now()
  try { return await scopes.run(scope, work) }
  finally { if (scope.calls.length || scope.db.query.n) log(rpcSummaryLine({ ...scope, totalMs: performance.now() - started })) }
}
