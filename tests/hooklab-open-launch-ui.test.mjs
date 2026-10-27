// The self-serve launch flow and the coin surfaces for coins on our own stack, rendered as the pages stream them:
// connect → your coin → review (only the essentials) → one guided signing step → live; SOL-only trading; no invite or
// approval wording; Add SOL and Withdraw only for a wallet still holding legacy Hook Lab SOL; and the stack's quote marker
// never shown anywhere. Offline: synthetic data, no RPC, no keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { PLACEHOLDER_IDS } from './fixtures/hooklab-own-stack.mjs'
import { tradesFromWallet } from '../app/lib/hooklab-trade-math.mjs'
import { OPEN_LAUNCH_NOTE, nextOpenLaunchAction, openCreationProblem, openLaunchCosts, openLaunchNetworkFee, openLaunchPrice } from '../app/lib/hooklab-open-launch.mjs'

const { HookOpenLaunch, OpenLaunchReview, OpenLaunchSigning, OpenLaunchLive } = await appModule('app/components/hooklab-open-launch.jsx')
const { HookTradePanel, HookTradeBalances } = await appModule('app/components/hooklab-trade-panel.jsx')
const { HookMyCoinsBody } = await appModule('app/components/hooklab-my-coins.jsx')
const { HooksRisk } = await appModule('app/components/hooks-ui.jsx')
const genesisHash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const MARKER = PLACEHOLDER_IDS.quoteMint
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
// Nothing the creator or a buyer reads names the marker, a quote token or bridged SOL, and nothing speaks of invites or approval.
const FORBIDDEN = [new RegExp(MARKER), /quote token|quote mint|quoteMint|bridged/i]
const NO_INVITE = /invite|repo\.ing approv|Waiting for approval|request launch|Send your request/i
function assertClean(markup, label) { for (const pattern of FORBIDDEN) assert.doesNotMatch(markup, pattern, `${label}: ${pattern}`) }

// The chain's open-creation state as the launch runtime reads it: the owner's menus and the creation fee (0.02 SOL).
const openCreation = { native: true, open: true, paused: false, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500], maxCreatorFeeBps: 200,
  launchFeeLamports: '20000000', minVirtualQuote: '5625000000', maxVirtualQuote: '112500000000', rentLamports: '27604720',
  preparationRentLamports: '3713480', launchRentLamports: '23891240', guardRentLamports: String(23891240 + 3520440 + 100000) }
const availability = { status: 'available', open: true, openCreation, costs: { networkFeeLamports: openLaunchNetworkFee('0') }, launchPrice: { solUsdMicros: '105630000', virtualQuote: '53251917070' } }
const coin = { name: 'Repo Cat', symbol: 'RCAT', image: 'data:image/png;base64,AAAA', description: '', x: '', website: '', telegram: '', creatorFeeBps: 100, capBps: 200 }

test('custom hook configuration and review never advertise a signing-ready gate launch', () => {
  const custom = { ...coin, hookKind: 'selected', capBps: 0, selectedHook: { program: 'So11111111111111111111111111111111111111112', flags: 129 } }
  const fields = html(h(HookOpenLaunch, { genesisHash, initial: { availability, coin: custom } }), { wallet: true })
  for (const pattern of [/Published hook version/, /Callback flags/, /value="129"/, /hook setup, coin settings and opening trading/]) assert.match(fields, pattern)
  assert.match(text(fields), /must be approved for this release before you can sign/i)
  assert.doesNotMatch(text(fields), /Production launches remain max-wallet gate only|Custom hook \(signing unavailable\)/)
  assert.doesNotMatch(fields, /aria-label="Max wallet block"|Max 0% per wallet/)
  const review = html(h(OpenLaunchReview, { coin: custom, openCreation, onSign() {} }))
  for (const pattern of [/Check hook availability/, /Nothing will be signed/, /Wallet limits set by hook/, /Token fees are checked on your transaction before approval/, /Flags: 129/]) assert.match(review, pattern)
  assert.doesNotMatch(text(review), /No wallet holding limit|no maximum holding per wallet/i)
  assert.doesNotMatch(review, /Sign and launch|Approve twice|<input/)
  const ready=html(h(OpenLaunchReview,{coin:custom,openCreation:{...openCreation,selectedHooksEnabled:true},onSign(){}}))
  assert.match(text(ready),/same quote fee budget/)
  assert.match(text(ready),/approve three times/)
  assert.doesNotMatch(text(ready),/Registry setup is separate|Inclusive fee policy \(model 2\)/)
  const setup=html(h(OpenLaunchSigning,{symbol:'CSTM',stage:'hook-setup',selectedHook:custom.selectedHook,review:{messageSha256:'a'.repeat(64),maxNativeDebitLamports:'15000'},canRetry:true}))
  assert.match(text(setup),/Approve hook setup.*Approve launch configuration.*Approve the launch/)
  assert.match(text(setup),/15000 lamports/)
})

