// Pure source-candidate model 1 math, pinned Bordrless 7fde54001d7f0c88b17c87babf73fb40be07b3cb.
// Mirrors core creator_and_holder_fees, quote_cut_fee, swap_amounts_shared,
// output_share, launch_fill and the native run_swap accounting. Does not authorize a trade.
const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n, BPS = 10000n
const check = (ok, code) => { if (!ok) throw Error(code) }
const amount = n => { check(typeof n === 'bigint' && n >= 0n && n <= U64, 'INVALID_U64'); return n }
const rate = n => { amount(n); check(n <= BPS, 'INVALID_BPS'); return n }
const ceil = (n, d) => { check(d > 0n, 'ZERO_DENOMINATOR'); return (n + d - 1n) / d }
const fee = (n, bps) => amount(ceil(n * bps, BPS))
const positive = (n, code) => { check(n > 0n, code); return amount(n) }

/** All arguments are BigInts. Share is additional to (never deducted from) creator revenue. */
export function shareProtocol(value, bps) {
  return fee(amount(value), rate(bps))
}

/** Quote-leg cuts: independent ceiling creator/eligible-holder fees, jointly dropped at dust;
 * optional custom quote cut floors and is dropped if total cuts would consume the leg.
 * This primitive can model holder fees alone; shareNativeQuote deliberately excludes kits.
 * Required: amount, creatorFeeBps. Optional BigInts: holderFeeBps=0, eligible=0,
 * minEligible=1, quoteCutBps=0. Returns {creator, holder, custom, total}, all quote units.
 */
export function shareCreatorCuts({ amount: basis, creatorFeeBps, holderFeeBps = 0n,
  eligible = 0n, minEligible = 1n, quoteCutBps = 0n }) {
  amount(basis); rate(creatorFeeBps); rate(holderFeeBps); rate(quoteCutBps)
  amount(eligible); amount(minEligible)
  let creator = fee(basis, creatorFeeBps)
  let holder = eligible >= minEligible ? fee(basis, holderFeeBps) : 0n
  if (creator + holder >= basis) { creator = 0n; holder = 0n }
  let custom = basis * quoteCutBps / BPS
  if (creator + holder + custom >= basis) custom = 0n
  return Object.freeze({ creator, holder, custom, total: creator + holder + custom })
}

/** Native SOL quote, base token, fee model 1 only. Every numeric field is a BigInt in raw
 * units (bps for rates); no Number coercion. Required: side ('buy'|'sell'), amountIn (requested),
 * minAmountOut, creatorFeeBps, lpFeeBps (already resolved pool/sniper override), tokenInputTax,
 * tokenOutputTax, pool {baseReserve, quoteReserve, virtualBase, virtualQuote,
 * protocolFeesQuote, protocolShareBps}. Optional: quoteCutBps=0, burnIn=0, burnOut=0,
 * allowPartialFill=false, kit=false. Nonzero kit/holder economics are unsupported here.
 *
 * Taxes are explicit measured shortfalls: sell tokenInputTax = amountIn - burnIn - vault credit;
 * buy tokenOutputTax = grossOutput - burnOut - recipient credit. Supply zero explicitly when
 * untaxed. Native-side tax/burn must be zero. No tax schedule is inferred. Burns and tax losses
 * must describe this actual (possibly filled) trade, not a scaled estimate of the request.
 * A buy with allowPartialFill uses pinned launch_fill bisection on exact quote fees.
 * Returns raw-unit measurements, fee breakdown, reserve/protocol books and signed vault delta.
 * Output is calculation evidence only, never an executable or validated transaction.
 */
