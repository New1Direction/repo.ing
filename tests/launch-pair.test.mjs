import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { QUOTE_ERRORS, QuoteAssetError, STOCK_PAIR_LAUNCHES_READY, quoteAssetById, quoteOptions, stockPairsLaunchable } from '../src/quote-assets.mjs'
import { launchFailure } from '../src/launch-failure.mjs'
import { forgetQuoteOptions, quoteOptionsForRepo } from '../app/lib/quote-options.mjs'
import { launchPair, stockPairGuard } from '../app/lib/stock-launch.mjs'
import { POST as launchRoute } from '../app/api/launch/route.js'

const { LaunchForm } = await appModule('app/components/launch-form.jsx')
const DOCUSAURUS = { repoId: '94911145', owner: 'facebook', name: 'docusaurus', fullName: 'facebook/docusaurus', ownerId: '69631', ownerType: 'Organization' }
const PAIRS = quoteOptions(DOCUSAURUS, { enabled: true })
const launch = body => launchRoute(new Request('https://repo.ing/api/launch', { method: 'POST', body: JSON.stringify(body) }))
const prepareBody = extra => ({ action: 'prepare', repoId: DOCUSAURUS.repoId, repositoryUrl: 'https://github.com/facebook/docusaurus',
  tokenName: 'Docusaurus', tokenSymbol: 'DOCUSAURUS', tokenImage: 'data:image/png;base64,AA==', launcherWallet: '11111111111111111111111111111111',
  initialBuyLamports: '0', ...extra })

// STOCK_QUOTES_ENABLED as web sees it (undefined: unset) for the length of one check. Only exactly "true" turns it on.
const CLOSED = [undefined, '', 'false', 'TRUE', '1', 'yes', ' true']
async function withSwitch(value, work) {
  const saved = process.env.STOCK_QUOTES_ENABLED
  if (value === undefined) delete process.env.STOCK_QUOTES_ENABLED
  else process.env.STOCK_QUOTES_ENABLED = value
  forgetQuoteOptions()
  try { return await work() } finally {
    if (saved === undefined) delete process.env.STOCK_QUOTES_ENABLED
    else process.env.STOCK_QUOTES_ENABLED = saved
    forgetQuoteOptions()
  }
}
// The launch-side checks on their defaults, which read the switch at call time; GitHub, the stock's config and its mint are
// stand-ins that count their reads.
const META = quoteAssetById('meta-xstock'), META_CONFIG = 'MetaConfig1111111111111111111111111111111111'
function launchDeps() {
  const reads = { github: 0 }
  const owner = async () => { reads.github++; return { ownerId: DOCUSAURUS.ownerId, ownerType: DOCUSAURUS.ownerType } }
  return { reads, deps: { solConfig: 'SolConfig111111111111111111111111111111111111', owner, configFor: () => ({ toBase58: () => META_CONFIG }),
    mintUsable: async () => {} } }
}
const options = async () => {
  let reads = 0
  const result = await quoteOptionsForRepo(DOCUSAURUS.repoId, { load: async () => { reads++; return DOCUSAURUS } })
  return { assetIds: result.options.map(option => option.assetId), reads }
}
const refusedAs = (code, message) => error => error.code === code && error.message === message

test('the code gate is open: stock pairs are launchable exactly while STOCK_QUOTES_ENABLED is "true"', () => {
  assert.equal(STOCK_PAIR_LAUNCHES_READY, true, 'the switch PR opened the code gate (docs/STOCK_GO_LIVE.md, step 6)')
  assert.equal(stockPairsLaunchable({ STOCK_QUOTES_ENABLED: 'true' }), true)
  for (const value of CLOSED) assert.equal(stockPairsLaunchable(value === undefined ? {} : { STOCK_QUOTES_ENABLED: value }), false, `closed with ${JSON.stringify(value)}`)
})

