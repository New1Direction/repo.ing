// /stats builder split (src/protocol-analytics.mjs builders.{earned,paid}): each side's share of the total, to 0.1%,
// rounded half up from exact lamports. null when there is nothing to split.
export function splitShare(part, total) {
  const value = BigInt(part), sum = BigInt(total)
  if (sum <= 0n) return null
  return Number((value * 2000n + sum) / (2n * sum)) / 10
}

export const shareLabel = share => `${share.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
