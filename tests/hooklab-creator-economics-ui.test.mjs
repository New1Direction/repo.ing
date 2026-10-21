import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { launchHookInput } from '../app/lib/hooklab-native-launch-form.mjs'

const { HookBlocks, HookSelectedEconomics } = await appModule('app/components/hooklab-coin-form.jsx')
const { HookOpenLaunch, OpenLaunchSigning } = await appModule('app/components/hooklab-open-launch.jsx')
const selected = { name: 'Custom', symbol: 'CSTM', description: '', capBps: 0, creatorFeeBps: 100, hookKind: 'selected', selectedHook: { program: 'So11111111111111111111111111111111111111112', flags: 65 } }
const economics = { quoteCut: { maxBuyBps: 123, maxSellBps: 0 }, authorShareBps: 4321, rules: { burnBuyBps: 987, burnSellBps: 654 } }
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)] }

test('approval copy keeps costs and permanent effects visible while diagnostics start collapsed', () => {
  const review = { baseFeeLamports: '5000', maxFeeLamports: '10000', maxNativeDebitLamports: '5740040', messageSha256: 'a'.repeat(64), supplementalTableCost: {
    address: selected.selectedHook.program, rentLamports: '5735040', permanentFreeze: true,
  } }
  const doc = new JSDOM(html(h(OpenLaunchSigning, { symbol: 'CSTM', stage: 'hook-setup', selectedHook: selected.selectedHook,
    review, status: 'outcome-unknown', error: 'SELECTED_HOOK_AUTHORITY_CHANGED: policySha256 mismatch', canRetry: true }))).window.document
  const details = [...doc.querySelectorAll('details')]
  assert.ok(details.length > 0)
  assert.ok(details.every(d => !d.open))
  assert.ok(details.some(d => d.textContent.includes(review.messageSha256)))
  assert.ok(details.some(d => d.textContent.includes('SELECTED_HOOK_AUTHORITY_CHANGED')))
  for (const d of details) d.remove()
  const visible = doc.body.textContent
  assert.match(visible, /5735040 lamports/)
  assert.match(visible, /5740040 lamports/)
  assert.match(visible, /Base network fee: 5000 lamports/)
  assert.match(visible, /Network fee limit: 10000 lamports/)
  assert.match(visible, /rent cannot be reclaimed/)
  assert.match(visible, /permanently freezes/)
  assert.match(visible, /wallet approval/i)
  assert.match(visible, /still checking|not yet confirmed/i)
  assert.doesNotMatch(visible, /outcome-unknown|policySha256|SHA-256|Flags:|SELECTED_HOOK_/)
})

test('hook setup discloses exact irreversible table rent before Continue, separately from network fee', () => {
  const review = { maxNativeDebitLamports: '9007199254741999', messageSha256: 'a'.repeat(64), supplementalTableCost: {
    address: selected.selectedHook.program, rentLamports: '9007199254740993', permanentFreeze: true,
  } }
  const props = { symbol: 'CSTM', stage: 'hook-setup', selectedHook: selected.selectedHook, review, canRetry: true, busy: false }
  const markup = html(h(OpenLaunchSigning, props))
  assert.match(markup, /Address table cost \(rent\)/)
  assert.match(markup, /9007199254740993 lamports/)
  assert.match(markup, /9007199254741999 lamports/)
  assert.match(markup, /separate from the network fee/i)
  assert.match(markup, /included in the maximum wallet debit/i)
  assert.match(markup, /creates and permanently freezes/i)
  assert.match(markup, /rent cannot be reclaimed/i)
  assert.match(markup, /addresses cannot be changed/i)
  assert.match(markup, /table cannot be closed/i)
  assert.ok(markup.indexOf('rent cannot be reclaimed') < markup.indexOf('>Continue</button>'))
  assert.equal(nodes(OpenLaunchSigning(props)).find(n => n.type === 'button').props.disabled, false)
  for (const stage of ['preparation', 'launch']) {
    assert.doesNotMatch(html(h(OpenLaunchSigning, { ...props, stage })), /Address table cost|permanently freezes/)
  }
  for (const supplementalTableCost of [undefined, { ...review.supplementalTableCost, permanentFreeze: false }, { ...review.supplementalTableCost, rentLamports: 123 }]) {
    const tree = OpenLaunchSigning({ ...props, review: { ...review, supplementalTableCost } })
    assert.equal(nodes(tree).find(n => n.type === 'button').props.disabled, true)
    assert.match(html(tree), /Nothing will be signed/)
    assert.doesNotMatch(html(tree), /Continue requests your wallet approval/)
  }
  assert.doesNotMatch(html(h(OpenLaunchSigning, { ...props, selectedHook: undefined })), /Address table cost|permanently freezes/)
})

