// Fixed-cardinality, process-local observations. Never persist job arguments, results or errors.
export const RELIABILITY_STAGES = Object.freeze(['launches', 'fees', 'stockFees', 'claims', 'allocations', 'discovery', 'liquidity',
  'reinvest', 'platformFees', 'tipTransfers', 'tipExpiry', 'tipMonitor', 'partsFunds', 'chartOrdering', 'graduation',
  'graduatedTrades', 'stockGraduation', 'operatingWallets', 'buybackReceipts', 'tradeCanary', 'reminders', 'launchAlerts',
  'milestoneAlerts', 'trendAlerts', 'transparency'])

export function deploymentVersion(env = process.env) {
  const value = env.REPOING_COMMIT_SHA ?? env.RAILWAY_GIT_COMMIT_SHA ?? env.VERCEL_GIT_COMMIT_SHA
  return /^[a-f0-9]{7,40}$/i.test(value ?? '') ? value : null
}

// Existing jobs can return partial failures instead of throwing. These are observations, not a business-success SLA.
function outcome(value) {
  if (!value || typeof value !== 'object') return 'completed'
  const values = Array.isArray(value) ? value : Object.values(value)
  if (!Array.isArray(value) && (value.error || value.ok === false || value.failed > 0 || value.retrying > 0 ||
    /^(error|review|invalid|mismatch|missing|unavailable|failed)$/i.test(value.status ?? value.state ?? ''))) return 'degraded'
  const nested = values.filter(v => v && typeof v === 'object').map(outcome)
  if (nested.includes('degraded')) return 'degraded'
  if (value.skipped || /^skipped$/i.test(value.status ?? value.state ?? '') || value.deferred > 0 || nested.includes('incomplete')) return 'incomplete'
  return 'completed'
}

export function createWorkerReliability({ write, now = Date.now, version = deploymentVersion(), log = console.error }) {
  const startedAt = new Date(now()).toISOString(), stages = {}
  let pending = null
  return {
    async track(name, work) {
      if (!RELIABILITY_STAGES.includes(name)) throw new Error('Unknown reliability stage')
      const start = now(), previous = stages[name]
      stages[name] = { ...previous, name, state: 'running', lastStartedAt: new Date(start).toISOString() }
      let state = 'failed'
      try { const result = await work(); state = outcome(result); return result }
      finally {
        const finished = now()
        stages[name] = { ...stages[name], state, lastFinishedAt: new Date(finished).toISOString(),
          lastSuccessAt: state === 'completed' ? new Date(finished).toISOString() : previous?.lastSuccessAt ?? null,
          durationMs: Math.max(0, finished - start) }
      }
    },
    flush() {
      if (pending) return pending
      const snapshot = { startedAt, capturedAt: new Date(now()).toISOString(), version, stages: Object.values(stages) }
      // Serialize before yielding: work can finish while the database write is waiting.
      const payload = JSON.stringify(snapshot)
      pending = Promise.resolve().then(() => write(payload)).catch(() => log('Worker reliability snapshot unavailable'))
        .finally(() => { pending = null })
      return pending
    },
  }
}

export const WRITE_WORKER_SNAPSHOT = `insert into operator_worker_snapshot (id, snapshot) values (1, $1::jsonb)
  on conflict (id) do update set snapshot = excluded.snapshot`
