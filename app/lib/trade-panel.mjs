import { formatUnits } from './format.mjs'

// A quoted amount as the trade panel shows it: 2 decimals from 1,000 up, 4 from 1, up to 6 below (truncated, so a quote
// never reads higher than it is). The exact amount goes in the element's title.
export function quoteAmountLabel(raw, decimals) {
  if (raw === null || raw === undefined) return '—'
  const value = BigInt(raw), base = 10n ** BigInt(decimals), finest = Math.min(decimals, 6)
  const smallest = 10n ** BigInt(decimals - finest)
  if (value > 0n && value < smallest) return `<${formatUnits(smallest, decimals)}`
  return formatUnits(value, decimals, value >= 1000n * base ? 2 : value >= base ? 4 : finest)
}

// The trade button names what is missing (an amount, enough tokens, enough of what a buy spends, enough SOL for costs)
// before it offers the trade itself. quoteSymbol: what a buy spends (SOL, or a stock pair's stock, docs/STOCK_QUOTES.md);
// network fees and account deposits are always SOL.
export function tradeButtonLabel({ direction, symbol, quoteSymbol = 'SOL', validAmount, buyExceedsBalance = false, sellExceedsBalance = false,
  costShortfall = false, quoteShortfall = false }) {
  if (!validAmount) return 'Enter an amount'
  if (direction === 'sell' && sellExceedsBalance) return `Not enough ${symbol}`
  if (buyExceedsBalance || quoteShortfall) return `Not enough ${quoteSymbol}`
  if (costShortfall) return 'Not enough SOL'
  return `${direction === 'sell' ? 'Sell' : 'Buy'} ${symbol}`
}
