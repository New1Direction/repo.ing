import { checkTradeLandingAlert, recordTradeOutcome } from '../../src/trade-outcomes.mjs'

// Glue between the trade API and operator telemetry. Best effort by design: a database hiccup is logged (error class
// only) and never changes what the trader sees. A session remembers what it recorded so status polls stay cheap.
const ALERTING = Object.freeze(['expired', 'failed', 'verification_failed'])

// Status-poll results that settle an attempt. chainConfirmed with a live session is left out: it is the transient
// "landed, detailed verification catching up" state. Without a session the chain result is all there is.
export function statusOutcome(state, { hasSession }) {
  if (state === 'confirmed' || (state === 'chainConfirmed' && !hasSession)) return 'confirmed'
  return state === 'expired' || state === 'failed' ? state : null
}

// The submit path already waited for confirmation, so a chainConfirmed there means verification itself failed.
export function submitOutcome(state) {
  return { confirmed: 'confirmed', chainConfirmed: 'verification_failed', expired: 'expired', failed: 'failed' }[state] ?? null
}

export async function trackTradeOutcome(db, fields, { session = null, log = console.error, now = Date.now } = {}) {
  if (!db || !fields?.outcome) return false
  if (session) {
    session.recorded ??= new Set()
    if (session.recorded.has(fields.outcome)) return false
    session.recorded.add(fields.outcome)
  }
  try {
    const inserted = await recordTradeOutcome(db, fields)
    if (inserted && ALERTING.includes(fields.outcome)) await checkTradeLandingAlert(db, { now })
    return inserted
  } catch (error) {
    log('trade outcome recording failed', error?.code ?? error?.name ?? 'error')
    return false
  }
}
