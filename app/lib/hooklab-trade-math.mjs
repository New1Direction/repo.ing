// Pure trade-panel math for Hooks coins: amounts, estimates and the steps a buy or sell takes. No network or wallet.
// Estimates use the same quote model the server compiles with; the server's exact review is what gets signed.
import { modelInclusiveCreatorQuote, previewSelectedHookQuote } from '../../src/hooklab-inclusive-fee-quote.mjs'
import { finalFillLamports, isReady } from '../../src/hooklab-graduation.mjs'
import { shareNativeQuote } from '../../src/hooklab-share-fee-quote.mjs'

export { finalFillLamports }

export const SOL_DECIMALS = 9
// Network fee per step at the production compute budget and priority (an upper bound shown before signing).
export const STEP_FEE_LAMPORTS = { fund: 7000n, withdraw: 7000n, buy: 19000n, sell: 19000n }
export const SLIPPAGE_CHOICES = [100, 300, 500]
// The server reviews trades with at most this price impact (its request schema caps it at 10%).
export const MAX_PRICE_IMPACT_BPS = 1000
// Buying the last of a curve goes out as one transaction, [buy the exact final fill, graduate], and a graduated coin
// trades on its open pool; both need the native-SOL swap. A bridged coin's panel shows these estimates but holds them
// (graduationHold), so no SOL moves into Hook Lab for a trade the server would refuse; a native-SOL coin opens them
// once native trading is on (nativeTradingOpen).
export const GRADUATION_TRADING_OPEN = false
// One rent source for every estimate shown before a review: Solana's rent-exempt minimum is this many lamports per byte
// of an account plus its 128-byte overhead, 5,080 on mainnet since SIMD-0437 (what getMinimumBalanceForRentExemption
// returns there). Server reviews read the live rate from the rent sysvar, so this only shapes estimates.
export const RENT_LAMPORTS_PER_BYTE = 5080n
export const rentExemptLamports = bytes => (128n + BigInt(bytes)) * RENT_LAMPORTS_PER_BYTE
// The least an empty wallet keeps, and the deposit for one 204-byte Hook Lab holding (a coin account).
export const WALLET_MINIMUM_LAMPORTS = rentExemptLamports(0)
export const HOLDING_RENT_LAMPORTS = rentExemptLamports(204)

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

// A coin's token burn as the quote model takes it (the market reads it from the launch's rules), or 'none'.
const burnRules = market => Number(market.burnBuyBps ?? 0) > 0 || Number(market.burnSellBps ?? 0) > 0
  ? { burnBuyBps: Number(market.burnBuyBps), burnSellBps: Number(market.burnSellBps) } : 'none'

const QUOTE_ERRORS = { MAX_WALLET: 'That would put you over this coin’s max per wallet.', MIN_OUTPUT: 'Price moved too much for this amount.' }