test('selected creator fee accepts zero and non-menu values with the live ceiling, not presets', () => {
  for (const creatorFeeBps of [0, 137, '']) {
    const custom = { ...coin, creatorFeeBps, hookKind: 'selected', capBps: 0, selectedHook: { program: 'So11111111111111111111111111111111111111112', flags: 129 } }
    const markup = html(h(HookOpenLaunch, { genesisHash, initial: { availability, coin: custom } }), { wallet: true })
    assert.match(markup, /id="selected-creator-fee"/)
    assert.match(markup, /min="0" max="200" step="1"/)
    assert.match(markup, new RegExp(`value="${creatorFeeBps}"`))
    assert.doesNotMatch(text(markup), /additional protocol charges|not deducted from creator revenue/i)
  }
})

test('the review screen pays out only the essentials, every figure from the chain or server', () => {
  // The economics review's exact outlay at mainnet rent: 3,713,480 setup rent + 23,891,240 creation rent, the 0.02 SOL
  // creation fee, and three plus two signatures.
  const costs = openLaunchCosts(openCreation, availability.costs), line = r => [r.label, r.amount, r.note].filter(Boolean).join(' ')
  assert.deepEqual(costs.rows.map(line), ['Creation fee 0.02 SOL (to repo.ing)', 'Account rent ≈0.0276 SOL (stays in the coin’s accounts)', 'Network fees ≈0.00003 SOL'])
  assert.equal(costs.total, '≈0.0476 SOL')
  // What the wallet must hold at the start: the setup rent, the launch's signed bound (fee + the guard's rent, which counts
  // the launch account twice, + the margin) and both network fees; rounded up.
  assert.equal(costs.needLamports, 3_713_480n + 20_000_000n + 23_891_240n + 3_520_440n + 100_000n + 25_000n); assert.equal(costs.need, '0.0513 SOL')
  assert.equal(costs.rows[0].lamports, 20_000_000n, 'the creation fee is the chain value'); assert.equal(costs.totalLamports, 20_000_000n + 27_604_720n + 25_000n)
  assert.equal(openLaunchCosts({ ...openCreation, launchFeeLamports: '30000000' }).rows[0].lamports, 30_000_000n, 'never a literal: a changed fee shows the changed fee')
  assert.equal(openLaunchCosts({ ...openCreation, rentLamports: undefined }, availability.costs).totalLamports, null, 'an unknown figure leaves the total to the wallet')
  assert.equal(openLaunchCosts({ ...openCreation, poolCreationFeeLamports: '1000' }).rows[1].label, 'Pool fee')
  assert.equal(openLaunchNetworkFee('0'), '25000'); assert.equal(openLaunchNetworkFee('1000'), String(15000 + 10000 + 2 * 1400), 'setup (three signatures) and launch (two), each with the priority price')
  const price = openLaunchPrice(availability.launchPrice)
  assert.deepEqual(price.opening, { sol: '47.34 SOL', usd: '≈$5,000' }); assert.equal(price.graduation.usd, '≈$45,000'); assert.match(price.graduation.sol, / SOL$/)
  assert.deepEqual(openLaunchPrice({ virtualQuote: '53251917070' }).opening, { sol: '47.34 SOL', usd: null }, 'without a SOL price: SOL only')
  assert.equal(openCreationProblem(openCreation), ''); assert.match(openCreationProblem({ ...openCreation, paused: true }), /paused/); assert.match(openCreationProblem(null), /isn’t available/)

  const markup = html(h(OpenLaunchReview, { coin, image: coin.image, profile: null, openCreation, costs: availability.costs, price: availability.launchPrice, onSign() {}, onEdit() {} }))
  for (const pattern of [/Check your launch/, /Creation fee <strong>0\.02 SOL<\/strong><small> \(to repo\.ing\)/, /Account rent <strong>≈0\.0276 SOL<\/strong><small> \(stays in the coin’s accounts\)/,
    /Network fees <strong>≈0\.00003 SOL/, /You’ll spend about<\/span><strong>≈0\.0476 SOL/, /You need at least<\/span><strong>0\.0513 SOL in your wallet/,
    /Opening price/, /≈\$5,000/, /Graduates at/, /≈\$45,000/, /Creator fee/, /1%/, /Max per wallet/, /2%/, /Sign and launch/, /Your wallet will ask you to approve twice/])
    assert.match(markup, pattern)
  assert.ok(text(markup).includes(OPEN_LAUNCH_NOTE.replace("'", '&#x27;')) || markup.includes(OPEN_LAUNCH_NOTE.replace("'", '&#x27;')), 'the owner’s note, word for word')
  assert.equal(OPEN_LAUNCH_NOTE, 'Anyone can launch a Hooks coin. repo.ing doesn\'t review or vouch for coins. Check the mint address, creator and links before you buy.')
  assert.doesNotMatch(markup, NO_INVITE); assertClean(markup, 'review')
  const paused = html(h(OpenLaunchReview, { coin, openCreation: { ...openCreation, paused: true }, costs: availability.costs, price: availability.launchPrice, onSign() {} }))
  assert.match(paused, /<button type="button" class="button primary" disabled="">Sign and launch<\/button>/); assert.match(paused, /Launches are paused right now/)
})

