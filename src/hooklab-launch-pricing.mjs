// USD launch pricing for owner-approved Hooks coins (owner decision 2026-10-19): every launch opens at about a $5,000
// market cap and graduates at about $45,000. The chain has no price oracle, so repo.ing fixes the SOL price and the
// virtual quote when the owner invites a request; the owner's co-signature and the on-chain bounds bind them.
// Pure (no node: APIs): the creator UI, the server and the owner agent all use these exact numbers.

// The reviewed curve input before USD pricing: 1,000,000,000 raw is curve math, not deposited SOL.
export const STANDARD_VIRTUAL_QUOTE = '1000000000'
export const OPENING_MARKET_CAP_USD = 5000
// On-chain [min, max] virtual quote after the owner's governed_set_config: SOL at $1,000 down to SOL at $50.
export const VIRTUAL_QUOTE_BOUNDS = Object.freeze({ min: 5_625_000_000n, max: 112_500_000_000n })
export const MAX_SOURCE_SPREAD_BPS = 200n
export const SOL_USD_SOURCE_NAMES = Object.freeze(['coingecko', 'jupiter', 'coinbase'])
export const usdLaunchPricingEnabled = env => env?.HOOK_LAUNCH_USD_PRICING === 'true'

const LAMPORTS = 1_000_000_000n, MICROS = 1_000_000n
// Mainnet launch config: supply 1e15 raw, curve_bps 7500. Curve tokens C = 0.75 S, reserve R = 0.25 S and virtual
// base VB = C R / (C - R) = 0.375 S. Opening market cap = Vq S / (C + VB) = Vq / 1.125; graduation sells all of C,
// raising Vq (C - R) / R = 2 Vq, and ends at price (Vq + raise) / VB, a market cap of 8 Vq.
const SUPPLY = 1_000_000_000_000_000n, CURVE = SUPPLY * 7500n / 10000n, RESERVE = SUPPLY - CURVE, VIRTUAL_BASE = CURVE * RESERVE / (CURVE - RESERVE)
const OPEN_MICROS = BigInt(OPENING_MARKET_CAP_USD) * MICROS
export const TARGET_USD_MICROS = Object.freeze({ opening: OPEN_MICROS, raise: OPEN_MICROS * (CURVE + VIRTUAL_BASE) * (CURVE - RESERVE) / (SUPPLY * RESERVE),
  graduation: OPEN_MICROS * (CURVE + VIRTUAL_BASE) * CURVE / (RESERVE * VIRTUAL_BASE) })

const refuse = message => Object.assign(Error(message), { code: 'LAUNCH_PRICE_REFUSED' })
const need = (ok, message) => { if (!ok) throw refuse(message) }
const decimal = (value, scale, digits) => {
  const unit = 10n ** BigInt(digits), scaled = (value * unit + scale / 2n) / scale, whole = scaled / unit
  const fraction = digits ? (scaled % unit).toString().padStart(digits, '0') : ''
  return { whole: Number(whole).toLocaleString('en-US'), fraction }
}
// Lamports as SOL with at most `digits` decimals and no trailing zeros: 53.25 SOL, 106.5 SOL, 1 SOL.
export function formatSol(lamports, digits = 2) {
  const { whole, fraction } = decimal(BigInt(lamports), LAMPORTS, digits), trimmed = fraction.replace(/0+$/, '')
  return `${whole}${trimmed ? `.${trimmed}` : ''} SOL`
}
export const formatUsd = usdMicros => `$${decimal(BigInt(usdMicros), MICROS, 0).whole}`
export const formatSolPrice = usdMicros => { const { whole, fraction } = decimal(BigInt(usdMicros), MICROS, 2); return `$${whole}.${fraction}` }

export function solUsdMicros(usd) {
  need(typeof usd === 'number' && Number.isFinite(usd) && usd > 0 && usd < 1e9, 'SOL price must be a positive dollar amount')
  const micros = BigInt(Math.round(usd * 1e6))
  need(micros > 0n, 'SOL price must be a positive dollar amount')
  return micros
}

