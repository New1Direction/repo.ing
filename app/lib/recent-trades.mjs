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

// A trade's key across the chart's trades and the /traders response.
export const tradeKey = trade => `${trade.signature}:${trade.eventIndex}`
const USERNAME = /^[A-Za-z0-9_]{1,15}$/

// The /traders response as trade key → public X link (handle, name, avatar); a malformed entry is skipped.
export function traderHandles(body) {
  const handles = new Map()
  for (const entry of Array.isArray(body?.traders) ? body.traders : []) {
    if (SIGNATURE.test(entry?.signature ?? '') && USERNAME.test(entry?.x?.username ?? '')) handles.set(tradeKey(entry), entry.x)
  }
  return handles
}
