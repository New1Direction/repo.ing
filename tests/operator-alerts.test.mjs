import test from 'node:test'
import assert from 'node:assert/strict'
import { ledgerAlertLine } from '../app/lib/operator-alerts.mjs'
import { feeLedgerAlertDetail, ledgerChecksAlertDetail, ledgerSummaryAlertDetail, platformLedgerAlertDetail } from '../src/reserve-alerts.mjs'

const since = '2026-10-05T08:00:00.000Z', time = value => `<${value}>`
const market = { githubRepoId: '7', mint: 'mint', pool: 'curve', fullName: 'local/reserve' }

test('every shape of ledger alert row renders, with or without a delivery', () => {
  const lagging = feeLedgerAlertDetail({ market, reconciliation: { status: 'MISMATCH', difference: 5n }, episode: { lagging: true, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine(lagging, time), `Ledger behind the chain since <${since}> · Notification pending`)
  const real = feeLedgerAlertDetail({ market, reconciliation: { status: 'MISMATCH', difference: -5n }, episode: { lagging: false, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine({ ...real, delivery: { status: 'sent' } }, time), `Ledger does not match the chain since <${since}> · Notification sent`)
  const broken = feeLedgerAlertDetail({ market, reconciliation: { status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }, episode: { lagging: false, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine(broken, time), `Ledger could not be reconciled since <${since}> · Notification pending`)
  const platform = platformLedgerAlertDetail({ revenue: { status: 'MISMATCH', problems: [] }, liquidity: { status: 'MATCH', problems: [] }, episode: { since }, now: 0 })
  assert.equal(ledgerAlertLine(platform, time), `Revenue MISMATCH · Liquidity MATCH since <${since}> · Notification pending`)
  // The other states that normally clear by themselves are named for what they are, as in the notification.
  const unread = feeLedgerAlertDetail({ market, reconciliation: { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }, episode: { lagging: true, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine(unread, time), `Ledger could not be checked since <${since}> · Notification pending`)
  const claim = feeLedgerAlertDetail({ market, reconciliation: { status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' }, episode: { lagging: true, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine(claim, time), `Builder claim still unresolved since <${since}> · Notification pending`)
  // An alert its pass summed up instead of sending, the summary itself, and the monitor's own checks.
  const summed = feeLedgerAlertDetail({ market, reconciliation: { status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }, episode: { lagging: false, since }, observedAt: since, now: 0, deliver: false })
  assert.equal(ledgerAlertLine(summed, time), `Ledger could not be reconciled since <${since}> · Notification in a summary`)
  assert.equal(ledgerAlertLine(ledgerSummaryAlertDetail({ count: 49, now: Date.parse(since) }), time), `49 more fee ledgers need review since <${since}> · Notification pending`)
  assert.equal(ledgerAlertLine(ledgerChecksAlertDetail({ code: 'RPC_UNAVAILABLE', episode: { since }, now: 0 }), time), `Ledger checks are not running since <${since}> · Notification pending`)
  // A stock ledger's alert (src/stock-reconcile.mjs): it has a start time and is never queued, so it carries no delivery.
  const stock = { ledger: 'stock', code: 'CUSTODY_SHORTFALL', status: 'MISMATCH', reason: 'CUSTODY_SHORTFALL', lagging: false, since, result: {} }
  assert.equal(ledgerAlertLine(stock, time), `Ledger does not match the chain since <${since}> · Notification off`)
  assert.equal(ledgerAlertLine({ ...stock, ledger: 'stock-custody', lagging: true }, time), `Ledger behind the chain since <${since}> · Notification off`)
  // Rows from before these carried a start time add nothing, as before.
  for (const old of [{ status: 'MISMATCH' }, { status: 'UNAVAILABLE' }, { revenue: 'MISMATCH', liquidity: 'MATCH' }, {}, null, undefined])
    assert.equal(ledgerAlertLine(old, time), null)
})
