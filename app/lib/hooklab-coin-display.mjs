// Client-safe pieces of a Hooks coin's chart, trades and holders: intervals, URLs and readable amounts.
import { formatSolDisplay, formatUnits } from './format.mjs'
import { percent } from '../../src/hooklab-launch-menus.mjs'

// [key, seconds, button label]. The chart opens on DEFAULT_HOOK_INTERVAL.
export const HOOK_CHART_INTERVALS = Object.freeze([['1m', 60, '1m'], ['5m', 300, '5m'], ['15m', 900, '15m'], ['1h', 3600, '1H'], ['4h', 14400, '4H'], ['1d', 86400, '1D']])
export const DEFAULT_HOOK_INTERVAL = '15m'
export const hookIntervalSeconds = key => HOOK_CHART_INTERVALS.find(([value]) => value === key)?.[1] ?? null

export const hookActivityUrl = (mint, kind, params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== '')).toString()
  return `/api/hook-lab/market/${encodeURIComponent(mint)}/${kind}${query ? `?${query}` : ''}`
}
export const shortAddress = address => `${address.slice(0, 4)}…${address.slice(-4)}`
export const explorerAddress = address => `https://explorer.solana.com/address/${encodeURIComponent(address)}`
export const explorerTx = signature => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`

const DIGITS = /^\d+$/
export const solAmount = raw => DIGITS.test(raw ?? '') ? `${formatSolDisplay(raw)} SOL` : '—'
// A coin amount in whole coins: 2 decimals, compact from a million up ("1.11M"), "<0.01" for dust.
export function coinAmount(raw, decimals = 6) {
  if (!DIGITS.test(raw ?? '')) return '—'
  const value = BigInt(raw), whole = Number(value) / 10 ** decimals
  if (value > 0n && whole < 0.01) return '<0.01'
  if (whole >= 1e6) return whole.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })
  return formatUnits(value, decimals, 2)
}
export function percentLabel(percent) {
  if (!Number.isFinite(percent) || percent < 0) return '—'
  if (percent > 0 && percent < 0.01) return '<0.01%'
  return `${percent.toLocaleString('en-US', { maximumFractionDigits: percent >= 10 ? 1 : 2 })}%`
}
// A trade's age in a narrow column: "now", "4m", "2h", "3d".
export function shortAge(tradedAt, now) {
  const elapsed = now - Date.parse(tradedAt)
  if (!Number.isFinite(elapsed)) return '—'
  const minutes = Math.max(0, Math.floor(elapsed / 60000))
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}

// The trades list: { trades (newest first, as the API pages them), next (the API cursor for the next older page) }.
const swapOf = trade => BigInt(trade.swapCount)
const newestFirst = trades => [...new Map(trades.map(t => [`${t.signature}:${t.eventIndex}`, t])).values()]
  .sort((a, b) => swapOf(a) > swapOf(b) ? -1 : swapOf(a) < swapOf(b) ? 1 : 0)
// A refreshed first page joined to the trades already shown. Swap counters run without gaps, so a refreshed page whose
// oldest trade is more than one past the newest shown means trades in between were never fetched: start again from it.
export function mergeTradePage(shown, page) {
  if (!shown?.trades.length || !page.trades.length || swapOf(page.trades.at(-1)) > swapOf(shown.trades[0]) + 1n) return { trades: page.trades, next: page.next }
  return { trades: newestFirst([...page.trades, ...shown.trades]), next: shown.next }
}
export const appendOlderTrades = (shown, page) => ({ trades: newestFirst([...shown.trades, ...page.trades]), next: page.next })

// A coin's rules in one line: its max per wallet and its fee (with Burn, the total and its split).
// capLifted: the coin has graduated, so its max per wallet no longer applies.
export function hookCoinRules({ capBps, creatorFeeBps, burnBps = 0, selectedHook = null, capLifted = false }) {
  const wallet = selectedHook ? 'Custom hook · Wallet limits set by hook' : capLifted ? 'No max per wallet' : `Max ${percent(capBps)} per wallet`
  const fee = burnBps > 0 ? `${percent(creatorFeeBps + burnBps)} total fee (${percent(creatorFeeBps)} creator + ${percent(burnBps)} burn)` : `${percent(creatorFeeBps)} creator fee`
  return `${wallet} · ${fee}`
}
