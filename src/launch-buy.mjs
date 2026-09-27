import BN from 'bn.js'

export const INITIAL_BUY_CAP_BPS = 300
const MAX_U64 = 18446744073709551615n
// The fixed mainnet config mints one billion base tokens with six decimals.
const FIXED_SUPPLY_BASE_UNITS = 1_000_000_000_000_000n

// Choose the largest whole-lamport input whose output stays at or below the
// requested percentage. Rounding an exact-output quote up can breach the cap.
export function launchBuyPreset(client, config, supplyBps) {
  if (![100, 200, INITIAL_BUY_CAP_BPS].includes(supplyBps)) throw new Error('Choose 1%, 2%, or 3% of supply')
  if (BigInt(config.preMigrationTokenSupply.toString()) !== FIXED_SUPPLY_BASE_UNITS) {
    throw new Error('Initial buy requires the tested one-billion-token config')
  }
  const target = FIXED_SUPPLY_BASE_UNITS * BigInt(supplyBps) / 10_000n
  const output = amount => BigInt(client.pool.getQuoteFromInputAmount({ config, swapBaseForQuote: false,
    amountIn: new BN(amount.toString()), slippageBps: 0, hasReferral: false,
    eligibleForFirstSwapWithMinFee: false }).outputAmount.toString())
  let low = 0n, high = 1_000_000n
  while (output(high) <= target) {
    low = high; high *= 2n
    if (high > MAX_U64) throw new Error('Initial buy preset is unavailable')
  }
  while (low + 1n < high) {
    const middle = (low + high) / 2n
    if (output(middle) <= target) low = middle
    else high = middle
  }
  if (low === 0n) throw new Error('Initial buy preset is unavailable')
  return low.toString()
}

export function launchBuyQuote(client, config, rawLamports) {
  if (!/^(0|[1-9]\d*)$/.test(String(rawLamports))) throw new Error('Initial buy must be a whole number of lamports')
  const amount = BigInt(rawLamports)
  if (amount > MAX_U64) throw new Error('Initial buy exceeds the Solana u64 amount limit')
  if (amount === 0n) return null
  if (BigInt(config.preMigrationTokenSupply.toString()) !== FIXED_SUPPLY_BASE_UNITS) {
    throw new Error('Initial buy requires the tested one-billion-token config')
  }
  const quote = client.pool.getQuoteFromInputAmount({ config, swapBaseForQuote: false,
    amountIn: new BN(amount.toString()), slippageBps: 0, hasReferral: false,
    eligibleForFirstSwapWithMinFee: false })
  const output = BigInt(quote.outputAmount.toString())
  if (output <= 0n) throw new Error('Initial buy has no executable token output')
  if (output * 10_000n > FIXED_SUPPLY_BASE_UNITS * BigInt(INITIAL_BUY_CAP_BPS)) {
    throw new Error(`Initial buy exceeds ${INITIAL_BUY_CAP_BPS / 100}% of token supply; enter less SOL`)
  }
  // Pool creation and swap are atomic. There is no earlier pool trade that can
  // change this deterministic first-buy quote before the wallet signs it.
  return { outputAmount: quote.outputAmount, minimumAmountOut: quote.outputAmount,
    tradingFee: quote.tradingFee.add(quote.protocolFee).add(quote.referralFee) }
}
