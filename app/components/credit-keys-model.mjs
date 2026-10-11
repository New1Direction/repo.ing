// What the "Your AI credits" section on /credits does in the browser: the form's checks and the lines it shows. The server
// checks everything again (src/credits-keys.mjs); tests/credits-keys.test.mjs keeps the two rules the same.
export const MIN_LIMIT_MICRO = 10_000
export const DEFAULT_LABEL = 'coding-tool'
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

/** "20", "$20.50" or " 75.00 " → micro-USD; null unless it is $0.01 or more, with at most 2 decimals. */
export function usdToMicro(text) {
  const match = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(text ?? '').trim())
  if (!match) return null
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(2, '0')) * 10_000
  return micro >= MIN_LIMIT_MICRO ? micro : null
}
/** 75000000 → "75.00": the whole cents, as the limit field shows them. */
export const usdText = micro => (Math.floor(micro / 10_000) / 100).toFixed(2)
/** The two lines for the coding tool's settings: the variable, its value and the line to copy. */
export const settingLines = (baseUrl, token) => [['OPENAI_BASE_URL', baseUrl], ['OPENAI_API_KEY', token]].map(([variable, value]) => ({ variable, value, line: `${variable}=${value}` }))
/** "2026-11-06T19:00:00.000Z" → "2026-11-06"; "unknown" when the service gave no usable date. */
export const dayOf = iso => typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : 'unknown'
export const STATE_NAMES = Object.freeze({ live: 'Live', expired: 'Expired', revoked: 'Revoked' })
