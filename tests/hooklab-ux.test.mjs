// Hooks UI pass (owner, 2026-10-28): the trade box's pre-sign preview, the fee headline, the max-wallet room, the launch
// limit check, browse filters and the burned counter. All display math: it reads the same estimate the trade panel
// already sends for review (app/lib/hooklab-trade-math.mjs estimateTrade) and never computes money on its own.
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTrade } from '../app/lib/hooklab-trade-math.mjs'
import { burnedTotal, capRoom, coinTags, feeHeadline, filterCoins, launchLimit, tradePreview } from '../app/lib/hooklab-ux.mjs'
import { SMOKE_MARKET, SMOKE_START_POOL, SMOKE_TRADES, SMOKE_FINAL_POOL } from './fixtures/hooklab-smoke-burn-trades.mjs'

const marketAt = pool => ({ ...SMOKE_MARKET, pool: { ...SMOKE_START_POOL, ...pool } })

test('preview = execution: the six real mainnet Burn trades replay through the trade box preview to the lamport', () => {
  let pool = SMOKE_START_POOL
  for (const t of SMOKE_TRADES) {
    const market = marketAt(pool), amount = BigInt(t.side === 'buy' ? t.solLamports : t.tokenBaseUnits)
    const estimate = estimateTrade(market, { side: t.side, amount, coinBalance: 0n, slippageBps: 100 })
    assert.equal(estimate.error, undefined, `${t.signature.slice(0, 8)}: ${estimate.error}`)
    const preview = tradePreview(market, estimate, { side: t.side, amount })
    // What the box shows before signing is exactly what Solana executed (the swap event and the mint's supply drop).
    assert.equal(preview.pay.raw, amount, `${t.signature.slice(0, 8)} pay`)
    assert.equal(preview.receive.raw, BigInt(t.side === 'buy' ? t.tokenBaseUnits : t.solLamports), `${t.signature.slice(0, 8)} receive`)
    assert.equal(preview.burned.raw, BigInt(t.burned), `${t.signature.slice(0, 8)} burned`)
    assert.equal(preview.fee.lamports, BigInt(t.creatorFee), `${t.signature.slice(0, 8)} fee`)
    // The preview is the estimate itself, not a second calculation: the same numbers the review and minimum come from.
    assert.equal(preview.receive.raw, estimate.delivered); assert.equal(preview.minimum.raw, estimate.minAmountOut)
    pool = { ...pool, ...estimate.after }
  }
  // After the six trades the model's pool is the pool account read on mainnet: nothing drifted in between.
  for (const k of ['baseReserve', 'quoteReserve', 'protocolFeesQuote']) assert.equal(String(pool[k]), SMOKE_FINAL_POOL[k], k)
  assert.equal(SMOKE_TRADES.reduce((s, t) => s + BigInt(t.burned), 0n), 19_921_989_384n)
})

test('one fee number with a plain breakdown, the creator part last', () => {
  assert.equal(feeHeadline({ creatorFeeBps: 200, burnBps: 300 }).text, '5% fee: 3% burned, 2% creator')
  assert.equal(feeHeadline({ creatorFeeBps: 200, burnBps: 0 }).text, '2% fee, all to the creator')
  assert.equal(feeHeadline({ creatorFeeBps: 100, burnBps: 200, holderBps: 300 }).text, '6% fee: 2% burned, 3% to holders, 1% creator')
  assert.equal(feeHeadline({ creatorFeeBps: 50, burnBps: 0 }).totalBps, 50)
  assert.equal(feeHeadline({ creatorFeeBps: 0, burnBps: 0 }).text, 'No trading fee')
})

test('max wallet room before the click: what this wallet can still hold, never negative, none after graduation', () => {
  const market = { ...SMOKE_MARKET, capRaw: '10000000000000' }
  assert.deepEqual(capRoom(market, 2_500_000_000_000n), { capRaw: 10_000_000_000_000n, held: 2_500_000_000_000n, room: 7_500_000_000_000n, full: false })
  assert.equal(capRoom(market, 10_000_000_000_000n).full, true)
  assert.equal(capRoom(market, 12_000_000_000_000n).room, 0n)
  assert.equal(capRoom({ ...market, graduated: true }, 0n), null)
  assert.equal(capRoom({ ...market, policyKind: 'selected-hook' }, 0n), null)
})

test('a buy over the cap is blocked by the same estimate, so the panel can say so before any click', () => {
  const market = marketAt(SMOKE_START_POOL)
  assert.match(estimateTrade(market, { side: 'buy', amount: 600_000_000n, coinBalance: 0n }).error, /max per wallet/)
})

