import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import * as charts from '../scripts/recovery-chart-indexer.mjs'
import { recoveryHistory, runRecoveryCharts } from '../scripts/recovery-chart-indexer.mjs'

const pool = '11111111111111111111111111111111'
const item = (signature, slot) => ({ signature, slot, err: null })
const rpc = (endpoint, pages) => ({ rpcEndpoint: endpoint, getSignaturesForAddress: async (_key, { before }, commitment) => {
  assert.equal(commitment, 'finalized')
  return pages[before ?? 'head'] ?? []
} })

test('chart recovery requires complete agreeing history and returns oldest first without the accounting boundary', async () => {
  const pages = { head: [item('new', 33), item('middle', 22)], middle: [item('old', 11), item('boundary', 10)] }
  assert.deepEqual(await recoveryHistory(rpc('primary', pages), rpc('verifier', pages), pool, 'boundary', { pageSize: 2 }),
    [item('old', 11), item('middle', 22), item('new', 33)])
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('primary', pages), pool, 'boundary'), /INDEPENDENT_RPC_REQUIRED/)
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('verifier', { head: [item('different', 33), item('boundary', 10)] }), pool, 'boundary', { pageSize: 2 }), /RPC_DISAGREEMENT/)
  await assert.rejects(recoveryHistory(rpc('primary', { head: [item('new', 33)] }), rpc('verifier', pages), pool, 'boundary'), /CHART_HISTORY_INCOMPLETE/)
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('verifier', pages), pool, 'boundary', { pageSize: 2, maxPages: 1 }), /CHART_HISTORY_LIMIT/)
})

test('a separate current-state verifier cannot conceal a non-independent archive provider', async () => {
  const manifest = readFileSync(new URL('../config/existing-market-custody.json', import.meta.url))
  await assert.rejects(runRecoveryCharts({
    TRADING_CUSTODY_RECOVERY_SHA256: createHash('sha256').update(manifest).digest('hex'),
    RECOVERY_CHART_DATABASE_URL: 'postgres://repoing_chart_recovery@127.0.0.1:1/chart?sslmode=verify-full',
    SOLANA_RPC_URL: 'https://primary.invalid/current',
    SOLANA_VERIFICATION_RPC_URL: 'https://independent.invalid',
    SOLANA_ARCHIVE_VERIFICATION_RPC_URL: 'https://primary.invalid/archive',
  }), /INDEPENDENT_RPC_REQUIRED/)
})

const pacedEnv = {
  RECOVERY_CHART_RPC_MODE: 'archival-paced',
  SOLANA_RPC_URL: 'https://primary.invalid/read',
  SOLANA_VERIFICATION_RPC_URL: 'https://pruned.invalid',
  SOLANA_ARCHIVE_VERIFICATION_RPC_URL: 'https://archive.invalid/read',
}

test('chart archival mode shares alias pacing through body completion, without changing legacy selection', async () => {
  assert.equal(typeof charts.createRecoveryChartProviders, 'function')
  const starts = []; let active = 0, peak = 0
  const providers = charts.createRecoveryChartProviders(pacedEnv, async (url, options) => {
    assert.equal(new URL(url).hostname, 'archive.invalid')
    const { id } = JSON.parse(options.body)
    starts.push(performance.now()); active++; peak = Math.max(peak, active)
    return new Response(new ReadableStream({ async start(controller) {
      await delay(starts.length === 1 ? 1200 : 5)
      controller.enqueue(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: 123 })))
      active--; controller.close()
    } }))
  })
  assert.deepEqual(await Promise.all([
    providers.verification.getBlockTime(1), providers.archiveVerification.getBlockTime(2),
    providers.verification.getBlockTime(3),
  ]), [123, 123, 123])
  assert.equal(peak, 1)
  assert.ok(starts[1] - starts[0] >= 1200, 'headers must not release the endpoint queue')
  assert.ok(starts[2] - starts[1] >= 1000, 'short bodies must still respect start spacing')
  const legacy = charts.createRecoveryChartProviders({ ...pacedEnv, RECOVERY_CHART_RPC_MODE: undefined })
  assert.equal(legacy.verification.rpcEndpoint, pacedEnv.SOLANA_VERIFICATION_RPC_URL)
  assert.equal(legacy.archiveVerification.rpcEndpoint, pacedEnv.SOLANA_ARCHIVE_VERIFICATION_RPC_URL)
  assert.throws(() => charts.createRecoveryChartProviders({ ...pacedEnv, RECOVERY_CHART_RPC_MODE: 'typo' }), /CHART_RPC_MODE/)
  assert.throws(() => charts.createRecoveryChartProviders({ ...pacedEnv, SOLANA_ARCHIVE_VERIFICATION_RPC_URL: undefined }), /CHART_RPC_CONFIG/)
})