test('the create flow, step by step: your coin (the chain’s menus), review, one guided signing step, live', () => {
  const coinStep = html(h(HookOpenLaunch, { genesisHash, initial: { availability } }), { wallet: true })
  for (const pattern of [/<li data-state="current" aria-current="step"><span>1<\/span>Your coin<\/li>/, /Review<\/li>/, /Sign<\/li>/, /Live<\/li>/,
    /Name/, /Ticker/, /Max per wallet/, /Creator fee/, /Review launch/, /Review first\. Nothing is signed yet\./, /Launch cost/, /Coming soon/])
    assert.match(coinStep, pattern)
  for (const bps of ['0.5%', '1%', '2%']) assert.match(coinStep, new RegExp(`aria-pressed="(true|false)">${bps.replace('.', '\\.')}</button>`), `fee ${bps} from the chain menu`)
  assert.match(coinStep, /<button type="button" aria-pressed="true">1%<\/button>/); assert.match(coinStep, /<button type="button" aria-pressed="true">2%<\/button>/)
  assert.doesNotMatch(coinStep, NO_INVITE); assertClean(coinStep, 'your coin')

  const reviewStep = html(h(HookOpenLaunch, { genesisHash, initial: { availability, coin, step: 'review' } }), { wallet: true })
  assert.match(reviewStep, /<li data-state="current" aria-current="step"><span>2<\/span>Review<\/li>/); assert.match(reviewStep, /Creation fee <strong>0\.02 SOL<\/strong><small> \(to repo\.ing\)/)
  assert.doesNotMatch(reviewStep, NO_INVITE); assertClean(reviewStep, 'review step')

  const signStep = html(h(HookOpenLaunch, { genesisHash, initial: { availability, coin, step: 'sign' } }), { wallet: true })
  for (const pattern of [/Launching \$RCAT/, /Approve the setup/, /Approve the launch/, /Your wallet will ask you to approve twice/, /Recovery IDs/]) assert.match(signStep, pattern)
  const second = html(h(OpenLaunchSigning, { symbol: 'RCAT', stage: 'launch', status: 'Approve in your wallet (2 of 2)', busy: true }))
  assert.match(second, /<li data-state="done"><span><svg/); assert.match(second, /Approve in your wallet \(2 of 2\)/)
  assert.doesNotMatch(signStep + second, NO_INVITE); assertClean(signStep + second, 'sign step')

  const live = html(h(OpenLaunchLive, { symbol: 'RCAT', mint: PLACEHOLDER_IDS.gate, onAnother() {} }))
  assert.match(live, /\$RCAT is live/); assert.match(live, new RegExp(`href="/hooks/token/${PLACEHOLDER_IDS.gate}"`)); assert.match(live, /in SOL/)
  assertClean(live, 'live')
})

