// Pure trade-panel math for Hooks coins: amounts, estimates and the steps a buy or sell takes. No network or wallet.
// Estimates use the same quote model the server compiles with; the server's exact review is what gets signed.
import { modelInclusiveCreatorQuote } from '../../src/hooklab-inclusive-fee-quote.mjs'

export const SOL_DECIMALS = 9
// Network fee per step at the production compute budget and priority (an upper bound shown before signing).
export const STEP_FEE_LAMPORTS = { fund: 7000n, withdraw: 7000n, buy: 19000n, sell: 19000n }
export const SLIPPAGE_CHOICES = [100, 300, 500]
// The server reviews trades with at most this price impact (its request schema caps it at 10%).
export const MAX_PRICE_IMPACT_BPS = 1000

// '0.05' -> 50_000_000n for 9 decimals; null when the text is not a positive amount with at most `decimals` places.
export function parseUnits(text, decimals) {
  const value = String(text ?? '').trim()
  if (!/^\d*\.?\d*$/.test(value) || !/\d/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) return null
  const raw = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return raw > 0n ? raw : null
}

// 50_000_000n, 9 -> '0.05'; trims trailing zeros, keeps at most `places` fraction digits.
export function formatUnits(raw, decimals, places = decimals) {
  const value = BigInt(raw), negative = value < 0n, abs = negative ? -value : value, base = 10n ** BigInt(decimals)
  const fraction = (abs % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '')
  return `${negative ? '-' : ''}${(abs / base).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`
}
export const sol = (lamports, places = 4) => `${formatUnits(lamports, SOL_DECIMALS, places)} SOL`

const QUOTE_ERRORS = { MAX_WALLET: 'That would put you over this coin’s max per wallet.', MIN_OUTPUT: 'Price moved too much for this amount.' }

// Estimated result of a buy (amount in lamports) or sell (amount in raw coin units) at the current curve.
export function estimateTrade(market, { side, amount, coinBalance = 0n, slippageBps = 300 }) {
  const p = market.pool
  try {
    const quote = modelInclusiveCreatorQuote({ side, amountIn: amount, minAmountOut: 1n, maxInput: amount, creatorFeeBps: market.creatorFeeBps,
      feeModel: 2, protocolShareBps: 2500, lpFeeBps: 0, flatProtocolFeeBps: 0, sniperWindowSecs: 0, sniperStartBps: 0, quoteHook: 'none', modules: 0,
      authorShareBps: 0, rules: 'none', rewards: false, recipientBaseBalance: BigInt(coinBalance),
      pool: { baseReserve: BigInt(p.baseReserve), quoteReserve: BigInt(p.quoteReserve), virtualBase: BigInt(p.virtualBase), virtualQuote: BigInt(p.virtualQuote), protocolFeesQuote: BigInt(p.protocolFeesQuote) },
      policy: { version: 2, feeModel: 2, protocolShareBps: 2500, creatorFeeBps: market.creatorFeeBps, lpFeeBps: 0, initialSupply: BigInt(market.initialSupply), capBps: market.capBps } })
    const minAmountOut = quote.delivered * BigInt(10000 - slippageBps) / 10000n
    if (minAmountOut <= 0n) return { error: 'This amount is too small to trade.' }
    if (quote.priceImpactBps > BigInt(MAX_PRICE_IMPACT_BPS)) return { error: 'That moves the price more than 10%. Try a smaller amount.' }
    // Trades that would reach the graduation point are not supported here yet (the swap refuses them).
    if (market.graduationQuote && quote.after.quoteReserve >= BigInt(market.graduationQuote)) return { error: 'That would take the coin to graduation, which this page can’t trade through yet. Try a smaller amount.' }
    return { delivered: quote.delivered, minAmountOut, creatorFee: quote.fees.grossQuote, priceImpactBps: Number(quote.priceImpactBps) }
  } catch (error) { return { error: QUOTE_ERRORS[error?.message] ?? 'This amount can’t be traded right now.' } }
}