test('paced chart transport fails closed on HTTP/RPC errors and cancels queued aliases without retries or secrets', async () => {
  assert.equal(typeof charts.createRecoveryChartProviders, 'function')
  for (const status of [429, 503, 200]) {
    let requests = 0
    const providers = charts.createRecoveryChartProviders(pacedEnv, async (_url, options) => {
      requests++
      const { id } = JSON.parse(options.body)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: 'SECRET_SENTINEL' } }), { status })
    })
    const results = await Promise.allSettled([providers.verification.getBlockTime(1), providers.archiveVerification.getBlockTime(2)])
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      assert.match(result.reason.message, /CHART_RPC_FAILED/)
      assert.equal(result.reason.message.includes('SECRET_SENTINEL'), false)
    }
    await assert.rejects(providers.connection.getGenesisHash(), /CHART_RPC_FAILED/)
    assert.equal(requests, 1)
    assert.throws(() => providers.assertSafe(), /CHART_RPC_FAILED/)
  }
})

test('paced chart transport cannot send transactions or fall back after a denied request', async () => {
  assert.equal(typeof charts.createRecoveryChartProviders, 'function')
  let requests = 0
  const providers = charts.createRecoveryChartProviders(pacedEnv, async () => { requests++; throw Error('must not fetch') })
  await assert.rejects(providers.connection.sendRawTransaction(Buffer.from([1])), /CHART_RPC_DENIED/)
  await assert.rejects(providers.connection.getGenesisHash(), /CHART_RPC_DENIED/)
  assert.equal(requests, 0)
})

test('writer diagnostics retain SQLSTATE and cleanup evidence without error text or identity leakage', async () => {
  assert.equal(typeof charts.createChartDiagnostics, 'function')
  const diagnostics = charts.createChartDiagnostics(), worker = diagnostics.scope(2)
  worker.market(7); worker.market(11)
  const error = Object.assign(Error('SECRET_SENTINEL'), { code: '23514', constraint: 'private_constraint',
    table: 'private_table', detail: 'SECRET_SENTINEL', hint: 'SECRET_SENTINEL', schema: 'SECRET_SENTINEL' })
  const db = { async query(sql) { if (sql === 'rollback') return { rowCount: null }; throw error } }
  await assert.rejects(worker.query(db, 'insert into public.trade_events values ($1)', ['SECRET_SENTINEL']), e => e === error)
  await worker.query(db, 'rollback')
  diagnostics.lockRelease('SUCCEEDED')
  const [report] = diagnostics.reports()
  assert.equal(report.phase, 'TRADE_INSERT'); assert.equal(report.operation, 'INSERT')
  assert.equal(report.sqlstate, '23514'); assert.equal(report.rollback, 'SUCCEEDED'); assert.equal(report.lockRelease, 'SUCCEEDED')
  assert.deepEqual([report.worker, report.marketFirst, report.marketLast, report.marketIndex], [2, 7, 11, 11])
  assert.equal(report.constraintHash, createHash('sha256').update('private_constraint').digest('hex'))
  assert.equal(report.tableHash, createHash('sha256').update('private_table').digest('hex'))
  assert.equal(report.indexHash, null, 'pg exposes constraint identity, not a separate index field')
  assert.equal(/SECRET_SENTINEL|private_constraint|private_table/.test(JSON.stringify(report)), false)
  assert.equal(charts.validateChartDiagnostic(report), true)
  for (const patch of [{ message: 'SECRET_SENTINEL' }, { phase: 'UNKNOWN' }, { sqlstate: 'ABCDE' },
    { operation: 'SECRET_SENTINEL' }, { worker: 4 }, { elapsedMs: Infinity }, { marketIndex: -2 },
    { constraintHash: 'SECRET_SENTINEL' }, { rollback: 'UNKNOWN_STATUS' }]) {
    assert.equal(charts.validateChartDiagnostic({ ...report, ...patch }), false)
  }
})

