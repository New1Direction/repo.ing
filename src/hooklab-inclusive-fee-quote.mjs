// Source-candidate arithmetic only. No release pin, RPC observation, signing or submission.
// Mirrors bordrless-core swap_out/creator_and_holder_fees/inclusive_creator_fee/trade_burn,
// Launch process_inclusive_swap and DEX swap mode 2. Never use for legacy modes 0/1.
// rules: 'none', or a token burn { burnBuyBps, burnSellBps } (one rate, both sides; owner 2026-10-27): a buy burns from
// the curve's output before delivery, a sell from its input before the curve. Holder fees are not supported here yet.
const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n
const check = (ok, code) => { if (!ok) throw Error(code) }
const amount = n => { check(typeof n === 'bigint' && n >= 0n && n <= U64, 'INVALID_U64'); return n }
const ceil = (n, d) => (n + d - 1n) / d
// bordrless-core trade_burn: rounded down, and none unless it is below the amount.
export function tradeBurn(basis, burnBps) {
  const burned = amount(basis) * BigInt(burnBps) / 10000n
  return burned < basis ? burned : 0n
}
// The burn rate a quote applies, or a refusal: one whole rate for both sides, and creator + burn within 10% per side.
function burnRateOf(rules, creatorFeeBps) {
  if (rules === 'none') return 0
  const keys = Object.keys(rules ?? {}).sort().join()
  check(keys === 'burnBuyBps,burnSellBps' && rules.burnBuyBps === rules.burnSellBps && Number.isInteger(rules.burnBuyBps)
    && rules.burnBuyBps >= 0 && rules.burnBuyBps + creatorFeeBps <= 1000, 'UNSUPPORTED_INCLUSIVE_ECONOMICS')
  return rules.burnBuyBps
}
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
  const { creatorFeeBps, policy } = input
  check(policy?.version === 2 && policy.feeModel === 2 && policy.protocolShareBps === 2500
    && policy.creatorFeeBps === creatorFeeBps && policy.lpFeeBps === 0, 'POLICY_FEE_MISMATCH')
  check(Number.isInteger(policy.capBps) && policy.capBps > 0 && policy.capBps < 10000, 'INVALID_CAP')
  const cap = amount(policy.initialSupply) * BigInt(policy.capBps) / 10000n
  check(cap > 0n, 'INVALID_CAP')
  return inclusiveQuote(input,cap)
}

// Display estimate only: arbitrary token-hook deductions require exact-message simulation.
// No gate policy is manufactured for a selected hook, and this never authorizes signing.
export function previewSelectedHookQuote(input) {
  check(input.policy===undefined,'SELECTED_GATE_POLICY')
  return Object.freeze({...inclusiveQuote(input,null),hookDeductionsUnmeasured:true})
}

function inclusiveQuote(input,cap) {
  const { side, amountIn, minAmountOut, creatorFeeBps, pool } = input
  check(side === 'buy' || side === 'sell', 'INVALID_SIDE')
  check(input.feeModel === 2 && input.protocolShareBps === 2500 && input.lpFeeBps === 0
    && input.flatProtocolFeeBps === 0 && input.sniperWindowSecs === 0 && input.sniperStartBps === 0
    && input.quoteHook === 'none' && input.modules === 0 && input.authorShareBps === 0
    && input.rewards === false, 'UNSUPPORTED_INCLUSIVE_ECONOMICS')
  const burnBps = burnRateOf(input.rules, creatorFeeBps)
  amount(amountIn); amount(minAmountOut); amount(input.maxInput); amount(input.recipientBaseBalance)
  check(amountIn > 0n && minAmountOut > 0n && amountIn <= input.maxInput, 'INPUT_OR_OUTPUT_BOUND')
  for (const k of ['baseReserve', 'quoteReserve', 'virtualBase', 'virtualQuote', 'protocolFeesQuote']) amount(pool[k])
  const buy = side === 'buy', x = buy ? pool.quoteReserve + pool.virtualQuote : pool.baseReserve + pool.virtualBase
  const y = buy ? pool.baseReserve + pool.virtualBase : pool.quoteReserve + pool.virtualQuote
  let fees = inclusiveCreatorFee(buy ? amountIn : 0n, creatorFeeBps)
  const sellBurn = buy ? 0n : tradeBurn(amountIn, burnBps)
  const curveInput = buy ? amountIn - fees.grossQuote : amountIn - sellBurn
  check(curveInput > 0n && x + curveInput > 0n && curveInput * y <= U128, 'CURVE_OVERFLOW')
  const grossOutput = amount(curveInput * y / (x + curveInput))
  check(grossOutput > 0n && grossOutput <= (buy ? pool.baseReserve : pool.quoteReserve), 'INSUFFICIENT_LIQUIDITY')
  if (!buy) fees = inclusiveCreatorFee(grossOutput, creatorFeeBps)
  const burned = buy ? tradeBurn(grossOutput, burnBps) : sellBurn
  const delivered = buy ? grossOutput - burned : grossOutput - fees.grossQuote
  check(delivered >= minAmountOut, 'MIN_OUTPUT')
  const recipientBaseAfter = amount(input.recipientBaseBalance + (buy ? delivered : 0n))
  // After graduation the gate reads Launch status 1 and stops capping; only display estimates pass maxWalletLifted.
  check(cap === null || !buy || input.maxWalletLifted === true || recipientBaseAfter <= cap, 'MAX_WALLET')
  const after = Object.freeze({
    // A buy's burned coins leave the vault with the output; a sell's never reach the pool.
    baseReserve: amount(pool.baseReserve + (buy ? -grossOutput : curveInput)),
    quoteReserve: amount(pool.quoteReserve + (buy ? curveInput : -grossOutput)),
    protocolFeesQuote: amount(pool.protocolFeesQuote + fees.platformQuote),
  })
  // Reserve and accrued platform balance are distinct; a quote vault retains both.
  amount(after.quoteReserve + after.protocolFeesQuote)
  return Object.freeze({ kind: 'source-candidate-inclusive-quote/1', feeModel: 2, protocolShareBps: 2500,
    amountIn, curveInput, grossOutput, burned, delivered, minAmountOut, fees, after, cap, recipientBaseAfter,
    quoteVaultDelta: buy ? amountIn - fees.creatorQuote : -(delivered + fees.creatorQuote),
    priceImpactBps: ceil(curveInput * 10000n, x + curveInput),
    executable: false, sbfValidated: false, artifactAdopted: false, canSign: false, canSubmit: false })
}