test('the guided step moves on its own: sign, the coin address’s signature, send, confirm, then the second approval, then live', () => {
  const wallet = PLACEHOLDER_IDS.launch, now = 1000, fresh = { reviewExpiresAtMs: 5000 }, stale = { reviewExpiresAtMs: 10 }
  const op = (stage, status, extra = {}) => ({ stage, status, review: fresh, signedBy: [], ...extra })
  assert.equal(nextOpenLaunchAction(null, { wallet, now }), 'reserve')
  assert.equal(nextOpenLaunchAction(op('preparation', 'reviewed'), { wallet, now }), 'sign')
  assert.equal(nextOpenLaunchAction(op('preparation', 'partial', { signedBy: [wallet] }), { wallet, now }), 'cosign')
  assert.equal(nextOpenLaunchAction(op('preparation', 'signed'), { wallet, now }), 'submit')
  for (const status of ['submission-claimed', 'submitted', 'outcome-unknown']) assert.equal(nextOpenLaunchAction(op('preparation', status, { signature: 'x' }), { wallet, now }), 'reconcile')
  assert.equal(nextOpenLaunchAction(op('preparation', 'finalized-success'), { wallet, now }), 'launch')
  assert.equal(nextOpenLaunchAction(op('launch', 'reviewed'), { wallet, now }), 'sign')
  assert.equal(nextOpenLaunchAction(op('launch', 'finalized-success'), { wallet, now }), 'live')
  // Expired before anything was sent: an unseen review refreshes; anything the wallet saw is closed (chain-checked) first.
  assert.equal(nextOpenLaunchAction(op('launch', 'reviewed', { review: stale }), { wallet, now }), 'refresh')
  assert.equal(nextOpenLaunchAction(op('launch', 'reviewed', { review: stale, walletRequestIssued: true }), { wallet, now }), 'close')
  assert.equal(nextOpenLaunchAction(op('launch', 'partial', { review: stale, signedBy: [wallet] }), { wallet, now }), 'close')
  assert.equal(nextOpenLaunchAction(op('launch', 'expired'), { wallet, now }), 'fresh')
  for (const status of ['finalized-failure', 'review-required']) assert.equal(nextOpenLaunchAction(op('launch', status), { wallet, now }), 'stop', 'a person looks; nothing more is signed')
})

// An own-stack coin's market view as the runtime serves it; the marker sits in it only to prove nothing renders it.
const mint = PLACEHOLDER_IDS.gate, creator = PLACEHOLDER_IDS.swap
const market = (extra = {}) => ({ mint, name: 'Repo Cat', symbol: 'RCAT', uri: '', decimals: 6, observedSlot: 1, selectedConfig: PLACEHOLDER_IDS.token, creator, graduated: false,
  native: true, quoteFormMismatch: false, capBps: 200, creatorFeeBps: 100, initialSupply: '1000000000000000', supply: '1000000000000000', capRaw: '20000000000000',
  pool: { baseReserve: '750000000000000', quoteReserve: '1000', virtualBase: '375000000000000', virtualQuote: '53251917070', protocolFeesQuote: '0', swapCount: '2' },
  marketCapLamports: '47335037395', graduationQuote: '106503834140', curveProgressBps: 0, quoteMint: MARKER, ...extra })
const ownCoin = (extra = {}) => ({ id: '6f1c3b0e-3b7a-4c55-9d7e-2d7d1b6a9c10', name: 'Repo Cat', symbol: 'RCAT', creator, profile: null, stack: 'own', moderation: { delisted: false }, ...extra })
const panel = view => html(h(HookTradePanel, { mint, genesisHash, initial: view }), { wallet: true })