test('diagnostics preserve the primary error when rollback fails, bound output and never invoke error getters', async () => {
  assert.equal(typeof charts.createChartDiagnostics, 'function')
  const diagnostics = charts.createChartDiagnostics(), scope = diagnostics.scope(0)
  const primary = Object.assign(Error('SECRET_SENTINEL'), { code: '42501' })
  const secondary = Object.assign(Error('SECRET_SENTINEL'), { code: '08006' })
  await assert.rejects(scope.query({ query: async () => { throw primary } }, 'insert into recovery_charts.cursors values ($1)'), e => e === primary)
  await assert.rejects(scope.query({ query: async () => { throw secondary } }, 'rollback'), e => e === secondary)
  scope.fail(secondary)
  diagnostics.lockRelease('FAILED')
  const [report] = diagnostics.reports()
  assert.equal(report.sqlstate, '42501'); assert.equal(report.rollback, 'FAILED'); assert.equal(report.lockRelease, 'FAILED')
  const other = diagnostics.scope(1)
  const hostile = Object.defineProperty({}, 'code', { get() { throw Error('must not inspect') } })
  other.fail(hostile)
  other.fail(primary)
  assert.equal(diagnostics.reports()[1].sqlstate, null)
  assert.equal(diagnostics.reports().length, 2)
  assert.equal(JSON.stringify(diagnostics.reports()).includes('SECRET_SENTINEL'), false)
})

test('chart workers share one batched pool/config read per provider instead of reading per market', async () => {
  assert.equal(typeof charts.createChartCurveReads, 'function')
  const { Keypair } = await import('@solana/web3.js')
  const { NATIVE_MINT } = await import('@solana/spl-token')
  const { deriveDbcPoolAddress } = await import('@meteora-ag/dynamic-bonding-curve-sdk')
  const config = Keypair.generate().publicKey
  const markets = Array.from({ length: 78 }, () => {
    const mint = Keypair.generate().publicKey
    return { mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, config).toBase58() }
  })
  const provider = name => {
    const calls = { accounts: 0, times: 0 }
    return { calls, rpcEndpoint: `https://${name}.invalid`,
      getMultipleAccountsInfoAndContext: async keys => {
        calls.accounts++; await delay(20)
        return { context: { slot: 10 }, value: keys.map(key => ({ owner: config, data: Buffer.from(`${name}:${key.toBase58()}`) })) }
      },
      getBlockTime: async () => { calls.times++; return 1_700_000_000 } }
  }
  const primary = provider('primary'), verification = provider('verification')
  const reads = charts.createChartCurveReads({ connection: primary, verification, config: config.toBase58(), markets })
  const pending = [...markets], seen = []
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const market = pending.shift()
      const [mine] = await reads.read(market)
      seen.push(mine.snapshot.value[0].data.toString() === `primary:${market.pool}`)
    }
  }))
  assert.equal(seen.length, 78)
  assert.ok(seen.every(Boolean), 'each market gets its own pool account')
  assert.deepEqual([primary.calls.accounts, verification.calls.accounts], [1, 1], '78 pools + 1 config fit one 100-account batch')
  assert.deepEqual([primary.calls.times, verification.calls.times], [1, 1])
})

test('the paced transport reports its first failure code so a wrapped RPC error is not misread', async () => {
  assert.equal(typeof charts.createRecoveryChartProviders, 'function')
  const providers = charts.createRecoveryChartProviders(pacedEnv, async (_url, options) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: 1 }), { status: 429 }))
  await assert.rejects(providers.connection.getGenesisHash())
  assert.equal(providers.failure(), 'CHART_RPC_FAILED')
  providers.stop('CHART_SLOT_MISMATCH')
  assert.equal(providers.failure(), 'CHART_RPC_FAILED', 'the first failure wins')
  const quiet = charts.createRecoveryChartProviders(pacedEnv, async () => { throw Error('unused') })
  assert.equal(quiet.failure(), undefined)
  quiet.stop('RPC_DISAGREEMENT')
  assert.equal(quiet.failure(), 'RPC_DISAGREEMENT')
})