test('advanced economics start omitted, explicitly configure bounds, and max-wallet clears them', () => {
  let form = { ...selected }, set = patch => { form = { ...form, ...patch } }
  const render = () => HookSelectedEconomics({ form, set })
  assert.deepEqual(launchHookInput(form), { capBps: 0, selectedHook: selected.selectedHook })
  assert.match(html(h(HookSelectedEconomics, { form, set })), /basis points/)
  let tree = render()
  nodes(tree).find(n => n.props?.id === 'hook-quote-cut').props.onChange({ target: { value: 'configure' } })
  assert.throws(() => launchHookInput(form), /quote cut/)
  for (const [id, value] of [['hook-max-buy', '123'], ['hook-max-sell', '0']]) {
    nodes(render()).find(n => n.props?.id === id).props.onChange({ target: { value } })
  }
  assert.deepEqual(launchHookInput(form).quoteCut, economics.quoteCut)
  const change = (id, value) => nodes(render()).find(n => n.props?.id === id).props.onChange({ target: { value } })
  change('hook-author-share', 'configure')
  assert.throws(() => launchHookInput(form), /author share/)
  change('hook-author-bps', '4321')
  change('hook-burn-rules', 'none')
  assert.equal(launchHookInput(form).rules, 'none')
  change('hook-burn-rules', 'configure')
  assert.throws(() => launchHookInput(form), /burn rules/)
  change('hook-burn-buy', '987'); change('hook-burn-sell', '654')
  assert.deepEqual(launchHookInput(form), { capBps: 0, selectedHook: selected.selectedHook, ...economics })
  const markup = html(h(HookSelectedEconomics, { form, set }))
  for (const value of [123, 4321, 987, 654]) assert.match(markup, new RegExp(`value="${value}"`))
  assert.doesNotMatch(markup, /recipient address/i)
  change('hook-author-share', 'omit'); change('hook-burn-rules', 'omit'); change('hook-quote-cut', 'omit')
  assert.deepEqual(launchHookInput(form), { capBps: 0, selectedHook: selected.selectedHook })
  form = { ...form, ...economics }
  const blocks = HookBlocks({ form, set, allowSelectedHook: true })
  nodes(blocks).find(n => n.props?.id === 'hook-kind').props.onChange({ target: { value: 'max-wallet' } })
  for (const key of ['quoteCut', 'authorShareBps', 'rules', 'selectedHook']) assert.equal(form[key], undefined)
  assert.doesNotThrow(() => launchHookInput(form))
})

test('recorded review and signing recovery expose actual economics and additional protocol fees', () => {
  const request = { ...selected, ...economics, id: 'recorded', status: 'queued' }
  const availability = { openCreation: { open: true, native: true, selectedHooksEnabled: true } }
  for (const step of ['review', 'sign']) {
    const markup = html(h(HookOpenLaunch, { genesisHash: 'offline', initial: { availability, request, coin: selected, step } }), { wallet: true })
    for (const value of ['123 bps', '0 bps', '4321 bps', '987 bps', '654 bps']) assert.ok(markup.includes(value), `${step}: ${value}`)
    assert.match(markup, /Additional protocol/)
    assert.match(markup, /creator wallet receives the author share/i)
    assert.doesNotMatch(markup, /75%|25%/)
  }
  const blocks = html(h(HookBlocks, { form: selected, set() {} }))
  assert.match(blocks, /additional protocol/i)
  assert.doesNotMatch(blocks, /75%|25%/)
})
