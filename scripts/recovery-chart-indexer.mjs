// Chain reads and chart inserts only. Never run the general worker during recovery.
// Independent cursors must never advance the fee/accounting indexer's checkpoints.
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { Connection, PublicKey } from '@solana/web3.js'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { agreeGraduation, agreedFinalizedTransaction, createCurveReads, evidenceJSON, readGraduationState } from '../src/graduation-state.mjs'
import { publicGraduation } from '../src/graduation-readiness.mjs'
import { canonicalTradeEvents } from '../src/trade-evidence.mjs'
import { dammSwapEvents } from '../src/damm-trades.mjs'
import { createMarketConfigResolver } from '../src/market-config.mjs'
import { chartMigration } from '../src/market-chart.mjs'
import { createChartDiagnostics } from './recovery-chart-diagnostics.mjs'
export { createChartDiagnostics, validateChartDiagnostic } from './recovery-chart-diagnostics.mjs'

export function createRecoveryChartProviders(env, fetchImpl = globalThis.fetch) {
  // Existing Mac invocations stay unchanged until the explicitly reviewed handoff.
  if (env.RECOVERY_CHART_RPC_MODE === undefined) {
    const connection = new Connection(env.SOLANA_RPC_URL, 'finalized')
    const verification = new Connection(env.SOLANA_VERIFICATION_RPC_URL, 'finalized')
    const archiveVerification = env.SOLANA_ARCHIVE_VERIFICATION_RPC_URL
      ? new Connection(env.SOLANA_ARCHIVE_VERIFICATION_RPC_URL, 'finalized') : verification
    return { connection, verification, archiveVerification }
  }
  if (env.RECOVERY_CHART_RPC_MODE !== 'archival-paced') throw Error('CHART_RPC_MODE')
  const endpoints = [env.SOLANA_RPC_URL, env.SOLANA_ARCHIVE_VERIFICATION_RPC_URL]
  try {
    if (endpoints.some(e => new URL(e).protocol !== 'https:')) throw Error()
    // This detects hostname reuse, not common provider operators or upstreams.
    if (new URL(endpoints[0]).hostname === new URL(endpoints[1]).hostname) throw Error()
  } catch { throw Error('CHART_RPC_CONFIG') }
  const queues = new Map(), abort = new AbortController()
  let failure, calls = 0, bytes = 0
  const stop = (code = 'CHART_RPC_FAILED') => { failure ??= code; abort.abort() }
  const assertSafe = () => { if (failure) throw Error(failure) }
  const fetch = async (endpoint, options) => {
    assertSafe()
    try {
      const { method, params } = JSON.parse(options.body)
      const finalized = Array.isArray(params) && params.length === 2 && params[1]?.commitment === 'finalized'
      const allowed = method === 'getGenesisHash' && params.length === 0 ||
        method === 'getBlockTime' && params.length === 1 && Number.isSafeInteger(params[0]) && params[0] >= 0 ||
        finalized && (['getTransaction', 'getAccountInfo'].includes(method) ||
          method === 'getMultipleAccounts' && Array.isArray(params[0]) && params[0].length <= 100 ||
          method === 'getSignaturesForAddress' && Number.isInteger(params[1].limit) && params[1].limit > 0 && params[1].limit <= 1000)
      if (!allowed) { stop('CHART_RPC_DENIED'); assertSafe() }
      if (++calls > 2000) { stop('CHART_RPC_LIMIT'); assertSafe() }
      const origin = new URL(endpoint).origin
      if (!queues.has(origin)) queues.set(origin, { tail: Promise.resolve(), lastStart: -Infinity })
      const queue = queues.get(origin)
      const task = queue.tail.then(async () => {
        try {
          assertSafe()
          while (performance.now() - queue.lastStart < 1000) {
            await delay(Math.ceil(1000 - (performance.now() - queue.lastStart)), undefined, { signal: abort.signal })
          }
          assertSafe()
          const responsePromise = fetchImpl(endpoint, { ...options, redirect: 'error',
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) })
          queue.lastStart = performance.now()
          const response = await responsePromise
          if (!response.ok) { await response.body?.cancel(); throw Error() }
          const reader = response.body.getReader(), chunks = []; let size = 0
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              size += value.byteLength; bytes += value.byteLength
              if (size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw Error()
              chunks.push(Buffer.from(value))
            }
          } finally { await reader.cancel() }
          assertSafe()
          const text = Buffer.concat(chunks).toString('utf8'), payload = JSON.parse(text)
          if (payload.error || !Object.hasOwn(payload, 'result')) throw Error()
          return new Response(text, { status: 200 })
        } catch { stop(); assertSafe() }
      })
      // Aliases share the slot until their entire body is consumed and checked.
      queue.tail = task.catch(() => {})
      return await task
    } catch { stop(); assertSafe() }
  }
  const [connection, verification] = endpoints.map(endpoint => new Connection(endpoint,
    { commitment: 'finalized', fetch, disableRetryOnRateLimit: true, httpAgent: false }))
  return { connection, verification, archiveVerification: verification, assertSafe, stop, failure: () => failure }
}

