// Graduation of a Hooks coin, in BigInt: the curve, its threshold, the least buy that completes it, and what the
// launch program's permissionless `graduate` leaves behind. Mirrors bordrless-core (hook-lab 134e16de: curve_params,
// graduation_topup, initial_lp, max_swap_in) and graduate.rs/finalize_curve; tests/fixtures/hooklab-graduation-vectors.json
// pins every function to the Rust. Display and estimates only: nothing here signs or sends.
import { inclusiveCreatorFee } from './hooklab-inclusive-fee-quote.mjs'

const BPS = 10000n, MINIMUM_LIQUIDITY = 1000n, WAD = 10n ** 18n, U64 = (1n << 64n) - 1n
const u64 = v => { const n = BigInt(v); if (n < 0n || n > U64) throw Error('INVALID_U64'); return n }
const fits = n => n >= 0n && n <= U64 ? n : null
const ceilDiv = (n, d) => (n + d - 1n) / d
export const STATUS_GRADUATED = 1

// Largest r with r*r <= n, by the core's Newton iteration from 2^ceil(bits/2).
export function isqrt(n) {
  if (n < 2n) return n
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1)
  for (;;) { const y = (x + n / x) / 2n; if (y >= x) return x; x = y }
}

// C = S·bps/10⁴ on the curve, R = S − C kept for graduation, Vb = C·R/(C−R), threshold T = Vq·(C−R)/R; null unless C > R.
export function curveParams(supply, curveBps, virtualQuote) {
  const s = u64(supply), bps = BigInt(curveBps), vq = u64(virtualQuote)
  if (bps > BPS || vq === 0n) return null
  const c = s * bps / BPS, r = s - c
  if (c <= r || r === 0n) return null
  const virtualBase = fits(c * r / (c - r)), graduationQuote = fits(vq * (c - r) / r)
  return virtualBase === null || graduationQuote === null ? null : { curveTokens: c, reserveTokens: r, virtualQuote: vq, virtualBase, graduationQuote }
}

// Base the reserve adds at graduation so dropping the virtual offsets keeps the price: Rq·(Rb+Vb)/(Rq+Vq) − Rb, floored, never negative.
export function graduationTopup({ baseReserve, quoteReserve, virtualBase, virtualQuote }) {
  const rb = u64(baseReserve), rq = u64(quoteReserve), y = rq + u64(virtualQuote)
  if (y === 0n) return null
  const target = rq * (rb + u64(virtualBase)) / y
  return fits(target > rb ? target - rb : 0n)
}

// finalize_curve's LP: sqrt(base·quote), of which 1000 stay with the pool; the rest is minted to the launch, locked for good.
export function initialLp(base, quote) {
  const supply = fits(isqrt(u64(base) * u64(quote)))
  if (supply === null || supply <= MINIMUM_LIQUIDITY) return null
  return { locked: supply - MINIMUM_LIQUIDITY, supply }
}

// The curve input (after fees) that buys exactly `amountOut`, rounded up; null unless 0 < amountOut <= reserveOut.
export function swapInForOut(amountOut, reserveIn, virtualIn, reserveOut, virtualOut) {
  const dy = u64(amountOut), rOut = u64(reserveOut)
  if (dy === 0n || dy > rOut) return null
  const x = u64(reserveIn) + u64(virtualIn), d = rOut + u64(virtualOut) - dy
  return d === 0n ? null : fits(ceilDiv(dy * x, d))
}
// The input that empties the real reserve the curve sells from (a buy: all of the base left on the curve).
export const maxSwapIn = (reserveIn, virtualIn, reserveOut, virtualOut) => swapInForOut(reserveOut, reserveIn, virtualIn, reserveOut, virtualOut)

const pool = p => ({ baseReserve: u64(p.baseReserve), quoteReserve: u64(p.quoteReserve), virtualBase: u64(p.virtualBase),
  virtualQuote: u64(p.virtualQuote), protocolFeesQuote: u64(p.protocolFeesQuote ?? 0) })
// What `graduate` checks: the pool raised the threshold, or its curve sold out.
export const isReady = (p, graduationQuote) => u64(p.quoteReserve) >= u64(graduationQuote) || u64(p.baseReserve) === 0n
// The curve's output for curve input c, before the swap refuses anything above the real reserve.
const curveOut = (p, c) => c * (p.baseReserve + p.virtualBase) / (p.quoteReserve + p.virtualQuote + c)
// What a buy of `amount` lamports puts into the curve: the inclusive creator fee comes off first.
export const curveInputOf = (amount, creatorFeeBps) => u64(amount) - inclusiveCreatorFee(u64(amount), creatorFeeBps).grossQuote

