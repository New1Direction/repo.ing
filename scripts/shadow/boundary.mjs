// Separate from the live recovery runners. No arbitrary SQL or RPC capability is exported.
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

export const canonicalJSON = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) :
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
export const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex')
export function parseArgs(args) {
  if (args.length === 2 && args[0] === 'validate' && args[1] === '--read-only') return { mode: 'validate' }
  const [mode, lane, flag, path] = args
  if (args.length !== 4 || !['capture', 'replay'].includes(mode) || !['chart', 'accounting'].includes(lane) ||
    flag !== '--read-only' || !path || path.startsWith('-')) throw Error('SHADOW_ARGUMENTS')
  return { mode, lane, path }
}

const marketColumns = `github_repo_id::text as "repoId",mint,pool,creator_wallet as "creatorWallet",
  launch_signature as "launchSignature",bundle_id as "bundleId",early_access_end as "earlyAccessEnd",
  transfer_hook_program as "transferHookProgram",discovery_version as "discoveryVersion",launch_block_time as "launchBlockTime"`
const markets = `select ${marketColumns} from public.markets where status='confirmed' and indexed_at is not null
  and launch_finality='finalized' and quote_asset_id is null`
const cursors = 'select pool,last_signature,last_slot::text from public.pool_fee_cursors'
const common = { markets, cursors }
// Static, column-scoped reads only. No claims, payouts, private sessions, signing or general DB access.
const queries = {
  chart: { ...common,
    graduates: 'select github_repo_id::text,pool,signature,slot::text,evidence,evidence_hash from public.graduation_events',
    chartCursors: 'select pool,signature,slot::text from recovery_charts.cursors',
    trades: 'select pool,signature,event_index,slot::text from public.trade_events',
    dammTrades: 'select github_repo_id::text,pool,signature,event_index,slot::text,traded_at,quote_amount::text from public.damm_trade_events',
  },
  accounting: { ...common, markets: markets + ' and bundle_id is null and early_access_end is null and transfer_hook_program is null',
    fees: 'select github_repo_id::text,mint,pool,signature,event_index,kind,amount_base_units::text,slot::text from public.fee_events',
    discovery: 'select github_repo_id::text,pool,signature,event_index,partner_amount::text,discovery_eligible,slot::text,traded_at from public.discovery_fee_events',
    graduated: 'select github_repo_id::text,amount_base_units::text from public.damm_fee_events',
    platform: 'select github_repo_id::text,amount_base_units::text from public.platform_fee_events',
  },
}
export const queryNames = lane => Object.keys(queries[lane] ?? {})

export async function openSnapshot(connectionOptions, lane) {
  const expectedRole = lane === 'chart' ? 'repoing_chart_recovery' : lane === 'accounting' ? 'repoing_fee_indexer' : null
  if (!expectedRole) throw Error('SHADOW_DB_ROLE')
  const client = new pg.Client({ ...connectionOptions, application_name: 'repoing-no-write-shadow',
    options: '-c default_transaction_read_only=on -c search_path=pg_catalog,public',
    statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 })
  try {
    await client.connect()
    await client.query('begin isolation level repeatable read read only')
    const { rows: [r] } = await client.query(`select current_user as role,current_database() as db,
      current_setting('transaction_read_only') as ro,current_setting('default_transaction_read_only') as dro,
      txid_current_snapshot()::text as snapshot,rolsuper,rolbypassrls from pg_roles where rolname=current_user`)
    if (r.role !== expectedRole || r.ro !== 'on' || r.dro !== 'on' || r.rolsuper || r.rolbypassrls) throw Error('SHADOW_DB_ROLE')
    let denied = false
    return Object.freeze({ identity: { role: r.role, readOnly: true, snapshot: r.snapshot },
      assertSafe() { if (denied) throw Error('SHADOW_QUERY_DENIED') },
      async read(name) {
        if (!Object.hasOwn(queries[lane], name)) { denied = true; throw Error('SHADOW_QUERY_DENIED') }
        try {
          const { rows } = await client.query(queries[lane][name] + ' limit 100001')
          if (rows.length > 100000) throw Error('SHADOW_ROW_LIMIT')
          // SQL order is irrelevant; normalize it before freezing the shared input.
          return JSON.parse(canonicalJSON(rows)).sort((a, b) => canonicalJSON(a) < canonicalJSON(b) ? -1 : canonicalJSON(a) > canonicalJSON(b) ? 1 : 0)
        } catch { throw Error('SHADOW_DB_READ_FAILED') }
      },
      async close() { try { await client.query('rollback') } finally { await client.end() } },
    })
  } catch {
    await client.end().catch(() => {})
    throw Error('SHADOW_DB_FAILED')
  }
}

