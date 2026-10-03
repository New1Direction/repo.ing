import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { QUOTE_ERRORS, QuoteAssetError, STOCK_PAIR_LAUNCHES_READY, quoteOptions, stockPairsLaunchable } from '../src/quote-assets.mjs'
import { launchFailure } from '../src/launch-failure.mjs'
import { forgetQuoteOptions, quoteOptionsForRepo } from '../app/lib/quote-options.mjs'
import { POST as launchRoute } from '../app/api/launch/route.js'

const { LaunchForm } = await appModule('app/components/launch-form.jsx')
const DOCUSAURUS = { repoId: '94911145', owner: 'facebook', name: 'docusaurus', fullName: 'facebook/docusaurus', ownerId: '69631', ownerType: 'Organization' }
const PAIRS = quoteOptions(DOCUSAURUS, { enabled: true })
const launch = body => launchRoute(new Request('https://repo.ing/api/launch', { method: 'POST', body: JSON.stringify(body) }))
const prepareBody = extra => ({ action: 'prepare', repoId: DOCUSAURUS.repoId, repositoryUrl: 'https://github.com/facebook/docusaurus',
  tokenName: 'Docusaurus', tokenSymbol: 'DOCUSAURUS', tokenImage: 'data:image/png;base64,AA==', launcherWallet: '11111111111111111111111111111111',
  initialBuyLamports: '0', ...extra })

test('stock pairs stay unlaunchable until the code says it is ready, whatever the switch says', async () => {
  assert.equal(STOCK_PAIR_LAUNCHES_READY, false, 'flip only once creation, trading, indexing, payouts and reconciliation are quote-aware')
  assert.equal(stockPairsLaunchable({ STOCK_QUOTES_ENABLED: 'true' }), false)
  const saved = process.env.STOCK_QUOTES_ENABLED
  process.env.STOCK_QUOTES_ENABLED = 'true'
  try {
    forgetQuoteOptions()
    let reads = 0
    const result = await quoteOptionsForRepo(DOCUSAURUS.repoId, { load: async () => { reads++; return DOCUSAURUS } })
    assert.deepEqual(result.options.map(option => option.assetId), ['sol'])
    assert.equal(reads, 0, 'GitHub is not read while stock pairs cannot launch')
  } finally {
    if (saved === undefined) delete process.env.STOCK_QUOTES_ENABLED
    else process.env.STOCK_QUOTES_ENABLED = saved
    forgetQuoteOptions()
  }
})

test('the launch API refuses a stock pair with its code before reading anything; it never launches it as SOL', async () => {
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
})

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
