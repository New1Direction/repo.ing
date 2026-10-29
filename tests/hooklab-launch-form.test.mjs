// The Hooks launch form (owner redesign 2026-10-27): the fee breakdown is the programs' own split, costs come only from the
// server's availability response, Burn and Holders Earn stay unavailable, and a custom fee such as 3% leaves the form as
// whole basis points the chain accepts. Offline: synthetic data, no RPC, no keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { inclusiveCreatorFee } from '../src/hooklab-inclusive-fee-quote.mjs'
import { isOpenCreatorFeeChoice } from '../src/hooklab-launch-menus.mjs'
import { openLaunchCosts, openLaunchNetworkFee } from '../app/lib/hooklab-open-launch.mjs'

const { HookLaunchForm, feeBreakdown, percentToBps } = await appModule('app/components/hooklab-launch-form.jsx')
const { HookOpenLaunch } = await appModule('app/components/hooklab-open-launch.jsx')
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const genesisHash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
// The independent stack: no fee menu (any whole fee up to 5%), caps 1/2/3/5%, a 0.05 SOL creation fee.
const openCreation = { native: true, open: true, paused: false, creatorFeeBps: [], continuousCreatorFee: true, maxCreatorFeeBps: 500, capBps: [100, 200, 300, 500],
  launchFeeLamports: '50000000', rentLamports: '27604720', preparationRentLamports: '3713480', guardRentLamports: String(23891240 + 3520440 + 100000) }
const costs = { networkFeeLamports: openLaunchNetworkFee('0') }
const coin = { name: 'Repo Cat', symbol: 'RCAT', image: null, description: '', x: '', website: '', telegram: '', creatorFeeBps: 300, capBps: 300 }
const menus = { creatorFeeBps: [], capBps: openCreation.capBps, maxCreatorFeeBps: 500, continuousCreatorFee: true, selectedHooksEnabled: false }
const form = props => html(h(HookLaunchForm, { coin, set() {}, menus, openCreation, costs, onSubmit() {}, ...props }))

test('the fee breakdown is the programs’ split: repo.ing floor(gross / 4), the creator the rest', () => {
  for (const bps of [0, 1, 50, 257, 300, 301, 500]) {
    const split = feeBreakdown(bps), chain = inclusiveCreatorFee(1_000_000_000n, bps)
    assert.deepEqual(split.perSol, { gross: chain.grossQuote, creator: chain.creatorQuote, platform: chain.platformQuote }, `${bps} bps`)
    assert.equal(split.creatorBps + split.platformBps, bps)
  }
  assert.deepEqual([feeBreakdown(300).creatorBps, feeBreakdown(300).platformBps], [225, 75])
  assert.equal(feeBreakdown(''), null)
})

test('at 3% the form and its preview show 2.25% to the creator and 0.75% to repo.ing', () => {
  const markup = text(form())
  assert.match(markup, /At 3%: 2\.25% to you \+ 0\.75% to repo\.ing/)
  assert.match(markup, /You receive 2\.25%/); assert.match(markup, /repo\.ing receives 0\.75%/)
  assert.match(markup, /Max per wallet 3%/)
  assert.match(form(), /value="3"/)
})

test('a typed custom fee leaves the form as whole basis points the chain accepts, up to its ceiling', () => {
  assert.equal(percentToBps('3'), 300); assert.equal(percentToBps('2.57'), 257); assert.equal(percentToBps('0'), 0); assert.equal(percentToBps(''), '')
  for (const typed of ['0', '0.5', '2.57', '3', '5']) assert.equal(isOpenCreatorFeeChoice({ creatorFeeBps: percentToBps(typed) }, openCreation), true, typed)
  assert.equal(isOpenCreatorFeeChoice({ creatorFeeBps: percentToBps('5.01') }, openCreation), false, 'over the 5% ceiling')
})

