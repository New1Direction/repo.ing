import test from 'node:test'
import assert from 'node:assert/strict'
import { shareNativeQuote, shareCreatorCuts, shareProtocol } from '../src/hooklab-share-fee-quote.mjs'

const pool = { baseReserve: 50003n, quoteReserve: 7001n, virtualBase: 211n,
  virtualQuote: 101n, protocolFeesQuote: 9n, protocolShareBps: 3333n }
const input = (extra = {}) => ({ side: 'buy', amountIn: 10003n, minAmountOut: 1n,
  creatorFeeBps: 137n, quoteCutBps: 43n, lpFeeBps: 31n,
  tokenInputTax: 0n, tokenOutputTax: 17n, burnOut: 11n, pool, ...extra })

test('native creator share is floor-rounded inside the gross fee, including custom quote revenue', () => {
  for (const [amountIn, gross] of [[17n, 1n], [201n, 3n], [301n, 4n], [401n, 5n]]) {
    const q = shareNativeQuote(input({ amountIn, creatorFeeBps: 100n, quoteCutBps: 0n,
      lpFeeBps: 0n, tokenOutputTax: 0n, burnOut: 0n,
      pool: { ...pool, baseReserve: 100000n, quoteReserve: 100000n,
        virtualBase: 0n, virtualQuote: 0n, protocolShareBps: 2500n } }))
    assert.equal(q.fees.protocolQuote, gross / 4n)
    assert.equal(q.fees.creatorQuote, gross - gross / 4n)
    assert.equal(q.curveInput, amountIn - gross)
    assert.equal(q.delivered, (amountIn - gross) * 100000n / (100000n + amountIn - gross))
    assert.equal(q.quoteVaultDelta + q.fees.creatorQuote, amountIn)
  }
  const q = shareNativeQuote(input({ side: 'sell', amountIn: 101n, creatorFeeBps: 100n,
    quoteCutBps: 83n, lpFeeBps: 0n, burnIn: 17n, tokenInputTax: 29n,
    burnOut: 0n, tokenOutputTax: 0n,
    pool: { ...pool, baseReserve: 1000n, quoteReserve: 1000000n,
      virtualBase: 0n, virtualQuote: 0n, protocolShareBps: 2500n } }))
  assert.equal(q.grossOutput, 52132n)
  assert.equal(q.fees.customQuote, 432n)
  assert.equal(q.fees.creatorQuote, 716n) // ceil(52132*1%) + floor(52132*0.83%) = 954; 954-238
  assert.equal(q.fees.protocolQuote, 238n)
  assert.equal(q.delivered, 51178n)
  assert.equal(q.after.quoteReserve, 947868n)
  assert.equal(-q.quoteVaultDelta + q.fees.protocolQuote, q.grossOutput)
})

