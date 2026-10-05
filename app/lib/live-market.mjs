import { recentTrades } from './recent-trades.mjs'

// The home page's live $REPOING card reads the market's 7-day chart (hourly bars): enough to draw the last 24 hours from the
// bar just before them, and a flat line at the last price on a day nothing traded (phone-market-summary.mjs).
export const LIVE_MARKET_RANGE = '7d'
export const LIVE_TRADE_ROWS = 4
// The card polls the CDN-cached /trades response rather than holding a live event stream per home page visitor.
export const LIVE_MARKET_POLL_MS = 20_000

const DIGITS = /^\d+$/

// The parts of a /trades payload (src/market-chart.mjs) the card draws, in the same field names, so phoneMarketSummary reads
// it as it reads the token page's chart. trades: the newest LIVE_TRADE_ROWS swaps, newest first; pending marks one confirmed
// but not finalized yet (src/market-chart.mjs mergeLiveTrades). null for anything else.
export function liveChart(payload) {
  if (!payload || !Array.isArray(payload.candles) || !Number.isFinite(payload.interval)) return null
  return {
    interval: payload.interval,
    volume24hLamports: DIGITS.test(String(payload.volume24hLamports ?? '')) ? String(payload.volume24hLamports) : null,
    latest: Number.isFinite(payload.latest?.priceSol) && payload.latest.priceSol > 0 ? { priceSol: payload.latest.priceSol } : null,
    candles: payload.candles.filter(bar => Number.isFinite(bar?.time)).map(({ time, open, close, orderingPending }) =>
      ({ time, open, close, ...orderingPending ? { orderingPending: true } : {} })),
    trades: recentTrades(payload.trades, LIVE_TRADE_ROWS).map(({ signature, eventIndex, direction, tradedAt, solLamports, pending }) =>
      ({ signature, eventIndex, direction, tradedAt, solLamports, ...pending === true ? { pending: true } : {} })),
  }
}

// The x/y of a sparklinePath's last point (its final "L x y"), as percentages of the box, for the live dot drawn over it.
export function lastPoint(path, width, height) {
  const match = /(-?[\d.]+) (-?[\d.]+)\s*$/.exec(path ?? '')
  return match ? { left: Number(match[1]) / width * 100, top: Number(match[2]) / height * 100 } : null
}
