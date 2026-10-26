import { createBuilderReminders, createReminderSender } from '../../src/builder-reminders.mjs'
import { database } from './server.mjs'
import { publicOrigin } from './origin.mjs'

// Opted-in builders hear about a payout wallet change at once. Started after the request is saved and not awaited (the web
// service is a long-running Node server): email never delays, blocks or undoes the change.
export function notifyPayoutAddressChange(request, notice) {
  const origin = publicOrigin(request.url)
  void (async () => {
    try {
      const reminders = createBuilderReminders({ pool: database(), send: createReminderSender(), secret: process.env.BUILDER_REMINDER_SECRET, origin })
      const result = await reminders.notifyPayoutAddressChange(notice)
      if (result.failed) console.error('payout address notice failed', { accepted: result.accepted, failed: result.failed })
    } catch (error) { console.error('payout address notice failed', { error: error?.name ?? 'error' }) }
  })()
}
