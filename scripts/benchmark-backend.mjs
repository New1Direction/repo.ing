// Reproducible local transport and scheduler-query benchmarks. No public RPC, keys or chain writes.
// node scripts/benchmark-backend.mjs
// BENCH_DATABASE_URL=postgres://postgres@127.0.0.1:55432/repoing_perf_test node scripts/benchmark-backend.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { clearFinalizedTransactionCache, loadFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { createRpcMeter, registerRpcEndpoint } from '../src/rpc-usage.mjs'

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const check = process.argv.includes('--check')
let requests = 0, active = 0, peak = 0
const server = http.createServer(async (req, res) => {
  requests++; peak = Math.max(peak, ++active)
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const { params: [signature] } = JSON.parse(Buffer.concat(chunks))
  // Scripted congestion model: 10ms base latency plus 5ms per concurrently active request, not a live provider SLA.
  await sleep(10 + active * 5)
  active--
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ result: { version: 0, slot: 42, blockTime: 1700000000,
    transaction: { signatures: [signature], message: { accountKeys: ['11111111111111111111111111111111'], instructions: [] } },
    meta: { err: null } } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const meter = createRpcMeter({ log: () => {} })
  registerRpcEndpoint(endpoint, meter.fetchFor('benchmark'))
  const timings = [], counts = [], peaks = []
  for (let run = 0; run < 7; run++) {
    clearFinalizedTransactionCache(); requests = 0; peak = 0
    const at = performance.now()
    const values = await Promise.all(Array.from({ length: 24 }, () => loadFinalizedTransaction({ rpcEndpoint: endpoint }, `signature-${run}`)))
    assert.ok(values.every(value => value.slot === 42 && value.transaction.signatures[0] === `signature-${run}`))
    timings.push(performance.now() - at); counts.push(requests); peaks.push(peak)
  }
  console.log(JSON.stringify({ benchmark: '24 concurrent finalized reads, one signature, 7 cold-cache runs',
    medianMs: +median(timings).toFixed(2), requests: median(counts), peakRequests: median(peaks) }))
  if (check) {
    assert.ok(counts.every(n => n === 1), 'one upstream request per cold-cache burst')
    assert.ok(median(timings) < 250, 'local burst latency budget: 250ms')
  }
} finally { clearFinalizedTransactionCache(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }

if (process.env.BENCH_DATABASE_URL) {
  const target = new URL(process.env.BENCH_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/repoing_perf_test', 'Disposable local benchmark database required')
  const db = new pg.Client({ connectionString: target.toString() })
  await db.connect()
  try {
    // Temporary data models the scheduler's correlated latest-session lookup, with wide session records.
    // All-null and absent repositories are included to check MAX's null semantics independently of the plan.
    await db.query('create temp table markets(github_repo_id bigint primary key)')
    await db.query('create temp table trade_sessions(github_repo_id bigint, submitted_at timestamptz, record text)')
    await db.query('insert into markets select generate_series(1,200)')
    await db.query(`insert into trade_sessions select 1 + g % 199,
      case when g % 199 = 0 or g % 3 = 0 then null else '2026-10-01'::timestamptz + g * interval '1 second' end,
      repeat(md5(g::text), 64) from generate_series(1,20000) g`)
    await db.query('vacuum analyze trade_sessions')
    const sql = `select github_repo_id::text, (select max(s.submitted_at) from trade_sessions s
      where s.github_repo_id = markets.github_repo_id) as "sessionAt" from markets order by markets.github_repo_id`
    let expected
    for (const indexed of [false, true]) {
      if (indexed) await db.query('create index trade_sessions_repo_submitted on trade_sessions(github_repo_id, submitted_at) where submitted_at is not null')
      const timings = []
      for (let run = 0; run < 7; run++) {
        const at = performance.now(), { rows } = await db.query(sql)
        timings.push(performance.now() - at)
        if (!expected) expected = rows
        assert.deepEqual(rows, expected)
        assert.equal(rows[0].sessionAt, null); assert.equal(rows.at(-1).sessionAt, null)
      }
      const { rows } = await db.query(`explain (analyze, buffers, format json) ${sql}`)
      console.log(JSON.stringify({ benchmark: '200 markets / 20000 trade sessions, 7 runs', indexed,
        medianMs: +median(timings).toFixed(2), executionMs: rows[0]['QUERY PLAN'][0]['Execution Time'],
        plan: rows[0]['QUERY PLAN'][0].Plan }))
      if (check && indexed) assert.ok(median(timings) < 50, 'indexed local scheduler-query budget: 50ms')
    }
  } finally { await db.end() }
}

// Optional control: a running production build against disposable local data, without any UI or chain writes.
// BENCH_HTTP_ORIGIN=http://127.0.0.1:3001 BENCH_MINT=<seeded market mint> node scripts/benchmark-backend.mjs
if (process.env.BENCH_HTTP_ORIGIN) {
  const origin = new URL(process.env.BENCH_HTTP_ORIGIN), mint = process.env.BENCH_MINT
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint), 'Local app and seeded mint required')
  const timings = [], loaders = []
  let coldMs, events
  for (let run = 0; run < 21; run++) {
    const at = performance.now()
    const response = await fetch(new URL(`/api/market/${mint}/activity`, origin), { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(Array.isArray(body.events) && body.events.length > 0, 'control must return seeded activity, not an empty/error page')
    events = body.events.length
    const ms = performance.now() - at
    if (!run) coldMs = ms
    else { timings.push(ms); loaders.push(response.headers.get('server-timing')) }
  }
  const p95 = [...timings].sort((a, b) => a - b)[18]
  console.log(JSON.stringify({ benchmark: 'built activity endpoint control, 1 cold + 20 warm requests', events,
    coldMs: +coldMs.toFixed(2), medianMs: +median(timings).toFixed(2), p95Ms: +p95.toFixed(2), serverTiming: loaders.at(-1) }))
  if (check) assert.ok(p95 < 250, 'warm local activity endpoint p95 budget: 250ms')
}
