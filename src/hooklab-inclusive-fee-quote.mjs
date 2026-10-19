// Source-candidate arithmetic only. No release pin, RPC observation, signing or submission.
// Mirrors bordrless-core swap_out/creator_and_holder_fees/inclusive_creator_fee,
// Launch process_inclusive_swap and DEX swap mode 2. Never use for legacy modes 0/1.
const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n
const check = (ok, code) => { if (!ok) throw Error(code) }
const amount = n => { check(typeof n === 'bigint' && n >= 0n && n <= U64, 'INVALID_U64'); return n }
const ceil = (n, d) => (n + d - 1n) / d
export function inclusiveCreatorFee(basis, creatorFeeBps) {
  amount(basis)
  check(Number.isInteger(creatorFeeBps) && creatorFeeBps >= 0 && creatorFeeBps < 10000, 'INVALID_CREATOR_FEE')
  const calculated = ceil(basis * BigInt(creatorFeeBps), 10000n)
  // Existing creator_and_holder_fees omits fees that consume the entire leg.
  const grossQuote = calculated < basis ? calculated : 0n
  const platformQuote = grossQuote / 4n
  return Object.freeze({ grossQuote, platformQuote, creatorQuote: grossQuote - platformQuote })
}
export function modelInclusiveCreatorQuote(input) {
  const { side, amountIn, minAmountOut, creatorFeeBps, pool, policy } = input
  check(side === 'buy' || side === 'sell', 'INVALID_SIDE')
  check(input.feeModel === 2 && input.protocolShareBps === 2500 && input.lpFeeBps === 0
    && input.flatProtocolFeeBps === 0 && input.sniperWindowSecs === 0 && input.sniperStartBps === 0
    && input.quoteHook === 'none' && input.modules === 0 && input.authorShareBps === 0
    && input.rules === 'none' && input.rewards === false, 'UNSUPPORTED_INCLUSIVE_ECONOMICS')
  check(policy?.version === 2 && policy.feeModel === 2 && policy.protocolShareBps === 2500
    && policy.creatorFeeBps === creatorFeeBps && policy.lpFeeBps === 0, 'POLICY_FEE_MISMATCH')
  check(Number.isInteger(policy.capBps) && policy.capBps > 0 && policy.capBps < 10000, 'INVALID_CAP')
  const cap = amount(policy.initialSupply) * BigInt(policy.capBps) / 10000n
  check(cap > 0n, 'INVALID_CAP')
  amount(amountIn); amount(minAmountOut); amount(input.maxInput); amount(input.recipientBaseBalance)
  check(amountIn > 0n && minAmountOut > 0n && amountIn <= input.maxInput, 'INPUT_OR_OUTPUT_BOUND')
  for (const k of ['baseReserve', 'quoteReserve', 'virtualBase', 'virtualQuote', 'protocolFeesQuote']) amount(pool[k])
  const buy = side === 'buy', x = buy ? pool.quoteReserve + pool.virtualQuote : pool.baseReserve + pool.virtualBase
  const y = buy ? pool.baseReserve + pool.virtualBase : pool.quoteReserve + pool.virtualQuote
  let fees = inclusiveCreatorFee(buy ? amountIn : 0n, creatorFeeBps)
  const curveInput = buy ? amountIn - fees.grossQuote : amountIn
  check(curveInput > 0n && x + curveInput > 0n && curveInput * y <= U128, 'CURVE_OVERFLOW')
  const grossOutput = amount(curveInput * y / (x + curveInput))
  check(grossOutput > 0n && grossOutput <= (buy ? pool.baseReserve : pool.quoteReserve), 'INSUFFICIENT_LIQUIDITY')
  if (!buy) fees = inclusiveCreatorFee(grossOutput, creatorFeeBps)
  const delivered = buy ? grossOutput : grossOutput - fees.grossQuote
  check(delivered >= minAmountOut, 'MIN_OUTPUT')
  const recipientBaseAfter = amount(input.recipientBaseBalance + (buy ? delivered : 0n))
  // After graduation the gate reads Launch status 1 and stops capping; only display estimates pass maxWalletLifted.
  check(!buy || input.maxWalletLifted === true || recipientBaseAfter <= cap, 'MAX_WALLET')
  const after = Object.freeze({
    baseReserve: amount(pool.baseReserve + (buy ? -grossOutput : amountIn)),
    quoteReserve: amount(pool.quoteReserve + (buy ? curveInput : -grossOutput)),
    protocolFeesQuote: amount(pool.protocolFeesQuote + fees.platformQuote),
  })
  // Reserve and accrued platform balance are distinct; a quote vault retains both.
  amount(after.quoteReserve + after.protocolFeesQuote)
  return Object.freeze({ kind: 'source-candidate-inclusive-quote/1', feeModel: 2, protocolShareBps: 2500,
    amountIn, curveInput, grossOutput, delivered, minAmountOut, fees, after, cap, recipientBaseAfter,
    quoteVaultDelta: buy ? amountIn - fees.creatorQuote : -(delivered + fees.creatorQuote),
    priceImpactBps: ceil(curveInput * 10000n, x + curveInput),
    executable: false, sbfValidated: false, artifactAdopted: false, canSign: false, canSubmit: false })
}