test('an own-stack coin trades straight in SOL: no Add SOL, no Withdraw, no Hook Lab balance, never the marker', () => {
  // Even a wallet that also holds legacy Hook Lab SOL sees no Hook Lab balance on a coin of ours.
  const view = { market: market(), coin: ownCoin(), wallet: { address: creator, lamports: '5000000000', coin: '0', bridgedSol: '500000000' }, tradingOpen: true, nativeTrading: true }
  const markup = panel(view)
  assert.match(text(markup), /trades straight from your wallet’s SOL/); assert.doesNotMatch(text(markup), /Add SOL|Withdraw|In Hook Lab/)
  assertClean(markup, 'trade panel')
  // The balances under the panel: a coin of ours always reads as trading from the wallet, whatever the wallet holds.
  const holding = { address: creator, lamports: '5000000000', coin: '0', bridgedSol: '500000000' }
  assert.equal(tradesFromWallet(view), true); assert.equal(tradesFromWallet({ ...view, market: market({ native: false }) }), true, 'ours, whatever its flags say')
  const balances = html(h(HookTradeBalances, { mine: holding, market: market(), symbol: '$RCAT', native: tradesFromWallet(view), canWithdraw: true, onWithdraw() {} }))
  assert.doesNotMatch(text(balances), /In Hook Lab|Withdraw/); assertClean(balances, 'balances')
  // A coin of ours never takes the bridged path, even if its flags read otherwise.
  const odd = text(panel({ ...view, market: market({ native: false }) }))
  assert.match(odd, /Trading this coin isn’t available right now\./); assert.doesNotMatch(odd, /Add SOL|In Hook Lab|moved into Hook Lab/)
})

test('a delisted coin shows the notice and offers no BUY; selling still works', () => {
  const notice = 'repo.ing has delisted this coin: PLACEHOLDER. You can still sell it, and its creator can still claim fees.'
  const view = { market: market(), coin: ownCoin({ moderation: { delisted: true, reason: 'impersonation', notice } }), wallet: null, tradingOpen: true, nativeTrading: true }
  const markup = panel(view)
  assert.match(text(markup), /delisted this coin, so buying it here is off\. You can still sell\./)
  assert.match(markup, /<button type="button" disabled="">0\.01 SOL<\/button>/, 'the buy shortcuts are off')
  assertClean(markup, 'delisted panel')
})

test('My coins: Withdraw only for a wallet that still holds legacy Hook Lab SOL; otherwise just the coin', () => {
  const launched = { id: ownCoin().id, name: 'Repo Cat', symbol: 'RCAT', creatorFeeBps: 100, capBps: 200, status: 'launched', mint, profile: null }
  const fresh = html(h(HookMyCoinsBody, { balances: { wallet: { address: creator, lamports: '1000', bridgedSol: null }, funding: true }, request: launched, genesisHash }))
  assert.doesNotMatch(text(fresh), /Withdraw|Hook Lab|Add SOL/); assert.match(fresh, new RegExp(`href="/hooks/token/${mint}"`)); assert.match(text(fresh), /Live/)
  assertClean(fresh, 'my coins'); assert.doesNotMatch(fresh, NO_INVITE)
  const holder = html(h(HookMyCoinsBody, { balances: { wallet: { address: creator, lamports: '1000', bridgedSol: '500000000' }, funding: true }, request: null, genesisHash }))
  assert.match(text(holder), /Withdraw your Hook Lab SOL/); assert.match(holder, /Withdraw 0\.5 SOL/)
  const pending = html(h(HookMyCoinsBody, { balances: null, request: { ...launched, status: 'queued', mint: undefined }, genesisHash }))
  assert.match(text(pending), /Not launched yet/); assert.match(pending, /Finish your launch/); assert.doesNotMatch(pending, NO_INVITE)
})

test('a legacy coin’s holder still sees the Hook Lab balance and Withdraw', () => {
  const view = { market: market({ native: false, quoteMint: undefined }), coin: ownCoin({ stack: 'legacy' }), funding: true, tradingOpen: true, nativeTrading: false }
  assert.equal(tradesFromWallet(view), false)
  const holding = { address: creator, lamports: '5000000000', coin: '0', bridgedSol: '500000000' }
  const legacy = html(h(HookTradeBalances, { mine: holding, market: view.market, symbol: '$RCAT', native: tradesFromWallet(view), canWithdraw: true, onWithdraw() {} }))
  assert.match(text(legacy), /In Hook Lab/); assert.match(legacy, />Withdraw<\/button>/)
  assert.match(text(html(h(HooksRisk))), /Trades use SOL moved into Hook Lab/)
  assert.doesNotMatch(text(html(h(HookTradeBalances, { mine: { ...holding, bridgedSol: '0' }, market: view.market, symbol: '$RCAT', native: false, canWithdraw: true, onWithdraw() {} }))), /Withdraw/,
    'no Withdraw without a balance')
})