test('launch costs come from the server’s figures, shown separately, with the first buy after launch', () => {
  const markup = text(form()), expected = openLaunchCosts(openCreation, costs)
  for (const row of expected.rows) assert.match(markup, new RegExp(`${row.key === 'network' ? 'Network cost' : row.label} ${row.amount.replace('.', '\\.')}`))
  assert.match(markup, new RegExp(`Estimated total ${expected.total.replace('.', '\\.')}`))
  assert.match(markup, /First buy After launch/)
  // Nothing from the server: no figures invented.
  const blank = text(form({ openCreation: { ...openCreation, launchFeeLamports: undefined, rentLamports: undefined }, costs: {} }))
  assert.match(blank, /Creation fee Shown at review/); assert.match(blank, /Estimated total Shown at review/)
})

test('Burn and Holders Earn are shown as coming soon and cannot be chosen', () => {
  const markup = form()
  assert.match(text(markup), /Burn Coming soon/); assert.match(text(markup), /Holders Earn Coming soon/)
  assert.doesNotMatch(markup, /burnBps|burn_bps|holderFeeBps|name="burn"/)
  assert.match(markup, /aria-disabled="true"/)
})

test('one primary action, a short compatibility notice and the risks one tap away', () => {
  const markup = form()
  assert.equal((markup.match(/class="hlf-primary"/g) ?? []).length, 2, 'the desktop button and the phone bar submit the same form')
  assert.match(text(markup), /Some wallets may not display these coins/)
  assert.match(markup, /<summary>Compatibility &amp; risks<\/summary>/)
  assert.match(text(markup), /can lose all its value/)
  assert.doesNotMatch(markup, /Approve twice in your wallet|Snap on what your coin does/)
})

test('the custom-hook path is offered only when the release allows it, or to recover one already chosen', () => {
  assert.doesNotMatch(form({ allowSelectedHook: false }), /Advanced: use a custom hook/)
  const coinStep = html(h(HookOpenLaunch, { genesisHash, initial: { availability: { status: 'available', open: true, openCreation, costs } } }), { wallet: true })
  assert.doesNotMatch(coinStep, /Advanced: use a custom hook/)
  const enabled = html(h(HookOpenLaunch, { genesisHash, initial: { availability: { status: 'available', open: true, openCreation: { ...openCreation, selectedHooksEnabled: true }, costs } } }), { wallet: true })
  assert.match(enabled, /Advanced: use a custom hook/)
})

test('a refusal shows next to the action, in plain words', () => {
  assert.match(form({ error: 'Enter an integer creator fee within the current chain limits.' }), /class="hlf-error"><div><p class="inline-error" role="alert">Enter an integer creator fee/)
})

test('an expired setup review renews the same reservation before its fresh review; other stages and custom hooks do not', async () => {
  const { freshNeedsReserve, nextOpenLaunchAction } = await import('../app/lib/hooklab-open-launch.mjs')
  const expired = { stage: 'preparation', status: 'expired', review: { reviewExpiresAtMs: 1 } }
  assert.equal(nextOpenLaunchAction(expired, { wallet: 'w', now: 2 }), 'fresh')
  assert.equal(freshNeedsReserve(expired, { selectedHook: undefined }), true)
  assert.equal(freshNeedsReserve({ ...expired, stage: 'launch' }, {}), false)
  assert.equal(freshNeedsReserve(expired, { selectedHook: { program: 'x', flags: 1 } }), false)
})

test('a wallet holding less than the launch needs is told before anything is signed; an unreadable balance blocks nothing', async () => {
  const { walletShortfall } = await import('../app/components/hooklab-open-launch.jsx').catch(() => appModule('app/components/hooklab-open-launch.jsx'))
  const reply = (lamports, ok = true) => async () => ({ ok, json: async () => ({ status: 'available', wallet: { lamports } }) })
  assert.match(await walletShortfall('w', '92800000', reply('10000000')), /^Your wallet has 0\.01 SOL\. Launching needs at least 0\.0928 SOL\. Add SOL, then try again\. Nothing was signed\.$/)
  assert.equal(await walletShortfall('w', '92800000', reply('92800000')), '')
  assert.equal(await walletShortfall('w', '92800000', reply('1', false)), '', 'balance unavailable: the chain decides')
  assert.equal(await walletShortfall('w', '92800000', async () => { throw Error('offline') }), '')
  assert.equal(await walletShortfall('w', null, reply('1')), '', 'need unknown')
})

