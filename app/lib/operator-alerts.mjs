// The line under a RECONCILIATION_MISMATCH alert on the operations pages, or null when the row has nothing to add. These
// rows come in several shapes: a market's fee ledger and the platform ledgers (src/reserve-alerts.mjs), the stock ledgers
// (src/stock-reconcile.mjs, never queued for the receiver, so no delivery), and rows from before any carried a start time.
export function ledgerAlertLine(detail, formatTime = value => new Date(value).toLocaleString()) {
  if (!detail?.since) return null
  const what = detail.ledger === 'platform' ? `Revenue ${detail.revenue} · Liquidity ${detail.liquidity}`
    : detail.status === 'ERROR' ? 'Ledger could not be reconciled' : detail.lagging ? 'Ledger behind the chain' : 'Ledger does not match the chain'
  return `${what} since ${formatTime(detail.since)} · Notification ${detail.delivery?.status ?? 'off'}`
}
