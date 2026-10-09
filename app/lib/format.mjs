export function formatUnits(raw, decimals = 9, maxFraction = decimals) {
  if (raw === null || raw === undefined) return '—'
  const n = BigInt(raw)
  const sign = n < 0n ? '-' : ''
  const value = n < 0n ? -n : n
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = (value % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '')
  return `${sign}${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`
}
// Readable SOL for summaries: 2 decimals from 1 SOL up, ~4 significant digits below (never
// showing a nonzero balance as 0). Amounts a user signs or pays should use formatUnits instead.
export function formatSolDisplay(raw) {
  if (raw === null || raw === undefined) return '—'
  const amount = BigInt(raw)
  // A loss too small to show keeps its minus: "-<0.000001".
  if (amount !== 0n && amount > -1000n && amount < 1000n) return amount < 0n ? '-<0.000001' : '<0.000001'
  const sol = Number(amount) / 1e9, size = Math.abs(sol)
  const decimals = size >= 1 || size === 0 ? 2 : Math.min(6, 3 - Math.floor(Math.log10(size)))
  return sol.toLocaleString('en-US', { maximumFractionDigits: decimals })
}
export function formatSolRounded(raw) {
  if (raw === null || raw === undefined) return '—'
  const amount = Number(BigInt(raw)) / 1e9
  if (amount !== 0 && Math.abs(amount) < 0.00005) return amount < 0 ? '>-0.0001' : '<0.0001'
  return amount.toLocaleString('en-US', { maximumFractionDigits: Math.abs(amount) >= 1 ? 2 : 4 })
}
// A percent change, rounded first and signed after: a change too small to show reads "0.00%", never "-0.00%". sign (-1, 0
// or 1) is the shown value's, for up/down colors; value is the unsigned figure ("1.25%"); null for no change figure.
export function percentChange(change, digits = 2) {
  if (typeof change !== 'number' || !Number.isFinite(change)) return null
  const shown = Number(change.toFixed(digits)), sign = Math.sign(shown) || 0
  const value = `${Math.abs(shown).toFixed(digits)}%`
  return { sign, value, label: `${sign > 0 ? '+' : sign < 0 ? '−' : ''}${value}` }
}
export function formatUsdEstimate(lamports, usdPerSol) {
  if (lamports === null || lamports === undefined || !Number.isFinite(usdPerSol) || usdPerSol <= 0) return null
  const value = Number(lamports) / 1e9 * usdPerSol
  if (!Number.isFinite(value) || value < 0) return null
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
export function parseUnits(input, decimals) {
  if (!/^(?:\d+)(?:\.\d+)?$/.test(input)) throw new Error('Enter a positive amount')
  const [whole, fraction = ''] = input.split('.')
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places`)
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'))
  if (amount <= 0n) throw new Error('Enter a positive amount')
  return amount.toString()
}
// A USD estimate already in dollars (tips in mixed tokens). null/invalid → null so callers can show '—'.
export function formatUsdValue(value) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
// Token amounts for tip UIs: up to 4 decimals (xStocks have 8), never rounding a nonzero amount to 0.
export function formatTokenAmount(raw, decimals) {
  if (raw === null || raw === undefined) return '—'
  const value = BigInt(raw)
  if (value > 0n && value < 10n ** BigInt(Math.max(0, decimals - 4))) return '<0.0001'
  return formatUnits(value, decimals, Math.min(decimals, 4))
}
// Dates a server renders, in UTC as the site's other dates are: never the server's own time zone or numeric US format.
// "Oct 9, 2026" and "Oct 9, 2026, 3:47 AM UTC".
export const formatUtcDay = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
export const formatUtcDateTime = value => `${new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
// Whole USD cents (parts-fund goals and pledges): "$120", "$12.50".
export function formatCents(cents) {
  const value = Number(cents)
  if (!Number.isFinite(value)) return '—'
  return `$${(value / 100).toLocaleString('en-US', { minimumFractionDigits: value % 100 ? 2 : 0, maximumFractionDigits: 2 })}`
}
