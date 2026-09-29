import { totalBuybackLamports } from './buyback-receipts.mjs'
import { formatSolDisplay } from './format.mjs'

const TOKEN_DECIMALS = 6n
const AMOUNT = /^\d+$/

// Headline for the homepage counter, from the same receipts /stats lists. Platform revenue
// ('custody') only: team-wallet buys are not platform fees. Returns null when nothing is recorded.
export function buybackSummary(receipts, source = 'custody') {
  if (!Array.isArray(receipts)) return null
  let lamports, tokens = 0n, count = 0
  try {
    lamports = BigInt(totalBuybackLamports(receipts, source))
    for (const receipt of receipts) {
      if (receipt.source !== source) continue
      if (!AMOUNT.test(String(receipt.tokenBaseUnits))) return null
      tokens += BigInt(receipt.tokenBaseUnits); count++
    }
  } catch { return null }
  if (!count || lamports <= 0n) return null
  return { lamports: lamports.toString(), tokenBaseUnits: tokens.toString(), count,
    sol: formatSolDisplay(lamports), tokens: formatTokenCompact(tokens) }
}

// 50,570,757 whole tokens -> '50.57M'. Truncates rather than rounds up, so the figure never overstates.
export function formatTokenCompact(baseUnits, decimals = TOKEN_DECIMALS) {
  if (!AMOUNT.test(String(baseUnits))) return '—'
  const whole = BigInt(baseUnits) / 10n ** decimals
  for (const [threshold, suffix] of [[1_000_000_000n, 'B'], [1_000_000n, 'M'], [1_000n, 'K']]) {
    if (whole >= threshold) {
      const hundredths = whole * 100n / threshold
      const fraction = String(hundredths % 100n).padStart(2, '0').replace(/0+$/, '')
      return `${(hundredths / 100n).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}${suffix}`
    }
  }
  return whole.toLocaleString('en-US')
}
