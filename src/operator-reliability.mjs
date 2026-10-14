import { RELIABILITY_STAGES, deploymentVersion } from './worker-reliability.mjs'

export const RELIABILITY_LIMIT = 1000
export const RELIABILITY_DEFAULTS = Object.freeze({ workerStaleMs: 180_000, stageSlowMs: 300_000,
  reportStaleMs: 7_200_000, marketStaleMs: 7_200_000, pendingStaleMs: 900_000, dependencySlowMs: 1000 })
const ENV_KEYS = { workerStaleMs: 'OPS_WORKER_STALE_MS', stageSlowMs: 'OPS_STAGE_SLOW_MS', reportStaleMs: 'OPS_REPORT_STALE_MS',
  marketStaleMs: 'OPS_MARKET_STALE_MS', pendingStaleMs: 'OPS_PENDING_STALE_MS', dependencySlowMs: 'OPS_DEPENDENCY_SLOW_MS' }
export function reliabilityThresholds(env = process.env) {
  return Object.fromEntries(Object.entries(RELIABILITY_DEFAULTS).map(([key, fallback]) => {
    const value = Number(env[ENV_KEYS[key]])
    return [key, Number.isSafeInteger(value) && value >= 1000 && value <= 7 * 86400_000 ? value : fallback]
  }))
}
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null
const age = (value, now) => iso(value) && new Date(value).getTime() <= now ? now - new Date(value).getTime() : null
const observation = (status, summary, action, data = {}) => ({ status, summary, action, ...data })

// Read only scalar timestamps/statuses; no report JSON, addresses, job results, webhook URLs or identities.
export const RELIABILITY_SQL = Object.freeze({
  worker: 'select snapshot from operator_worker_snapshot where id = 1',
  markets: `select m.indexed_at as "indexedAt", q.assessed_at as "assessedAt", s.sampled_at as "sampledAt"
    from (select github_repo_id, indexed_at from markets where status = 'confirmed' and indexed_at is not null
      and launch_finality = 'finalized' and quote_asset_id is null order by id limit 1001) m
    left join launch_quality_reports q on q.github_repo_id = m.github_repo_id
    left join lateral (select sampled_at from market_liquidity_samples where github_repo_id = m.github_repo_id
      order by sampled_at desc limit 1) s on true`,
  pending: `select status, created_at as "createdAt" from markets where status in ('prepared', 'submitted', 'ambiguous')
    order by created_at limit 1001`,
  webhooks: `select status, next_attempt_at as "nextAttemptAt", attempts from launch_webhook_deliveries
    where status in ('pending', 'sending') order by next_attempt_at limit 1001`,
  failures: `select created_at as "createdAt" from launch_webhook_deliveries where status = 'failed' and created_at >= $1
    order by created_at desc limit 1001`,
})

export function workerObservation(snapshot, now, thresholds) {
  if (!snapshot) return observation('unknown', 'No worker snapshot recorded.', 'Apply migration 0074 and deploy the instrumented worker. No heartbeat is not evidence of an idle queue.', { stages: [] })
  const lagMs = age(snapshot.capturedAt, now)
  const stages = (Array.isArray(snapshot.stages) ? snapshot.stages : []).filter(s => RELIABILITY_STAGES.includes(s.name)).slice(0, RELIABILITY_STAGES.length).map(s => {
    const elapsedMs = s.state === 'running' ? age(s.lastStartedAt, now) : null
    const durationMs = Number.isFinite(s.durationMs) && s.durationMs >= 0 ? s.durationMs : null
    const state = ['running', 'completed', 'degraded', 'incomplete', 'failed'].includes(s.state) ? s.state : 'unknown'
    const slow = (elapsedMs ?? durationMs ?? 0) > thresholds.stageSlowMs
    return { name: s.name, state, slow, elapsedMs, durationMs, lastStartedAt: iso(s.lastStartedAt),
      lastFinishedAt: iso(s.lastFinishedAt), lastSuccessAt: iso(s.lastSuccessAt) }
  })
  const stale = lagMs === null || lagMs > thresholds.workerStaleMs
  const degraded = stages.some(s => s.slow || ['failed', 'degraded', 'incomplete'].includes(s.state))
  return observation(stale || degraded ? 'degraded' : stages.length ? 'ok' : 'unknown',
    stale ? 'Worker snapshot is stale or its clock is ahead.' : degraded ? 'Worker stages need attention.' : stages.length ? 'Worker snapshot is fresh.' : 'Worker has not reported a stage yet.',
    stale ? 'Check the worker process, its database access, and clock synchronization. A fresh web page does not refresh worker evidence.'
      : 'Review failed, incomplete or slow stages in worker logs. Completed means no recognized error was returned, not that every market succeeded.',
    { lagMs, capturedAt: iso(snapshot.capturedAt), startedAt: iso(snapshot.startedAt), version: deploymentVersion({ REPOING_COMMIT_SHA: snapshot.version }), stages })
}

