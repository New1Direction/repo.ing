// One amount split by a platform revenue policy (platform_revenue_policies: permille shares of buyback and liquidity, the
// rest to treasury). Integer lamports, rounded down per share, so the treasury takes the remainder and the three parts
// always add up to the amount. Shared by allocation (src/platform-revenue.mjs) and the Hooks allocation preview.
const PERMILLE = 1000n

export function splitByPolicy(amount, { buybackPermille, liquidityPermille }) {
  const total = BigInt(amount)
  if (total < 0n) throw Error('Split amount must not be negative')
  if (!Number.isInteger(buybackPermille) || !Number.isInteger(liquidityPermille) || buybackPermille < 0 || liquidityPermille < 0
    || buybackPermille + liquidityPermille > 1000) throw Error('Policy permilles must be non-negative integers summing to at most 1000')
  const buyback = total * BigInt(buybackPermille) / PERMILLE, liquidity = total * BigInt(liquidityPermille) / PERMILLE
  return { buyback, liquidity, treasury: total - buyback - liquidity }
}
