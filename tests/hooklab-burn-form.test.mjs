// The launch form with Burn on (owner design 2026-10-27): one total fee from 0 to 10%, split between the creator fee and a
// token burn (shares add up to 100%); Holders Earn is shown as coming and cannot be chosen. Offline, synthetic chain state.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { openFeeSplit, feeFormOf, openCreationProblem } from '../app/lib/hooklab-open-launch.mjs'
import { launchHookInput } from '../app/lib/hooklab-native-launch-form.mjs'

const { HookBlocks } = await appModule('app/components/hooklab-coin-form.jsx')
const { OpenLaunchReview } = await appModule('app/components/hooklab-open-launch.jsx')
const chain = { native: true, open: true, paused: false, creatorFeeBps: [], continuousCreatorFee: true, capBps: [100, 200, 300, 500], maxCreatorFeeBps: 500,
  maxBurnBps: 1000, maxRulesFeeBps: 1000, maxHolderFeeBps: 1000, burnEnabled: true }
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

test('the fee split: one total, the burn\'s share, the creator takes the rest; the chain\'s bounds explain any refusal', () => {
  assert.deepEqual(openFeeSplit(chain, { totalBps: 1000, burnShareBps: 5000 }).rules, { burnBuyBps: 500, burnSellBps: 500 })
  const all = openFeeSplit(chain, { totalBps: 1000, burnShareBps: 10000 })
  assert.deepEqual([all.creatorFeeBps, all.burnBps, all.problem], [0, 1000, ''])
  const none = openFeeSplit(chain, { totalBps: 300, burnShareBps: 0 })
  assert.deepEqual([none.creatorFeeBps, none.rules, none.problem], [300, undefined, ''], 'no burn sends no rules')
  assert.match(openFeeSplit(chain, { totalBps: 1000, burnShareBps: 4000 }).problem, /creator fee can be at most 5%/)
  assert.match(openFeeSplit({ ...chain, maxBurnBps: 300 }, { totalBps: 800, burnShareBps: 5000 }).problem, /burn can be at most 3%/)
  assert.equal(openFeeSplit({ ...chain, maxRulesFeeBps: 900 }, { totalBps: 1000, burnShareBps: 5000 }).maxTotalBps, 900)
  assert.match(openFeeSplit(chain, { totalBps: 1001, burnShareBps: 0 }).problem, /total fee from 0% to 10%/)
  assert.match(openFeeSplit(chain, { totalBps: '', burnShareBps: 0 }).problem, /total fee/)
  const lines = openFeeSplit(chain, { totalBps: 1000, burnShareBps: 5000 }).lines
  assert.equal(lines.total, 'Every buy and sell pays 10% in total.')
  assert.doesNotMatch(JSON.stringify(lines), /buy ?back/i)
  // A stored coin reads back into the same form.
  for (const [totalBps, burnShareBps] of [[1000, 5000], [333, 6667], [7, 3000], [1000, 10000], [250, 0]]) {
    const split = openFeeSplit(chain, { totalBps, burnShareBps }), form = feeFormOf({ creatorFeeBps: split.creatorFeeBps, rules: split.rules })
    const again = openFeeSplit(chain, { totalBps: form.feeTotalBps, burnShareBps: form.burnShareBps })
    assert.deepEqual([again.creatorFeeBps, again.burnBps], [split.creatorFeeBps, split.burnBps], `${totalBps} ${burnShareBps}`)
  }
})

test('a gate coin sends its burn with its cap; a burn needs Burn on and a split the chain accepts', () => {
  assert.deepEqual(launchHookInput({ hookKind: 'max-wallet', capBps: 200, rules: { burnBuyBps: 500, burnSellBps: 500 } }), { capBps: 200, rules: { burnBuyBps: 500, burnSellBps: 500 } })
  assert.throws(() => launchHookInput({ hookKind: 'max-wallet', capBps: 200, rules: { burnBuyBps: 500, burnSellBps: 400 } }), /burn/i)
  assert.throws(() => launchHookInput({ hookKind: 'max-wallet', capBps: 200, quoteCut: { maxBuyBps: 1, maxSellBps: 0 } }), /selected hook/)
  const coin = { creatorFeeBps: 500, capBps: 200, rules: { burnBuyBps: 500, burnSellBps: 500 } }
  assert.equal(openCreationProblem(chain, coin), '')
  assert.match(openCreationProblem({ ...chain, burnEnabled: false }, coin), /Burn is not available/)
  assert.match(openCreationProblem({ ...chain, maxBurnBps: 400 }, coin), /burn can be at most 4%/)
})

test('with Burn on the form shows a total, the shares, Holders Earn as coming, and the worst case; with it off, the creator fee alone', () => {
  let form = { capBps: 200, creatorFeeBps: 100, hookKind: 'max-wallet' }
  const set = patch => { form = { ...form, ...patch } }
  const markup = html(h(HookBlocks, { form: { ...form, feeTotalBps: 1000, burnShareBps: 5000, creatorFeeBps: 500, rules: { burnBuyBps: 500, burnSellBps: 500 } }, set, menus: chain })), words = text(markup)
  assert.match(markup, /id="fee-total-percent"/); assert.match(markup, /id="fee-share-burn"/)
  assert.match(words, /Burn: a share of every trade’s coins is burned \(destroyed\), shrinking supply/)
  assert.match(words, /Every buy and sell pays 10% in total/)
  assert.match(words, /Holders Earn.*Coming/)
  assert.doesNotMatch(markup, /id="fee-share-holders"[^>]*type="range"(?![^>]*disabled)/)
  assert.doesNotMatch(words, /buy ?back/i)
  // Burns is live, so it leaves the "on the way" list.
  assert.doesNotMatch(words, /More blocks are on the way.*Trade burns/)
  const off = text(html(h(HookBlocks, { form, set, menus: { ...chain, burnEnabled: false } })))
  assert.doesNotMatch(off, /Total fee|Holders Earn/); assert.match(off, /Creator fee \(%\)/)
})

test('the review screen shows the burn and the total a trade pays', () => {
  const coin = { name: 'Burn', symbol: 'BURN', image: 'data:image/png;base64,AAAA', description: '', x: '', website: '', telegram: '', creatorFeeBps: 500, capBps: 200,
    rules: { burnBuyBps: 500, burnSellBps: 500 } }
  const words = text(html(h(OpenLaunchReview, { coin, openCreation: chain, costs: { networkFeeLamports: '30000' }, onSign() {} })))
  assert.match(words, /Burn.*5%/); assert.match(words, /10% in total/); assert.match(words, /5% burn/)
  assert.doesNotMatch(words, /buy ?back/i)
})

test('a burning coin\'s trade summary shows the coins each trade burns, as a token burn', async () => {
  const { HookTradeSummary } = await appModule('app/components/hooklab-trade-panel.jsx')
  const market = { decimals: 6, creatorFeeBps: 500, burnBuyBps: 500, burnSellBps: 500 }
  const estimate = { minAmountOut: 9_000_000n, priceImpactBps: 10, creatorFee: 50_000n, burned: 490_000n }
  const words = text(html(h(HookTradeSummary, { market, symbol: 'BURN', buying: true, estimate, native: true })))
  assert.match(words, /Token burn \(5%\) 0\.49 BURN/)
  assert.doesNotMatch(words, /buy ?back/i)
  assert.doesNotMatch(text(html(h(HookTradeSummary, { market: { ...market, burnBuyBps: 0, burnSellBps: 0 }, symbol: 'BURN', buying: true, estimate: { ...estimate, burned: 0n }, native: true }))), /Token burn/)
})
