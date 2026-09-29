import { totalBuybackLamports } from './buyback-receipts.mjs'
import { formatSolDisplay } from './format.mjs'

const TOKEN_DECIMALS = 6n
const AMOUNT = /^\d+$/

// Totals from the same receipts /stats lists. source 'custody' is platform revenue only; null counts
// every published buyback (platform revenue and team wallet). Returns null when nothing is recorded.
export function buybackSummary(receipts, source = 'custody') {
  if (!Array.isArray(receipts)) return null
  let lamports, tokens = 0n, count = 0
  try {
    lamports = BigInt(totalBuybackLamports(receipts, source))
    for (const receipt of receipts) {
      if (source && receipt.source !== source) continue
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

const AGO_UNITS = [['day', 86_400], ['hour', 3_600], ['minute', 60]]
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' })
// '3 hours ago'. Whole units, floored, so a buyback never reads as more recent than it was.
export function formatAgo(at, now = Date.now()) {
  const seconds = Math.floor((now - Date.parse(at)) / 1000)
  if (Number.isNaN(seconds)) return null
  for (const [unit, size] of AGO_UNITS) if (seconds >= size) return relative.format(-Math.floor(seconds / size), unit)
  return 'just now'
}
