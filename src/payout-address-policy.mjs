// Pasted payout address rules shared by the server (src/payout-address.mjs) and the claim and Builders pages.
// Dependency-free so client components can import it. The server re-checks everything; nothing here authorizes anything.

// A pasted address waits this long before it can receive payouts. The database enforces it as a floor
// (drizzle/0048_pasted_payout_address.sql, payout_address_requests_hold_check).
export const PASTED_ADDRESS_HOLD_MS = 48 * 60 * 60 * 1000
export const PASTED_ADDRESS_HOLD_HOURS = PASTED_ADDRESS_HOLD_MS / 3_600_000

export const PAYOUT_ADDRESS_WARNING = 'Use a Solana wallet you control. Exchange deposit addresses may not credit program payouts.'

// The builder retypes the address's last characters from their wallet app: a check against a wrong paste. It is not a
// defence against clipboard malware that grinds a look-alike address; the hold, cancel and email notice are.
export const CONFIRM_CHARACTERS = 4

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function normalizeAddressInput(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// Shape only (base58 alphabet, 32–44 characters). The server decodes it and checks the curve and the chain.
export function looksLikeSolanaAddress(value) {
  return BASE58_ADDRESS.test(normalizeAddressInput(value))
}

// Base58 is case-sensitive, so the retyped characters must match exactly.
export function confirmsAddress(address, typed) {
  const value = normalizeAddressInput(address), suffix = normalizeAddressInput(typed)
  return value.length > CONFIRM_CHARACTERS && suffix.length === CONFIRM_CHARACTERS && value.endsWith(suffix)
}

export function holdRemainingMs(activeAt, now = Date.now()) {
  const at = new Date(activeAt).getTime()
  return Number.isFinite(at) ? Math.max(0, at - now) : 0
}

// "47 h 5 min", "12 min", "under a minute".
export function formatHoldRemaining(ms) {
  const minutes = Math.ceil(Math.max(0, ms) / 60_000)
  if (minutes <= 1) return ms > 0 ? 'under a minute' : 'now'
  const hours = Math.floor(minutes / 60), rest = minutes % 60
  if (!hours) return `${minutes} min`
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

// UTC, so the server render and the browser agree.
export function formatUtcDateTime(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} UTC`
}

// How the active payout address was set.
export function bindingLabel(active) {
  if (!active?.wallet) return ''
  return active.method === 'pasted' ? `Pasted address, active since ${formatUtcDateTime(active.boundAt)}` : 'Verified by wallet signature'
}

export function pendingLabel(pending) {
  return pending?.activeAt ? `Pasted address, active from ${formatUtcDateTime(pending.activeAt)}` : ''
}