function allowedRpc(method, params) {
  if (!Array.isArray(params)) return false
  if (method === 'getGenesisHash') return params.length === 0
  if (method === 'getBlockTime') return params.length === 1 && Number.isSafeInteger(params[0]) && params[0] >= 0
  if (!['getTransaction', 'getAccountInfo', 'getMultipleAccounts', 'getSignaturesForAddress'].includes(method) ||
    params.length !== 2 || params[1]?.commitment !== 'finalized') return false
  if (method === 'getSignaturesForAddress' && (!Number.isInteger(params[1].limit) || params[1].limit < 1 || params[1].limit > 1000)) return false
  if (method === 'getMultipleAccounts' && (!Array.isArray(params[0]) || params[0].length > 100)) return false
  return true
}

export function createRpcTape({ endpoints = null, entries = {}, fetchImpl = globalThis.fetch, maxCalls = 2000 } = {}) {
  const frozen = structuredClone(entries), pending = new Map(), queues = new Map(), abort = new AbortController()
  let calls = 0, requests = 0, bytes = Buffer.byteLength(canonicalJSON(frozen)), failure
  const fail = code => { failure ??= code; abort.abort(); throw Error(failure) }
  return {
    get entries() { return structuredClone(frozen) },
    get calls() { return calls },
    assertSafe() { if (failure) throw Error(failure) },
    async request(provider, method, params) {
      if (failure) throw Error(failure)
      if (!['primary', 'verification', 'archive'].includes(provider) || !allowedRpc(method, params)) fail('SHADOW_RPC_DENIED')
      // Repeated cached pages must not make an unbounded library history walk spin forever.
      if (++requests > maxCalls * 5) fail('SHADOW_RPC_LIMIT')
      const key = canonicalJSON([provider, method, params])
      if (Object.hasOwn(frozen, key)) return structuredClone(frozen[key])
      if (pending.has(key)) return structuredClone(await pending.get(key))
      if (!endpoints) fail('SHADOW_RPC_MISSING')
      if (calls >= maxCalls) fail('SHADOW_RPC_LIMIT')
      calls++
      let origin
      try {
        const url = new URL(endpoints[provider])
        if (url.protocol !== 'https:') throw Error()
        origin = url.origin
      } catch { fail('SHADOW_RPC_FAILED') }
      // Paths, credentials and provider aliases do not create independent quota buckets.
      if (!queues.has(origin)) queues.set(origin, { tail: Promise.resolve(), lastStart: -Infinity })
      const queue = queues.get(origin)
      const task = queue.tail.then(async () => {
        try {
          if (failure) throw Error()
          while (performance.now() - queue.lastStart < 1000) {
            await delay(Math.ceil(1000 - (performance.now() - queue.lastStart)), undefined, { signal: abort.signal })
          }
          if (failure) throw Error()
          const responsePromise = fetchImpl(endpoints[provider], { method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
          queue.lastStart = performance.now()
          const response = await responsePromise
          if (!response.ok) throw Error()
          const reader = response.body.getReader(), chunks = []; let size = 0
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              size += value.byteLength
              if (size > 8 * 1024 * 1024) throw Error()
              chunks.push(Buffer.from(value))
            }
          } finally { await reader.cancel() }
          if (failure) throw Error()
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (payload.error || !Object.hasOwn(payload, 'result')) throw Error()
          const result = payload.result
          if (method === 'getTransaction' && result?.meta) delete result.meta.logMessages
          bytes += Buffer.byteLength(canonicalJSON(result))
          if (bytes > 64 * 1024 * 1024) throw Error()
          frozen[key] = result
          return result
        } catch { fail('SHADOW_RPC_FAILED') }
      })
      // The slot spans the full bounded body, decoding and validation, never just headers.
      queue.tail = task.catch(() => {})
      pending.set(key, task)
      try { return structuredClone(await task) } finally { pending.delete(key) }
    },
  }
}