test('RPC hiccups exit retryable, one-off read failures retry in process, data problems never retry', () => {
  assert.equal(typeof charts.chartFailure, 'function')
  assert.equal(charts.CHART_RETRY_EXIT, 75)
  for (const code of ['CHART_RPC_FAILED', 'STALE_PROGRESS', 'RPC_UNAVAILABLE', 'RPC_RATE_LIMITED']) {
    assert.deepEqual(charts.chartFailure(Error(code)), { code, retryable: true, transient: true }, code)
  }
  for (const code of ['CHART_SLOT_MISMATCH', 'RPC_DISAGREEMENT', 'CHART_HISTORY_INCOMPLETE', 'CHART_HISTORY_LIMIT',
    'CONFIG_OR_POOL_MISMATCH', 'MIGRATION_EVIDENCE_INCOMPLETE', 'NETWORK_MISMATCH', 'CHART_RPC_DENIED', 'CHART_RPC_LIMIT',
    'INCOMPLETE_CYCLE', 'CUSTODY_BINDING_REQUIRED', 'CHART_DATA_REJECTED']) {
    assert.deepEqual(charts.chartFailure(Error(code)), { code, retryable: false, transient: false }, code)
  }
  // A dropped connection or a client-side query timeout carries no code: a one-off read failure.
  assert.deepEqual(charts.chartFailure(Error('CHART_READ_UNAVAILABLE')), { code: 'CHART_READ_UNAVAILABLE', retryable: false, transient: true })
  assert.deepEqual(charts.chartFailure(Error('connect ECONNREFUSED 10.0.0.1:5432 SECRET_SENTINEL')), { code: 'UNCLASSIFIED', retryable: false, transient: true })
  assert.deepEqual(charts.chartFailure(Error('Query read timeout')), { code: 'UNCLASSIFIED', retryable: false, transient: true })
  assert.deepEqual(charts.chartFailure(null), { code: 'UNCLASSIFIED', retryable: false, transient: true })
  // The database refusing the data itself (duplicate, constraint, bad value, permission) is a data problem.
  for (const sqlstate of ['23505', '23514', '22P02', '42501']) {
    assert.deepEqual(charts.chartFailure(Object.assign(Error('duplicate key value'), { code: sqlstate })),
      { code: 'CHART_DATA_REJECTED', retryable: false, transient: false }, sqlstate)
  }
  assert.equal(charts.chartFailure(Object.assign(Error('terminating connection'), { code: '57P01' })).transient, true)
})

test('a one-off read failure gets three retries with backoff; a data problem stops at once', async () => {
  const run = failures => {
    const waits = [], retries = []
    let attempts = 0
    const result = charts.runChartsWithRetries(async attempt => {
      assert.equal(attempt, attempts++)
      if (failures.length) throw failures.shift()
      return 'done'
    }, { sleep: async ms => { waits.push(ms) }, onRetry: r => retries.push(r.attempt) })
    return { result, waits, retries, attempts: () => attempts }
  }
  assert.deepEqual(charts.CHART_RETRY_DELAYS_MS, [10000, 30000, 90000])
  const recovered = run([Error('Connection terminated unexpectedly'), Error('CHART_READ_UNAVAILABLE')])
  assert.equal(await recovered.result, 'done')
  assert.deepEqual(recovered.waits, [10000, 30000])
  assert.deepEqual(recovered.retries, [1, 2])
  const persistent = run(Array.from({ length: 5 }, () => Error('CHART_READ_UNAVAILABLE')))
  await assert.rejects(persistent.result, /CHART_READ_UNAVAILABLE/)
  assert.equal(persistent.attempts(), 4, 'the first try plus three retries')
  assert.deepEqual(persistent.waits, [10000, 30000, 90000])
  for (const code of ['CHART_SLOT_MISMATCH', 'CHART_HISTORY_INCOMPLETE', 'RPC_DISAGREEMENT', 'INCOMPLETE_CYCLE']) {
    const data = run([Error(code)])
    await assert.rejects(data.result, new RegExp(code))
    assert.equal(data.attempts(), 1, code)
    assert.deepEqual(data.waits, [], code)
  }
  const duplicate = run([Object.assign(Error('duplicate key value'), { code: '23505' })])
  await assert.rejects(duplicate.result, /duplicate/)
  assert.equal(duplicate.attempts(), 1)
  // No retry starts that would end past the budget (the unit's start timeout).
  let clock = 0, attempts = 0
  await assert.rejects(charts.runChartsWithRetries(async () => { attempts++; clock += 200000; throw Error('CHART_READ_UNAVAILABLE') },
    { budgetMs: 420000, now: () => clock, sleep: async ms => { clock += ms } }), /CHART_READ_UNAVAILABLE/)
  assert.equal(attempts, 2)
})

