// Native launcher reserve input. Pure (no node: APIs) so the client component can use it; the server
// re-validates everything and checks an invited coin against its stored request byte for byte.

import { STANDARD_VIRTUAL_QUOTE } from '../../src/hooklab-launch-pricing.mjs'
import bs58 from 'bs58'

// The reviewed curve input every unpriced launch uses: 1,000,000,000 raw is curve math, not deposited SOL.
export { STANDARD_VIRTUAL_QUOTE }

const bytes = value => new TextEncoder().encode(value).length
const isHttps = value => { try { return new URL(value).protocol === 'https:' } catch { return false } }

// What an invited creator cannot edit: the approved coin, plus a label from its symbol and its opening price (the
// virtual quote fixed with a USD-priced invite, otherwise the standard curve).
export const lockedLaunchFields = intent => intent ? { label: intent.symbol, virtualQuote: STANDARD_VIRTUAL_QUOTE, ...intent } : {}

// Optional compiler economics use JSON numbers, not percent strings. Omission is
// intentional (legacy tax-hook defaults), and is retained through recovery.
export function selectedHookEconomics(form) {
  const result = Object.fromEntries(['quoteCut', 'authorShareBps', 'rules'].filter(k => form[k] !== undefined).map(k => [k, form[k]]))
  const bps = (n, max, min = 0) => Number.isInteger(n) && n >= min && n <= max
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
  if (result.quoteCut !== undefined && (!exact(result.quoteCut, ['maxBuyBps', 'maxSellBps']) || !bps(result.quoteCut.maxBuyBps, 1000, 1) || !bps(result.quoteCut.maxSellBps, 1000))) throw Error('Invalid selected hook quote cut.')
  if (result.authorShareBps !== undefined && !bps(result.authorShareBps, 5000)) throw Error('Invalid selected hook author share.')
  if (result.rules !== undefined && result.rules !== 'none' && (!exact(result.rules, ['burnBuyBps', 'burnSellBps']) || !bps(result.rules.burnBuyBps, 10000) || !bps(result.rules.burnSellBps, 10000))) throw Error('Invalid selected hook burn rules.')
  return result
}

// No chain lookups: validate only the immutable creator configuration, never signing readiness.
export function launchHookInput(form) {
  if (form.hookKind && !['max-wallet', 'selected'].includes(form.hookKind)) throw Error('Choose a max-wallet gate or custom hook.')
  if (form.hookKind === 'max-wallet' && form.selectedHook) throw Error('Custom hook configuration conflicts with the max-wallet gate.')
  const economics = selectedHookEconomics(form)
  if (form.hookKind !== 'selected' && !form.selectedHook) {
    if (Object.keys(economics).length) throw Error('Economics require a selected hook.')
    return { capBps: Number(form.capBps) }
  }
  const hook = form.selectedHook ?? {}, program = hook.program
  try {
    if (typeof program !== 'string' || bs58.decode(program).length !== 32 || program === '11111111111111111111111111111111') throw Error()
  } catch { throw Error('Enter a valid nonzero Solana hook program address.') }
  if (!/^[1-9][0-9]{0,2}$/.test(String(hook.flags)) || Number(hook.flags) > 255) throw Error('Hook flags must be an integer from 1–255 (known token callback flags only).')
  if (form.capBps !== 0 && form.capBps !== '0') throw Error('Custom hooks require a max-wallet cap of 0; they do not use the max-wallet gate.')
  return { capBps: 0, selectedHook: { program, flags: Number(hook.flags) }, ...(form.hookPublication ? { hookPublication: form.hookPublication } : {}), ...economics }
}

// The reserve request body, approved details first. Throws a plain-words Error for anything invalid.
export function reservationInput(form, approvedIntent = null) {
  const values = { ...form, ...lockedLaunchFields(approvedIntent), ...(approvedIntent ? { hookKind: approvedIntent.selectedHook ? 'selected' : 'max-wallet', selectedHook: approvedIntent.selectedHook, hookPublication: approvedIntent.hookPublication,
    quoteCut: approvedIntent.quoteCut, authorShareBps: approvedIntent.authorShareBps, rules: approvedIntent.rules } : {}) }
  const hook = launchHookInput(values)
  const capBps = String(values.capBps), creatorFeeBps = String(values.creatorFeeBps), virtualQuote = String(values.virtualQuote)
  if (!hook.selectedHook && (!/^\d{1,4}$/.test(capBps) || +capBps < 1 || +capBps > 9999)) throw Error('Max-wallet cap must be 1–9999 basis points.')
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
  return { label, name, symbol, uri, ...hook, creatorFeeBps: Number(creatorFeeBps), virtualQuote }
}
