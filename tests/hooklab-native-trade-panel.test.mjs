// The trade panel's states for native-SOL coins, rendered as the page streams them: no Add SOL and no Hook Lab wording,
// one approval, the finishing buy that graduates the coin, held until native trading is on, refused when the flags
// disagree. A bridged coin renders exactly as before.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { estimateTrade, finalFillLamports, planBuy, planNative, tradeHold } from '../app/lib/hooklab-trade-math.mjs'

const { HookTradePanel, HookTradeSummary, HookTradeBalances, HookTradeNote } = await appModule('app/components/hooklab-trade-panel.jsx')
const vectors = JSON.parse(readFileSync(new URL('./fixtures/hooklab-graduation-vectors.json', import.meta.url)))
const config = vectors.configs.find(c => c.name === 'Vq 53.25 SOL, fee 100'), at = label => config.states.find(s => s.label === label)
const mint = '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn'
const market = (extra = {}) => ({ mint, name: 'Graduate', symbol: 'GRAD', decimals: 6, selectedConfig: mint, creatorFeeBps: config.creatorFeeBps, capBps: 200, initialSupply: config.supply,
  capRaw: String(BigInt(config.supply) * 200n / 10000n), graduationQuote: config.curve.graduationQuote, graduated: false, curveComplete: false, native: false, quoteFormMismatch: false,
  pool: at('near the end').pool, ...extra })
const panel = view => html(h(HookTradePanel, { mint, genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', initial: view }), { wallet: true })
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

test('a native coin’s panel never mentions Hook Lab; it says the coin trades straight from the wallet', () => {
  const open = text(panel({ market: market({ native: true }), wallet: null, tradingOpen: true, nativeTrading: true }))
  assert.match(open, /trades straight from your wallet’s SOL: one approval per trade/); assert.doesNotMatch(open, /Hook Lab|Add SOL/)
  assert.doesNotMatch(open, /opens soon/)
  const bridged = text(panel({ market: market(), wallet: null, tradingOpen: true, nativeTrading: true }))
  assert.match(bridged, /Hooks coins trade with SOL moved into Hook Lab/, 'a bridged coin reads as before')
})

test('a native coin waits for native trading; a coin whose flags disagree is refused; a graduated native coin trades', () => {
  assert.match(text(panel({ market: market({ native: true }), wallet: null, tradingOpen: true, nativeTrading: false })), /Trading this coin on repo\.ing opens soon\./)
  assert.match(text(panel({ market: market({ quoteFormMismatch: true }), wallet: null, tradingOpen: true, nativeTrading: true })), /Trading this coin isn’t available right now\./)
  const graduated = market({ native: true, graduated: true, pool: at('complete').graduation.after })
  assert.doesNotMatch(text(panel({ market: graduated, wallet: null, tradingOpen: true, nativeTrading: true })), /opens again soon|opens soon/)
  assert.match(text(panel({ market: { ...graduated, native: false }, wallet: null, tradingOpen: true, nativeTrading: true })), /Trading it on repo\.ing opens again soon/, 'a bridged graduated coin stays held')
})

test('the finishing buy says it graduates the coin; the first buy shows one coin account deposit and the wallet total', () => {
  const m = market({ native: true }), fill = finalFillLamports(m), estimate = estimateTrade(m, { side: 'buy', amount: fill, slippageBps: 100 })
  const plan = planNative({ side: 'buy', amount: fill, wallet: { lamports: '100000000000', coin: null }, rentLamports: '1686560' })
  const view = { market: m, nativeTrading: true }, hold = tradeHold(view, estimate)
  assert.equal(hold, '')
  const shown = text(html(h(HookTradeSummary, { market: m, symbol: '$GRAD', buying: true, estimate, plan, hold, native: true })))
  assert.match(shown, /This buy finishes the curve\. \$GRAD graduates in the same transaction: its liquidity is locked forever and the max per wallet lifts\./)
  assert.match(shown, /Coin account deposit \(first buy\) 0\.00168 SOL/); assert.match(shown, /From your wallet/); assert.doesNotMatch(shown, /Hook Lab/)
  // Native trading off: no graduation promise.
  const held = tradeHold({ market: m, nativeTrading: false }, estimate)
  assert.doesNotMatch(text(html(h(HookTradeSummary, { market: m, symbol: '$GRAD', buying: true, estimate, plan, hold: held, native: true }))), /finishes the curve/)
  // A sale shows what it costs in fees, not a wallet total; a bridged buy keeps its Hook Lab deposits line.
  const sale = estimateTrade(m, { side: 'sell', amount: 1_000_000_000n }), salePlan = planNative({ side: 'sell', amount: 1_000_000_000n, wallet: { lamports: '100000000', coin: '5000000000' }, rentLamports: '1686560' })
  const sold = text(html(h(HookTradeSummary, { market: m, symbol: '$GRAD', buying: false, estimate: sale, plan: salePlan, hold: '', native: true })))
  assert.match(sold, /Network fees/); assert.doesNotMatch(sold, /From your wallet|deposit/)
  const bridgedPlan = planBuy({ amount: 10_000_000n, wallet: { lamports: '100000000', bridgedSol: null, coin: null }, rentLamports: '1686560' })
  const bridged = text(html(h(HookTradeSummary, { market: market(), symbol: '$GRAD', buying: true, estimate: estimateTrade(market(), { side: 'buy', amount: 10_000_000n }), plan: bridgedPlan, hold: '', native: false })))
  assert.match(bridged, /Hook Lab deposits \(first trade only\) 0\.00337 SOL/)
})

test('selected finishing-buy preview discloses unmeasured hook deductions and never promises gate removal',()=>{
  const m=market({native:true,policyKind:'selected-hook',capBps:0}),amount=finalFillLamports(m)
  const estimate=estimateTrade(m,{side:'buy',amount,slippageBps:100})
  assert.equal(estimate.error,undefined)
  const shown=text(html(h(HookTradeSummary,{market:m,symbol:'$GRAD',buying:true,estimate,plan:null,hold:'',native:true})))
  assert.match(shown,/Hook fees are not included yet/)
  assert.match(shown,/Get a measured quote to check fees and the minimum you receive before wallet approval/)
  assert.match(shown,/selected hook remains active/)
  assert.doesNotMatch(shown,/max per wallet lifts/)
})

test('balances: a native coin shows the wallet and the coin only; a bridged coin keeps Hook Lab and Withdraw', () => {
  const nativeBalances = html(h(HookTradeBalances, { mine: { lamports: '2500000000', coin: '12000000' }, market: market({ native: true }), symbol: '$GRAD', native: true, canWithdraw: true, busy: false, onWithdraw() {} }))
  assert.match(nativeBalances, /class="hooks-trade-balances is-native"/); assert.doesNotMatch(nativeBalances, /Hook Lab|Withdraw/)
  assert.match(text(nativeBalances), /Wallet 2\.5 SOL \$GRAD 12/)
  const bridged = html(h(HookTradeBalances, { mine: { lamports: '2500000000', bridgedSol: '7000000', coin: '12000000' }, market: market(), symbol: '$GRAD', native: false, canWithdraw: true, busy: false, onWithdraw() {} }))
  assert.match(text(bridged), /In Hook Lab 0\.007 SOL Withdraw/)
  assert.match(text(html(h(HookTradeNote, { native: true }))), /How Hooks work/)
})