test('the coin page of an own-stack coin: SOL and USD only, the delisted notice, never the marker', async () => {
  const { default: Token } = await appModule('app/(site)/hooks/token/[mint]/page.jsx')
  const key = Symbol.for('repo.ing.hooklab.inclusive-trade-runtime')
  const notice = 'repo.ing has delisted this coin: PLACEHOLDER. You can still sell it, and its creator can still claim fees.'
  for (const delisted of [false, true]) {
    const coinRecord = ownCoin(delisted ? { moderation: { delisted: true, notice } } : {}), id = delisted ? PLACEHOLDER_IDS.launch : PLACEHOLDER_IDS.gate
    globalThis[key] = { market: async requested => requested === id ? { market: market({ mint: id }), wallet: null } : null, coinProfile: async requested => requested === id ? coinRecord : null }
    try {
      const page = html(await Token({ params: Promise.resolve({ mint: id }) }), { wallet: true })
      assert.match(page, /\$RCAT/); assert.match(page, /Market cap/); assert.match(page, /SOL/)
      assertClean(page, `coin page${delisted ? ' (delisted)' : ''}`); assert.doesNotMatch(text(page), /Add SOL|Withdraw|SOL moved into Hook Lab/)
      assert.match(text(page), /Trades use SOL straight from your wallet/)
      if (delisted) assert.match(page, /class="hooks-delisted-notice"/); else assert.doesNotMatch(page, /hooks-delisted-notice/)
    } finally { delete globalThis[key] }
  }
})

