// Hooks UI pass, rendered: launch presets, the live limit and the blocked launch button, the status bar, the max-wallet
// room and the burned counter. Offline, synthetic chain state (the same open-creation shape as the burn form tests).
import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim()
const chain = { native: true, open: true, paused: false, creatorFeeBps: [], continuousCreatorFee: true, capBps: [100, 200, 300, 500], maxCreatorFeeBps: 500,
  maxBurnBps: 1000, maxRulesFeeBps: 1000, maxHolderFeeBps: 1000, burnEnabled: true, launchFeeLamports: '50000000' }
const coin = { name: 'Smoke', symbol: 'SMK', description: '', image: '', x: '', website: '', telegram: '', creatorFeeBps: 200, capBps: 100,
  feeTotalBps: 500, burnShareBps: 6000, rules: { burnBuyBps: 300, burnSellBps: 300 } }
const { HookLaunchForm, launchBlockReason } = await appModule('app/components/hooklab-launch-form.jsx')
const ux = await appModule('app/components/hooklab-trade-ux.jsx')
const form = props => html(h(HookLaunchForm, { coin, set() {}, disabled: false, menus: chain, openCreation: chain, costs: {}, onSubmit() {}, ...props }))

test('launch: three presets (holder rewards marked soon), a live "5% of 10% max" and an open launch button', () => {
  const markup = form(), words = text(markup)
  assert.match(words, /Burn coin 5% fee: 3% burned, 2% creator/); assert.match(words, /Holder rewards Soon/); assert.match(words, /Creator coin 2% creator fee/)
  assert.match(markup, /<button type="button" class="hlf-preset is-holders" aria-pressed="false" disabled=""/)
  assert.match(markup, /class="hlf-preset is-burn" aria-pressed="true"/)
  assert.match(words, /5% of 10% max/)
  assert.match(words, /Live preview of your coin page/); assert.match(markup, /class="hook-badge is-burn"/)
  assert.doesNotMatch(markup, /hlf-block-reason/)
  assert.doesNotMatch(markup, /class="hlf-primary" disabled=""/)
})

test('launch: over the limit the button is blocked with the reason, before any review', () => {
  const over = { ...coin, feeTotalBps: 1100 }
  assert.match(launchBlockReason(over, chain), /10% at most/)
  const markup = form({ coin: over }), words = text(markup)
  assert.match(words, /11% of 10% max/); assert.match(markup, /hlf-limit is-over/)
  assert.match(words, /The total fee can be 10% at most\. Lower it to launch\./)
  assert.match(markup, /class="hlf-primary" disabled=""/)
  assert.equal(launchBlockReason(coin, chain), '')
  assert.match(launchBlockReason({ ...coin, creatorFeeBps: 700 }, { ...chain, burnEnabled: false }), /creator fee can be 5% at most/)
})

test('trade: the status bar walks approve, sent, confirming, done instead of a spinner', () => {
  const steps = [{ kind: 'buy', status: 'confirm', signature: 'sig1' }]
  const markup = html(h(ux.HookTradeStatusBar, { steps, labelOf: k => `Buy ${k}`, explorer: s => `https://x/${s}` })), words = text(markup)
  assert.match(words, /Approve Sent Confirming Done/); assert.match(markup, /aria-valuetext="Confirming"/)
  assert.equal((markup.match(/is-done/g) ?? []).length, 2); assert.match(markup, /is-now/)
  assert.match(text(html(h(ux.HookTradeStatusBar, { steps: [{ kind: 'buy', status: 'failed' }], labelOf: k => k, explorer: s => s }))), /Stopped/)
})

test('trade: the max-wallet room shows before the click, with a one-tap max when the amount is over', () => {
  const market = { symbol: 'SMK', decimals: 6, capBps: 100, capRaw: '10000000000000' }
  const words = text(html(h(ux.HookCapRoom, { market, held: 2_500_000_000_000n, connected: true, onUseMax() {}, maxBuyText: '0.30 SOL' })))
  assert.match(words, /You can hold up to 10,000,000 \$SMK \(1% of the supply\)/); assert.match(words, /Room left: 7,500,000 \$SMK/)
  assert.match(words, /Buy the most I can \(0\.30 SOL\)/)
  assert.match(text(html(h(ux.HookCapRoom, { market, held: 10_000_000_000_000n, connected: true }))), /already holds the most/)
  assert.equal(html(h(ux.HookCapRoom, { market: { ...market, graduated: true }, held: 0n, connected: true })), '')
})

test('coin page: one fee number and the live total burned', () => {
  assert.equal(text(html(h(ux.HookFeeHeadline, { market: { creatorFeeBps: 200, burnBuyBps: 300 } }))), '5% fee: 3% burned, 2% creator')
  const words = text(html(h(ux.HookBurnCounter, { mint: 'm', symbol: 'SMKBRN', decimals: 6, initial: { initialSupply: '1000000000000000', supply: '999980078010616' } })))
  assert.match(words, /Total burned 19,921 \$SMKBRN/); assert.match(words, /0\.0020% of the supply/)
})
