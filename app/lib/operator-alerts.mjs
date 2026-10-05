// What a RECONCILIATION_MISMATCH alert is about, in the words the notification and the operations pages share. These rows
// come in several shapes: a market's fee ledger, the platform ledgers, the monitor's own checks and the message that
// gathers them (src/reserve-alerts.mjs, src/ledger-digest.mjs), and the stock ledgers (src/stock-reconcile.mjs).
// subject: how a market's ledger is named.
export function ledgerAlertTitle(detail, subject = 'Fee ledger') {
  if (detail.ledger === 'platform') return 'Platform ledger does not match'
  if (detail.ledger === 'digest') return detail.count === 1 ? '1 ledger needs review' : `${detail.count} ledgers need review`
  if (detail.ledger === 'checks') return 'Ledger checks are not running'
  if (detail.status === 'ERROR') return `${subject} could not be reconciled`
  if (!detail.lagging) return `${subject} does not match the chain`
  if (detail.status === 'UNAVAILABLE') return `${subject} could not be checked`
  if (detail.status === 'PENDING_REVIEW') return 'Builder claim still unresolved'
  return `${subject} behind the chain`
}

// The line under a RECONCILIATION_MISMATCH alert on the operations pages, or null when the row has nothing to add: rows from
// before any carried a start time. A ledger's own row is not sent by itself: it waits for the next ledger message, then
// names it. A stock ledger's row is never queued for the receiver, so it has no delivery.
export function ledgerAlertLine(detail, formatTime = value => new Date(value).toLocaleString()) {
  if (!detail?.since) return null
  const delivery = detail.delivery
  const notification = delivery?.status === 'digest' ? delivery.digest ? `in alert #${delivery.digest}` : 'in the next ledger message'
    : delivery?.reason === 'DESTINATION_REQUIRED' ? 'off (no destination)' : delivery?.status ?? 'off'
  const what = detail.ledger === 'digest' ? `Message about ${detail.count} ${detail.count === 1 ? 'ledger, since' : 'ledgers, the earliest since'}`
    : `${detail.ledger === 'platform' ? `Revenue ${detail.revenue} · Liquidity ${detail.liquidity}` : ledgerAlertTitle(detail, 'Ledger')} since`
  return `${what} ${formatTime(detail.since)} · Notification ${notification}`
}
