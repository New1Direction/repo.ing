import test from 'node:test'
import assert from 'node:assert/strict'
import { ledgerAlertLine, ledgerAlertTitle } from '../app/lib/operator-alerts.mjs'
import { feeLedgerAlertDetail, ledgerChecksAlertDetail, marketPassAlertDetail, platformLedgerAlertDetail } from '../src/reserve-alerts.mjs'

const since = '2026-10-05T08:00:00.000Z', time = value => `<${value}>`
const market = { githubRepoId: '7', mint: 'mint', pool: 'curve', fullName: 'local/reserve' }

const episode = (kind, lagging) => ({ kind, lagging, repeat: false, since })

test('every shape of ledger alert row renders, with or without a delivery', () => {
  const lagging = feeLedgerAlertDetail({ market, reconciliation: { status: 'MISMATCH', difference: 5n }, episode: episode('behind', true), observedAt: since, now: 0 })
  // As recorded, a ledger waits for the delivery job's next message; once that is written it names the message.
  assert.equal(ledgerAlertLine(lagging, time), `Ledger behind the chain since <${since}> · Notification in the next ledger message`)
  assert.equal(ledgerAlertLine({ ...lagging, delivery: { ...lagging.delivery, digest: 77 } }, time), `Ledger behind the chain since <${since}> · Notification in alert #77`)
  assert.equal(ledgerAlertLine({ ...lagging, delivery: { ...lagging.delivery, status: 'expired', error: 'ALERT_TOO_OLD' } }, time), `Ledger behind the chain since <${since}> · Notification expired`)
  // A ledger that matched again says when, whether its row went out or was dropped first.
  const cleared = '2026-10-05T09:00:00.000Z'
  assert.equal(ledgerAlertLine({ ...lagging, clearedAt: cleared, delivery: { ...lagging.delivery, digest: 77 } }, time), `Ledger behind the chain since <${since}> · Cleared <${cleared}> · Notification in alert #77`)
  assert.equal(ledgerAlertLine({ ...lagging, clearedAt: cleared, delivery: { ...lagging.delivery, status: 'off', reason: 'CLEARED' } }, time),
    `Ledger behind the chain since <${since}> · Cleared <${cleared}> · Notification not sent (cleared first)`)
  const real = feeLedgerAlertDetail({ market, reconciliation: { status: 'MISMATCH', difference: -5n }, episode: episode('difference', false), observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine(real, time), `Ledger does not match the chain since <${since}> · Notification in the next ledger message`)
  const platform = platformLedgerAlertDetail({ revenue: { status: 'MISMATCH', problems: [] }, liquidity: { status: 'MATCH', problems: [] }, episode: episode('difference', false), now: 0 })
  assert.equal(ledgerAlertLine(platform, time), `Revenue MISMATCH · Liquidity MATCH since <${since}> · Notification in the next ledger message`)
  // The other states that normally clear by themselves are named for what they are, as in the notification.
  const unread = feeLedgerAlertDetail({ market, reconciliation: { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }, episode: episode('unchecked', true), observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine(unread, time), `Ledger could not be checked since <${since}> · Notification in the next ledger message`)
  const claim = feeLedgerAlertDetail({ market, reconciliation: { status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' }, episode: episode('unchecked', true), observedAt: since, now: 0 })
  assert.equal(ledgerAlertLine(claim, time), `Builder claim still unresolved since <${since}> · Notification in the next ledger message`)
  // A market's pass, the monitor's own checks.
  assert.equal(ledgerAlertLine(marketPassAlertDetail({ market, code: 'RPC_UNAVAILABLE', transient: true, episode: episode('unchecked', true), now: 0 }), time),
    `Market could not be verified since <${since}> · Notification in the next ledger message`)
  assert.equal(ledgerAlertLine(marketPassAlertDetail({ market, code: 'CONFIG_OR_POOL_MISMATCH', transient: false, episode: episode('unchecked', false), now: 0 }), time),
    `Market verification failed since <${since}> · Notification in the next ledger message`)
  assert.equal(ledgerAlertLine(ledgerChecksAlertDetail({ code: 'RPC_UNAVAILABLE', episode: episode('unchecked', true), now: 0 }), time), `Ledger checks are not running since <${since}> · Notification in the next ledger message`)
  assert.equal(ledgerAlertLine(ledgerChecksAlertDetail({ code: 'PASS_TOO_SLOW', episode: episode('unchecked', true), now: 0 }), time), `Ledger checks are too slow since <${since}> · Notification in the next ledger message`)
  // The message itself: how many ledgers it is about, and what became of it, with the sender's code when it could not go out.
  const message = { ledger: 'digest', count: 12, rows: 30, reminder: false, items: [], since, observedAt: since }
  assert.equal(ledgerAlertLine({ ...message, delivery: { status: 'sent' } }, time), `Message about 12 ledgers, the earliest since <${since}> · Notification sent`)
  assert.equal(ledgerAlertLine({ ...message, count: 1, delivery: { status: 'pending' } }, time), `Message about 1 ledger, since <${since}> · Notification pending`)
  assert.equal(ledgerAlertLine({ ...message, delivery: { status: 'retry', error: 'NOTIFICATION_SEND_FAILED', errorCode: 'HTTP_404' } }, time), `Message about 12 ledgers, the earliest since <${since}> · Notification retry (HTTP_404)`)
  assert.equal(ledgerAlertLine({ ...message, delivery: { status: 'sent', error: null, errorCode: null } }, time), `Message about 12 ledgers, the earliest since <${since}> · Notification sent`)
  assert.equal(ledgerAlertLine({ ...message, delivery: { status: 'off', reason: 'DESTINATION_REQUIRED' } }, time), `Message about 12 ledgers, the earliest since <${since}> · Notification off (no destination)`)
  // A stock ledger's alert (src/stock-reconcile.mjs): it has a start time and is never queued, so it carries no delivery.
  const stock = { ledger: 'stock', code: 'CUSTODY_SHORTFALL', status: 'MISMATCH', reason: 'CUSTODY_SHORTFALL', lagging: false, since, result: {} }
  assert.equal(ledgerAlertLine(stock, time), `Ledger does not match the chain since <${since}> · Notification off`)
  assert.equal(ledgerAlertLine({ ...stock, ledger: 'stock-custody', lagging: true }, time), `Ledger behind the chain since <${since}> · Notification off`)
  assert.equal(ledgerAlertLine({ ...stock, status: 'ERROR' }, time), `Ledger could not be reconciled since <${since}> · Notification off`)
  // Rows from before these carried a start time add nothing, as before.
  for (const old of [{ status: 'MISMATCH' }, { status: 'UNAVAILABLE' }, { revenue: 'MISMATCH', liquidity: 'MATCH' }, {}, null, undefined])
    assert.equal(ledgerAlertLine(old, time), null)
})

test('a ledger message is titled by how many ledgers it is about, and says when it is a reminder', () => {
  const titles = [[1, false], [1, true], [2, false], [52, true]].map(([count, reminder]) => ledgerAlertTitle({ ledger: 'digest', count, reminder }))
  assert.deepEqual(titles, ['1 ledger needs review', '1 ledger still needs review', '2 ledgers need review', '52 ledgers still need review'])
})