test('launch limit check reads "7% of 10% max" and blocks with a reason when over', () => {
  assert.deepEqual(launchLimit({ totalBps: 700, maxBps: 1000 }), { ok: true, text: '7% of 10% max', fill: 0.7, reason: '' })
  const over = launchLimit({ totalBps: 1100, maxBps: 1000 })
  assert.equal(over.ok, false); assert.equal(over.fill, 1); assert.match(over.reason, /10% at most/)
  assert.equal(launchLimit({ totalBps: '', maxBps: 1000 }).ok, false)
})

test('browse tags and filters by hook type', () => {
  const coins = [{ mint: 'a', capBps: 100, creatorFeeBps: 200, burnBps: 300 }, { mint: 'b', capBps: 200, creatorFeeBps: 100, burnBps: 0 },
    { mint: 'c', capBps: 0, creatorFeeBps: 0, burnBps: 0, holderBps: 200 }]
  assert.deepEqual(coinTags(coins[0]), ['max-wallet', 'burn', 'creator-fee'])
  assert.deepEqual(filterCoins(coins, 'burn').map(c => c.mint), ['a'])
  assert.deepEqual(filterCoins(coins, 'holders').map(c => c.mint), ['c'])
  assert.deepEqual(filterCoins(coins, 'all').map(c => c.mint), ['a', 'b', 'c'])
})

test('total burned is the supply drop read from the mint', () => {
  assert.deepEqual(burnedTotal({ initialSupply: '1000000000000000', supply: '999980078010616' }), { raw: 19_921_989_384n, bps: 0.19921989384 })
  assert.equal(burnedTotal({ initialSupply: '1000000000000000', supply: null }), null)
})

test('launch presets set the sliders; holder rewards waits for Holders Earn; a burn coin needs Burn on', async () => {
  const { LAUNCH_PRESETS, presetFields, activePreset } = await import('../app/lib/hooklab-ux.mjs')
  const [burn, holders, creator] = LAUNCH_PRESETS
  assert.deepEqual(presetFields(burn, { burnEnabled: true }), { totalBps: 500, burnShareBps: 6000 })
  assert.equal(presetFields(burn, { burnEnabled: false }), null)
  assert.equal(presetFields(holders, { burnEnabled: true }), null)
  assert.deepEqual(presetFields(creator, { burnEnabled: false, maxCreatorFeeBps: 150 }), { creatorFeeBps: 150 })
  assert.equal(activePreset({ burnEnabled: true, totalBps: 500, burnShareBps: 6000 }), 'burn')
  assert.equal(activePreset({ burnEnabled: true, totalBps: 600, burnShareBps: 6000 }), null)
  assert.equal(activePreset({ burnEnabled: false, creatorFeeBps: 200 }), 'creator')
})

test('after a confirmed trade the panel shows the new balances at once, never below zero', async () => {
  const { optimisticWallet } = await import('../app/lib/hooklab-ux.mjs')
  const view = { market: {}, wallet: { address: 'w', lamports: '50000000', coin: '0' } }
  assert.deepEqual(optimisticWallet(view, { side: 'buy', amount: 4000000n, received: 76943743134n }).wallet, { address: 'w', lamports: '46000000', coin: '76943743134' })
  assert.deepEqual(optimisticWallet({ ...view, wallet: { ...view.wallet, coin: '76943743134' } }, { side: 'sell', amount: 76943743134n, received: 3614576n }).wallet,
    { address: 'w', lamports: '53614576', coin: '0' })
  assert.equal(optimisticWallet({ market: {} }, { side: 'buy', amount: 1n, received: 1n }).wallet, undefined)
})

test('the status bar follows the signing lifecycle: approve, sent, confirming, done', async () => {
  const { tradeStage } = await import('../app/lib/hooklab-ux.mjs')
  assert.deepEqual(['review', 'sign', 'send', 'confirm', 'done'].map(s => tradeStage(s).index), [0, 0, 1, 2, 3])
  assert.equal(tradeStage('failed').failed, true)
})

test('size buttons remember a default, and a broken storage never breaks the panel', async () => {
  const { rememberSize, rememberedSize } = await import('../app/lib/hooklab-ux.mjs')
  const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(rememberedSize(storage), null); rememberSize(storage, '0.5'); assert.equal(rememberedSize(storage), '0.5')
  rememberSize(storage, '7'); assert.equal(rememberedSize(storage), '0.5')
  const broken = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }
  assert.equal(rememberedSize(broken), null); assert.doesNotThrow(() => rememberSize(broken, '1'))
})
