import { parseUnits } from './format.mjs'

function baseUnits(value, decimals) {
  try { return BigInt(parseUnits(String(value ?? '').trim(), decimals)) } catch { return null }
}

// Mirrors the panel's buy guard (amount must stay below balance so fees fit). Unknown balance stays enabled so connect/retry can take over.
export function canAffordBuy(amountSol, solBalanceLamports) {
  const lamports = baseUnits(amountSol, 9)
  if (lamports === null) return false
  if (solBalanceLamports === null || solBalanceLamports === undefined) return true
  return lamports < BigInt(solBalanceLamports)
}

// Compared in base units so '0.50' and '0.5' mark the same preset; any other typed value clears the mark.
export function sameAmount(a, b, decimals) {
  const left = baseUnits(a, decimals)
  return left !== null && left === baseUnits(b, decimals)
}