// A failed pass exits CHART_RETRY_EXIT only for provider hiccups, so the unit retries instead of latching.
// Data problems (mismatch, disagreement, incomplete history) and anything unrecognised still latch.
export const CHART_RETRY_EXIT = 75
const RETRYABLE_FAILURES = new Set(['CHART_RPC_FAILED', 'STALE_PROGRESS', 'RPC_UNAVAILABLE', 'RPC_RATE_LIMITED'])
export function chartFailure(error) {
  const code = typeof error?.message === 'string' && /^[A-Z_]+$/.test(error.message) ? error.message : 'UNCLASSIFIED'
  return { code, retryable: RETRYABLE_FAILURES.has(code) }
}

// Pool and config accounts for a whole pass, batched like the graduation worker's reads. Concurrent workers
// queue behind one another so an expired batch is reloaded once, not once per worker.
export function createChartCurveReads(options) {
  const reads = createCurveReads(options)
  let tail = Promise.resolve()
  return { read(market) {
    const result = tail.then(() => reads.read(market))
    tail = result.catch(() => {})
    return result
  } }
}

export async function recoveryHistory(connection, verification, address, boundary, { pageSize = 100, maxPages = 10 } = {}) {
  if (!verification || connection.rpcEndpoint === verification.rpcEndpoint) throw Error('INDEPENDENT_RPC_REQUIRED')
  if (!boundary) throw Error('CHART_BASELINE_REQUIRED')
  const walk = async rpc => {
    const result = []; let before
    for (let n = 0; n < maxPages; n++) {
      const page = await rpc.getSignaturesForAddress(new PublicKey(address), { limit: pageSize, ...(before ? { before } : {}) }, 'finalized')
      for (const { signature, slot, err } of page) {
        if (signature === boundary) return result.reverse()
        result.push({ signature, slot, err })
      }
      if (page.length < pageSize) throw Error('CHART_HISTORY_INCOMPLETE')
      before = page.at(-1).signature
    }
    throw Error('CHART_HISTORY_LIMIT')
  }
  return agreeGraduation(...await Promise.all([connection, verification].map(walk)))
}