export async function loadOperatorReliability({ query, probeRpc, now = Date.now, env = process.env } = {}) {
  const at = now(), thresholds = reliabilityThresholds(env)
  const section = async work => {
    try { return await work() }
    catch (error) { return observation('unknown', error?.code === '42P01' ? 'Required table is not migrated.' : 'Observation unavailable.',
      'Check configuration, migrations and service connectivity. Query/probe deadlines are enforced; raw errors are withheld.') }
  }
  const read = async (key, values = []) => {
    if (!query) throw new Error('Database not configured')
    return (await query(RELIABILITY_SQL[key], values)).rows
  }
  const [database, rpc, worker, markets, pending, webhooks] = await Promise.all([
    section(async () => {
      if (!query) return observation('unknown', 'Database is not configured.', 'Set DATABASE_URL on the web service.')
      const start = now(); await query('select 1'); const latencyMs = Math.max(0, now() - start)
      return observation(latencyMs > thresholds.dependencySlowMs ? 'degraded' : 'ok', 'Database read probe completed.',
        'This measures a single SELECT, not replication, write availability or all application queries.', { latencyMs })
    }),
    section(async () => {
      if (!probeRpc) return observation('unknown', 'RPC is not configured.', 'Set SOLANA_RPC_URL on the web service.')
      const start = now(), slot = await probeRpc(), latencyMs = Math.max(0, now() - start)
      if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Invalid RPC response')
      return observation(latencyMs > thresholds.dependencySlowMs ? 'degraded' : 'ok', 'Confirmed-slot RPC probe completed.',
        'Reachability only: this does not verify cluster freshness, failover providers or transaction landing.', { latencyMs, slot })
    }),
    section(async () => workerObservation((await read('worker'))[0]?.snapshot, at, thresholds)),
    section(async () => {
      const all = await read('markets'), rows = all.slice(0, RELIABILITY_LIMIT)
      let reportsMissing = 0, reportsStale = 0, samplesMissing = 0, samplesStale = 0
      for (const row of rows) {
        if (!iso(row.assessedAt)) reportsMissing++
        else if (age(row.assessedAt, at) === null || age(row.assessedAt, at) > thresholds.reportStaleMs || new Date(row.assessedAt) <= new Date(row.indexedAt)) reportsStale++
        if (!iso(row.sampledAt)) samplesMissing++
        else if (age(row.sampledAt, at) === null || age(row.sampledAt, at) > thresholds.marketStaleMs) samplesStale++
      }
      const truncated = all.length > RELIABILITY_LIMIT
      return observation(reportsMissing + reportsStale + samplesMissing + samplesStale ? 'degraded' : truncated || !rows.length ? 'unknown' : 'ok',
        rows.length ? 'Stored transparency and liquidity freshness.' : 'No eligible markets observed.',
        'Check the transparency stage, sampling configuration and RPC limits. Old liquidity samples mean stale observations, not necessarily inactive trading.',
        { sampled: rows.length, truncated, reportsMissing, reportsStale, samplesMissing, samplesStale })
    }),
    section(async () => {
      const all = await read('pending'), rows = all.slice(0, RELIABILITY_LIMIT)
      const overdue = rows.filter(r => age(r.createdAt, at) === null || age(r.createdAt, at) > thresholds.pendingStaleMs).length
      return observation(overdue || all.length > RELIABILITY_LIMIT ? 'degraded' : 'ok', 'Launch work awaiting resolution.',
        'Inspect launch indexing and ambiguous evidence in Operations health. Do not blindly retry a transaction that may have landed.',
        { count: rows.length, truncated: all.length > RELIABILITY_LIMIT, overdue, oldestAt: iso(rows[0]?.createdAt) })
    }),
    section(async () => {
      const [all, failures] = await Promise.all([read('webhooks'), read('failures', [new Date(at - 86400_000)])])
      const rows = all.slice(0, RELIABILITY_LIMIT)
      const overdue = rows.filter(r => age(r.nextAttemptAt, at) > thresholds.pendingStaleMs).length
      const retrying = rows.filter(r => r.status === 'pending' && r.attempts > 0).length
      return observation(overdue || retrying || failures.length || all.length > RELIABILITY_LIMIT ? 'degraded' : 'ok',
        'Launch-feed webhook delivery queue.',
        'Check transparency.webhooks logs and receiver availability. Failed includes inactive/deleted subscriptions; the 24h window uses delivery creation time, not failure time.',
        { pending: rows.length, truncated: all.length > RELIABILITY_LIMIT, overdue, retrying,
          failed24h: Math.min(failures.length, RELIABILITY_LIMIT), failuresTruncated: failures.length > RELIABILITY_LIMIT })
    }),
  ])
  const sections = { database, rpc, worker, markets, pending, webhooks }
  const status = Object.values(sections).some(s => s.status === 'degraded') ? 'degraded' : Object.values(sections).some(s => s.status === 'unknown') ? 'unknown' : 'ok'
  return { generatedAt: new Date(at).toISOString(), status, thresholds, version: deploymentVersion(env), ...sections }
}