// Burn on (owner design 2026-10-27): one total fee from 0 to 10%, split by shares between the creator and a token burn.
// The 75/25 platform split applies only inside the creator's part; the coin carries creatorFeeBps and rules exactly as the
// reserve/review path takes them (mainnet smoke: creator 200 + burn 300).
const burnMenus = { ...menus, burnEnabled: true, maxBurnBps: 1000, maxRulesFeeBps: 1000, maxHolderFeeBps: 1000 }
const burnCoin = { ...coin, feeTotalBps: 500, burnShareBps: 6000, creatorFeeBps: 200, rules: { burnBuyBps: 300, burnSellBps: 300 } }

test('with Burn on, the form splits one total fee: what the creator, repo.ing and the burn each take', () => {
  const markup = text(form({ coin: burnCoin, menus: burnMenus, openCreation: { ...openCreation, burnEnabled: true, maxBurnBps: 1000, maxRulesFeeBps: 1000, maxHolderFeeBps: 1000 } }))
  assert.match(markup, /Total fee/)
  assert.match(markup, /You receive 1\.5%/); assert.match(markup, /repo\.ing receives 0\.5%/); assert.match(markup, /Burned 3%/)
  assert.match(markup, /Every buy and sell pays 5% in total/)
  assert.doesNotMatch(markup, /Burn Coming soon/); assert.match(markup, /Holders Earn Coming soon/)
})

test('the burn split arithmetic is the server’s and the programs’: parts add up, rules as the reserve path takes them', async () => {
  const { burnFeeChange } = await appModule('app/components/hooklab-launch-form.jsx')
  const { splitFee } = await import('../src/hooklab-fee-split.mjs')
  const { gateBurnRulesSchema } = await import('../src/hooklab-inclusive-max-wallet-profile.mjs')
  for (const [totalBps, burnShareBps] of [[500, 6000], [1000, 5000], [300, 0], [1000, 10000], [757, 3333], [0, 5000]]) {
    const next = burnFeeChange(burnMenus, { feeTotalBps: totalBps, burnShareBps }, {})
    const split = splitFee({ totalBps, shares: { creator: 10000 - burnShareBps, burn: burnShareBps } })
    assert.equal(next.creatorFeeBps, split.creatorFeeBps, `${totalBps}/${burnShareBps}`)
    assert.equal(next.creatorFeeBps + (next.rules?.burnBuyBps ?? 0), totalBps)
    if (split.burnBps) assert.deepEqual(gateBurnRulesSchema.parse(next.rules), { burnBuyBps: split.burnBps, burnSellBps: split.burnBps })
    else assert.equal(next.rules, undefined)
  }
  assert.match(burnFeeChange(burnMenus, { feeTotalBps: 1000, burnShareBps: 0 }, {}).problem, /creator fee can be at most 5%/)
  assert.match(burnFeeChange(burnMenus, { feeTotalBps: 1100, burnShareBps: 5000 }, {}).problem, /total fee from 0% to 10%/)
})

test('with Burn off the form is unchanged and carries no burn', () => {
  const markup = form({ coin: burnCoin })
  assert.match(text(markup), /Burn Coming soon/); assert.doesNotMatch(text(markup), /Burned 3%/)
})

test('the coin card shows the total fee and the burn, not only the creator fee', async () => {
  const { HookCoinPreview } = await appModule('app/components/hooklab-coin-form.jsx')
  const card = text(html(h(HookCoinPreview, { name: 'Smoke', symbol: 'SMKBRN', capBps: 100, creatorFeeBps: 200, burnBps: 300 })))
  assert.match(card, /5% total fee \(2% creator \+ 3% burn\)/)
  assert.match(text(html(h(HookCoinPreview, { name: 'Plain', symbol: 'P', capBps: 100, creatorFeeBps: 200 }))), /2% creator fee/)
})
