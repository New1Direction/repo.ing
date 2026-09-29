import { formatSolDisplay, formatUnits } from './format.mjs'
import { chartTradeAge } from './chart-display.mjs'

export const RECENT_TRADE_LIMIT = 10
const DIGITS = /^\d+$/
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/

// Chart trades arrive oldest first; the list shows the newest, skipping rows it cannot link or date.
export function recentTrades(trades, limit = RECENT_TRADE_LIMIT) {
  if (!Array.isArray(trades)) return []
  return trades.filter(trade => ['buy', 'sell'].includes(trade?.direction) && SIGNATURE.test(trade.signature ?? '') &&
    Number.isFinite(Date.parse(trade.tradedAt))).slice(-limit).reverse()
}

export function recentTradeSol(trade) {
  return DIGITS.test(trade.solLamports ?? '') ? `${formatSolDisplay(trade.solLamports)} SOL` : '—'
}

export function recentTradeTokens(trade, decimals = 6) {
  if (!DIGITS.test(trade.tokenBaseUnits ?? '')) return null
  const raw = BigInt(trade.tokenBaseUnits)
  if (raw > 0n && raw < 10n ** BigInt(decimals - 2)) return '<0.01'
  return formatUnits(raw, decimals, 2)
}

export function recentTradeAge(trade, now) {
  return chartTradeAge(trade.tradedAt, now) ?? ''
}

export function solscanTx(signature) {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}`
}
