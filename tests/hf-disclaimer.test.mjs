import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appModule, h, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'
import { HF_DISCLAIMER, HF_DISCLAIMER_BADGE, HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'

// The disclaimer on every Hugging Face model surface, never the Hugging Face logo:
//   pages and lists that show a model: the full HF_DISCLAIMER, visible;
//   each list row and market card: HF_DISCLAIMER_BADGE (or the short or full text);
//   share, OG, Blink and metadata text: HF_DISCLAIMER_SHORT or the full text;
//   JSON-LD and token metadata descriptions: the full text.
// Every module in app/ that has a model branch is either checked below (SURFACES) or exempt with a reason (EXEMPT), so a
// new model surface cannot ship without being added here.
process.env.HF_MARKETS_ENABLED = 'true'
delete process.env.DATABASE_URL

const MODEL_ID = '4503599627370497', MINT = 'MintModelGpt2'
const MODEL = { repoId: MODEL_ID, source: 'huggingface', mint: MINT, pool: 'PoolModelGpt2', fullName: 'openai-community/gpt2', owner: 'openai-community', name: 'gpt2',
  description: null, symbol: 'GPT2', tokenName: 'gpt2', wasVerified: false, volume24hLamports: '3000000000', earned: '0', claimed: '0', remaining: '0',
  stars: 4194, forks: 0, priceSol: null, indexedAt: '2026-10-01T11:00:00.000Z', newRepo: false, promoted: true, officialLaunch: false, discoveryVersion: null }
const decoded = markup => markup.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"')
const full = text => assert.ok(decoded(text).includes(HF_DISCLAIMER), `missing the full disclaimer in: ${decoded(text).slice(0, 160)}`)
const short = text => assert.ok(text.includes(HF_DISCLAIMER_SHORT) || decoded(text).includes(HF_DISCLAIMER), `missing the disclaimer in: ${text.slice(0, 160)}`)

// The read side of PostgreSQL as the token and return pages see it: this model market, its registry row, nothing else.
const ROW = { repoId: MODEL_ID, mint: MINT, pool: 'PoolModelGpt2', tokenName: 'gpt2', symbol: 'GPT2', indexedAt: new Date('2026-10-01T11:00:00Z'), allocationVersion: null,
  discoveryVersion: null, launcherWallet: 'LauncherWallet', verificationBonusLamports: null, owner: 'openai-community', name: 'gpt2', fullName: 'openai-community/gpt2',
  description: null, avatarUrl: null, source: 'huggingface', stars: 4194, forks: 0, updatedAt: null, githubCreatedAt: null, beneficiaryWallet: null,
  beneficiaryBoundAt: null, beneficiaryMethod: null, earned: '0', claimed: '0', volume24hLamports: '0', wasVerified: false, lastSqrtPrice: null,
  graduationStatus: null, observation: null, graduationError: null, migrationEvidenceHash: null }
async function withModelDatabase(work) {
  const net = offlineFetch()
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
  globalThis.__gitfunPool = { query: async sql => ({ rows: /where m\.mint = \$1/.test(sql) ? [ROW]
    : /from hf_models/.test(sql) ? [{ hfId: '621ffdc036468d709f17434d', path: 'openai-community/gpt2', ownerHandle: 'openai-community', ownerKind: 'org', gated: false, baseModels: [] }] : [] }) }
  try { return await work() } finally { net.restore(); delete globalThis.__gitfunPool; delete process.env.DATABASE_URL }
}

const SURFACES = {
  'app/(site)/token/[mint]/page.jsx': async () => withModelDatabase(async () => {
    const page = await appModule('app/(site)/token/[mint]/page.jsx')
    const params = Promise.resolve({ mint: MINT })
    const metadata = await page.generateMetadata({ params })
    for (const description of [metadata.description, metadata.openGraph.description, metadata.twitter.description]) short(description)
    const markup = html(await resolveServer(await page.default({ params, searchParams: Promise.resolve({}) })), { wallet: true })
    full(markup)
    assert.match(markup, /<script type="application\/ld\+json">\{[^<]*"description":"Community launch — not endorsed by the model's creators\. Not affiliated with Hugging Face\./)
    full(html(await resolveServer(await page.default({ params, searchParams: Promise.resolve({ view: 'activity' }) })), { wallet: true }))
  }),
  'app/components/hf/model-token-page.jsx': () => {
    const source = readFileSync('app/components/hf/model-token-page.jsx', 'utf8')
    assert.match(source, /<ModelDisclaimer className="is-banner"\/>/, 'the page banner')
    assert.match(source, /shareText=\{modelShareText\(market\)\}/, 'the system share sheet text')
  },
  'app/(site)/token/[mint]/return/[pct]/page.jsx': async () => withModelDatabase(async () => {
    const page = await appModule('app/(site)/token/[mint]/return/[pct]/page.jsx')
    const params = Promise.resolve({ mint: MINT, pct: '12.5' })
    const metadata = await page.generateMetadata({ params })
    short(metadata.description); short(metadata.openGraph.description)
    full(html(await page.default({ params }), { wallet: true }))
  }),
  'app/components/ui.jsx': async () => {
    const { MarketTable } = await appModule('app/components/ui.jsx')
    const markup = html(h(MarketTable, { markets: [MODEL, { ...MODEL, repoId: '4503599627370498', mint: 'MintModelTwo' }] }))
    const rows = markup.split(/(?=<div class="market-row)/).slice(1)
    assert.equal(rows.length, 2)
    for (const row of rows) assert.ok(row.includes(`<small>${HF_DISCLAIMER_BADGE} · `), 'each row carries the badge')
    full(markup)
  },
  'app/components/more-markets.jsx': async () => {
    const { MoreMarkets } = await appModule('app/components/more-markets.jsx')
    const { selectMoreMarkets } = await import('../app/lib/more-markets.mjs')
    const markup = html(h(MoreMarkets, { markets: selectMoreMarkets([MODEL]) }))
    assert.equal(markup.split(`>${HF_DISCLAIMER_BADGE}</p>`).length - 1, 1, 'the card carries the badge')
    full(markup)
  },
  'app/components/hf/models-strip.jsx': async () => {
    const { ModelsStrip } = await appModule('app/components/hf/models-strip.jsx')
    const { selectModelStrip } = await import('../app/lib/hf-model-display.mjs')
    const markup = html(h(ModelsStrip, { markets: selectModelStrip([MODEL]) }))
    assert.equal(markup.split(`>${HF_DISCLAIMER_BADGE}</p>`).length - 1, 1, 'the card carries the badge')
    full(markup)
  },
  'app/components/graduation-race.jsx': async () => {
    const { GraduationRaceBoard } = await appModule('app/components/graduation-race.jsx')
    full(html(h(GraduationRaceBoard, { markets: [{ repoId: MODEL_ID, mint: MINT, fullName: MODEL.fullName, symbol: 'GPT2', progressPercent: 12,
      reserveLamports: '10200000000', thresholdLamports: '85000000000', remainingLamports: '74800000000', aboutToGraduate: false }] })))
  },
  'app/lib/og-market-card.jsx': async () => {
    const { MarketCard } = await appModule('app/lib/og-market-card.jsx')
    short(html(h(MarketCard, { market: MODEL, logo: null, stats: [] })))
    short(html(h(MarketCard, { market: MODEL, logo: null, stats: [{ label: 'Price', value: '0.0001 SOL' }] })))
  },
  'app/lib/og-return-card.jsx': async () => {
    const { ReturnCard } = await appModule('app/lib/og-return-card.jsx')
    short(html(h(ReturnCard, { market: MODEL, logo: null, pct: 12.5 })))
  },
  'app/components/market-share-artwork.jsx': async () => {
    const { MarketShareArtwork } = await appModule('app/components/market-share-artwork.jsx')
    short(html(h(MarketShareArtwork, { market: MODEL, snapshot: { kind: 'payout', headline: 'Model owner paid.', metric: '1 SOL', detail: 'd', note: 'n',
      timestamp: '2026-10-01T00:00:00.000Z' } })))
  },
  'app/api/market/[mint]/share-card/route.js': () => {
    // Its card is market-share-artwork (above); the caption it returns gains the short disclaimer for a model market.
    assert.match(readFileSync('app/api/market/[mint]/share-card/route.js', 'utf8'), /if \(model\) snapshot = \{ \.\.\.snapshot, caption: `\$\{snapshot\.caption\}\\n\$\{HF_DISCLAIMER_SHORT\}`/)
  },
  'app/lib/token-metadata.mjs': async () => {
    const { tokenMetadataJson } = await import('../app/lib/token-metadata.mjs')
    full(tokenMetadataJson({ mint: MINT, origin: 'https://repo.ing', market: { repoId: MODEL_ID, name: 'gpt2', symbol: 'GPT2', hasImage: false, fullName: MODEL.fullName } }).description)
    full(tokenMetadataJson({ mint: MINT, origin: 'https://repo.ing', market: { repoId: MODEL_ID, name: 'gpt2', symbol: 'GPT2', hasImage: true, fullName: null } }).description)
  },
  'app/lib/json-ld.mjs': async () => {
    const { tokenJsonLd } = await import('../app/lib/json-ld.mjs')
    full(tokenJsonLd(MODEL).description)
  },
  'app/lib/solana-actions.mjs': async () => {
    const { buyAction, sellAction } = await import('../app/lib/solana-actions.mjs')
    short(buyAction(MODEL).description); short(sellAction(MODEL).description)
  },
  'app/lib/share-links.mjs': async () => {
    const { returnShareText, shareText, xReturnShareUrl, xShareUrl } = await import('../app/lib/share-links.mjs')
    for (const kind of ['buy', 'sell', 'launch']) short(shareText({ fullName: MODEL.fullName, symbol: 'GPT2', kind, source: 'huggingface' }))
    short(new URL(xShareUrl({ mint: MINT, fullName: MODEL.fullName, symbol: 'GPT2', source: 'huggingface' })).searchParams.get('text'))
    // The wallet's "Share" of a holding's return (app/components/wallet-overview.jsx passes the market's source).
    short(returnShareText({ symbol: 'GPT2', fullName: MODEL.fullName, pct: 12.5, source: 'huggingface' }))
    short(new URL(xReturnShareUrl({ mint: MINT, symbol: 'GPT2', fullName: MODEL.fullName, percent: 12.5, source: 'huggingface' })).searchParams.get('text'))
    assert.match(readFileSync('app/components/wallet-overview.jsx', 'utf8'), /source: isModelMarket\(market\) \? 'huggingface' : 'github'/)
    // One post: the longest names the texts allow still fit X's 280 characters with the link (23).
    assert.ok(shareText({ fullName: 'a'.repeat(100), kind: 'launch', source: 'huggingface' }).length + 1 + 23 <= 280)
    assert.ok(returnShareText({ symbol: 'S'.repeat(20), fullName: 'a'.repeat(100), pct: -99.9, source: 'huggingface' }).length + 1 + 23 <= 280)
  },
  // The launch flow (#136): the model's launch page and review, the success screen and its launch-kit post.
  'app/components/hf/model-launch.jsx': () => {
    assert.match(readFileSync('app/components/hf/model-launch.jsx', 'utf8'), /<p className="community-launch-note" role="note">.*<strong>\{HF_DISCLAIMER\}<\/strong>/)
  },
  'app/components/launch-form.jsx': () => {
    assert.match(readFileSync('app/components/launch-form.jsx', 'utf8'), /\{model && <p className="launch-review-disclaimer" role="note"><strong>\{HF_DISCLAIMER\}<\/strong><\/p>\}/)
  },
  'app/components/launch-success.jsx': async () => {
    const { LaunchSuccess } = await appModule('app/components/launch-success.jsx')
    full(html(h(LaunchSuccess, { repo: { source: 'huggingface', fullName: MODEL.fullName, repoId: MODEL_ID }, launched: { mint: MINT, verified: false }, symbol: 'GPT2', image: null }),
      { wallet: true }))
    // Its share menu's system share sheet text, as on the model's token page.
    assert.match(readFileSync('app/components/launch-success.jsx', 'utf8'), /shareText=\{model \? modelShareText\(repo\) : null\}/)
  },
  'app/lib/model-share.mjs': async () => {
    const { modelLaunchPostText, modelLaunchPostUrl } = await import('../app/lib/model-share.mjs')
    short(modelLaunchPostText({ symbol: 'GPT2', path: MODEL.fullName }))
    short(new URL(modelLaunchPostUrl({ mint: 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A', symbol: 'GPT2', path: MODEL.fullName })).searchParams.get('text'))
  },
}

const EXEMPT = {
  'app/lib/hf-model-display.mjs': 'defines the display rules and re-exports the copy',
  'app/lib/hf-markets.mjs': 'flag, list filtering and reads; renders nothing',
  'app/components/hf/model-ui.jsx': 'the badge and disclaimer components themselves',
  'app/components/hf/source-split.jsx': '/stats aggregates; names no model',
  'app/components/trust-panel.jsx': 'rendered inside the model token page, which carries the disclaimer',
  'app/components/explore-list.jsx': 'filters rows; they render through MarketTable (ui.jsx)',
  'app/components/protocol-analytics.jsx': '/stats aggregates; names no model',
  'app/lib/og-image.jsx': 'loads logos; the cards are og-market-card and og-return-card',
  'app/(site)/token/[mint]/opengraph-image/route.jsx': 'flag gate; the card is og-market-card',
  'app/(site)/token/[mint]/return/[pct]/image/route.jsx': 'flag gate; the card is og-return-card',
  'app/api/repo-logo/[repo]/route.js': 'images only',
  'app/(site)/page.jsx': 'flag and filtering; lists render through MarketTable, the race board and ModelsStrip',
  'app/(site)/explore/page.jsx': 'flag and filtering; the list renders through MarketTable',
  'app/(site)/stats/page.jsx': 'flag only',
  'app/sitemap.js': 'URLs only',
  'app/lib/market-order.mjs': 'carries model rows’ display-only likes; renders nothing',
  'app/components/wallet-overview.jsx': 'passes the market’s source to the return share (checked under share-links.mjs)',
  'app/api/wallet/overview/route.js': 'flag filtering only',
  'app/lib/waiting-board.mjs': 'leaves model markets out of /waiting',
  'app/(site)/launch/[repo]/page.jsx': 'routes a model id to ModelLaunch (hf/model-launch.jsx, checked above)',
  'app/api/repo-images/[repo]/route.js': 'image suggestions only',
  'app/lib/hf-launch.mjs': 'launch reads, lookup quotas and avatar fetches; renders nothing',
  'app/lib/csp.mjs': 'admits the Hub avatar hosts to img-src; renders nothing',
}

const sources = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? sources(join(dir, entry.name)) : /\.(?:mjs|js|jsx)$/.test(entry.name) ? [join(dir, entry.name)] : [])
const MODEL_BRANCH = /\bisModelMarket\b|'huggingface'|hf-model-display|hf-markets\.mjs|hf-copy\.mjs|\.\/hf\/|\/hf\/[\w-]+'/

test('every module with a model branch is checked for the disclaimer or exempt with a reason', () => {
  const branching = sources('app').filter(file => MODEL_BRANCH.test(readFileSync(file, 'utf8'))).sort()
  const classified = [...Object.keys(SURFACES), ...Object.keys(EXEMPT)].sort()
  assert.deepEqual(branching, classified)
})

for (const [file, check] of Object.entries(SURFACES)) test(`disclaimer: ${file}`, check)

test('no Hugging Face logo anywhere: no logo asset, logo URL or 🤗', () => {
  // Asset and URL names only (prose may say "never use the Hugging Face logo").
  const LOGO = /huggingface\.co\/front\/assets|hf[-_]logo|hugging[-_]?face[-_](?:logo|mark|icon)|huggingface[-_]?logo|huggingface\.svg|\u{1F917}/iu
  for (const file of [...sources('app'), ...sources('src')]) assert.doesNotMatch(readFileSync(file, 'utf8'), LOGO, file)
  for (const file of sources('app').filter(name => name.endsWith('.css')).concat(readdirSync('app').filter(name => name.endsWith('.css')).map(name => join('app', name)))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), LOGO, file)
  }
  const assets = readdirSync('public', { recursive: true }).map(String)
  assert.deepEqual(assets.filter(name => /hugging|hf[-_]/i.test(name)), [])
})