test('while STOCK_QUOTES_ENABLED is unset or anything but "true", stock launches stay closed at every step', async () => {
  for (const value of CLOSED) {
    await withSwitch(value, async () => {
      const label = `STOCK_QUOTES_ENABLED=${JSON.stringify(value)}`
      // The pairs offered (the launch page and GET /api/repos/<id>/quote-options): SOL only, without reading GitHub.
      assert.deepEqual(await options(), { assetIds: ['sol'], reads: 0 }, label)
      // Prepare decides the pair first: refused before GitHub is read.
      const { reads, deps } = launchDeps()
      await assert.rejects(launchPair(prepareBody({ quoteAssetId: 'meta-xstock' }), deps),
        refusedAs(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are not available.'), label)
      assert.equal(reads.github, 0, label)
      // After reservation and after the wallet signed, a launch under way is refused at its next step.
      await assert.rejects(stockPairGuard(META, META_CONFIG, deps)({ repo: { githubRepoId: 94911145n } }),
        refusedAs(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are not available.'), label)
      // The launch API, for prepare and for an initial-buy quote.
      for (const body of [prepareBody({ quoteAssetId: 'meta-xstock' }), { action: 'quote', supplyBps: 100, quoteAssetId: 'meta-xstock' }]) {
        const response = await launch(body)
        assert.equal(response.status, 400, label)
        const result = await response.json()
        assert.deepEqual([result.code, result.error], [QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are not available.'], label)
      }
    })
  }
})

test('with STOCK_QUOTES_ENABLED=true a stock pair passes the gate to its own checks', async () => {
  await withSwitch('true', async () => {
    assert.deepEqual(await options(), { assetIds: ['sol', 'meta-xstock'], reads: 1 }, 'the owner company\'s stock is offered, from a live GitHub read')
    const { reads, deps } = launchDeps()
    const pair = await launchPair(prepareBody({ quoteAssetId: 'meta-xstock' }), deps)
    assert.deepEqual([pair.quote.assetId, pair.quote.mint, pair.config, reads.github], ['meta-xstock', META.mint, META_CONFIG, 1])
    // Its own checks still apply: a stock without a config in STOCK_QUOTE_CONFIGS cannot launch.
    await assert.rejects(launchPair(prepareBody({ quoteAssetId: 'meta-xstock' }), { ...deps, configFor: () => null }),
      refusedAs(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'METAx pairs are not open for launches yet.'))
    await stockPairGuard(META, META_CONFIG, deps)({ repo: { githubRepoId: 94911145n } })
    // A stock-paired launch has no initial buy: its quote is refused with that reason, not as unavailable.
    const result = await (await launch({ action: 'quote', supplyBps: 100, quoteAssetId: 'meta-xstock' })).json()
    assert.deepEqual([result.code, result.error], [QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock-paired launches have no initial buy yet. Buy after the launch.'])
  })
})

test('the launch API refuses a stock pair with its code before reading anything; it never launches it as SOL', async () => withSwitch(undefined, async () => {
  for (const body of [prepareBody({ quoteAssetId: 'meta-xstock' }), { action: 'quote', supplyBps: 100, quoteAssetId: 'meta-xstock' },
    prepareBody({ repoId: '4503599627370497', quoteAssetId: 'meta-xstock' })]) {
    const response = await launch(body)
    const result = await response.json()
    assert.equal(response.status, 400)
    assert.deepEqual([result.code, result.error], [QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are not available.'])
  }
  for (const quoteAssetId of ['METAx', 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', 'Meta Platforms', 42]) {
    const result = await (await launch(prepareBody({ quoteAssetId }))).json()
    assert.equal(result.code, QUOTE_ERRORS.QUOTE_ASSET_INVALID, `refuses ${quoteAssetId}`)
  }
  // SOL, named or not, goes down the existing path (here it stops later, at the unconfigured launch, with its usual code).
  for (const extra of [{}, { quoteAssetId: 'sol' }]) {
    const result = await (await launch(prepareBody(extra))).json()
    assert.equal(result.code, 'REVIEW_FAILED')
    assert.doesNotMatch(result.error, /pair/i)
  }
}))

test('a refused pair keeps its own code; every other failure keeps the code it had', () => {
  const refusal = launchFailure(new QuoteAssetError(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH, 'MSFTx is not offered for repositories owned by facebook.'), 'prepare')
  assert.deepEqual(refusal, { error: 'MSFTx is not offered for repositories owned by facebook.', canRetry: true, code: QUOTE_ERRORS.QUOTE_ASSET_MISMATCH })
  assert.equal(launchFailure(Object.assign(Error('Review expired'), { code: 'ECONNRESET' }), 'prepare').code, 'REVIEW_EXPIRED')
  assert.equal(launchFailure(Error('Network lost'), 'submit').code, 'CHECK_STATUS')
})

test('Choose pair: SOL selected by default beside the owner company\'s stock, explained by the owning organization', () => {
  const markup = html(h(LaunchForm, { repo: DOCUSAURUS, available: true, quoteOptions: PAIRS }), { wallet: true })
  assert.match(markup, /<legend class="field-label">Choose pair<\/legend>/)
  // React writes checked before value on a controlled radio.
  assert.match(markup, /<input type="radio" name="quote-asset" checked="" value="sol"\/><span class="launch-pair-symbol">SOL<\/span><small>Default<\/small>/)
  assert.doesNotMatch(markup, /checked="" value="meta-xstock"/)
  assert.match(markup, /value="meta-xstock"\/><span class="launch-pair-symbol">METAx<\/span><small>Meta Platforms<\/small>/)
  assert.match(markup, /Available because this repo belongs to facebook/)
  assert.doesNotMatch(markup, /launch-pair-note/, 'the instrument note appears once the stock pair is chosen')
  assert.ok(markup.indexOf('Choose pair') < markup.indexOf('Initial buy'), 'the pair comes before the amount it denominates')
})

test('no chooser for SOL-only repositories, an ineligible stock or a model market', () => {
  const chooser = props => html(h(LaunchForm, { repo: DOCUSAURUS, available: true, ...props }), { wallet: true }).includes('Choose pair')
  assert.equal(chooser({}), false)
  assert.equal(chooser({ quoteOptions: [PAIRS[0]] }), false)
  assert.equal(chooser({ quoteOptions: [PAIRS[0], { ...PAIRS[1], eligible: false, reason: QUOTE_ERRORS.STOCK_ASSET_DISABLED }] }), false)
  assert.equal(chooser({ repo: { ...DOCUSAURUS, source: 'huggingface', repoId: '4503599627370497', hfId: 'a'.repeat(24) }, quoteOptions: PAIRS }), false)
})

test('a chosen pair is always sent: the form never drops it on the way to the server', () => {
  const source = readFileSync('app/components/launch-form.jsx', 'utf8')
  assert.match(source, /const pairRequest = quoteAssetId === 'sol' \? \{\} : \{ quoteAssetId \}/)
  assert.match(source, /action: 'quote', \.\.\.body, \.\.\.pairRequest/)
  assert.match(source, /initialBuyLamports, \.\.\.pairRequest \}\)/)
  assert.match(source, /code:result\.code/)
})
