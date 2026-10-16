import { readProductionEvidence } from './hooklab-production-rpc.mjs'
import { indexPlainReceipts } from './hooklab-plain-receipts.mjs'

// Operator-invoked observation only. No scheduling, alert transport, adoption or chain mutation.
// Configuration drift blocks new work, but must not prevent inspecting retained signatures.
export async function monitorPlainProduction({ enabled = false, evidence, journal, now = Date.now, maxUnresolvedAgeMs = 300000 } = {}) {
  const result = { status: 'disabled', executionEnabled: false, canSign: false, canSubmit: false,
    evidence: null, receipts: [], health: null, alerts: [] }
  if (!enabled) return result
  if (!journal || !evidence || !Number.isSafeInteger(maxUnresolvedAgeMs) || maxUnresolvedAgeMs < 1) {
    return { ...result, status: 'unavailable', alerts: ['MONITOR_CONFIGURATION_MISSING'] }
  }
  const observed = await readProductionEvidence({ ...evidence, now })
  result.evidence = { status: observed.status, reason: observed.reason, observedSlots: observed.observedSlots,
    accountBindingsMatched: observed.accountBindingsMatched, policyVerified: false, provenanceVerified: false }
  result.status = 'observed'
  if (!observed.accountBindingsMatched) result.alerts.push('DEPLOYMENT_EVIDENCE_UNAVAILABLE_OR_DRIFTED')
  // RPC adapters must be explicitly selected by the operator; malformed configuration is never
  // an excuse to infer provider independence or fall back to default/mainnet SDK connections.
  if (observed.status !== 'mismatch' || observed.observations.length > 0) {
    try { result.receipts = await indexPlainReceipts(journal, evidence.providers) }
    catch { result.alerts.push('RECEIPT_INDEX_UNAVAILABLE') }
  }
  try {
    result.health = await journal.health()
    if (BigInt(result.health.review_required) > 0n) result.alerts.push('RECEIPT_REVIEW_REQUIRED')
    if (BigInt(result.health.latest_unavailable) > 0n) result.alerts.push('RECEIPT_PROVIDER_UNAVAILABLE')
    if (result.health.oldest_unresolved && now() - new Date(result.health.oldest_unresolved).getTime() >= maxUnresolvedAgeMs) {
      result.alerts.push('RECEIPT_UNRESOLVED_TOO_LONG')
    }
  } catch { result.alerts.push('JOURNAL_HEALTH_UNAVAILABLE') }
  if (result.alerts.length) result.status = 'attention-required'
  return result
}
