// The trade panel's math for native-SOL coins: one step per trade, what holds a trade, the request it sends and the
// words for a trade Solana refused. Bridged coins keep today's plans and holds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { estimateTrade, finalFillLamports, graduationHold, nativeFailureText, nativeTradeIntent, nativeTradingOpen, planBuy, planNative, tradeButton, tradeHold } from '../app/lib/hooklab-trade-math.mjs'
import { createInclusiveTradeHandler } from '../app/lib/hooklab-inclusive-trade.mjs'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/hooklab-graduation-vectors.json', import.meta.url)))
const config = vectors.configs.find(c => c.name === 'Vq 53.25 SOL, fee 100'), at = label => config.states.find(s => s.label === label)
const market = (pool, extra = {}) => ({ mint: '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn', selectedConfig: '5hvm6s9DCiYX5QQFDVkcTKs1sF3PCKnACxYLHHTJCKZr', creatorFeeBps: config.creatorFeeBps,
  capBps: 200, initialSupply: config.supply, graduationQuote: config.curve.graduationQuote, graduated: false, native: false, quoteFormMismatch: false, pool, ...extra })
const near = market(at('near the end').pool), fill = finalFillLamports(near)

test('a native coin trades once native trading is on; until then, and for coins whose flags disagree, it is held', () => {
  const graduating = estimateTrade(near, { side: 'buy', amount: fill })
  assert.equal(graduating.graduates, true)
  const nativeNear = { ...near, native: true }, graduated = { ...market(at('complete').graduation.after), graduated: true, native: true }
  assert.equal(nativeTradingOpen({ market: nativeNear, nativeTrading: true }), true)
  assert.equal(nativeTradingOpen({ market: nativeNear, nativeTrading: false }), false); assert.equal(nativeTradingOpen({ market: near, nativeTrading: true }), false)
  assert.equal(tradeHold({ market: nativeNear, nativeTrading: true }, graduating), '', 'the final fill graduates the coin')
  assert.equal(tradeHold({ market: graduated, nativeTrading: true }, null), '', 'a graduated native coin trades')
  assert.match(tradeHold({ market: nativeNear, nativeTrading: false }, estimateTrade(near, { side: 'buy', amount: 1_000_000n })), /opens soon/, 'every native trade waits for the switch')
  assert.match(tradeHold({ market: { ...near, quoteFormMismatch: true }, nativeTrading: true }, null), /isn’t available/)
  // Bridged coins: exactly today's hold, switch or not.
  for (const nativeTrading of [true, false]) {
    assert.equal(tradeHold({ market: near, nativeTrading }, graduating), graduationHold(near, graduating))
    assert.match(tradeHold({ market: { ...near, graduated: true }, nativeTrading }, null), /graduated to its open market/)
    assert.equal(tradeHold({ market: near, nativeTrading }, estimateTrade(near, { side: 'buy', amount: fill - 1n })), '')
  }
})

test('a native trade is one step: no Add SOL, a first buy pays only its coin account deposit, a sale needs only the fee', () => {
  const first = planNative({ side: 'buy', amount: 50_000_000n, wallet: { lamports: '100000000', coin: null }, rentLamports: '1686560' })
  assert.deepEqual(first.steps.map(s => s.kind), ['buy']); assert.equal(first.depositLamports, 1_686_560n)
  assert.equal(first.walletCost, 50_000_000n + 1_686_560n + 19_000n); assert.equal(first.shortfall, 0n)
  const later = planNative({ side: 'buy', amount: 50_000_000n, wallet: { lamports: '100000000', coin: '7' }, rentLamports: '1686560' })
  assert.equal(later.depositLamports, 0n); assert.equal(later.walletCost, 50_019_000n)
  const sale = planNative({ side: 'sell', amount: 5n, wallet: { lamports: '1000000', coin: '7' }, rentLamports: '1686560' })
  assert.deepEqual(sale.steps.map(s => s.kind), ['sell']); assert.equal(sale.walletCost, 19_000n); assert.equal(sale.shortfall, 0n)
  assert.ok(planNative({ side: 'buy', amount: 99_500_000n, wallet: { lamports: '100000000', coin: null }, rentLamports: '1686560' }).shortfall > 0n, 'short of SOL before signing')
  assert.ok(planNative({ side: 'sell', amount: 5n, wallet: { lamports: '900000', coin: '7' }, rentLamports: '1686560' }).shortfall > 0n, 'the fee and the wallet minimum')
  assert.deepEqual(planBuy({ amount: 50_000_000n, wallet: { lamports: '100000000', bridgedSol: null, coin: null }, rentLamports: '1686560' }).steps.map(s => s.kind), ['fund', 'buy'], 'bridged coins still add SOL first')
})

test('the native request passes the trade API’s exact schema, and the finishing buy says it graduates the coin', async () => {
  const seen = [], owner = '11111111111111111111111111111111', signingId = '11111111-1111-4111-8111-111111111111'
  const handler = createInclusiveTradeHandler({ env: { HOOK_INCLUSIVE_TRADING_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_TRADING_PUBLIC: 'true', HOOK_NATIVE_TRADING_ENABLED: 'true' },
    configuration: () => ({ origin: 'https://repo.ing' }), database: () => ({ end: async () => {} }), quota: async () => true, principalStore: () => ({ resolve: async () => ({ wallet: owner }) }),
    runtime: () => ({ origin: 'https://repo.ing', nativeTrading: true, lifecycle: { createReview: async (t, i, value) => { seen.push(value); return { id: signingId, owner, stage: value.stage, status: 'reviewed', review: {} } } } }) })
  for (const [side, graduate] of [['buy', true], ['buy', false], ['sell', true]]) {
    const response = await handler(new Request('https://repo.ing/api/hook-lab/inclusive-trade', { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json',
      cookie: `__Host-hook-wallet-session=${Buffer.alloc(32, 9).toString('base64url')}` }, body: JSON.stringify({ action: 'native-quote', signingId, request: nativeTradeIntent(near, side, fill, 1n, graduate) }) }))
    assert.equal(response.status, 200, `${side} ${graduate}`)
  }
  assert.deepEqual(seen.map(x => [x.stage, x.intent.graduate]), [['native-buy', true], ['native-buy', false], ['native-sell', false]], 'a sale never graduates')
  const ready = { wallet: 'W', signedIn: true, side: 'buy', symbol: '$GRAD', hasAmount: true, blocked: false, tradingOpen: true, busy: false }
  assert.equal(tradeButton({ ...ready, graduates: true }).label, 'Buy and graduate $GRAD'); assert.equal(tradeButton(ready).label, 'Buy $GRAD')
  assert.equal(tradeButton({ ...ready, side: 'sell', graduates: true }).label, 'Sell $GRAD')
})

test('a trade Solana refused reads in plain words, and always says only the fee was charged', () => {
  assert.match(nativeFailureText('InsufficientLiquidity', 'Buy'), /Someone else bought first.*Only its network fee was charged\.$/)
  assert.match(nativeFailureText('NotReady', 'Buy'), /didn’t graduate/)
  assert.match(nativeFailureText('CapExceeded', 'Buy'), /max per wallet/)
  assert.equal(nativeFailureText('NativeInvariant', 'Sell'), 'Sell failed on Solana. Only its network fee was charged.')
  assert.equal(nativeFailureText(null, 'Buy'), 'Buy failed on Solana. Only its network fee was charged.')
})