// Median of bigints (midpoint of the middle two when even, rounded half up).
function median(values) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid] + 1n) / 2n
}
// readings: [{ source, usdMicros: bigint }] from distinct named sources. The median of every answer picks out the
// sources within 2% of it; at least two must remain, and their median is the price. Dropped outliers stay in the
// record, marked ignored, so the owner sees them and anyone can re-derive the same choice.
function quorum(readings) {
  const names = readings.map(r => r.source)
  need(readings.length >= 2, `Only ${readings.length} SOL price source${readings.length === 1 ? '' : 's'} answered${names.length ? ` (${names.join(', ')})` : ''}; at least two must agree before a launch is priced. Try again in a minute.`)
  need(new Set(names).size === names.length && names.every(name => SOL_USD_SOURCE_NAMES.includes(name)), 'SOL prices must come from independent known sources')
  need(readings.every(r => r.usdMicros > 0n), 'SOL price must be a positive dollar amount')
  const center = median(readings.map(r => r.usdMicros))
  const kept = readings.map(r => { const gap = r.usdMicros > center ? r.usdMicros - center : center - r.usdMicros; return gap * 10000n <= center * MAX_SOURCE_SPREAD_BPS })
  need(kept.filter(Boolean).length >= 2,
    `SOL price sources disagree: fewer than two are within 2% of their median (${readings.map(r => `${r.source} ${formatSolPrice(r.usdMicros)}`).join(', ')}). Try again in a minute.`)
  return { solUsdMicros: median(readings.filter((_, i) => kept[i]).map(r => r.usdMicros)).toString(),
    sources: readings.map((r, i) => ({ source: r.source, usdMicros: r.usdMicros.toString(), ...(!kept[i] && { ignored: true }) })) }
}
// readings: [{ source, usd }] as the price APIs answered (failed sources left out).
export const solUsdQuorum = readings => quorum(readings.map(r => ({ source: r.source, usdMicros: solUsdMicros(r.usd) })))

const boundsText = `${formatSol(VIRTUAL_QUOTE_BOUNDS.min, 9).replace(' SOL', '')}–${formatSol(VIRTUAL_QUOTE_BOUNDS.max, 9)}`
// Exact lamports for a ~$5,000 opening at this SOL price, rounded up. Outside the on-chain bounds it is refused, never clamped.
export function launchVirtualQuote(priceMicros) {
  const p = BigInt(priceMicros)
  need(p > 0n, 'SOL price must be a positive dollar amount')
  const numerator = OPEN_MICROS * LAMPORTS * (CURVE + VIRTUAL_BASE), denominator = SUPPLY * p
  const virtualQuote = (numerator + denominator - 1n) / denominator
  need(virtualQuote >= VIRTUAL_QUOTE_BOUNDS.min && virtualQuote <= VIRTUAL_QUOTE_BOUNDS.max,
    `At SOL ${formatSolPrice(p)} a $5,000 opening needs ${formatSol(virtualQuote)} of virtual quote, outside the launch config's ${boundsText} bounds. Update the bounds on chain with the owner driver before inviting.`)
  return virtualQuote.toString()
}

// A stored or returned price, re-derived from its own sources: the ignored marks, the median, then the virtual quote
// must all reproduce.
export function checkLaunchPricing(pricing) {
  need(pricing && typeof pricing === 'object' && Array.isArray(pricing.sources), 'Launch price is missing')
  need(pricing.sources.every(s => s && typeof s.source === 'string' && /^[1-9]\d{0,15}$/.test(String(s.usdMicros)) && [undefined, true].includes(s.ignored)), 'Launch price sources are malformed')
  const derived = quorum(pricing.sources.map(s => ({ source: s.source, usdMicros: BigInt(s.usdMicros) })))
  const marks = sources => sources.map(s => `${s.source}:${s.usdMicros}:${s.ignored === true}`).join()
  need(/^\d{1,16}$/.test(String(pricing.solUsdMicros)) && derived.solUsdMicros === String(pricing.solUsdMicros) && marks(derived.sources) === marks(pricing.sources),
    'Launch SOL price does not match its sources')
  need(launchVirtualQuote(derived.solUsdMicros) === String(pricing.virtualQuote), 'Launch opening price does not follow from its SOL price')
  return { solUsdMicros: derived.solUsdMicros, sources: derived.sources, virtualQuote: String(pricing.virtualQuote) }
}

// What a virtual quote means for buyers, in lamports, and in USD micros when a SOL price is known.
export function launchValues(virtualQuote, priceMicros = null) {
  const vq = BigInt(virtualQuote), raise = vq * (CURVE - RESERVE) / RESERVE
  const usd = (numerator, denominator) => priceMicros === null ? null : numerator * BigInt(priceMicros) / (denominator * LAMPORTS)
  return { virtualQuote: vq, raiseLamports: raise, openingLamports: vq * SUPPLY / (CURVE + VIRTUAL_BASE), graduationLamports: (vq + raise) * SUPPLY / VIRTUAL_BASE,
    openingUsdMicros: usd(vq * SUPPLY, CURVE + VIRTUAL_BASE), raiseUsdMicros: usd(raise, 1n), graduationUsdMicros: usd((vq + raise) * SUPPLY, VIRTUAL_BASE) }
}

export function ownerPricingLine(pricing) {
  const v = launchValues(pricing.virtualQuote, pricing.solUsdMicros)
  return `Opens at ≈${formatUsd(v.openingUsdMicros)} (${formatSol(v.virtualQuote)} virtual), graduates at ≈${formatUsd(v.graduationUsdMicros)} / ${formatSol(v.raiseLamports)} raised`
    + ` · SOL ${formatSolPrice(pricing.solUsdMicros)} (${pricing.sources.map(s => `${s.source} ${formatSolPrice(s.usdMicros)}${s.ignored ? ' ignored' : ''}`).join(', ')})`
}
