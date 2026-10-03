import { formatSolDisplay } from './format.mjs'
import { formatWholeSol } from './repoing-case.mjs'
import { buybackSummary, formatAgo } from './buyback-summary.mjs'
import { orderMarkets, tradedToday } from './market-order.mjs'
import { bondingProgress, marketCapDisplay } from './market-display.mjs'

export const MOVING_NOW_LIMIT = 4
const AMOUNT = /^\d+(\.\d+)?$/
const lamports = value => AMOUNT.test(String(value ?? '')) ? BigInt(String(value).split('.')[0]) : 0n

// The home hero's live markets: promoted markets that traded in the last 24 hours, busiest first ('moving'). On a day
// nothing has traded yet, the newest promoted launches instead ('new'), so the strip only empties with no markets at all.
export function movingNow(markets, limit = MOVING_NOW_LIMIT) {
  const promoted = markets.filter(market => market.promoted !== false)
  const traded = orderMarkets(promoted.filter(tradedToday), 'Trending').slice(0, limit)
  return traded.length ? { kind: 'moving', markets: traded } : { kind: 'new', markets: orderMarkets(promoted, 'New').slice(0, limit) }
}

// One card's figures: 24h volume (or, for a fresh launch, how long ago it launched), market cap (USD when SOL is priced)
// and where the market stands on its way to graduation.
export function moverFacts(market, usdPerSol = null, now = Date.now()) {
  return { volume: `${formatSolDisplay(lamports(market.volume24hLamports))} SOL`, launched: formatAgo(market.indexedAt, now),
    cap: marketCapDisplay(market.priceSol, usdPerSol)?.value ?? null, stage: bondingProgress(market)?.label ?? null }
}

// The hero's proof line, each figure only while it is known: all-time trading (whole SOL, floored), builder payouts,
// and buybacks (every published receipt, linking to them).
export function proofFacts({ totals = null, receipts = null } = {}) {
  const facts = [], traded = totals ? formatWholeSol(totals.volume) : null
  if (traded && traded !== '0') facts.push({ id: 'traded', value: `${traded} SOL`, label: 'traded' })
  if (totals && lamports(totals.paid) > 0n) facts.push({ id: 'paid', value: `${formatSolDisplay(lamports(totals.paid))} SOL`, label: 'paid to builders' })
  const bought = buybackSummary(receipts, null)
  if (bought) facts.push({ id: 'bought', value: `${bought.sol} SOL`, label: 'bought back', href: '/stats#repo-title' })
  return facts
}
