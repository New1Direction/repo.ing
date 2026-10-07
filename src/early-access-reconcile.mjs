import { createLedgerAlerts } from './ledger-alerts.mjs'
import { clearLedgerAlerts } from './reserve-alerts.mjs'
import { evidenceJSON } from './graduation-state.mjs'
import { RECONCILE_HOLD_MS } from './reconcile.mjs'

// Contributor early access markets' builder fee ledgers (docs/EARLY_ACCESS.md, step 6a; owner decision 2026-10-07). The graduation
// monitor does not watch these markets until their graduation ships (step 7), so this pass reconciles each one against its pool and
// records an operator alert exactly as the monitor does (graduation_alerts, kind RECONCILIATION_MISMATCH, gathered by the ledger
// digest): a difference that lasts its hold is recorded, a match clears it. It runs before any claim can pay from these ledgers.
export const EARLY_ACCESS_RECONCILE_MARKETS_SQL = `select m.github_repo_id::text as "githubRepoId", m.mint, m.pool, r.full_name as "fullName"
  from markets m join repositories r on r.github_repo_id = m.github_repo_id
  where m.early_access_end is not null and m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'
  order by m.github_repo_id`
const LEDGER_ALERT = 'RECONCILIATION_MISMATCH'
// A reconciliation that threw (a fixed code; a failure's own message never reaches an alert).
export const EARLY_ACCESS_RECONCILE_FAILED = 'EARLY_ACCESS_RECONCILE_FAILED'

async function recordAlert(db, repoId, key, detail) {
  const { rows } = await db.query(`insert into graduation_alerts(event_key, github_repo_id, kind, detail) values($1, $2, $3, $4)
    on conflict(event_key) do nothing returning id`, [`${repoId}:${LEDGER_ALERT}:${key}`, repoId, LEDGER_ALERT, evidenceJSON(detail)])
  return rows[0] ?? null
}

// reconciler: src/reconcile.mjs createReconciler (with the early access config), or a test's.
export function createEarlyAccessReconcileWatch({ pool, reconciler, now = Date.now, holdMs = RECONCILE_HOLD_MS,
  log = record => console.log(JSON.stringify({ earlyAccessReconcile: record })) }) {
  let faults = 0
  const ledgerAlerts = createLedgerAlerts({ now, holdMs, onFault: () => { faults += 1 } })
  async function runOnce() {
    const { rows: markets } = await pool.query(EARLY_ACCESS_RECONCILE_MARKETS_SQL)
    if (!markets.length) return { status: 'IDLE', markets: [] }
    ledgerAlerts.beginPass()
    const results = []
    for (const market of markets) {
      let result
      try { result = await reconciler.reconcile(market.githubRepoId) }
      catch { result = { status: 'UNAVAILABLE', reason: EARLY_ACCESS_RECONCILE_FAILED } }
      const watched = ledgerAlerts.market({ record: (key, detail) => recordAlert(pool, market.githubRepoId, key, detail),
        clear: (ledger, at) => clearLedgerAlerts(pool, market.githubRepoId, ledger, at) }, market)
      const alert = await watched.settle(result)
      // The reason up to its first colon: a failed read's own message (which can quote an endpoint) never reaches the log.
      const entry = { repoId: market.githubRepoId, status: result.status, ...result.reason ? { reason: String(result.reason).split(':')[0] } : {},
        ...result.difference != null ? { difference: String(result.difference) } : {}, alert: alert?.id ?? null }
      if (result.status !== 'MATCH') log(entry)
      results.push(entry)
    }
    return { status: 'OK', markets: results, ...faults ? { alertFaults: faults } : {} }
  }
  return { runOnce }
}
