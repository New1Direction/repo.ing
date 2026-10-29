// Token amounts for display: compact, one decimal, floored so a figure never overstates.
// 201,771,000.5 tokens -> '201.7M'; 705,460.37 -> '705.4K'; 812.5 -> '812'. baseUnits: integer string or bigint.
const STEPS = [[1_000_000_000n, 'B'], [1_000_000n, 'M'], [1_000n, 'K']]

export function formatTokenShort(baseUnits, decimals = 6) {
  if (!/^\d+$/.test(String(baseUnits))) return null
  const whole = BigInt(String(baseUnits)) / 10n ** BigInt(decimals)
  for (const [threshold, suffix] of STEPS) {
    if (whole < threshold) continue
    const tenths = whole * 10n / threshold
    return `${(tenths / 10n).toLocaleString('en-US')}${tenths % 10n ? `.${tenths % 10n}` : ''}${suffix}`
  }
  return whole.toLocaleString('en-US')
}
