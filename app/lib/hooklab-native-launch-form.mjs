// Native launcher reserve input. Pure (no node: APIs) so the client component can use it; the server
// re-validates everything and checks an invited coin against its stored request byte for byte.

// The reviewed curve input every launch uses: 1,000,000,000 raw is curve math, not deposited SOL.
export const STANDARD_VIRTUAL_QUOTE = '1000000000'

const bytes = value => new TextEncoder().encode(value).length
const isHttps = value => { try { return new URL(value).protocol === 'https:' } catch { return false } }

// What an invited creator cannot edit: the approved coin, plus the standard curve and a label from its symbol.
export const lockedLaunchFields = intent => intent ? { label: intent.symbol, virtualQuote: STANDARD_VIRTUAL_QUOTE, ...intent } : {}

// The reserve request body, approved details first. Throws a plain-words Error for anything invalid.
export function reservationInput(form, approvedIntent = null) {
  const values = { ...form, ...lockedLaunchFields(approvedIntent) }
  const capBps = String(values.capBps), creatorFeeBps = String(values.creatorFeeBps), virtualQuote = String(values.virtualQuote)
  if (!/^\d{1,4}$/.test(capBps) || +capBps < 1 || +capBps > 9999) throw Error('Max-wallet cap must be 1–9999 basis points.')
  if (!/^\d{1,4}$/.test(creatorFeeBps) || +creatorFeeBps > 9999) throw Error('Enter an explicit creator fee from 0–9999 basis points.')
  if (!/^(0|[1-9][0-9]*)$/.test(virtualQuote)) throw Error('Enter the virtual quote amount in integer base units.')
  // The owner-approved request form makes the metadata URL optional; the operator form still requires one.
  const required = approvedIntent ? ['label', 'name', 'symbol'] : ['label', 'name', 'symbol', 'uri']
  for (const [key, limit] of Object.entries({ label: 32, name: 32, symbol: 10, uri: 200 })) {
    if (required.includes(key) && !values[key].trim()) throw Error(`Enter ${key}.`)
    if (bytes(values[key]) > limit) throw Error(`${key} must be at most ${limit} UTF-8 bytes.`)
  }
  if (values.uri && !isHttps(values.uri)) throw Error('Use an HTTPS metadata URL.')
  const { label, name, symbol, uri } = values
  return { label, name, symbol, uri, capBps: Number(capBps), creatorFeeBps: Number(creatorFeeBps), virtualQuote }
}