test('the logged failure reason is the root error, with URLs, addresses and long tokens removed', () => {
  assert.equal(typeof charts.chartReason, 'function')
  const root = Object.assign(Error('connect ECONNREFUSED 10.0.0.1:5432 via https://rpc.example/?api-key=SECRET_KEY_VALUE ' +
    'key 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), { code: 'ECONNREFUSED' })
  const reason = charts.chartReason(Error('CHART_READ_UNAVAILABLE', { cause: root }))
  assert.equal(reason.name, 'Error')
  assert.equal(reason.code, 'ECONNREFUSED')
  assert.equal(reason.message, 'connect ECONNREFUSED <ip> via <url> key <redacted>')
  assert.match(reason.at, /^recovery-chart-indexer\.test\.mjs:\d+$/)
  assert.equal(/SECRET_KEY_VALUE|10\.0\.0\.1|7xKXtg/.test(JSON.stringify(reason)), false)
  assert.equal(charts.chartReason(Error('Query read timeout')).message, 'Query read timeout')
  assert.equal(charts.chartReason(Object.assign(Error('x'.repeat(500)), { name: 'TypeError' })).message.length <= 200, true)
  assert.equal(charts.chartReason(null), null)
  assert.equal(charts.chartReason('text'), null)
})

test('a market with no earlier history is read from its own finalized launch transaction, and must end exactly there', async () => {
  const pages = { head: [item('buy', 30), item('launch', 20)] }
  assert.deepEqual(await recoveryHistory(rpc('primary', pages), rpc('verifier', pages), pool, null, { origin: 'launch', pageSize: 3 }),
    [item('launch', 20), item('buy', 30)], 'the launch transaction is included: it carries the first buy')
  const older = { head: [item('buy', 30), item('launch', 20), item('older', 10)] }
  await assert.rejects(recoveryHistory(rpc('primary', older), rpc('verifier', older), pool, null, { origin: 'launch', pageSize: 5 }),
    /CHART_HISTORY_INCOMPLETE/, 'activity before the recorded launch means the origin is wrong')
  await assert.rejects(recoveryHistory(rpc('primary', { head: [item('buy', 30)] }), rpc('verifier', { head: [item('buy', 30)] }), pool, null,
    { origin: 'launch', pageSize: 5 }), /CHART_HISTORY_INCOMPLETE/, 'history must reach the launch')
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('verifier', { head: [item('other', 30), item('launch', 20)] }), pool, null,
    { origin: 'launch', pageSize: 3 }), /RPC_DISAGREEMENT/)
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('verifier', pages), pool, null), /CHART_BASELINE_REQUIRED/,
    'without a boundary or a launch origin the market is still refused')
})

// 2026-10-26: an env edit on the indexer host dropped 3ZESQ from DBC_LEGACY_CONFIGS and its markets stopped charting.
test('the custody launch configs are always charted, whatever DBC_LEGACY_CONFIGS says', async () => {
  const { CUSTODY_LAUNCH_CONFIGS } = await import('../src/launch-custody.mjs')
  const custody = Object.keys(CUSTODY_LAUNCH_CONFIGS)
  const legacy = 'D7oz8xQ4seaNaEgiDS4fu3YJfmUvR5iPuznxuqKV4u1c'
  for (const env of ['', legacy, `${legacy}, ${custody[0]}`]) {
    const configs = charts.chartLegacyConfigs(env)
    for (const key of custody) assert(configs.includes(key), `${key} missing for ${JSON.stringify(env)}`)
    assert.equal(new Set(configs).size, configs.length)
  }
  assert(charts.chartLegacyConfigs(legacy).includes(legacy))
})