// Estimated result of a buy (amount in lamports) or sell (amount in raw coin units) at the current pool. On the curve a
// buy can take at most the final fill, which graduates the coin (graduates: true); after graduation the pool is plain
// constant product on its real reserves, the creator fee still applies and there is no max per wallet.
export function estimateTrade(market, { side, amount, coinBalance = 0n, slippageBps = 300 }) {
  const p = market.pool, graduated = !!market.graduated, curveBuy = side === 'buy' && !graduated && !!market.graduationQuote
  if (curveBuy && isReady(p, market.graduationQuote)) return { error: 'This coin has finished its bonding curve and is graduating. Buying opens again once it moves to its open market. Selling still works.' }
  const shareModel = market.policyKind === 'selected-hook' && market.feeModel === 1
  const fill = curveBuy && !shareModel ? finalFillLamports(market) : null
  if (fill !== null && amount > fill) return { error: `That’s more than this coin’s curve has left: ${sol(fill, 6)} buys all of it and graduates the coin.` }
  try {
    const selected=market.policyKind==='selected-hook'
    if(shareModel){
      const q=shareNativeQuote({side,amountIn:amount,minAmountOut:0n,creatorFeeBps:BigInt(market.creatorFeeBps),lpFeeBps:BigInt(market.lpFeeBps??0),
        tokenInputTax:0n,tokenOutputTax:0n,allowPartialFill:curveBuy,
        pool:{...Object.fromEntries(Object.entries(p).map(([k,v])=>[k,BigInt(v)])),protocolShareBps:BigInt(market.protocolShareBps)}})
      const reserve=BigInt(side==='buy'?p.quoteReserve:p.baseReserve)+BigInt(side==='buy'?p.virtualQuote:p.virtualBase)
      const impact=Number((q.curveInput*10000n+reserve+q.curveInput-1n)/(reserve+q.curveInput))
      if(impact>MAX_PRICE_IMPACT_BPS)return {error:'That moves the price more than 10%. Try a smaller amount.'}
      return {delivered:q.delivered,minAmountOut:null,creatorFee:q.fees.creatorQuote,priceImpactBps:impact,
        graduates:curveBuy&&isReady(q.after,market.graduationQuote),consumedInput:q.amountIn,unspentInput:q.unspentInput,hookDeductionsUnmeasured:true}
    }
    const quote = (selected?previewSelectedHookQuote:modelInclusiveCreatorQuote)({ side, amountIn: amount, minAmountOut: 1n, maxInput: amount, creatorFeeBps: market.creatorFeeBps,
      feeModel: 2, protocolShareBps: 2500, lpFeeBps: 0, flatProtocolFeeBps: 0, sniperWindowSecs: 0, sniperStartBps: 0, quoteHook: 'none', modules: 0,
      authorShareBps: 0, rules: burnRules(market), rewards: false, recipientBaseBalance: BigInt(coinBalance), maxWalletLifted: graduated,
      pool: { baseReserve: BigInt(p.baseReserve), quoteReserve: BigInt(p.quoteReserve), virtualBase: BigInt(p.virtualBase), virtualQuote: BigInt(p.virtualQuote), protocolFeesQuote: BigInt(p.protocolFeesQuote) },
      ...(!selected?{policy: { version: 2, feeModel: 2, protocolShareBps: 2500, creatorFeeBps: market.creatorFeeBps, lpFeeBps: 0, initialSupply: BigInt(market.initialSupply), capBps: market.capBps }}:{}) })
    const minAmountOut = quote.delivered * BigInt(10000 - slippageBps) / 10000n
    if (minAmountOut <= 0n) return { error: 'This amount is too small to trade.' }
    if (quote.priceImpactBps > BigInt(MAX_PRICE_IMPACT_BPS)) return { error: 'That moves the price more than 10%. Try a smaller amount.' }
    const graduates = fill !== null && amount === fill
    // Without an exact fill no buy can stop at the graduation point, so one that gets there would overshoot it.
    if (curveBuy && !graduates && isReady(quote.after, market.graduationQuote)) return { error: 'That would take the coin past graduation. Try a smaller amount.' }
    // after: the pool's reserves once this trade lands (display only; the review re-reads the chain).
    return { delivered: quote.delivered, minAmountOut, creatorFee: quote.fees.grossQuote, burned: quote.burned, priceImpactBps: Number(quote.priceImpactBps), graduates, after: quote.after,
      ...(selected?{minAmountOut:null,hookDeductionsUnmeasured:true}:{}) }
  } catch (error) {
    if (curveBuy && error?.message === 'INSUFFICIENT_LIQUIDITY') return { error: 'That’s more than this coin’s curve has left. Try a smaller amount.' }
    return { error: QUOTE_ERRORS[error?.message] ?? 'This amount can’t be traded right now.' }
  }
}

// Why the panel holds an estimate it can show but not send yet (see GRADUATION_TRADING_OPEN), or ''.
export function graduationHold(market, estimate, open = GRADUATION_TRADING_OPEN) {
  if (open) return ''
  if (market?.graduated) return 'This coin has graduated to its open market. Trading it on repo.ing opens again soon.'
  if (estimate?.graduates) return 'This buy finishes the curve and graduates the coin. Finishing a curve from repo.ing opens soon, so buy a little less for now.'
  return ''
}

// A native-SOL coin (market.native) trades straight from the wallet's SOL, once the site turns native trading on.
export const nativeTradingOpen = view => !!view?.market?.native && view.nativeTrading === true

