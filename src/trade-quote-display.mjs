// Display-only impact versus the current spot price, excluding the quoted trading fee.
// Execution and slippage continue to use the SDK's exact integer amounts.
export function quoteDisplay({ direction, input, output, sqrtPrice, fee }) {
  const amountIn = BigInt(input), amountOut = BigInt(output), fees = BigInt(fee), sqrt = BigInt(sqrtPrice)
  if (!['buy', 'sell'].includes(direction) || amountIn <= 0n || amountOut <= 0n || sqrt <= 0n || fees < 0n) throw Error('Invalid quote amounts')
  const q128 = 1n << 128n, spot = sqrt * sqrt
  const numerator = direction === 'buy' ? (amountIn - fees) * q128 : (amountOut + fees) * q128
  const denominator = (direction === 'buy' ? amountOut : amountIn) * spot
  if (numerator <= 0n) throw Error('Invalid quote fee')
  const delta = direction === 'buy' ? numerator - denominator : denominator - numerator
  const impact = delta > 0n ? delta * 1_000_000n / denominator : 0n
  return { tradingFeeLamports: fees.toString(), priceImpactPercent: Number(impact) / 10000 }
}