// Regression (self-serve acceptance, 2026-10-19): the same coin's page, opened before and again after its delisting, shows
// the owner's reason once the market data's 3 s cache has passed (it kept the pre-delisting record for 60 s).
test('a coin page opened before a delisting shows the owner\'s reason on the next load after 3 s', async () => {
  const { default: Token } = await appModule('app/(site)/hooks/token/[mint]/page.jsx')
  const { COIN_PAGE_CACHE_MS } = await import('../app/lib/hooklab-market.mjs')
  const { delistedNotice } = await import('../src/hooklab-coin-moderation.mjs')
  const key = Symbol.for('repo.ing.hooklab.inclusive-trade-runtime'), id = PLACEHOLDER_IDS.swap
  let coinRecord = ownCoin()
  globalThis[key] = { market: async requested => requested === id ? { market: market({ mint: id }), wallet: null } : null, coinProfile: async requested => requested === id ? coinRecord : null }
  try {
    const load = async () => html(await Token({ params: Promise.resolve({ mint: id }) }), { wallet: true })
    assert.doesNotMatch(await load(), /hooks-delisted-notice/)
    coinRecord = ownCoin({ moderation: { delisted: true, reason: 'impersonation', notice: delistedNotice('impersonation') } })
    await new Promise(resolve => setTimeout(resolve, COIN_PAGE_CACHE_MS + 100))
    const page = await load()
    assert.match(page, /class="hooks-delisted-notice"/)
    assert.match(text(page), /repo\.ing has delisted this coin: It pretends to be a person, project or brand it isn(?:'|&#x27;)t\./) // the markup escapes the apostrophe
  } finally { delete globalThis[key] }
})

test('the launch-requests API sends the chain\'s menus, fees and the network fee, never the stack\'s programs or marker', async () => {
  const { createLaunchRequestsHandler } = await import('../app/lib/hooklab-launch-requests.mjs')
  const env = { HOOK_OPEN_LAUNCHES: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOKLAB_PRIORITY_MICROLAMPORTS: '1000' }
  const leaky = { ...openCreation, quoteMint: MARKER, programs: { launch: PLACEHOLDER_IDS.launch } }
  const handler = createLaunchRequestsHandler({ env, configuration: () => ({ origin: 'https://repo.ing' }), database: () => ({ end: async () => {} }),
    store: () => ({}), openCreation: async () => leaky, launchPriceEstimate: async () => availability.launchPrice })
  const response = await handler(new Request('https://repo.ing/api/hook-lab/launch-requests')), body = await response.json(), raw = JSON.stringify(body)
  assert.equal(body.open, true); assert.deepEqual(body.openCreation.creatorFeeBps, [50, 100, 200]); assert.equal(body.openCreation.launchFeeLamports, '20000000')
  assert.equal(body.costs.networkFeeLamports, String(15000 + 10000 + 2 * 1400))
  assert.doesNotMatch(raw, new RegExp(MARKER)); assert.doesNotMatch(raw, new RegExp(PLACEHOLDER_IDS.launch)); assert.doesNotMatch(raw, /quoteMint|programs/)
})

test('a self-serve creator\'s operation responses carry what the guided step needs, not the transaction\'s account list', async () => {
  const { customerOperation } = await import('../app/lib/hooklab-native-launch.mjs')
  const op = { id: 'a', stage: 'launch', status: 'submitted', signedBy: [creator], signature: 's', walletRequestIssued: true,
    review: { wallet: creator, genesisHash, messageSha256: 'f'.repeat(64), reviewExpiresAtMs: 5, requiredSigners: [creator, mint], accounts: [{ address: MARKER, writable: false }],
      lookupTables: [{ address: PLACEHOLDER_IDS.token }] }, settlement: { executionStatus: 'finalized-executed', postconditions: { quoteMint: MARKER } } }
  const shown = customerOperation(op), raw = JSON.stringify(shown)
  assert.doesNotMatch(raw, new RegExp(MARKER)); assert.doesNotMatch(raw, /quoteMint|lookupTables|"accounts"/)
  assert.deepEqual(shown.review.requiredSigners, [creator, mint]); assert.equal(shown.status, 'submitted'); assert.equal(shown.settlement.executionStatus, 'finalized-executed')
  assert.equal(nextOpenLaunchAction(shown, { wallet: creator, now: 1 }), 'reconcile', 'the guided step still knows its next move')
})

// The independent stack retired the fee menu (owner 2026-10-26): the chain then offers any whole fee from 0 to its ceiling.
const continuous = { ...openCreation, creatorFeeBps: [], continuousCreatorFee: true, maxCreatorFeeBps: 500 }
test('with no fee menu on chain the creator types a fee from 0% to the ceiling, not presets', async () => {
  const { openCreationProblem, defaultOpenChoices } = await import('../app/lib/hooklab-open-launch.mjs')
  assert.equal(openCreationProblem(continuous, coin), '')
  assert.equal(defaultOpenChoices(continuous).creatorFeeBps, 100)
  assert.equal(defaultOpenChoices({ ...continuous, maxCreatorFeeBps: 50 }).creatorFeeBps, 50, 'the default never exceeds the ceiling')
  const markup = html(h(HookOpenLaunch, { genesisHash, initial: { availability: { ...availability, openCreation: continuous }, coin: { ...coin, creatorFeeBps: 137 } } }), { wallet: true })
  assert.match(markup, /id="creator-fee-percent"/)
  assert.match(markup, /min="0" max="5" step="0.01"/)
  assert.match(markup, /value="1.37"/)
  assert.match(text(markup), /from 0% to 5%/)
})
test('the launch-requests API sends whether the creator fee is continuous', async () => {
  const { publicOpenCreation } = await import('../app/lib/hooklab-launch-requests.mjs')
  assert.equal(publicOpenCreation(continuous).continuousCreatorFee, true)
})

// 2026-10-27: a refused "complete" (the review lease ran out before repo.ing finished) leaves the attempt unsent and
// partial. The page waits out the review, then closes it on chain proof and starts a fresh approval: never stuck.
test('a refused single pass waits for the review to end only when nothing was sent', async () => {
  const { refusedPassWaitMs } = await import('../app/lib/hooklab-open-launch.mjs')
  const now = 1000, op = (status, extra = {}) => ({ status, review: { reviewExpiresAtMs: 31000 }, ...extra })
  assert.equal(refusedPassWaitMs(op('partial'), now), 32000, 'until the review ends, plus a margin')
  assert.equal(refusedPassWaitMs(op('signed'), now), 32000)
  assert.equal(refusedPassWaitMs(op('partial', { review: { reviewExpiresAtMs: 10 } }), now), 2000, 'already ended: just the margin')
  for (const status of ['signing-claimed', 'signing-unknown', 'submission-claimed', 'submitted', 'outcome-unknown', 'expired'])
    assert.equal(refusedPassWaitMs(op(status), now), null, status)
  assert.equal(refusedPassWaitMs(op('partial', { signature: 'x' }), now), null, 'a sent transaction is never replaced')
  assert.equal(refusedPassWaitMs(null, now), null)
})
