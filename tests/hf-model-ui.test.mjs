import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { appModule, h, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'
import { startFakeHf } from './fixtures/hf-server.mjs'
import { HF_DISCLAIMER, HF_DISCLAIMER_BADGE, HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'
import { createHfClient, HfNotFoundError, HfUpstreamError } from '../src/hf-api.mjs'
import { safeHfAvatarUrl } from '../src/hf-avatar.mjs'
import { createModelCards, hfMarketsEnabled, shownMarkets, withModelFacts } from '../app/lib/hf-markets.mjs'
import { baseModels, derivativeLabel, gatedLabel, isModelMarket, modelEarningsHeadline, modelView, selectModelStrip, taskLabel } from '../app/lib/hf-model-display.mjs'

// Hugging Face model markets in the UI: the display rules, the live model card, and every list, card and page variant.
// Rendering is offline (tests/fixtures/render-jsx.mjs); the Hub is the recorded fake (tests/fixtures/hf-server.mjs).
const { MarketTable, RepoAvatar, RepoIdentity, RepoStats, GitHubLink } = await appModule('app/components/ui.jsx')
const { MoreMarkets } = await appModule('app/components/more-markets.jsx')
const { GraduationRaceBoard } = await appModule('app/components/graduation-race.jsx')
const { ExploreList } = await appModule('app/components/explore-list.jsx')
const { TrustPanel } = await appModule('app/components/trust-panel.jsx')
const { ModelsStrip } = await appModule('app/components/hf/models-strip.jsx')
const { ModelTokenPage, modelTokenMetadata } = await appModule('app/components/hf/model-token-page.jsx')
const { ModelPulseSlot } = await appModule('app/components/hf/model-pulse-slot.jsx')
const { ProtocolAnalytics } = await appModule('app/components/protocol-analytics.jsx')
const { GET: repoLogo } = await appModule('app/api/repo-logo/[repo]/route.js')
const { selectMoreMarkets } = await import('../app/lib/more-markets.mjs')

const MODEL_ID = '4503599627370497', GPT2_HF_ID = '621ffdc036468d709f17434d'
const NOW = Date.parse('2026-10-01T12:00:00Z')
// Not base58: nothing rendered here can reach an RPC.
const MODEL = { repoId: MODEL_ID, source: 'huggingface', mint: 'MintModelGpt2', pool: 'PoolModelGpt2', fullName: 'openai-community/gpt2', owner: 'openai-community',
  name: 'gpt2', description: null, symbol: 'GPT2', tokenName: 'gpt2', wasVerified: false, volume24hLamports: '3000000000', earned: '9000000', claimed: '0',
  remaining: '9000000', stars: 0, forks: 0, priceSol: 0.0000003, indexedAt: new Date(NOW - 3_600_000).toISOString(), newRepo: true, promoted: true,
  officialLaunch: false, discoveryVersion: 2 }
// A list row once withModelFacts attached the model's display-only likes (repositories.stars stays 0 for models).
const LISTED = { ...MODEL, likes: 4194 }
const GITHUB = { repoId: '1384142609', source: 'github', mint: 'MintGithubVerified', pool: 'PoolGithubVerified', fullName: 'New1Direction/Waternot',
  owner: 'New1Direction', name: 'Waternot', description: 'Water quality on a budget', symbol: 'WTR', tokenName: 'Waternot', wasVerified: true,
  volume24hLamports: '2500000000', earned: '125000000', claimed: '25000000', remaining: '100000000', stars: 1200, forks: 31, priceSol: 0.00000042,
  indexedAt: new Date(NOW - 7_200_000).toISOString(), newRepo: false, promoted: true, officialLaunch: false }
const REGISTRY = { hfId: GPT2_HF_ID, path: 'openai-community/gpt2', ownerHandle: 'openai-community', ownerKind: 'org', gated: false, baseModels: [] }
// HTML-escaped copy: React writes ' as &#x27;.
const escaped = text => text.replaceAll("'", '&#x27;')
const withFlag = async (value, work) => {
  const before = process.env.HF_MARKETS_ENABLED
  if (value === undefined) delete process.env.HF_MARKETS_ENABLED; else process.env.HF_MARKETS_ENABLED = value
  try { return await work() } finally { if (before === undefined) delete process.env.HF_MARKETS_ENABLED; else process.env.HF_MARKETS_ENABLED = before }
}

test('the market id decides a model market, and only HF_MARKETS_ENABLED=true turns model surfaces on', () => {
  assert.equal(isModelMarket(MODEL), true)
  assert.equal(isModelMarket(GITHUB), false)
  assert.equal(isModelMarket({ ...GITHUB, source: 'huggingface' }), false, 'the id range wins over a stray source field')
  assert.equal(isModelMarket({ source: 'huggingface' }), true)
  assert.equal(isModelMarket({ repoId: '4503599627370496' }), false, '2^52 belongs to neither source')
  for (const value of [undefined, '', '1', 'TRUE', 'yes', 'false']) assert.equal(hfMarketsEnabled({ HF_MARKETS_ENABLED: value }), false, String(value))
  assert.equal(hfMarketsEnabled({ HF_MARKETS_ENABLED: 'true' }), true)
  assert.deepEqual(shownMarkets([GITHUB, MODEL], {}), [GITHUB])
  assert.deepEqual(shownMarkets([GITHUB, MODEL], { HF_MARKETS_ENABLED: 'true' }), [GITHUB, MODEL])
})

test('model facts: task names, gated access, base models and the derivative badge', () => {
  assert.equal(taskLabel('text-generation'), 'Text generation')
  assert.equal(taskLabel('image-text-to-text'), 'Image text to text')
  for (const bad of [null, '', 'Text', 'a b', '<script>', 'x'.repeat(70)]) assert.equal(taskLabel(bad), null, String(bad))
  assert.equal(gatedLabel(false), null)
  assert.equal(gatedLabel(null), null)
  assert.match(gatedLabel('manual').title, /after a request/)
  assert.match(gatedLabel('auto').title, /accepting the model’s conditions/)
  assert.equal(gatedLabel(true).label, 'Gated')
  // Registry rows store paths or objects; the live card stores { relation, models }. Invalid paths never become links.
  assert.deepEqual(baseModels(['meta-llama/Llama-2-7b-hf', { path: 'meta-llama/Llama-2-7b-hf' }, { id: 'a/b' }, 'not a path', 'datasets/x']),
    { relation: null, paths: ['meta-llama/Llama-2-7b-hf', 'a/b'] })
  assert.deepEqual(baseModels({ relation: 'quantized', models: [{ hfId: 'f'.repeat(24), path: 'meta-llama/Llama-2-7b-hf' }] }),
    { relation: 'quantized', paths: ['meta-llama/Llama-2-7b-hf'] })
  assert.equal(baseModels([]), null)
  assert.equal(baseModels({ relation: 'quantized', models: [] }), null)
  assert.deepEqual(derivativeLabel({ relation: 'finetune', paths: ['a/base', 'b/base', 'c/base'] }),
    { label: 'Derivative of a/base +2', href: 'https://huggingface.co/a/base', title: 'Finetune of a/base, b/base, c/base' })
  assert.equal(derivativeLabel(null), null)
})

test('modelView: live facts only for the registry row’s own _id; a moved path gets no link and no live figures', () => {
  const live = { status: 'live', hfId: GPT2_HF_ID, path: 'openai-community/gpt2', pipelineTag: 'text-generation', license: 'mit', likes: 4200,
    downloads30d: 15740994, gated: 'manual', baseModels: { relation: 'finetune', models: [{ hfId: 'a'.repeat(24), path: 'gpt/base' }] }, lastModified: '2024-02-19T10:57:45.000Z' }
  const view = modelView(MODEL, REGISTRY, live)
  assert.deepEqual({ ...view, gated: view.gated.label }, { path: 'openai-community/gpt2', owner: 'openai-community', name: 'gpt2', ownerKind: 'org', hfId: GPT2_HF_ID,
    url: 'https://huggingface.co/openai-community/gpt2', moved: false, live: true, task: 'Text generation', license: 'mit', gated: 'Gated',
    base: { relation: 'finetune', paths: ['gpt/base'] }, likes: 4200, downloads30d: 15740994, updatedAt: '2024-02-19T10:57:45.000Z' })
  const stored = modelView({ ...MODEL, stars: 4194 }, { ...REGISTRY, gated: true, baseModels: [{ hfId: 'a'.repeat(24), path: 'meta/base', relation: 'quantized' }] }, { status: 'unavailable' })
  assert.equal(stored.live, false)
  assert.equal(stored.likes, null, 'repositories.stars is never read as likes')
  assert.equal(stored.downloads30d, null)
  assert.equal(stored.task, null)
  assert.equal(stored.gated.label, 'Gated')
  assert.deepEqual(stored.base, { relation: 'quantized', paths: ['meta/base'] }, 'the launch stores the relation on each base model')
  assert.equal(modelView(LISTED, REGISTRY, { status: 'unavailable' }).likes, 4194, 'display-only likes attached to a list row')
  const moved = modelView(LISTED, REGISTRY, { status: 'moved' })
  assert.equal(moved.url, null)
  assert.equal(moved.moved, true)
  assert.equal(moved.likes, 4194)
})

test('list facts: lists show models’ likes from earlier live cards without a request, refreshing missing ones after the response', () => withFlag('true', async () => {
  const facts = globalThis.__repoingHfModelFacts, cards = globalThis.__repoingHfModelCards
  facts.clear()
  const reads = []
  globalThis.__repoingHfModelCards = createModelCards({ read: async path => { reads.push(path); return { hfId: GPT2_HF_ID, path, likes: 77, downloads30d: 5 } } })
  const queries = [], scheduled = []
  const pool = { query: async (sql, params) => { queries.push(params[0]); return { rows: [{ ...REGISTRY, marketRef: MODEL_ID }] } } }
  try {
    const rows = [GITHUB, MODEL, { ...MODEL, repoId: '4503599627370498', mint: 'MintModelTwo' }]
    const first = withModelFacts(rows, { pool, schedule: fn => scheduled.push(fn), refreshLimit: 1 })
    assert.deepEqual(first, rows, 'nothing known yet: the rows as they are')
    assert.equal(scheduled.length, 1)
    await scheduled[0]()
    assert.deepEqual(queries, [[MODEL_ID]], 'one registry read, at most refreshLimit models')
    assert.deepEqual(reads, ['openai-community/gpt2'])
    const second = withModelFacts(rows, { pool, schedule: fn => scheduled.push(fn) })
    assert.equal(second[0], GITHUB, 'GitHub rows are untouched')
    assert.deepEqual([second[1].likes, second[1].downloads30d, second[2].likes], [77, 5, undefined])
    assert.equal(scheduled.length, 2, 'the other model is still refreshed')
    await withFlag(undefined, () => assert.equal(withModelFacts(rows, { pool, schedule: () => assert.fail('no refresh when off') }), rows))
  } finally { facts.clear(); globalThis.__repoingHfModelCards = cards }
}))

test('model earnings headline: the builder evidence gate, in model-owner words', () => {
  assert.equal(modelEarningsHeadline(MODEL, { status: 'UNAVAILABLE' }, 150), null)
  const verify = modelEarningsHeadline(MODEL, { status: 'MATCH', onchainCreatorFee: '9000000' }, null)
  assert.deepEqual(verify.action, { kind: 'verify', href: `/claim/${MODEL_ID}`, label: 'Model owner? Verify to claim 0.009 SOL' })
  assert.equal(modelEarningsHeadline(MODEL, { status: 'MATCH', onchainCreatorFee: '0' }, null).action.label, 'The model’s owner earns from every trade')
  const paid = modelEarningsHeadline({ ...MODEL, claimed: '5', beneficiaryWallet: 'Wallet' }, { status: 'MATCH', onchainCreatorFee: '0' }, null)
  assert.equal(paid.action.label, 'Paid to the model’s verified owner')
  assert.equal(modelEarningsHeadline({ ...MODEL, beneficiaryWallet: 'Wallet' }, { status: 'MATCH', onchainCreatorFee: '7' }, null).action.kind, 'claim')
})

test('live model card: one Hub read per model per TTL, checked against the registry _id; moved, missing and failed reads', async () => {
  const server = await startFakeHf()
  try {
    let clock = NOW
    const hf = createHfClient({ fetchImpl: server.fetchImpl, retries: 0, maxWaitMs: 0, now: () => clock })
    const cards = createModelCards({ read: path => hf.model({ path }), now: () => clock })
    const [first, concurrent] = await Promise.all([cards(REGISTRY), cards(REGISTRY)])
    assert.equal(first, concurrent)
    assert.deepEqual(first, { status: 'live', hfId: GPT2_HF_ID, path: 'openai-community/gpt2', pipelineTag: 'text-generation', license: 'mit', likes: 4194,
      downloads30d: 15740994, gated: false, baseModels: null, lastModified: '2024-02-19T10:57:45.000Z', redirectedFrom: null })
    await cards(REGISTRY)
    assert.equal(server.requests.length, 1, 'cached: one request')
    clock += 10 * 60_000
    await cards(REGISTRY)
    assert.equal(server.requests.length, 2, 'read again after the TTL')
    // The runwayml path now redirects to a repository with another _id: the market's model has moved away.
    assert.deepEqual(await cards({ hfId: 'b'.repeat(24), path: 'runwayml/stable-diffusion-v1-5' }), { status: 'moved' })
    assert.deepEqual(await cards({ hfId: 'c'.repeat(24), path: 'openai-community/no-such-model-repoing-x9' }), { status: 'missing' })
    assert.deepEqual(await cards({ hfId: null, path: 'openai-community/gpt2' }), { status: 'unavailable' })
  } finally { await server.close() }
  // Any other failure is retried after a minute, not after the full TTL.
  let clock = NOW, calls = 0
  const failing = createModelCards({ read: async () => { calls++; throw new HfUpstreamError('down', { code: 'HF_HTTP_503' }) }, now: () => clock })
  assert.deepEqual(await failing(REGISTRY), { status: 'unavailable' })
  await failing(REGISTRY)
  assert.equal(calls, 1)
  clock += 60_000
  await failing(REGISTRY)
  assert.equal(calls, 2)
  const missing = createModelCards({ read: async () => { throw new HfNotFoundError('gone', { code: 'HF_NOT_FOUND' }) } })
  assert.deepEqual(await missing(REGISTRY), { status: 'missing' })
})

const rowsOf = markup => markup.split(/(?=<div class="market-row)/).slice(1)

test('market tables: a model row shows its source label, the disclaimer badge, likes that link to the model, and the table ends with the disclaimer', () => {
  const mixed = html(h(MarketTable, { markets: [GITHUB, LISTED], usdPerSol: 150 }))
  const [githubRow, modelRow] = rowsOf(mixed)
  // The GitHub row is byte-for-byte the row a GitHub-only table renders.
  const [alone] = rowsOf(html(h(MarketTable, { markets: [GITHUB], usdPerSol: 150 })))
  assert.equal(githubRow, alone.replace(/<\/div><\/div>$/, ''))
  assert.match(modelRow, /^<div class="market-row is-model">/)
  assert.match(modelRow, /<span class="source-chip is-model"[^>]*>Hugging Face<\/span>/)
  assert.match(modelRow, new RegExp(`<small>${HF_DISCLAIMER_BADGE} · Public Hugging Face model</small>`))
  assert.match(modelRow, /<a class="table-stars table-likes" href="https:\/\/huggingface\.co\/openai-community\/gpt2" target="_blank" rel="noreferrer"/)
  assert.match(modelRow, /lucide-heart/)
  assert.match(modelRow, />4\.2K<span class="sr-only"> likes, open openai-community\/gpt2 on Hugging Face<\/span>/)
  assert.doesNotMatch(modelRow, /lucide-star|New repo|github\.com/)
  assert.match(mixed, /<div class="market-head"><span>#<\/span><span>Repo \/ model<\/span><span>Token<\/span><span>Market cap<\/span><span>24h Volume<\/span><span>Earnings<\/span><span>Stars \/ likes<\/span>/)
  assert.equal(mixed.split(escaped(HF_DISCLAIMER)).length - 1, 1, 'the full disclaimer once, under the table')
  assert.ok(mixed.endsWith(`<p class="model-disclaimer table-disclaimer" role="note">${mixed.slice(mixed.lastIndexOf('<svg'), mixed.lastIndexOf('</svg>') + 6)}<span>${escaped(HF_DISCLAIMER)}</span></p>`))
  const unknown = html(h(MarketTable, { markets: [MODEL] }))
  assert.match(unknown, /<span>Repo \/ model<\/span>/)
  assert.match(unknown, /title="Likes unavailable right now · open openai-community\/gpt2 on Hugging Face"><svg[^>]*lucide-heart[\s\S]*?<\/svg>—<span class="sr-only"> likes/, 'unknown likes read as a dash, never 0')
})

test('avatars, identity, stats and source links have model variants, with no GitHub mark or link and no Hugging Face logo', () => {
  assert.match(html(h(RepoAvatar, { repo: { repoId: undefined, source: 'huggingface' } })), /lucide-brain-circuit/)
  assert.match(html(h(RepoAvatar, { repo: {} })), /<svg[^>]*><path d="M12 \.75a11\.25 11\.25/, 'GitHub keeps its mark')
  assert.match(html(h(RepoAvatar, { repo: MODEL })), /<img src="\/api\/token-image\/MintModelGpt2\?w=128"/)
  const link = html(h(GitHubLink, { repo: MODEL }))
  assert.match(link, /^<a class="button outline github-link model-link" href="https:\/\/huggingface\.co\/openai-community\/gpt2" target="_blank" rel="noreferrer">View on Hugging Face<svg/)
  assert.equal(html(h(GitHubLink, { repo: { ...MODEL, fullName: 'not a model path' } })), '')
  const identity = html(h(RepoIdentity, { repo: MODEL, heading: true }))
  assert.match(identity, /<span class="source-chip is-model"[^>]*>Hugging Face<\/span>/)
  assert.match(identity, /<p>Public Hugging Face model<\/p>/)
  assert.doesNotMatch(identity, /Public<\/span>|GitHub/)
  const stats = html(h(RepoStats, { repo: LISTED, detailed: true }))
  assert.match(stats, /^<div class="repo-stats model-stats"><span title="4,194 likes on Hugging Face">/)
  assert.match(stats, /4\.2K<small>likes<\/small>/)
  assert.doesNotMatch(stats, /lucide-star|lucide-git-fork/)
  for (const markup of [link, identity, stats]) assert.doesNotMatch(markup, /huggingface\.co\/front|hf-logo|huggingface_logo/i)
})

test('more-markets cards, the graduation race and the home Models strip label models and carry the disclaimer', () => {
  const more = html(h(MoreMarkets, { markets: selectMoreMarkets([GITHUB, MODEL], { now: NOW }) }))
  assert.match(more, /^<section class="more-markets has-models" aria-labelledby="more-markets-title"><div class="more-markets-heading"><h2 id="more-markets-title">More markets<\/h2><p>Every trade pays the builders in SOL\.<\/p>/)
  assert.match(more, /\$GPT2<\/span><span class="source-chip is-model compact"[^>]*>Hugging Face<\/span>/)
  assert.match(more, new RegExp(`<p class="model-card-badge" title="${escaped(HF_DISCLAIMER)}">${HF_DISCLAIMER_BADGE}</p>`))
  assert.ok(more.includes(`<span>${escaped(HF_DISCLAIMER)}</span>`))
  const race = html(h(GraduationRaceBoard, { markets: [{ repoId: MODEL_ID, mint: MODEL.mint, fullName: MODEL.fullName, symbol: 'GPT2', progressPercent: 12,
    reserveLamports: '10200000000', thresholdLamports: '85000000000', remainingLamports: '74800000000', aboutToGraduate: false, newRepo: true }] }))
  assert.match(race, /\$GPT2<span class="source-chip is-model compact"/)
  assert.doesNotMatch(race, /New repo/)
  assert.ok(race.includes(`<span>${escaped(HF_DISCLAIMER)}</span>`))
  assert.equal(html(h(ModelsStrip, { markets: [] })), '')
  const strip = html(h(ModelsStrip, { markets: selectModelStrip([GITHUB, LISTED, { ...MODEL, repoId: '4503599627370498', mint: 'MintModelTwo', volume24hLamports: '0', stars: 12 }]) }))
  assert.match(strip, /title="4,194 likes on Hugging Face"/)
  assert.match(strip, /title="Likes unavailable right now"/, 'stars are never shown as likes')
  assert.match(strip, /<h2 id="models-strip-title">Hugging Face models<\/h2>/)
  assert.match(strip, /<a class="view-all" href="\/explore\?source=models">View all/)
  assert.deepEqual([...strip.matchAll(/<strong title="openai-community\/gpt2">([^<]+)<\/strong>/g)].map(match => match[1]), ['openai-community/gpt2', 'openai-community/gpt2'])
  assert.deepEqual([...strip.matchAll(/href="\/token\/(\w+)#trade-panel"/g)].map(match => match[1]), ['MintModelGpt2', 'MintModelTwo'], 'by 24h volume')
  assert.equal(strip.split(`<p class="model-card-badge" title="${escaped(HF_DISCLAIMER)}">${HF_DISCLAIMER_BADGE}</p>`).length - 1, 2, 'each card shows the badge')
  assert.ok(strip.includes(`<span>${escaped(HF_DISCLAIMER)}</span>`), 'and the strip ends with the full disclaimer')
})

test('explore: the Market source filter appears only with the flag, and ?source=models lists only models', () => {
  const markets = [GITHUB, MODEL]
  const off = html(h(ExploreList, { markets }), { query: 'source=models' })
  assert.doesNotMatch(off, /Market source/)
  assert.equal(rowsOf(off).length, 2, 'without the flag the parameter is ignored')
  const on = html(h(ExploreList, { markets, modelsEnabled: true }), { query: 'source=models' })
  assert.match(on, /<select aria-label="Market source"><option value="all">Repos &amp; models<\/option><option value="repos">GitHub repos \(1\)<\/option><option value="models" selected="">Hugging Face models \(1\)<\/option><\/select>/)
  assert.match(on, /placeholder="Search repositories, models or tokens\.\.\."/)
  const rows = rowsOf(on)
  assert.equal(rows.length, 1)
  assert.match(rows[0], /^<div class="market-row is-model">/)
  assert.match(on, />Clear filters<\/button>/)
  const repos = rowsOf(html(h(ExploreList, { markets, modelsEnabled: true }), { query: 'source=repos' }))
  assert.deepEqual(repos.map(row => /class="market-row(?: is-model)?"/.exec(row)[0]), ['class="market-row"'])
  assert.match(html(h(ExploreList, { markets: [GITHUB], modelsEnabled: true }), { query: 'source=models' }), /No Hugging Face model markets match these filters\./)
})

test('trust panel: a model’s owner verifies and claims on /claim/<id>, in Hugging Face words', () => {
  const panel = html(h(TrustPanel, { market: MODEL }))
  assert.match(panel, /<strong class="trust-title">Model owner hasn&#x27;t verified yet<\/strong><span class="trust-line">Model owner\? <a href="\/claim\/4503599627370497">Claim as the model&#x27;s owner →<\/a><\/span>/)
  assert.doesNotMatch(panel, /GitHub admin/)
  const verified = html(h(TrustPanel, { market: { ...MODEL, beneficiaryWallet: 'Wallet' }, declined: { createdAt: '2026-09-01T00:00:00Z' } }))
  assert.match(verified, /Verified model owner ✓<\/strong><span class="trust-line">Hugging Face owner verified · payout wallet set/)
  assert.match(verified, /Model owner declined this market<\/strong><span class="trust-line">Not promoted · not endorsed by the model&#x27;s creators/)
})

test('model token page: disclaimer, model card, Model Pulse slot and the owner claim; no tips, parts, allocation, invites, streams or Dev Pulse', () => withFlag('true', async () => {
  const net = offlineFetch()
  try {
    const page = html(await resolveServer(await ModelTokenPage({ market: MODEL })), { wallet: true })
    assert.ok(page.includes(`<p class="model-disclaimer is-banner" role="note">`))
    assert.ok(page.includes(escaped(HF_DISCLAIMER)))
    assert.match(page, /<div class="market-hero-ticker"><strong>\$GPT2<\/strong><span>Model market<\/span>/)
    assert.match(page, /<div id="model" class="inner-card model-card">/)
    assert.match(page, /<dt>Author<\/dt><dd>openai-community<\/dd>/)
    assert.match(page, /<dt>Likes<\/dt><dd>—<\/dd>/, 'no live card: unknown, never repositories.stars')
    assert.match(page, /Live Hugging Face details are unavailable right now/)
    assert.match(page, /<a href="https:\/\/huggingface\.co\/openai-community\/gpt2" target="_blank" rel="noreferrer">View on Hugging Face ↗<\/a>/)
    assert.match(page, /<a href="\/claim\/4503599627370497">Claim as the model’s owner<\/a>/)
    assert.match(page, /<a class="button white earnings-claim" href="\/claim\/4503599627370497">Claim as the model’s owner/)
    assert.match(page, /<a href="#model">Model<\/a>/)
    assert.match(page, /"description":"Community launch — not endorsed by the model's creators\. Not affiliated with Hugging Face\./, 'JSON-LD')
    // Leaves out every GitHub-only feature, and never links GitHub (the site footer's link to repo.ing's own source aside).
    const main = page.slice(page.indexOf('<main'), page.indexOf('</main>'))
    for (const absent of ['tip-jar', 'repo-tips', 'parts-fund', 'builder-allocation', 'invite-owner', 'building-live', 'dev-pulse', 'participation',
      'README badge', 'github.com', 'View on GitHub', 'Repository market']) assert.ok(!main.includes(absent), absent)
    assert.ok(net.requested.every(url => !/github|huggingface/.test(url)), 'no GitHub or Hub request without a registry row')
  } finally { net.restore() }
}))

test('model token page: when the path now leads to another repository, no link and no live figures anywhere on the page', () => withFlag('true', async () => {
  const net = offlineFetch(), before = process.env.DATABASE_URL, cards = globalThis.__repoingHfModelCards
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
  globalThis.__gitfunPool = { query: async sql => ({ rows: /from hf_models/.test(sql) ? [REGISTRY] : [] }) }
  let reads = 0
  globalThis.__repoingHfModelCards = createModelCards({ read: async () => { reads++; return { hfId: 'f'.repeat(24), path: 'openai-community/gpt2', likes: 1 } } })
  try {
    const page = html(await resolveServer(await ModelTokenPage({ market: MODEL })), { wallet: true })
    assert.equal(reads, 1, 'one Hub read serves the hero, the card and the menu')
    assert.ok(!page.includes('href="https://huggingface.co/openai-community/gpt2"'))
    assert.match(page, /This model’s Hugging Face path now leads to a different repository/)
    assert.match(page, /<dt>Likes<\/dt><dd>—<\/dd>/, 'not the other repository’s likes')
  } finally {
    net.restore(); delete globalThis.__gitfunPool; globalThis.__repoingHfModelCards = cards
    if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before
  }
}))

test('model pages, metadata and logos are off without HF_MARKETS_ENABLED', () => withFlag(undefined, async () => {
  await assert.rejects(ModelTokenPage({ market: MODEL }), error => String(error.digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404'))
  assert.deepEqual(modelTokenMetadata(MODEL), { title: 'Market not found — repo.ing' })
  assert.equal((await repoLogo(new Request(`https://repo.ing/api/repo-logo/${MODEL_ID}`), { params: Promise.resolve({ repo: MODEL_ID }) })).status, 404)
}))

test('model metadata leads with the disclaimer', () => withFlag('true', () => {
  const metadata = modelTokenMetadata(MODEL)
  assert.equal(metadata.title, '$GPT2 · openai-community/gpt2 — repo.ing')
  assert.ok(metadata.description.startsWith(`${HF_DISCLAIMER_SHORT}.`))
  assert.equal(metadata.openGraph.description, metadata.description)
  assert.equal(metadata.twitter.description, metadata.description)
  assert.equal(metadata.openGraph.images[0].url, 'https://repo.ing/token/MintModelGpt2/opengraph-image')
}))

test('logo route: a model’s avatar only from the Hub avatar hosts, resized through the image proxy, never another host', () => withFlag('true', async () => {
  const avatar = 'https://cdn-avatars.huggingface.co/v1/production/uploads/5dd96eb166059660ed1ee413/9NY4jfufqo1uyv8oNXQju.png'
  let stored = avatar
  const before = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
  globalThis.__gitfunPool = { query: async (sql, params) => {
    assert.match(sql, /source = 'huggingface'/)
    return { rows: params[0] === MODEL_ID ? [{ avatar_url: stored }] : [] }
  } }
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#81e6ad' } }).png().toBuffer()
  const net = offlineFetch([[/^https:\/\/cdn-avatars\.huggingface\.co\//, () => new Response(png, { headers: { 'content-type': 'image/png' } })],
    [/^https:\/\/huggingface\.co\/avatars\/moved\.png$/, () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.png' } })]])
  const get = (id, query = '') => repoLogo(new Request(`https://repo.ing/api/repo-logo/${id}${query}`), { params: Promise.resolve({ repo: id }) })
  try {
    const redirect = await get(MODEL_ID, '?v=3')
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), avatar)
    const resized = await get(MODEL_ID, '?v=3&w=128')
    assert.equal(resized.status, 200)
    assert.equal(resized.headers.get('content-type'), 'image/webp')
    assert.equal((await sharp(Buffer.from(await resized.arrayBuffer())).metadata()).width, 128)
    assert.equal((await get(MODEL_ID, '?w=99')).status, 400)
    assert.equal((await get('4503599627370498')).status, 404, 'no repositories row')
    // A redirect off the allowlist is never followed: the route falls back to redirecting to the stored avatar itself.
    const other = '4503599627370499'
    globalThis.__gitfunPool = { query: async () => ({ rows: [{ avatar_url: 'https://huggingface.co/avatars/moved.png' }] }) }
    const refused = await get(other, '?w=64')
    assert.equal(refused.status, 302)
    assert.equal(refused.headers.get('location'), 'https://huggingface.co/avatars/moved.png')
    assert.ok(!net.requested.some(url => url.includes('evil.example')))
    // A stored avatar on any other host is not served at all.
    stored = 'https://www.gravatar.com/avatar/0123456789abcdef0123456789abcdef?d=retro'
    globalThis.__gitfunPool = { query: async () => ({ rows: [{ avatar_url: stored }] }) }
    assert.equal((await get('4503599627370500')).status, 404)
  } finally {
    net.restore(); delete globalThis.__gitfunPool
    if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before
  }
}))

test('Hugging Face avatar allowlist: two Hub hosts, avatar paths, nothing else', () => {
  const ok = ['https://cdn-avatars.huggingface.co/v1/production/uploads/6426d3f3a7723d62b53c259b/tvPikpAzKTKGN5wrpadOJ.jpeg',
    'https://huggingface.co/avatars/0238dfe072bf70b8478b9201744585da.svg']
  for (const url of ok) assert.equal(safeHfAvatarUrl(url), url)
  for (const url of ['http://cdn-avatars.huggingface.co/v1/production/uploads/a.png', 'https://cdn-avatars.huggingface.co/other/a.png',
    'https://cdn-avatars.huggingface.co/v1/production/uploads/a.png?x=1', 'https://cdn-avatars.huggingface.co:444/v1/production/uploads/a.png',
    'https://user@huggingface.co/avatars/a.png', 'https://huggingface.co/api/avatars/openai', 'https://hf.co/avatars/a.png',
    'https://www.gravatar.com/avatar/0123456789abcdef0123456789abcdef', 'https://avatars.githubusercontent.com/u/1', 'https://cdn-avatars.huggingface.co/../avatars/x.png',
    'javascript:alert(1)', '', null, 42]) assert.equal(safeHfAvatarUrl(url), null, String(url))
})

test('/stats: the GitHub / Hugging Face split renders only when asked, and each pair is its total', () => {
  const data = { range: 'all', bucket: 'day', updatedAt: '2026-10-01T00:00:00.000Z',
    totals: { volume: '7000000000', earned: '700000000', paid: '380000000', trades: 4, markets: 4, graduated: 1 },
    days: [{ bucket: '2026-09-30T00:00:00.000Z', volume: '7000000000', earned: '700000000', paid: '380000000' }], payouts: [],
    builders: { earned: { outside: '200000000', team: '500000000' }, paid: { outside: '80000000', team: '300000000' } }, platform: { status: 'REVIEW' },
    sources: { github: { volume: '6000000000', earned: '670000000', paid: '380000000', trades: 3, markets: 3 },
      huggingface: { volume: '1000000000', earned: '30000000', paid: '0', trades: 1, markets: 1 } } }
  assert.doesNotMatch(html(h(ProtocolAnalytics, { data, usdPerSol: 150 })), /By market source/)
  const markup = html(h(ProtocolAnalytics, { data, usdPerSol: 150, showSources: true }))
  assert.match(markup, /<h2 id="source-split-title">By market source<\/h2><p>3 repository markets and 1 model market, from the same snapshot/)
  assert.match(markup, /<h3>Trading volume<\/h3><span class="source-split-bar" aria-hidden="true"><span style="width:85\.7%"><\/span><\/span>/)
  assert.match(markup, /GitHub repos<\/dt><dd>6 SOL<small>85\.7%<\/small><\/dd><\/div><div><dt><i class="is-model" aria-hidden="true"><\/i>Hugging Face models<\/dt><dd>1 SOL<small>14\.3%<\/small>/)
  assert.match(markup, /<h3>Builder payouts<\/h3><span class="source-split-bar" aria-hidden="true"><span style="width:100%"><\/span><\/span>/)
  assert.match(html(h(ProtocolAnalytics, { data: { ...data, sources: { github: { ...data.sources.github, paid: '0' }, huggingface: data.sources.huggingface } }, showSources: true })),
    /<h3>Builder payouts<\/h3><span class="source-split-bar is-empty" aria-hidden="true"><\/span>/)
})

test('Model Pulse slot renders nothing until app/lib/model-pulse.mjs ships', async () => {
  assert.equal(await ModelPulseSlot({ market: MODEL }), null)
})
