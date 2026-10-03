import { formatUsdValue, parseUnits } from './format.mjs'
import { parseMultiplier, shownRoundedUp } from '../../src/scaled-ui-amount.mjs'

export { parseMultiplier }

// The units a trade panel's quote side works in (docs/STOCK_QUOTES.md). A SOL market: SOL, 9 decimals, amounts as they are.
// A stock pair: its symbol and decimals, with amounts shown and typed as wallets show them (Token-2022 ScaledUiAmount:
// raw × multiplier, truncated) and converted back to raw units, rounded down, for every request. The server only ever
// receives raw units, and a typed or preset amount never spends more than it says.
export const SOL_UNITS = Object.freeze({ symbol: 'SOL', decimals: 9, stock: false, scale: null })

// A stock pair's units from its display facts (GET /api/quote-assets/:assetId), or null if they are not usable.
export function stockUnits(info) {
  if (!info || typeof info.symbol !== 'string' || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 18) return null
  try { return Object.freeze({ symbol: info.symbol, decimals: info.decimals, stock: true, scale: parseMultiplier(info.uiMultiplier) }) }
  catch { return null }
}

// Raw units → the base units a wallet shows (truncated, as Token-2022 does), as a string.
export function shownUnits(raw, units) {
  const value = BigInt(raw)
  return (units.scale ? value * units.scale.num / units.scale.den : value).toString()
}

// Shown base units → raw units, rounded down.
export function rawUnits(shown, units) {
  const value = BigInt(shown)
  return (units.scale ? value * units.scale.den / units.scale.num : value).toString()
}

// A typed amount in shown units → raw units for a request. Throws as parseUnits does, and for an amount below one raw unit.
export function parseShownAmount(text, units) {
  const raw = rawUnits(parseUnits(text, units.decimals), units)
  if (BigInt(raw) <= 0n) throw Error('Enter a positive amount')
  return raw
}

// Base units as an input value: "12.5", never grouped or rounded.
export function plainAmount(base, decimals) {
  const value = BigInt(base), unit = 10n ** BigInt(decimals)
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / unit}${fraction ? `.${fraction}` : ''}`
}

// The input value for `percent` of a raw balance, in shown units: '' when that is nothing, or when, typed back, it would
// convert to no raw unit at all (a dust balance).
export function shownPercentAmount(rawBalance, percent, units) {
  if (![25, 50, 100].includes(percent)) throw Error('Unsupported percentage')
  const shown = BigInt(shownUnits(BigInt(rawBalance) * BigInt(percent) / 100n, units))
  return shown > 0n && BigInt(rawUnits(shown, units)) > 0n ? plainAmount(shown, units.decimals) : ''
}

// A shortfall in shown units, rounded up to at most 6 places, so it never reads smaller than it is.
export function shownShortfall(raw, units) {
  const shown = shownRoundedUp(raw, units.scale)
  const places = Math.min(units.decimals, 6), step = 10n ** BigInt(units.decimals - places)
  const rounded = (shown + step - 1n) / step, scale = 10n ** BigInt(places)
  return places ? `${rounded / scale}.${String(rounded % scale).padStart(places, '0')}` : String(rounded)
}

// "$12.34" for a raw amount of the stock at `usdPrice` per whole raw token, or null without a price.
export function stockUsdLabel(raw, units, usdPrice) {
  if (raw === null || raw === undefined || !units || !Number.isFinite(usdPrice) || usdPrice <= 0) return null
  return formatUsdValue(Number(BigInt(raw)) / 10 ** units.decimals * usdPrice)
}
