// The trade panel's estimates around graduation, on pools taken from the Rust-core vectors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GRADUATION_TRADING_OPEN, estimateTrade, finalFillLamports, graduationHold, maxBuyLamports, sol } from '../app/lib/hooklab-trade-math.mjs'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/hooklab-graduation-vectors.json', import.meta.url)))
const config = vectors.configs.find(c => c.name === 'Vq 53.25 SOL, fee 100'), at = label => config.states.find(s => s.label === label)
const market = (pool, extra = {}) => ({ creatorFeeBps: config.creatorFeeBps, capBps: 200, initialSupply: config.supply, graduationQuote: config.curve.graduationQuote, graduated: false, pool, ...extra })
const near = market(at('near the end').pool), fill = BigInt(at('near the end').finalFill.amountIn)
const cap = BigInt(config.supply) * 200n / 10000n

test('a buy that reaches graduation is estimated at exactly the final fill; one lamport more is refused, one less does not graduate', () => {
  assert.equal(finalFillLamports(near), fill)
  const exact = estimateTrade(near, { side: 'buy', amount: fill, slippageBps: 100 })
  assert.equal(exact.error, undefined); assert.equal(exact.graduates, true)
  assert.equal(exact.delivered, BigInt(at('near the end').finalFill.quote.delivered), 'the Rust core delivers the same')
  assert.equal(exact.minAmountOut, exact.delivered * 9900n / 10000n)
  const over = estimateTrade(near, { side: 'buy', amount: fill + 1n })
  assert.match(over.error, /more than this coin’s curve has left/); assert.ok(over.error.includes(sol(fill, 6)), over.error)
  const under = estimateTrade(near, { side: 'buy', amount: fill - 1n })
  assert.equal(under.error, undefined); assert.equal(under.graduates, false)
  assert.equal(estimateTrade(near, { side: 'sell', amount: 1_000_000_000n }).graduates, false)
})

test('Max is the smaller of the cap headroom and the final fill', () => {
  assert.equal(maxBuyLamports(near), fill, 'room under the cap: Max finishes the curve exactly')
  const holding = cap - 2_000_000_000_000n, capped = maxBuyLamports(near, holding)
  assert.ok(capped < fill)
  assert.equal(estimateTrade(near, { side: 'buy', amount: capped, coinBalance: holding }).error, undefined)
  assert.match(estimateTrade(near, { side: 'buy', amount: capped + 2000n, coinBalance: holding }).error, /max per wallet/)
  assert.equal(maxBuyLamports(near, cap), null, 'a full wallet buys nothing')
})

test('a complete curve waiting for graduate pauses buys on this page, never sells', () => {
  const complete = market(at('complete').pool)
  assert.match(estimateTrade(complete, { side: 'buy', amount: 10_000_000n }).error, /graduating/)
  assert.equal(maxBuyLamports(complete), null)
  assert.equal(finalFillLamports(complete), null)
  const sell = estimateTrade(complete, { side: 'sell', amount: 1_000_000_000_000n })
  assert.equal(sell.error, undefined); assert.ok(sell.delivered > 0n)
})

test('after graduation: constant product on the real reserves, the same inclusive fee, and no max wallet', () => {
  const g = at('complete').graduation, open = market(g.after, { graduated: true })
  const vector = label => vectors.trades.find(t => t.label === `complete: after graduation ${label}` && t.creatorFeeBps === config.creatorFeeBps && t.pool.quoteReserve === g.after.quoteReserve)
  const buy = estimateTrade(open, { side: 'buy', amount: 10_000_000_000n, coinBalance: cap })
  assert.equal(buy.error, undefined, 'a wallet at the old cap still buys'); assert.equal(buy.graduates, false)
  assert.equal(buy.delivered, BigInt(vector('buy 2').quote.delivered)); assert.ok(buy.delivered > cap, 'more than the old cap in one buy')
  assert.equal(buy.creatorFee, 100_000_000n, '1% of 10 SOL, still included')
  const sell = estimateTrade(open, { side: 'sell', amount: BigInt(vector('sell 0').amountIn) })
  assert.equal(sell.delivered, BigInt(vector('sell 0').quote.delivered))
  assert.equal(finalFillLamports(open), null)
  const max = maxBuyLamports(open, cap)
  assert.ok(max > 10_000_000_000n && !estimateTrade(open, { side: 'buy', amount: max, coinBalance: cap }).error)
  assert.match(estimateTrade(open, { side: 'buy', amount: max + 2000n, coinBalance: cap }).error, /more than 10%/, 'only price impact limits it')
})

test('until the server builds the graduation swap, graduating buys and graduated coins are shown but held', () => {
  assert.equal(GRADUATION_TRADING_OPEN, false)
  const graduating = estimateTrade(near, { side: 'buy', amount: fill })
  assert.match(graduationHold(near, graduating), /finishes the curve/)
  assert.equal(graduationHold(near, estimateTrade(near, { side: 'buy', amount: fill - 1n })), '')
  assert.match(graduationHold(market(at('complete').graduation.after, { graduated: true }), null), /graduated/)
  assert.equal(graduationHold(near, graduating, true), '', 'open: nothing held')
})
