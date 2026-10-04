import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appModule, h, html, offlineFetch } from './fixtures/render-jsx.mjs'
import { STOCK_FEE_SPLIT, stockFeeLine, stockFeeTerms } from '../src/stock-pair-copy.mjs'
import { STANDARD_FEE_NUMERATOR, feePercentLabel } from '../src/launch-fee.mjs'
import { LAUNCHER_DEN, LAUNCHER_NUM, STOCK_CREATOR_FEE_PERCENTAGE } from '../src/stock-fee-policy.mjs'
import { stockPairFeeLine } from '../src/stock-owner-claims.mjs'
import { marketQuoteView } from '../src/quote-assets.mjs'

// A stock-paired market's pages never say its trades pay the repo's builders in SOL (docs/STOCK_QUOTES.md, "Fee policy"):
// every trade pays 1.75% in the stock, 0.30% to the launcher and 1.10% to permanent $REPOING / <stock> liquidity. Each
// surface that said otherwise says that instead for a stock pair: the more-markets strip, the link-preview cards, the token
// metadata, the trade result's and the launch kit's X posts, the launch kit itself and a declined pair's trust-panel tip. SOL
// markets' output on those surfaces is pinned byte for byte in tests/stock-copy-sol-golden.test.mjs and
// tests/hf-flag-off-ui.test.mjs; the token and shared-return pages are in tests/stock-pair-pages.test.mjs.
const METAX = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', MINT = '3mg7sM6RFEBHiiFotFNfvteH1WdFcc9cujKuPaqZdfDz'
const LINE = 'Every trade pays 1.75% in METAx: 0.30% to the launcher, 1.10% to permanent $REPOING / METAx liquidity.'
const MIXED = 'SOL pairs pay builders in SOL. Stock pairs pay 0.30% to the launcher, 1.10% to $REPOING liquidity.'
const STOCK = { repoId: '94911145', source: 'github', mint: MINT, pool: 'PoolStockDocs', fullName: 'facebook/docusaurus', owner: 'facebook', name: 'docusaurus',
  description: 'Easy to maintain open source documentation websites.', symbol: 'DOCUSAURUS', tokenName: 'Docusaurus', quoteAssetId: 'meta-xstock', quoteMint: METAX,
  launcherWallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', beneficiaryWallet: null, wasVerified: false }
const QUOTE = marketQuoteView(STOCK)
// No copy below may say a stock pair's trades pay builders in SOL, in any wording a SOL surface uses.
const SOL_CLAIM = /builders in SOL|builders, who claim it in SOL|builder fees (?:earned|stay claimable)|Builders earn from every trade|README badge|Invite the maintainer/
const decoded = markup => markup.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"')
const xText = href => new URL(decoded(href)).searchParams.get('text')
// Rendered components may start reads (the trust panel's streamed rows read the chain): none reaches a network here.
const net = offlineFetch()
test.after(() => net.restore())
const xHrefs = markup => [...markup.matchAll(/href="(https:\/\/x\.com\/intent\/post[^"]*)"/g)].map(match => xText(match[1]))

test('the fee line is the policy\'s split: 1.75% in the stock, 0.30% to the launcher, 1.10% to permanent $REPOING / stock liquidity', async () => {
  // The split, computed from the regular fee (the SDK-free literal must equal STANDARD_FEE_NUMERATOR) and the policy constants.
  const routed = STANDARD_FEE_NUMERATOR * 80n / 100n, launcher = routed * BigInt(STOCK_CREATOR_FEE_PERCENTAGE) / 100n * LAUNCHER_NUM / LAUNCHER_DEN
  assert.deepEqual({ ...STOCK_FEE_SPLIT }, { total: feePercentLabel(STANDARD_FEE_NUMERATOR), meteora: feePercentLabel(STANDARD_FEE_NUMERATOR - routed),
    launcher: feePercentLabel(launcher), accumulator: feePercentLabel(routed - launcher) })
  assert.deepEqual({ ...STOCK_FEE_SPLIT }, { total: '1.75%', meteora: '0.35%', launcher: '0.30%', accumulator: '1.10%' })
  // The token page's fee routing card and trust panel read the same object.
  assert.equal((await import('../app/lib/stock-fee-routing.mjs')).STOCK_FEE_SPLIT, STOCK_FEE_SPLIT)
  assert.equal(stockFeeLine('METAx'), LINE)
  assert.equal(stockFeeTerms('MSFTx'), 'pays 1.75% in MSFTx: 0.30% to the launcher, 1.10% to permanent $REPOING / MSFTx liquidity')
  assert.equal(stockFeeLine(), 'Every trade pays 1.75% in its stock: 0.30% to the launcher, 1.10% to permanent $REPOING / stock liquidity.')
  // A market's line from its stamp (camelCase or column names); null for SOL; the generic line for a stamp off the registry.
  assert.equal(stockPairFeeLine(STOCK), LINE)
  assert.equal(stockPairFeeLine({ quote_asset_id: 'nvda-xstock', quote_mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' }), stockFeeLine('NVDAx'))
  assert.equal(stockPairFeeLine({ quoteAssetId: 'gone-xstock', quoteMint: METAX }), stockFeeLine())
  for (const sol of [{ quoteAssetId: null, quoteMint: null }, {}, null]) assert.equal(stockPairFeeLine(sol), null)
  // Client components import the copy: it loads nothing but the two dependency-free modules it is built from.
  const imports = [...readFileSync(new URL('../src/stock-pair-copy.mjs', import.meta.url), 'utf8').matchAll(/^import .* from '([^']+)'$/gm)].map(match => match[1])
  assert.deepEqual(imports, ['./launch-fee-copy.mjs', './stock-fee-policy.mjs'])
})

test('more markets: SOL strips on SOL pages read as before; a stock pair\'s page or a listed stock pair never says builders in SOL', async () => {
  const { MoreMarkets } = await appModule('app/components/more-markets.jsx')
  const { moreMarketsNote, selectMoreMarkets } = await import('../app/lib/more-markets.mjs')
  const now = Date.parse('2026-10-04T12:00:00Z')
  const row = (n, stock) => ({ repoId: String(n), mint: `Mint${n}`, fullName: `org/repo${n}`, symbol: `R${n}`, volume24hLamports: stock ? null : String(n),
    indexedAt: new Date(now - n * 60_000).toISOString(), ...(stock !== undefined && { stock }) })
  const metax = { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, price: null, volume24h: '0' }
  const msftx = { assetId: 'msft-xstock', symbol: 'MSFTx', decimals: 8, price: null, volume24h: '0' }
  const sol = selectMoreMarkets([row(1), row(2)], { now }), stocks = selectMoreMarkets([row(3, metax), row(4, metax)], { now })
  // Unchanged on a SOL page with SOL markets, repositories or models alike.
  assert.equal(moreMarketsNote(sol), 'Every trade pays the repo\'s builders in SOL.')
  assert.equal(moreMarketsNote(sol, { models: true }), 'Every trade pays the builders in SOL.')
  // Only METAx pairs listed: their own line, on a SOL or a METAx page.
  assert.equal(moreMarketsNote(stocks), LINE)
  assert.equal(moreMarketsNote(stocks, { quote: QUOTE }), LINE)
  // Anything else: SOL pairs and stock pairs named apart, never "every trade pays builders in SOL".
  for (const [markets, quote] of [[sol, QUOTE], [[...sol, ...stocks], null], [[...sol, ...stocks], QUOTE], [selectMoreMarkets([row(3, metax), row(5, msftx)], { now }), null],
    [selectMoreMarkets([row(6, { assetId: 'meta-xstock', symbol: null, unavailable: true })], { now }), null], [sol, { assetId: 'gone-xstock', unavailable: true }]]) {
    assert.equal(moreMarketsNote(markets, { quote }), MIXED)
  }
  // Rendered: the line under the heading, and the strip on a SOL page is the same markup with or without a null pair.
  const strip = props => decoded(html(h(MoreMarkets, props)))
  assert.ok(strip({ markets: sol, quote: QUOTE }).includes(`<p>${MIXED}</p>`))
  assert.ok(strip({ markets: stocks, quote: QUOTE }).includes(`<p>${LINE}</p>`))
  assert.doesNotMatch(strip({ markets: [...sol, ...stocks] }), /Every trade pays the repo's builders in SOL/)
  assert.equal(html(h(MoreMarkets, { markets: sol, quote: null })), html(h(MoreMarkets, { markets: sol })))
})

test('link previews of a stock pair: the card footer says what its trades pay, in the stock', async () => {
  const { MarketCard } = await appModule('app/lib/og-market-card.jsx')
  const { ReturnCard } = await appModule('app/lib/og-return-card.jsx')
  for (const markup of [html(h(MarketCard, { market: STOCK, logo: null, stats: [] })), html(h(ReturnCard, { market: STOCK, logo: null, pct: 12.5 }))]) {
    assert.ok(decoded(markup).includes(`>${LINE}</div>`), 'the footer')
    assert.doesNotMatch(decoded(markup), SOL_CLAIM)
  }
})

test('token metadata of a stock pair (wallets, DEX Screener, Jupiter) names its fee routing in the stock', async () => {
  const { tokenMetadataJson } = await import('../app/lib/token-metadata.mjs')
  const json = tokenMetadataJson({ mint: MINT, origin: 'https://repo.ing', market: { repoId: STOCK.repoId, name: 'Docusaurus', symbol: 'DOCUSAURUS', hasImage: false,
    fullName: STOCK.fullName, quoteAssetId: 'meta-xstock' } })
  assert.equal(json.description, `$DOCUSAURUS is the repo.ing market for github.com/facebook/docusaurus. ${LINE} ` +
    'Community launch: does not imply endorsement by the repository\'s maintainers.')
  // The route reads the stamp it decides by, for every market (SOL rows read null and keep their description).
  assert.match(readFileSync(new URL('../app/api/token-metadata/[mint]/route.js', import.meta.url), 'utf8'), /m\.quote_asset_id as "quoteAssetId"/)
})

test('X posts of a stock pair, after a trade and after its launch, say what its trades pay in the stock', async () => {
  const { shareText, xShareUrl } = await import('../app/lib/share-links.mjs')
  const { launchPostText, launchPostUrl } = await import('../app/lib/builder-share.mjs')
  const { xWeight, X_MAX_WEIGHT } = await import('../src/launch-alerts-message.mjs')
  const pays = 'every trade pays 1.75% in METAx: 0.30% to the launcher, 1.10% to permanent $REPOING / METAx liquidity'
  const details = { fullName: STOCK.fullName, symbol: 'DOCUSAURUS', quote: QUOTE }
  assert.equal(shareText({ ...details, kind: 'buy' }), `I just backed facebook/docusaurus on @repodoting — ${pays}`)
  assert.equal(shareText({ ...details, kind: 'sell' }), `I'm trading facebook/docusaurus on @repodoting — ${pays}`)
  assert.equal(shareText({ ...details, kind: 'launch' }), `I just launched a market for facebook/docusaurus on @repodoting — ${pays}`)
  assert.equal(xText(xShareUrl({ mint: MINT, ...details, kind: 'buy' })), `I just backed facebook/docusaurus on @repodoting — ${pays}`)
  // The longest repository name still fits one post with its link.
  assert.ok(xWeight(`${shareText({ ...details, fullName: `${'a'.repeat(39)}/${'b'.repeat(100)}`, kind: 'launch' })} https://repo.ing/token/${MINT}`) <= X_MAX_WEIGHT)
  const launch = `$DOCUSAURUS is live: I just launched a market for facebook/docusaurus on repo.ing (@repodoting). ${LINE}`
  assert.equal(launchPostText({ symbol: 'DOCUSAURUS', fullName: STOCK.fullName, quote: { symbol: 'METAx' } }), launch)
  assert.equal(xText(launchPostUrl({ mint: MINT, symbol: 'DOCUSAURUS', fullName: STOCK.fullName, quote: { symbol: 'METAx' } })), launch)

  // The trade result card's "Share on X", for a confirmed buy and sell of a stock pair.
  const { TradeResultCard } = await appModule('app/components/trade-result-card.jsx')
  for (const direction of ['buy', 'sell']) {
    const result = { state: 'confirmed', direction, signature: 'Sig111', tokenDelta: direction === 'buy' ? '123456789' : '-123456789', solDelta: '-5000',
      quoteDelta: '50000000', feeIndexing: 'recorded' }
    const markup = html(h(TradeResultCard, { result, symbol: 'DOCUSAURUS', mint: MINT, fullName: STOCK.fullName, source: 'github', onClose() {}, onCheck() {}, quote: QUOTE }))
    assert.deepEqual(xHrefs(markup), [`${direction === 'buy' ? 'I just backed' : 'I\'m trading'} facebook/docusaurus on @repodoting — ${pays}`])
    assert.doesNotMatch(decoded(markup), SOL_CLAIM)
  }
})

test('the launch kit of a stock pair: its fee line, no README badge and no maintainer invitation (no builder fees to show or claim)', async () => {
  const { LaunchKit } = await appModule('app/components/launch-kit.jsx')
  const { LaunchSuccess } = await appModule('app/components/launch-success.jsx')
  const kit = decoded(html(h(LaunchKit, { repoId: STOCK.repoId, fullName: STOCK.fullName, mint: MINT, symbol: 'DOCUSAURUS', quote: { symbol: 'METAx' } })))
  assert.ok(kit.includes(`<p>Announce it and share the market. ${LINE}</p>`))
  assert.deepEqual(xHrefs(kit), [`$DOCUSAURUS is live: I just launched a market for facebook/docusaurus on repo.ing (@repodoting). ${LINE}`])
  assert.ok(kit.includes('Copy link'))
  assert.doesNotMatch(kit, /\/api\/badge\/|Copy README badge|Invite the maintainer/)
  assert.doesNotMatch(kit, SOL_CLAIM)
  const success = decoded(html(h(LaunchSuccess, { repo: { source: 'github', fullName: STOCK.fullName, repoId: STOCK.repoId }, launched: { mint: MINT, verified: false },
    symbol: 'DOCUSAURUS', image: null, quote: { symbol: 'METAx' } })))
  assert.ok(success.includes(LINE))
  assert.doesNotMatch(success, SOL_CLAIM)
  // The launch form hands over the pair it launched (a chosen stock pair is never dropped on the way).
  assert.match(readFileSync(new URL('../app/components/launch-form.jsx', import.meta.url), 'utf8'),
    /<LaunchSuccess [^>]*quote=\{stockChosen \? \{ symbol: stockPair\?\.symbol \?\? null \} : null\}\/>/)
})

test('a declined stock pair\'s trust-panel tip names its fee routing, not builder fees claimable by the maintainer', async () => {
  const { TrustPanel } = await appModule('app/components/trust-panel.jsx')
  const declined = { createdAt: '2026-10-01T00:00:00Z' }
  const stock = decoded(html(h(TrustPanel, { market: STOCK, declined })))
  assert.ok(stock.includes('Trading stays open so holders can exit, and its fees keep going to the launcher and to permanent $REPOING liquidity.'))
  assert.doesNotMatch(stock, /builder fees stay claimable/)
  const sol = decoded(html(h(TrustPanel, { market: { ...STOCK, quoteAssetId: null, quoteMint: null }, declined })))
  assert.ok(sol.includes('Trading stays open so holders can exit, and builder fees stay claimable by the maintainer.'))
})