// Why the panel holds a trade it can estimate but not send, or '': a coin whose two native flags disagree never trades,
// a native coin waits for native trading, and a bridged coin keeps today's graduation hold.
// A coin on our own stack only ever trades natively (straight from the wallet's SOL); it never takes the bridged path.
export const ownStackCoin = view => view?.coin?.stack === 'own'
// Whether the panel shows a coin as trading straight from the wallet (no Hook Lab balance, no Add SOL or Withdraw).
export const tradesFromWallet = view => !!view?.market?.native || ownStackCoin(view)
export function tradeHold(view, estimate) {
  const market = view?.market
  if (market?.quoteFormMismatch || (ownStackCoin(view) && market && !market.native)) return 'Trading this coin isn’t available right now.'
  if (market?.native) return nativeTradingOpen(view) ? '' : 'Trading this coin on repo.ing opens soon.'
  return graduationHold(market, estimate)
}

// A delisted coin: the site stops offering BUY; SELL (and the creator's fee claim) keep working.
export const buyOff = view => view?.coin?.moderation?.delisted === true
export const DELISTED_BUY_TEXT = 'repo.ing has delisted this coin, so buying it here is off. You can still sell.'

// A native coin's buy or sell is one approval: the swap moves SOL straight between the wallet and the pool. A first buy
// also pays the deposit for the wallet's coin account. wallet: { lamports, coin (null = no coin account yet) }.
export function planNative({ side, amount, wallet, rentLamports }) {
  const buy = side === 'buy', depositLamports = buy && wallet.coin === null ? BigInt(rentLamports) : 0n, feeLamports = STEP_FEE_LAMPORTS[side]
  const walletCost = (buy ? amount : 0n) + depositLamports + feeLamports, left = BigInt(wallet.lamports) - walletCost
  return { steps: [{ kind: side, feeLamports, rentLamports: depositLamports }], walletCost, depositLamports,
    shortfall: left < WALLET_MINIMUM_LAMPORTS ? WALLET_MINIMUM_LAMPORTS - left : 0n }
}

// Why a native trade that reached Solana did not go through, in plain words, from the program error the server decoded.
const NATIVE_FAILURES = {
  InsufficientLiquidity: 'Someone else bought first, so the curve had less left than this buy. Nothing was bought.',
  NotReady: 'The curve wasn’t full when this buy landed, so the coin didn’t graduate. Nothing was bought.',
  Slippage: 'The price moved past your max slippage before this trade landed. Nothing was traded.',
  CapExceeded: 'That would have put this wallet over the coin’s max per wallet. Nothing was bought.',
  Paused: 'Trading is paused right now. Nothing was traded.',
}
export const nativeFailureText = (errorName, label) => `${NATIVE_FAILURES[errorName] ?? `${label} failed on Solana.`} Only its network fee was charged.`

// The steps a buy takes: add SOL to Hook Lab when the bridged balance or holdings fall short, then the swap.
// wallet: { lamports, bridgedSol (null = no holding yet), coin (null = no holding yet) }; rentLamports per holding.
export function planBuy({ amount, wallet, rentLamports }) {
  const bridged = BigInt(wallet.bridgedSol ?? 0), missing = (wallet.bridgedSol === null ? 1 : 0) + (wallet.coin === null ? 1 : 0)
  const fundLamports = amount > bridged ? amount - bridged : 0n, steps = []
  if (fundLamports > 0n || missing > 0) steps.push({ kind: 'fund', lamports: fundLamports, rentLamports: BigInt(rentLamports) * BigInt(missing), feeLamports: STEP_FEE_LAMPORTS.fund })
  steps.push({ kind: 'buy', amount, feeLamports: STEP_FEE_LAMPORTS.buy })
  const total = steps.reduce((sum, s) => sum + (s.lamports ?? 0n) + (s.rentLamports ?? 0n) + s.feeLamports, 0n)
  const spendable = BigInt(wallet.lamports) - total
  return { steps, walletCost: total, fromHookLab: amount - fundLamports, shortfall: spendable < WALLET_MINIMUM_LAMPORTS ? WALLET_MINIMUM_LAMPORTS - spendable : 0n }
}

