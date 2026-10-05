#!/usr/bin/env node
// Sends one test message to the operator alert destination (RESERVE_ALERT_WEBHOOK_URL), so a new destination is seen
// working before a real alert needs it. It reads no database and no chain, and prints nothing about the destination.
// Run it where the worker's variables are:
//   railway ssh --service worker -- node scripts/send-test-alert.mjs
import { createReserveWebhookSender } from '../src/reserve-alerts.mjs'

let send
try { send = createReserveWebhookSender() }
catch { console.error('RESERVE_ALERT_WEBHOOK_URL is not a destination the sender can use (docs/RESERVE_ALERTS.md, "Destinations").'); process.exit(2) }
if (!send) { console.error('RESERVE_ALERT_WEBHOOK_URL is not set here.'); process.exit(2) }

const sentAt = new Date().toISOString()
try {
  await send({ id: 0, text: ['repo.ing · Test alert', 'Operator alerts will arrive here.', `Sent: ${sentAt}`].join('\n'), detail: { test: true, observedAt: sentAt } })
  console.log('The receiver accepted the test alert.')
} catch (error) {
  // The sender's own code (docs/RESERVE_ALERTS.md, "Destinations"): HTTP_<status>, TIMEOUT or NETWORK.
  console.error(`The receiver did not accept the test alert (${/^[A-Z][A-Z0-9_]{2,30}$/.test(String(error?.code)) ? error.code : 'UNKNOWN'}).`)
  process.exit(1)
}
