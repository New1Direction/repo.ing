// What a RECONCILIATION_MISMATCH alert is about, in the words the notification and the operations pages share. These rows
// come in several shapes: a market's fee ledger, the platform ledgers, the monitor's own checks and a pass's summary
// (src/reserve-alerts.mjs), and the stock ledgers (src/stock-reconcile.mjs). subject: how a market's ledger is named.
export function ledgerAlertTitle(detail, subject = 'Fee ledger') {
  if (detail.ledger === 'platform') return 'Platform ledger does not match'
  if (detail.ledger === 'summary') return `${detail.count} more fee ledgers need review`
  if (detail.ledger === 'checks') return 'Ledger checks are not running'
  if (detail.status === 'ERROR') return `${subject} could not be reconciled`
  if (!detail.lagging) return `${subject} does not match the chain`
  if (detail.status === 'UNAVAILABLE') return `${subject} could not be checked`
  if (detail.status === 'PENDING_REVIEW') return 'Builder claim still unresolved'
  return `${subject} behind the chain`
}

// The line under a RECONCILIATION_MISMATCH alert on the operations pages, or null when the row has nothing to add: rows from
// before any carried a start time. A stock ledger's row is never queued for the receiver, so it has no delivery.
export function ledgerAlertLine(detail, formatTime = value => new Date(value).toLocaleString()) {
  if (!detail?.since) return null
  const what = detail.ledger === 'platform' ? `Revenue ${detail.revenue} · Liquidity ${detail.liquidity}` : ledgerAlertTitle(detail, 'Ledger')
  const notification = detail.delivery?.reason === 'SUMMARIZED' ? 'in a summary' : detail.delivery?.status ?? 'off'
  return `${what} since ${formatTime(detail.since)} · Notification ${notification}`
}
