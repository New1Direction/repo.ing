// What a RECONCILIATION_MISMATCH alert is about, in the words the notification and the operations pages share. These rows
// come in several shapes: a market's fee ledger or its pass, the platform ledgers, the monitor's own checks and the message
// that gathers them (src/reserve-alerts.mjs, src/ledger-digest.mjs), and the stock ledgers (src/stock-reconcile.mjs).
// subject: how a market's ledger is named.
export function ledgerAlertTitle(detail, subject = 'Fee ledger') {
  if (detail.ledger === 'platform') return 'Platform ledger does not match'
  if (detail.ledger === 'digest') return `${detail.count} ${detail.count === 1 ? 'ledger' : 'ledgers'} ${detail.reminder ? 'still ' : ''}${detail.count === 1 ? 'needs' : 'need'} review`
  if (detail.ledger === 'checks') return detail.reason === 'PASS_TOO_SLOW' ? 'Ledger checks are too slow' : 'Ledger checks are not running'
  if (detail.ledger === 'market') return detail.lagging ? 'Market could not be verified' : 'Market verification failed'
  if (detail.status === 'ERROR') return `${subject} could not be reconciled`
  if (!detail.lagging) return `${subject} does not match the chain`
  if (detail.status === 'UNAVAILABLE') return `${subject} could not be checked`
  if (detail.status === 'PENDING_REVIEW') return 'Builder claim still unresolved'
  return `${subject} behind the chain`
}

// What became of a row's notification. A recorded ledger is not sent by itself: it waits for the next ledger message, then
// names it. A stock ledger's row is never queued for the receiver, so it has no delivery.
function notificationState(detail) {
  const delivery = detail.delivery
  if (!delivery) return 'off'
  if (delivery.status === 'digest') return delivery.digest ? `in alert #${delivery.digest}` : 'in the next ledger message'
  if (delivery.reason === 'DESTINATION_REQUIRED') return 'off (no destination)'
  if (delivery.reason === 'CLEARED') return 'not sent (cleared first)'
  return `${delivery.status}${delivery.errorCode ? ` (${delivery.errorCode})` : ''}`
}

// The line under a RECONCILIATION_MISMATCH alert on the operations pages, or null when the row has nothing to add: rows from
// before any carried a start time.
export function ledgerAlertLine(detail, formatTime = value => new Date(value).toLocaleString()) {
  if (!detail?.since) return null
  const what = detail.ledger === 'digest' ? `Message about ${detail.count} ${detail.count === 1 ? 'ledger, since' : 'ledgers, the earliest since'}`
    : `${detail.ledger === 'platform' ? `Revenue ${detail.revenue} · Liquidity ${detail.liquidity}` : ledgerAlertTitle(detail, 'Ledger')} since`
  return `${what} ${formatTime(detail.since)}${detail.clearedAt ? ` · Cleared ${formatTime(detail.clearedAt)}` : ''} · Notification ${notificationState(detail)}`
}
