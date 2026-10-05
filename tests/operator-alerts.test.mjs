import test from 'node:test'
import assert from 'node:assert/strict'
import { ledgerAlertLine } from '../app/lib/operator-alerts.mjs'
import { feeLedgerAlertDetail, ledgerChecksAlertDetail, platformLedgerAlertDetail } from '../src/reserve-alerts.mjs'

const since = '2026-10-05T08:00:00.000Z', time = value => `<${value}>`
const market = { githubRepoId: '7', mint: 'mint', pool: 'curve', fullName: 'local/reserve' }

test('every shape of ledger alert row renders, with or without a delivery', () => {
  const lagging = feeLedgerAlertDetail({ market, reconciliation: { status: 'MISMATCH', difference: 5n }, episode: { lagging: true, since }, observedAt: since, now: 0 })
  // As recorded, a ledger waits for the delivery job's next message; once that is written it names the message.
  assert.equal(ledgerAlertLine(lagging, time), `Ledger behind the chain since <${since}> · Notification in the next ledger message`)
  assert.equal(ledgerAlertLine({ ...lagging, delivery: { ...lagging.delivery, digest: 77 } }, time), `Ledger behind the chain since <${since}> · Notification in alert #77`)
  assert.equal(ledgerAlertLine({ ...lagging, delivery: { ...lagging.delivery, status: 'expired', error: 'ALERT_TOO_OLD' } }, time), `Ledger behind the chain since <${since}> · Notification expired`)
  const real = feeLedgerAlertDetail({ market, reconciliation: { status: 'MISMATCH', difference: -5n }, episode: { lagging: false, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine({ ...real, delivery: { status: 'sent' } }, time), `Ledger does not match the chain since <${since}> · Notification sent`)
  const broken = feeLedgerAlertDetail({ market, reconciliation: { status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }, episode: { lagging: false, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine(broken, time), `Ledger could not be reconciled since <${since}> · Notification in the next ledger message`)
  const platform = platformLedgerAlertDetail({ revenue: { status: 'MISMATCH', problems: [] }, liquidity: { status: 'MATCH', problems: [] }, episode: { since }, now: 0 })
  assert.equal(ledgerAlertLine(platform, time), `Revenue MISMATCH · Liquidity MATCH since <${since}> · Notification in the next ledger message`)
  // The other states that normally clear by themselves are named for what they are, as in the notification.
  const unread = feeLedgerAlertDetail({ market, reconciliation: { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }, episode: { lagging: true, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine({ ...unread, delivery: { status: 'pending' } }, time), `Ledger could not be checked since <${since}> · Notification pending`)
  const claim = feeLedgerAlertDetail({ market, reconciliation: { status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' }, episode: { lagging: true, since }, observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine({ ...claim, delivery: { status: 'retry' } }, time), `Builder claim still unresolved since <${since}> · Notification retry`)
  assert.equal(ledgerAlertLine(ledgerChecksAlertDetail({ code: 'RPC_UNAVAILABLE', episode: { since }, now: 0 }), time), `Ledger checks are not running since <${since}> · Notification in the next ledger message`)
  // The message itself: how many ledgers it is about, and whether it went out.
  const message = { ledger: 'digest', count: 12, rows: 30, items: [], since, observedAt: since }
  assert.equal(ledgerAlertLine({ ...message, delivery: { status: 'sent' } }, time), `Message about 12 ledgers, the earliest since <${since}> · Notification sent`)
  assert.equal(ledgerAlertLine({ ...message, count: 1, delivery: { status: 'pending' } }, time), `Message about 1 ledger, since <${since}> · Notification pending`)
  assert.equal(ledgerAlertLine({ ...message, delivery: { status: 'off', reason: 'DESTINATION_REQUIRED' } }, time), `Message about 12 ledgers, the earliest since <${since}> · Notification off (no destination)`)
  // A stock ledger's alert (src/stock-reconcile.mjs): it has a start time and is never queued, so it carries no delivery.
  const stock = { ledger: 'stock', code: 'CUSTODY_SHORTFALL', status: 'MISMATCH', reason: 'CUSTODY_SHORTFALL', lagging: false, since, result: {} }
  assert.equal(ledgerAlertLine(stock, time), `Ledger does not match the chain since <${since}> · Notification off`)
  assert.equal(ledgerAlertLine({ ...stock, ledger: 'stock-custody', lagging: true }, time), `Ledger behind the chain since <${since}> · Notification off`)
  // Rows from before these carried a start time add nothing, as before.
  for (const old of [{ status: 'MISMATCH' }, { status: 'UNAVAILABLE' }, { revenue: 'MISMATCH', liquidity: 'MATCH' }, {}, null, undefined])
    assert.equal(ledgerAlertLine(old, time), null)
})
