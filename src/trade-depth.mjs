// SDK quotes run against one pool snapshot. The result is a guide, never a
// transaction limit or a promise about the price when a trade executes.
export function estimateBuySizes(maxInput, quoteImpact) {
  const result = []
  for (const percent of [1,3]) {
    let low = 0n, high = BigInt(maxInput)
    while (low < high) {
      const mid = (low + high + 1n) / 2n
      let fits = false
      try { const impact = quoteImpact(mid); fits = Number.isFinite(impact) && impact <= percent } catch { /* Beyond executable curve inventory. */ }
      if (fits) low = mid
      else high = mid - 1n
    }
    result.push({ percent, amountLamports: low.toString() })
  }
  return result
}