// The least buy (lamports, creator fee included) after which `graduate` is ready: its curve input either reaches the
// threshold or takes exactly the last base on the curve, and the swap can still fill it. null when the coin has
// graduated, its curve is already complete, or no buy lands exactly (every input that gets there asks for more base
// than is left). A bigger buy is refused on chain or overshoots the threshold.
export function finalFillLamports(market) {
  if (!market?.graduationQuote || market.graduated) return null
  const p = pool(market.pool), threshold = u64(market.graduationQuote), feeBps = market.creatorFeeBps
  if (isReady(p, threshold)) return null
  const min = (a, b) => a < b ? a : b, max = (a, b) => a > b ? a : b
  const empties = maxSwapIn(p.quoteReserve, p.virtualQuote, p.baseReserve, p.virtualBase)
  const reaches = empties !== null && curveOut(p, empties) === p.baseReserve ? min(threshold - p.quoteReserve, empties) : threshold - p.quoteReserve
  // The swap must also give something: at least the input that buys one base unit.
  const target = max(reaches, swapInForOut(1n, p.quoteReserve, p.virtualQuote, p.baseReserve, p.virtualBase) ?? 1n)
  if (curveOut(p, target) > p.baseReserve || curveOut(p, target) === 0n) return null
  // Curve input = A − ⌈A·b/10⁴⌉ never skips a value as A grows, so the least A reaching `target` puts exactly `target` in.
  let amount = feeBps > 0 ? ceilDiv(target * BPS, BPS - BigInt(feeBps)) : target
  while (curveInputOf(amount, feeBps) < target) amount += 1n
  while (amount > 1n && curveInputOf(amount - 1n, feeBps) >= target) amount -= 1n
  return fits(amount)
}

// The pool after a buy on the curve (creator fee off the input first; the platform's quarter stays in the pool).
export function buyOnCurve(market, amount) {
  const p = pool(market.pool), fees = inclusiveCreatorFee(u64(amount), market.creatorFeeBps), c = u64(amount) - fees.grossQuote
  const out = curveOut(p, c)
  if (c === 0n || out === 0n || out > p.baseReserve) return null
  return { curveInput: c, grossOutput: out, fees, pool: { ...p, baseReserve: p.baseReserve - out, quoteReserve: p.quoteReserve + c, protocolFeesQuote: p.protocolFeesQuote + fees.platformQuote } }
}

// What `graduate` does to a ready pool: the reserve tops the base vault up (at most what the launch's reserve holds),
// finalize_curve sets the reserves to the vault balances less the platform's fees, mints the LP to the launch and drops
// the virtual offsets, and the rest of the reserve is burned. Vault balances default to reserves (+ fees for quote);
// pass the real ones when known (a donation to a vault becomes liquidity). null where finalize_curve would refuse.
export function graduationOutcome(p, reserveHolding, vaults = {}) {
  const before = pool(p), held = u64(reserveHolding), topup = graduationTopup(before)
  if (topup === null) return null
  const added = topup < held ? topup : held
  const base = fits(u64(vaults.base ?? before.baseReserve) + added), quoteTotal = u64(vaults.quote ?? before.quoteReserve + before.protocolFeesQuote)
  if (base === null || quoteTotal < before.protocolFeesQuote) return null
  const quote = quoteTotal - before.protocolFeesQuote, lp = initialLp(base, quote)
  if (!lp) return null
  return { topup: added, burned: held - added, lockedLp: lp.locked, lpSupply: lp.supply,
    priceBeforeWad: spotPriceWad(before), priceAfterWad: spotPriceWad({ baseReserve: base, quoteReserve: quote, virtualBase: 0n, virtualQuote: 0n }),
    pool: { baseReserve: base, quoteReserve: quote, virtualBase: 0n, virtualQuote: 0n, protocolFeesQuote: before.protocolFeesQuote } }
}

// Quote per base unit scaled by 1e18, from the effective reserves (the core's spot_price_wad).
export function spotPriceWad(p) {
  const x = u64(p.baseReserve) + u64(p.virtualBase)
  return x === 0n ? null : (u64(p.quoteReserve) + u64(p.virtualQuote)) * WAD / x
}