export async function indexRecoveryMarket({ db, connection, verification, market, migration, config, legacyConfigs, assertSafe = () => {}, diagnostics }) {
  const address = migration?.pool ?? market.pool
  const resolve = createMarketConfigResolver(config, legacyConfigs)
  const configKey = resolve(market) // even a migrated market must derive from an approved curve config
  const { rows: [cursor] } = await db.query('select signature from recovery_charts.cursors where pool=$1', [address])
  // The reviewed pre-recovery accounting checkpoint is only a starting boundary. Never update it here.
  const { rows: [baseline] } = cursor ? { rows: [] } : await db.query('select last_signature as signature from public.pool_fee_cursors where pool=$1', [address])
  diagnostics?.phase('HISTORY')
  const history = await recoveryHistory(connection, verification, address, cursor?.signature ?? baseline?.signature)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized'), coder = new CpAmm(connection)._program.coder
  let inserted = 0
  for (const item of history) {
    diagnostics?.phase('TRANSACTION_READ')
    const tx = item.err ? null : await agreedFinalizedTransaction(connection, verification, item.signature)
    if (tx && (tx.slot !== item.slot || (migration && BigInt(tx.slot) < BigInt(migration.slot)))) throw Error('CHART_SLOT_MISMATCH')
    diagnostics?.phase('COMPUTE')
    const events = !tx ? [] : migration ? dammSwapEvents(tx, market, address, coder)
      : canonicalTradeEvents(tx, { ...market, signature: item.signature }, configKey, dbc)
    diagnostics?.phase('GUARD')
    assertSafe()
    await db.query('begin')
    try {
      for (const e of events) {
        const result = migration ? await db.query(`insert into public.damm_trade_events
          (github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,next_sqrt_price,trader,base_amount)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(signature,event_index) do nothing`,
        [market.repoId,address,item.signature,e.eventIndex,item.slot,e.tradedAt,e.quoteAmount,e.direction,evidenceJSON(e.evidence),e.nextSqrtPrice,e.trader,e.baseAmount])
          : await db.query(`insert into public.trade_events
          (pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(signature,event_index) do nothing`,
          [address,item.signature,e.eventIndex,item.slot,e.tradedAt,e.direction,e.inputBaseUnits,e.outputBaseUnits,e.nextSqrtPrice,e.trader])
        inserted += result.rowCount
      }
      await db.query(`insert into recovery_charts.cursors(pool,signature,slot,checked_at) values($1,$2,$3,now())
        on conflict(pool) do update set signature=excluded.signature,slot=excluded.slot,checked_at=now()`, [address,item.signature,item.slot])
      assertSafe()
      await db.query('commit')
    } catch (error) { diagnostics?.fail(error); await db.query('rollback'); throw error }
  }
  // A successful idle check is freshness evidence, not a fabricated trade timestamp.
  assertSafe()
  await db.query('update recovery_charts.cursors set checked_at=now() where pool=$1', [address])
  return { repoId: market.repoId, transactions: history.length, inserted }
}