// The steps a sell takes: create the bridged-SOL holding if it is missing (the swap pays into it), the swap, then
// withdraw every bridged lamport (the proceeds plus anything already there).
export function planSell({ amount, wallet, rentLamports = 0 }) {
  const steps = [...(wallet.bridgedSol === null ? [{ kind: 'fund', lamports: 0n, rentLamports: BigInt(rentLamports), feeLamports: STEP_FEE_LAMPORTS.fund }] : []),
    { kind: 'sell', amount, feeLamports: STEP_FEE_LAMPORTS.sell }, { kind: 'withdraw', all: true, feeLamports: STEP_FEE_LAMPORTS.withdraw }]
  const needed = steps.reduce((sum, s) => sum + (s.rentLamports ?? 0n) + s.feeLamports, 0n)
  return { steps, shortfall: BigInt(wallet.lamports) < needed + WALLET_MINIMUM_LAMPORTS ? needed + WALLET_MINIMUM_LAMPORTS - BigInt(wallet.lamports) : 0n }
}

// The largest buy (in lamports) this wallet can make right now, or null when nothing more can be bought: on the curve
// the smaller of the max per wallet (within 0.000001 SOL) and the final fill (exact), after graduation the price-impact
// limit. Searched with the same model, so it matches the estimate.
export function maxBuyLamports(market, coinBalance = 0n, ceiling = 1_000_000_000_000n) {
  const fits = amount => !estimateTrade(market, { side: 'buy', amount, coinBalance }).error
  const fill = finalFillLamports(market), top = fill !== null && fill <= ceiling ? fill : ceiling
  if (top > 0n && fits(top)) return top
  let low = 0n, high = top
  while (high - low > 1000n) { const mid = (low + high) / 2n; if (fits(mid)) low = mid; else high = mid }
  return low > 0n ? low : null
}

// The panel's main button: connect a wallet, then sign in (no amount needed), then trade. A visitor can always
// connect, even while coin data loads or before trading opens for their wallet. blocked: the amount can't trade.
// graduates: this buy is the curve's final fill and graduates the coin in the same transaction.
export function tradeButton({ wallet, signedIn, side, symbol, hasAmount, blocked, tradingOpen, busy, graduates = false }) {
  const label = text => busy ? 'Working…' : text
  if (!wallet) return { label: label('Connect wallet'), action: 'connect', disabled: !!busy }
  if (!signedIn) return hasAmount && !blocked ? { label: label(`Sign in and ${side} ${symbol}`), action: 'trade', disabled: !!busy }
    : { label: label('Sign in with your wallet'), action: 'sign-in', disabled: !!busy }
  const text = side === 'buy' ? graduates ? `Buy and graduate ${symbol}` : `Buy ${symbol}` : `Sell ${symbol}`
  return { label: label(text), action: 'trade', disabled: !!busy || !hasAmount || !!blocked || !tradingOpen }
}

// The swap request the server reviews (its exact schema: tests/hooklab-trade-client.test.mjs posts it to the trade API).
export function tradeIntent(market, side, amount, minAmountOut) {
  return { mint: market.mint, selectedConfig: market.selectedConfig, capBps: market.capBps, creatorFeeBps: market.creatorFeeBps, side,
    amountIn: String(amount), minAmountOut: String(minAmountOut), maxInput: String(amount), maxPriceImpactBps: MAX_PRICE_IMPACT_BPS }
}
// A native coin's request (the native-quote action): the same, plus whether this buy is the final fill that graduates it.
export const nativeTradeIntent = (market, side, amount, minAmountOut, graduate) => ({ ...tradeIntent(market, side, amount, minAmountOut), graduate: side === 'buy' && !!graduate,
  ...(market.policyKind==='selected-hook'?{policyKind:'selected-hook',selectedHook:market.selectedHook}:{}) })

export function measuredTradeMinimum(quote,slippageBps){
  if(!SLIPPAGE_CHOICES.includes(slippageBps))throw Error('Unsupported slippage')
  const minimum=BigInt(quote.delivered)*BigInt(10000-slippageBps)/10000n
  if(minimum<=0n)throw Error('This amount is too small to trade.')
  const consumed=BigInt(quote.consumedInput??'0'),unspent=BigInt(quote.unspentInput??'0')
  return unspent>0n&&consumed>0n?(minimum*(consumed+unspent)+consumed-1n)/consumed:minimum
}