export function shareNativeQuote(input) {
  const { side, pool, creatorFeeBps, lpFeeBps } = input
  const { quoteCutBps = 0n, burnIn = 0n, burnOut = 0n, allowPartialFill = false } = input
  check(side === 'buy' || side === 'sell', 'INVALID_SIDE')
  check(input.kit === undefined || input.kit === false, 'UNSUPPORTED_KIT')
  check(input.holderFeeBps === undefined || input.holderFeeBps === 0n, 'UNSUPPORTED_KIT')
  check(input.feeModel === undefined || input.feeModel === 1, 'UNSUPPORTED_FEE_MODEL')
  check(typeof allowPartialFill === 'boolean', 'INVALID_FILL')
  const buy = side === 'buy', requested = positive(input.amountIn, 'ZERO_INPUT')
  amount(input.minAmountOut); amount(input.tokenInputTax); amount(input.tokenOutputTax)
  amount(burnIn); amount(burnOut); rate(creatorFeeBps); rate(lpFeeBps); rate(quoteCutBps)
  for (const k of ['baseReserve', 'quoteReserve', 'virtualBase', 'virtualQuote', 'protocolFeesQuote']) amount(pool[k])
  const shareBps = rate(pool.protocolShareBps)
  check(buy ? burnIn === 0n && input.tokenInputTax === 0n
    : burnOut === 0n && input.tokenOutputTax === 0n, 'NATIVE_LEG_DEDUCTION')
  check(buy || !allowPartialFill, 'INVALID_FILL')
  const x = buy ? pool.quoteReserve + pool.virtualQuote : pool.baseReserve + pool.virtualBase
  const y = buy ? pool.baseReserve + pool.virtualBase : pool.quoteReserve + pool.virtualQuote
  const curve = n => {
    check(n * y <= U128, 'CURVE_OVERFLOW')
    check(x + n > 0n, 'ZERO_DENOMINATOR')
    return n * y / (x + n)
  }
  const cuts = n => shareCreatorCuts({ amount: n, creatorFeeBps, quoteCutBps })
  const buyLeg = n => {
    const cut = cuts(n), received = n - cut.total
    const lp = fee(received, lpFeeBps), share = shareProtocol(cut.total, shareBps)
    return { cut, received, lp, share, net: received - lp - share }
  }
  let amountIn = requested, filled = false
  if (buy && allowPartialFill && pool.baseReserve > 0n && curve(requested) >= pool.baseReserve) {
    const reaches = n => {
      const { net } = buyLeg(n)
      return net > 0n && curve(net) >= pool.baseReserve
    }
    if (reaches(requested)) {
      let lo = 0n, hi = requested
      // Identical bounded u64 bisection to launch_fill (at most 64 iterations).
      while (hi - lo > 1n) {
        const mid = lo + (hi - lo) / 2n
        if (reaches(mid)) hi = mid
        else lo = mid
      }
      amountIn = hi; filled = true
    }
  }
  let cut, receivedIn, curveInput, lpProtocolQuote, inputShareQuote
  if (buy) {
    const leg = buyLeg(amountIn)
    cut = leg.cut; receivedIn = leg.received; curveInput = leg.net
    lpProtocolQuote = leg.lp; inputShareQuote = leg.share
  } else {
    receivedIn = amountIn - burnIn - input.tokenInputTax
    curveInput = receivedIn
  }
  positive(curveInput, 'FEES_EXCEED_INPUT')
  const rawOutput = curve(curveInput), reserveOut = buy ? pool.baseReserve : pool.quoteReserve
  const grossOutput = amount(filled && rawOutput > reserveOut ? reserveOut : rawOutput)
  check(grossOutput > 0n && grossOutput <= reserveOut, 'INSUFFICIENT_LIQUIDITY')
  if (!buy) {
    lpProtocolQuote = fee(grossOutput, lpFeeBps)
    // Token-hook fees are split in tokens by the hook, never converted to a SOL charge.
    inputShareQuote = 0n
  }
  const protocolIn = amount(lpProtocolQuote + inputShareQuote)
  const amountOutBeforeHooks = positive(grossOutput - (buy ? 0n : protocolIn), 'FEES_EXCEED_OUTPUT')
  if (!buy) cut = cuts(amountOutBeforeHooks)
  const heldBack = buy ? 0n : shareProtocol(cut.total, shareBps)
  const delivered = positive(amountOutBeforeHooks - (buy ? burnOut + input.tokenOutputTax : cut.total + heldBack), 'FEES_EXCEED_OUTPUT')
  const cutsIn = amount(amountIn - burnIn - receivedIn)
  const cutsOut = amount(amountOutBeforeHooks - burnOut - heldBack - delivered)
  const outputShareQuote = buy ? 0n : shareProtocol(cutsOut, shareBps)
  const minAmountOut = input.minAmountOut * amountIn / requested
  check(delivered >= minAmountOut, 'MIN_OUTPUT')
  const protocolQuote = amount(protocolIn + outputShareQuote)
  const after = Object.freeze({
    baseReserve: amount(pool.baseReserve + (buy ? -grossOutput : receivedIn)),
    quoteReserve: amount(pool.quoteReserve + (buy ? curveInput : -grossOutput) - (outputShareQuote - heldBack)),
    protocolFeesQuote: amount(pool.protocolFeesQuote + protocolQuote),
  })
  amount(after.quoteReserve + after.protocolFeesQuote)
  const fees = Object.freeze({ creatorQuote: cut.creator, customQuote: cut.custom, lpFee: 0n,
    lpProtocolQuote, inputShareQuote, outputShareQuote, protocolQuote })
  return Object.freeze({ kind: 'source-candidate-share-quote/1', feeModel: 1,
    protocolShareBps: shareBps, requestedInput: requested, amountIn, unspentInput: requested - amountIn,
    filled, receivedIn, curveInput, grossOutput, amountOutBeforeHooks, delivered, cutsIn, cutsOut,
    burnIn, burnOut, minAmountOut, fees, after,
    quoteVaultDelta: buy ? receivedIn : -(delivered + cut.total),
    executable: false, sbfValidated: false, artifactAdopted: false, canSign: false, canSubmit: false })
}
