// Client-safe pieces of a Hooks coin's chart, trades and holders: intervals, URLs and readable amounts.
import { formatSolDisplay, formatUnits } from './format.mjs'

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