export async function runRecoveryCharts(env = process.env, diagnostics = createChartDiagnostics()) {
  const coordinator = diagnostics.scope()
  const manifestBytes = readFileSync(new URL('../config/existing-market-custody.json', import.meta.url))
  if (createHash('sha256').update(manifestBytes).digest('hex') !== env.TRADING_CUSTODY_RECOVERY_SHA256) throw Error('CUSTODY_BINDING_REQUIRED')
  const custodyRecovery = JSON.parse(manifestBytes)
  const url = new URL(env.RECOVERY_CHART_DATABASE_URL)
  if (url.username !== 'repoing_chart_recovery' || url.searchParams.get('sslmode') !== 'verify-full' ||
    [...url.searchParams.keys()].some(k => k !== 'sslmode')) throw Error('CHART_ROLE_REQUIRED')
  const db = coordinator.wrap(new pg.Client({ connectionString: url.toString(), application_name: 'repoing-chart-recovery',
    statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 }))
  const rpc = createRecoveryChartProviders(env)
  const { connection, verification, archiveVerification } = rpc
  const providers = [...new Set([connection, verification, archiveVerification])]
  if ([verification, archiveVerification].some(c => new URL(connection.rpcEndpoint).hostname === new URL(c.rpcEndpoint).hostname)) throw Error('INDEPENDENT_RPC_REQUIRED')
  let locked = false, readers
  try {
    await db.connect()
    if ((await db.query('select current_user as role')).rows[0].role !== 'repoing_chart_recovery') throw Error('CHART_ROLE_REQUIRED')
    coordinator.phase('GENESIS')
    if ((await Promise.all(providers.map(c => c.getGenesisHash()))).some(hash => hash !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')) throw Error('NETWORK_MISMATCH')
    locked = (await db.query("select pg_try_advisory_lock(hashtext('recovery-charts')) as locked")).rows[0].locked
    if (!locked) return { busy: true }
    const { rows: markets } = await db.query(`select github_repo_id::text as "repoId",mint,pool,bundle_id as "bundleId",creator_wallet as "creatorWallet",
      early_access_end as "earlyAccessEnd",transfer_hook_program as "transferHookProgram"
      from public.markets where status='confirmed' and indexed_at is not null and launch_finality='finalized' and quote_asset_id is null`)
    const { rows: graduates } = await db.query('select * from public.graduation_events')
    // A slow serial RPC pass can exceed the observation freshness window. Each
    // reader owns its DB session so chart transactions never interleave; the
    // separate coordinator connection retains the process-wide advisory lock.
    readers = new pg.Pool({ connectionString: url.toString(), application_name: 'repoing-chart-reader', max: 4,
      statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 })
    const results = [], pending = [...markets], curveReads = new Map()
    const curveReadsFor = verifier => {
      if (!curveReads.has(verifier)) curveReads.set(verifier, createChartCurveReads({ connection, verification: verifier, config: env.DBC_CONFIG, markets }))
      return curveReads.get(verifier)
    }
    const work = async (_unused, worker) => {
      const trace = diagnostics.scope(worker)
      trace.phase('CONNECT')
      let client
      try { client = await readers.connect() } catch (e) { trace.fail(e); throw e }
      const db = trace.wrap(client)
      try {
        while (pending.length) {
          rpc.assertSafe?.()
          trace.market(markets.length - pending.length)
          const market = pending.shift()
          const result = { repoId: market.repoId }
          try {
            trace.phase('COMPUTE')
            const graduation = graduates.find(g => String(g.github_repo_id) === market.repoId)
            const migration = chartMigration(market, graduation)
            const verifier = migration ? archiveVerification : verification
            Object.assign(result, await indexRecoveryMarket({ db, connection, verification: verifier, market, migration, config: env.DBC_CONFIG, legacyConfigs: env.DBC_LEGACY_CONFIGS, assertSafe: rpc.assertSafe, diagnostics: trace }))
            trace.phase('GRADUATION')
            const state = await readGraduationState({ db, connection, verification: verifier, market, config: env.DBC_CONFIG, custodyRecovery,
              curveReads: curveReadsFor(verifier) })
            if (state.migration) {
              const { rows: [volume] } = await db.query(`select coalesce(sum(quote_amount),0)::text as lamports
                from public.damm_trade_events where github_repo_id=$1 and pool=$2 and slot >= $3
                  and traded_at >= now()-interval '24 hours'`, [market.repoId,migration.pool,migration.slot])
              state.dammVolume24hLamports = volume.lamports
            }
            // Use the same freshness and immutable migration checks the public endpoint enforces.
            publicGraduation({ status: 'VERIFIED', observation: JSON.stringify(state), migration_evidence_hash: graduation?.evidence_hash })
            const { accountEvidence, positionEvidence, platform, partnerWallet, ...display } = state
            rpc.assertSafe?.()
            await db.query(`insert into recovery_charts.observations(github_repo_id,checked_at,observation) values($1,$2,$3)
              on conflict(github_repo_id) do update set checked_at=excluded.checked_at,observation=excluded.observation`, [market.repoId,state.checkedAt,JSON.stringify(display)])
            result.progress = state.phase
          } catch (e) {
            trace.fail(e)
            result.error = /^[A-Z_]+$/.test(e.message) ? e.message : 'CHART_READ_UNAVAILABLE'
            // The first failure is the cause; later markets only see the stopped transport.
            if (rpc.stop) { rpc.stop(result.error); throw Error(rpc.failure()) }
          }
          results.push(result)
          await new Promise(r => setTimeout(r, 500))
        }
      } catch (e) { trace.fail(e); throw e } finally { db.release() }
    }
    coordinator.phase('WORKERS')
    await Promise.allSettled(Array.from({ length: Math.min(4, markets.length) }, work)).then(outcomes => {
      const failed = outcomes.find(outcome => outcome.status === 'rejected')
      if (failed) throw failed.reason
    })
    return { at: new Date().toISOString(), results }
  } catch (e) {
    coordinator.fail(e); throw e
  } finally {
    coordinator.phase('POOL_DRAIN')
    try { await readers?.end() } catch (e) { coordinator.fail(e); throw e }
    if (locked) await db.query("select pg_advisory_unlock(hashtext('recovery-charts'))")
      .then(result => diagnostics.lockRelease(result.rows[0].pg_advisory_unlock === true ? 'SUCCEEDED' : 'FAILED'))
      .catch(() => { diagnostics.lockRelease('FAILED') })
    await db.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deadline = setTimeout(() => process.exit(1), 900000)
  try { console.log(JSON.stringify(await runRecoveryCharts())) }
  catch { console.error('CHART_RECOVERY_UNAVAILABLE'); process.exitCode = 1 }
  finally { clearTimeout(deadline) }
}