// The steps a buy takes: add SOL to Hook Lab when the bridged balance or holdings fall short, then the swap.
// wallet: { lamports, bridgedSol (null = no holding yet), coin (null = no holding yet) }; rentLamports per holding.
export function planBuy({ amount, wallet, rentLamports }) {
  const bridged = BigInt(wallet.bridgedSol ?? 0), missing = (wallet.bridgedSol === null ? 1 : 0) + (wallet.coin === null ? 1 : 0)
  const fundLamports = amount > bridged ? amount - bridged : 0n, steps = []
  if (fundLamports > 0n || missing > 0) steps.push({ kind: 'fund', lamports: fundLamports, rentLamports: BigInt(rentLamports) * BigInt(missing), feeLamports: STEP_FEE_LAMPORTS.fund })
  steps.push({ kind: 'buy', amount, feeLamports: STEP_FEE_LAMPORTS.buy })
  const total = steps.reduce((sum, s) => sum + (s.lamports ?? 0n) + (s.rentLamports ?? 0n) + s.feeLamports, 0n)
  const spendable = BigInt(wallet.lamports) - total
  return { steps, walletCost: total, fromHookLab: amount - fundLamports, shortfall: spendable < 890880n ? 890880n - spendable : 0n }
}

// The steps a sell takes: create the bridged-SOL holding if it is missing (the swap pays into it), the swap, then
// withdraw every bridged lamport (the proceeds plus anything already there).
export function planSell({ amount, wallet, rentLamports = 0 }) {
  const steps = [...(wallet.bridgedSol === null ? [{ kind: 'fund', lamports: 0n, rentLamports: BigInt(rentLamports), feeLamports: STEP_FEE_LAMPORTS.fund }] : []),
    { kind: 'sell', amount, feeLamports: STEP_FEE_LAMPORTS.sell }, { kind: 'withdraw', all: true, feeLamports: STEP_FEE_LAMPORTS.withdraw }]
  const needed = steps.reduce((sum, s) => sum + (s.rentLamports ?? 0n) + s.feeLamports, 0n)
  return { steps, shortfall: BigInt(wallet.lamports) < needed + 890880n ? needed + 890880n - BigInt(wallet.lamports) : 0n }
}

// The largest buy (in lamports, within 0.000001 SOL) that keeps this wallet under the coin's max per wallet at the
// current curve, or null when nothing more can be bought. Searched with the same model, so it matches the estimate.
export function maxBuyLamports(market, coinBalance = 0n, ceiling = 1_000_000_000_000n) {
  const fits = amount => !estimateTrade(market, { side: 'buy', amount, coinBalance }).error
  if (fits(ceiling)) return ceiling
  let low = 0n, high = ceiling
  while (high - low > 1000n) { const mid = (low + high) / 2n; if (fits(mid)) low = mid; else high = mid }
  return low > 0n ? low : null
}

// The panel's main button: connect a wallet, then sign in (no amount needed), then trade. A visitor can always
// connect, even while coin data loads or before trading opens for their wallet. blocked: the amount can't trade.
export function tradeButton({ wallet, signedIn, side, symbol, hasAmount, blocked, tradingOpen, busy }) {
  const label = text => busy ? 'Working…' : text
  if (!wallet) return { label: label('Connect wallet'), action: 'connect', disabled: !!busy }
  if (!signedIn) return hasAmount && !blocked ? { label: label(`Sign in and ${side} ${symbol}`), action: 'trade', disabled: !!busy }
    : { label: label('Sign in with your wallet'), action: 'sign-in', disabled: !!busy }
  return { label: label(`${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`), action: 'trade', disabled: !!busy || !hasAmount || !!blocked || !tradingOpen }
}

// The swap request the server reviews (its exact schema: tests/hooklab-trade-client.test.mjs posts it to the trade API).
export function tradeIntent(market, side, amount, minAmountOut) {
  return { mint: market.mint, selectedConfig: market.selectedConfig, capBps: market.capBps, creatorFeeBps: market.creatorFeeBps, side,
    amountIn: String(amount), minAmountOut: String(minAmountOut), maxInput: String(amount), maxPriceImpactBps: MAX_PRICE_IMPACT_BPS }
}