test('protocol share rounds up independently and accepts the pool rate endpoints', () => {
  assert.equal(shareProtocol(7n, 3333n), 3n)
  assert.equal(shareProtocol(7n, 0n), 0n)
  assert.equal(shareProtocol(7n, 10000n), 7n)
})
test('gross creator and holder rounding is independent; custom cut floors', () => {
  assert.deepEqual(shareCreatorCuts({ amount: 10001n, creatorFeeBps: 50n,
    holderFeeBps: 100n, eligible: 1n, minEligible: 1n }),
  { creator: 51n, holder: 101n, custom: 0n, total: 152n })
  assert.deepEqual(shareCreatorCuts({ amount: 10003n, creatorFeeBps: 137n, quoteCutBps: 43n }),
    { creator: 138n, holder: 0n, custom: 43n, total: 181n })
})
test('dust drops creator and holder together and drops custom when it consumes the leg', () => {
  assert.equal(shareCreatorCuts({ amount: 2n, creatorFeeBps: 50n, holderFeeBps: 100n,
    eligible: 1n, minEligible: 1n }).total, 0n)
  assert.deepEqual(shareCreatorCuts({ amount: 100n, creatorFeeBps: 100n, quoteCutBps: 10000n }),
    { creator: 1n, holder: 0n, custom: 0n, total: 1n })
})
test('native buy splits the gross budget and charges only the separate LP revenue', () => {
  const q = shareNativeQuote(input())
  assert.equal(q.receivedIn, 9882n)
  assert.equal(q.curveInput, 9791n)
  assert.equal(q.grossOutput, 29103n)
  assert.equal(q.delivered, 29075n)
  assert.equal(q.cutsIn, 121n)
  assert.equal(q.cutsOut, 17n)
  assert.deepEqual(q.fees, { grossQuote: 181n, creatorQuote: 121n, customQuote: 43n, lpFee: 0n,
    lpProtocolQuote: 31n, inputShareQuote: 60n, outputShareQuote: 0n, protocolQuote: 91n })
  assert.deepEqual(q.after, { baseReserve: 20900n, quoteReserve: 16792n, protocolFeesQuote: 100n })
  assert.equal(q.quoteVaultDelta, 9882n)
  assert.equal(q.canSign, false)
})
test('native sell measures input tax without charging its SOL equivalent', () => {
  const q = shareNativeQuote(input({ side: 'sell', amountIn: 1237n, burnIn: 19n,
    burnOut: 0n, tokenInputTax: 23n, tokenOutputTax: 0n }))
  assert.equal(q.receivedIn, 1195n)
  assert.equal(q.cutsIn, 23n)
  assert.equal(q.grossOutput, 165n)
  assert.equal(q.amountOutBeforeHooks, 164n)
  assert.equal(q.delivered, 161n)
  assert.equal(q.cutsOut, 3n)
  assert.deepEqual(q.fees, { grossQuote: 3n, creatorQuote: 3n, customQuote: 0n, lpFee: 0n,
    lpProtocolQuote: 1n, inputShareQuote: 0n, outputShareQuote: 0n, protocolQuote: 1n })
  assert.deepEqual(q.after, { baseReserve: 51198n, quoteReserve: 6836n, protocolFeesQuote: 10n })
  assert.equal(q.quoteVaultDelta, -164n)
})
test('burns do not accrue protocol share on either side', () => {
  const q = shareNativeQuote(input({ creatorFeeBps: 0n, quoteCutBps: 0n,
    lpFeeBps: 0n, tokenOutputTax: 0n }))
  assert.equal(q.cutsOut, 0n)
  assert.equal(q.fees.protocolQuote, 0n)
})
test('fill uses smallest fee-adjusted input, caps output, and prorates minimum down', () => {
  const q = shareNativeQuote(input({ amountIn: 101n, minAmountOut: 11n,
    creatorFeeBps: 1000n, quoteCutBps: 0n, lpFeeBps: 0n, tokenOutputTax: 0n,
    burnOut: 0n, allowPartialFill: true,
    pool: { ...pool, baseReserve: 10n, quoteReserve: 100n, virtualBase: 100n,
      virtualQuote: 0n, protocolShareBps: 2500n } }))
  // 12 - ceil(12/10) = 10; 11 only nets 9. The share is inside the two-lamport fee.
  assert.equal(q.amountIn, 12n)
  assert.equal(q.unspentInput, 89n)
  assert.equal(q.grossOutput, 10n)
  assert.equal(q.minAmountOut, 1n)
  assert.equal(q.after.baseReserve, 0n)
})
test('without fill permission a buy past the real reserve fails', () => {
  assert.throws(() => shareNativeQuote(input({ pool: { ...pool, baseReserve: 1n } })), /LIQUIDITY/)
})
test('minimum applies to measured delivery, not nominal curve output', () => {
  assert.throws(() => shareNativeQuote(input({ minAmountOut: 29076n })), /MIN_OUTPUT/)
})
test('zero protocol rate is read from the pool', () => {
  const q = shareNativeQuote(input({ pool: { ...pool, protocolShareBps: 0n } }))
  assert.equal(q.fees.inputShareQuote, 0n)
  assert.equal(q.fees.outputShareQuote, 0n)
  assert.equal(q.fees.protocolQuote, 31n)
})
test('kit is not combined with selected custom hooks', () => {
  assert.throws(() => shareNativeQuote(input({ kit: true })), /UNSUPPORTED_KIT/)
})
test('all numeric inputs are explicit bounded BigInts, including tax observations', () => {
  for (const extra of [{ amountIn: 10003 }, { creatorFeeBps: 137 },
    { amountIn: 1n << 64n }, { tokenOutputTax: -1n }, { tokenOutputTax: undefined },
    { lpFeeBps: 10001n }, { pool: { ...pool, protocolShareBps: 10001n } }]) {
    assert.throws(() => shareNativeQuote(input(extra)))
  }
  assert.throws(() => shareProtocol(1n, 10001n))
})
test('rejects tax or burn on the native leg and deductions exhausting a token leg', () => {
  for (const extra of [{ tokenInputTax: 1n }, { burnIn: 1n }, { tokenOutputTax: 50000n },
    { side: 'sell', tokenInputTax: 10003n, tokenOutputTax: 0n, burnOut: 0n }]) {
    assert.throws(() => shareNativeQuote(input(extra)))
  }
})
test('rejects quote reserve and protocol-accounting u64 overflows', () => {
  assert.throws(() => shareNativeQuote(input({ pool: { ...pool, protocolFeesQuote: (1n << 64n) - 1n } })), /U64/)
})

test('token tax alone never accrues SOL protocol revenue or removes pool SOL', () => {
  const q = shareNativeQuote(input({ side: 'sell', amountIn: 10n, creatorFeeBps: 0n,
    quoteCutBps: 0n, lpFeeBps: 0n, tokenInputTax: 2n, tokenOutputTax: 0n, burnOut: 0n,
    pool: { ...pool, baseReserve: 100n, quoteReserve: 1000n, virtualBase: 0n,
      virtualQuote: 0n, protocolShareBps: 7000n } }))
  // Only the eight tokens reaching the pool price the trade: floor(8*1000/108)=74.
  assert.equal(q.fees.inputShareQuote, 0n)
  assert.equal(q.fees.protocolQuote, 0n)
  assert.equal(q.delivered, 74n)
  assert.equal(q.after.quoteReserve, 926n)
  const buy = shareNativeQuote(input({ creatorFeeBps: 0n, quoteCutBps: 0n,
    lpFeeBps: 0n, burnOut: 0n, tokenOutputTax: 19n }))
  assert.equal(buy.fees.protocolQuote, 0n)
  assert.equal(buy.after.quoteReserve, 17004n)
})
test('quote books reconcile to native vault movement on both sides', () => {
  for (const extra of [{}, { side: 'sell', amountIn: 1237n, burnOut: 0n,
    tokenInputTax: 23n, tokenOutputTax: 0n, burnIn: 19n }]) {
    const q = shareNativeQuote(input(extra))
    assert.equal(q.after.quoteReserve + q.after.protocolFeesQuote
      - pool.quoteReserve - pool.protocolFeesQuote, q.quoteVaultDelta)
  }
})
test('rejects curve u128 product overflow rather than using unlimited JS integers', () => {
  const max = (1n << 64n) - 1n
  assert.throws(() => shareNativeQuote(input({ amountIn: max, creatorFeeBps: 0n,
    quoteCutBps: 0n, lpFeeBps: 0n, tokenOutputTax: 0n, burnOut: 0n,
    pool: { ...pool, baseReserve: max, virtualBase: max } })), /CURVE_OVERFLOW/)
})
