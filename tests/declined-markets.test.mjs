import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'
import { buyAction, handleBuyGet, loadActionMarket, sellAction } from '../app/lib/solana-actions.mjs'
import { appModule, h, html, offlineFetch } from './fixtures/render-jsx.mjs'

// A market its maintainer declined (src/maintainer-opt-outs.mjs) says so off its token page too: its Blink and X card lead with
// the decline and stop saying that trades pay the builders (the buy and sell buttons stay, as on the page), its page is noindex,
// and the sitemap leaves it out. $CRYPTOGOAT (WILDCATZWEB3/Cryptogoat) was declined on Oct 6.
process.env.TZ = 'UTC'
const MINT = 'MintCryptogoatDeclined'
const GOAT = { repoId: '1060000001', mint: MINT, symbol: 'CRYPTOGOAT', fullName: 'WILDCATZWEB3/Cryptogoat', description: 'The goat of crypto.' }
const DECLINED = { ...GOAT, declined: true }
const MODEL = { repoId: '4503599627370497', mint: 'MintModelGpt2', symbol: 'GPT2', fullName: 'openai-community/gpt2', description: null, declined: true }
const LEAD = 'The maintainer of WILDCATZWEB3/Cryptogoat has declined this market. repo.ing does not promote it, and it is not endorsed by the project.'

test('the Blink of a declined market leads with the decline, keeps its buttons and no longer says trades pay the builders', () => {
  const action = buyAction(DECLINED)
  assert.equal(action.title, 'Declined by the maintainer · $CRYPTOGOAT · WILDCATZWEB3/Cryptogoat')
  assert.ok(action.description.startsWith(`${LEAD} Trading stays open so holders can exit.`), action.description)
  assert.doesNotMatch(action.description, /Every trade pays|goat of crypto/)
  assert.match(action.description, /canonical repo\.ing pool with 1% max slippage\.$/)
  assert.deepEqual(action.links.actions.map(link => link.label), ['Buy 0.1 SOL', 'Buy 0.5 SOL', 'Buy 1 SOL', 'Buy', 'Sell 25%', 'Sell 50%', 'Sell all'])
  assert.equal(action.disabled, undefined)

  const sell = sellAction(DECLINED)
  assert.equal(sell.title, 'Declined by the maintainer · Sell $CRYPTOGOAT · WILDCATZWEB3/Cryptogoat')
  assert.ok(sell.description.startsWith(LEAD))
  assert.doesNotMatch(sell.description, /Every trade pays/)
  assert.deepEqual(sell.links.actions.map(link => link.label), ['Sell 25%', 'Sell 50%', 'Sell all'])

  // Not declined: exactly as before.
  const normal = buyAction(GOAT)
  assert.equal(normal.title, '$CRYPTOGOAT · WILDCATZWEB3/Cryptogoat')
  assert.equal(normal.description, 'The goat of crypto. Every trade pays the builders. Trades use the canonical repo.ing pool with 1% max slippage.')
  assert.equal(sellAction(GOAT).title, 'Sell $CRYPTOGOAT · WILDCATZWEB3/Cryptogoat')
})

test('a declined model market\'s Blink names its owner and keeps the disclaimer', () => {
  const action = buyAction(MODEL)
  assert.equal(action.title, 'Declined by the owner · $GPT2 · openai-community/gpt2')
  assert.ok(action.description.startsWith('The owner of openai-community/gpt2 has declined this market.'))
  assert.ok(action.description.includes(HF_DISCLAIMER_SHORT))
  assert.doesNotMatch(action.description, /Every trade pays/)
  assert.ok(sellAction(MODEL).description.includes(HF_DISCLAIMER_SHORT))
})

test('the Blink GET serves the declined copy, and the market read carries the active decline', async () => {
  const mint = Keypair.generate().publicKey.toBase58()
  const response = await handleBuyGet(mint, { loadMarket: async () => ({ ...DECLINED, mint }) })
  assert.equal(response.status, 200)
  const action = await response.json()
  assert.match(action.title, /^Declined by the maintainer · /)
  assert.equal(action.links.actions.length, 7)
  let seen
  await loadActionMarket({ query: async sql => { seen = sql; return { rows: [] } } }, MINT)
  assert.match(seen, /exists\(select 1 from maintainer_opt_outs o where o\.github_repo_id = m\.github_repo_id and o\.withdrawn_at is null\) as declined/)
})

test('the X card of a declined market says so in its header and drops "Every trade pays"', async () => {
  const { MarketCard } = await appModule('app/lib/og-market-card.jsx')
  const stats = [{ label: 'Price', value: '$0.00001240' }]
  const card = html(h(MarketCard, { market: GOAT, logo: null, stats, at: Date.UTC(2026, 9, 8, 23, 40), declined: true }))
  const notice = card.indexOf('Declined by the maintainer')
  assert.ok(notice > 0, 'the notice is on the card')
  // In the header, top right (before the repository name), never in the bottom-left corner that X covers with its title.
  assert.ok(notice < card.indexOf('WILDCATZWEB3/Cryptogoat'))
  const footer = card.indexOf('Not endorsed by the project. Trading stays open so holders can exit.')
  assert.ok(footer > card.indexOf('$0.00001240'), 'the footer line, after the figures')
  assert.doesNotMatch(card, /Every trade pays|Open source markets/)
  // Not declined: the card is the same as before the notice existed.
  assert.equal(html(h(MarketCard, { market: GOAT, logo: null, stats, declined: false })), html(h(MarketCard, { market: GOAT, logo: null, stats })))
  assert.ok(html(h(MarketCard, { market: GOAT, logo: null, stats })).includes('Every trade pays the repo’s builders in SOL.'))
  const model = html(h(MarketCard, { market: MODEL, logo: null, stats, declined: true }))
  assert.ok(model.includes('Declined by the owner') && model.includes(HF_DISCLAIMER_SHORT))
  assert.doesNotMatch(model, /Every trade pays/)
})

// The read side of PostgreSQL as the sitemap and the token page see it.
const ROW = { repoId: GOAT.repoId, mint: MINT, pool: 'PoolGoat', tokenName: 'Cryptogoat', symbol: 'CRYPTOGOAT', indexedAt: new Date('2026-10-01T00:00:00Z'),
  allocationVersion: null, discoveryVersion: null, launcherWallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', verificationBonusLamports: null,
  quoteAssetId: null, quoteMint: null, owner: 'WILDCATZWEB3', name: 'Cryptogoat', fullName: GOAT.fullName, description: GOAT.description, avatarUrl: null,
  source: 'github', stars: 3, forks: 0, updatedAt: null, githubCreatedAt: null, beneficiaryWallet: null, beneficiaryBoundAt: null, beneficiaryMethod: null,
  earned: '0', claimed: '0', volume24hLamports: '0', wasVerified: false, lastSqrtPrice: null, graduationStatus: null, observation: null, graduationError: null,
  migrationEvidenceHash: null }
const DECISION = { repoId: GOAT.repoId, kind: 'decline', note: null, createdAt: new Date('2026-10-06T12:00:00Z') }
const OTHER = { repoId: '1060000002', mint: 'MintOther', indexedAt: new Date('2026-10-02T00:00:00Z') }

async function withDatabase(query, work) {
  const saved = { url: process.env.DATABASE_URL, pool: globalThis.__gitfunPool, excluded: process.env.PROMOTION_EXCLUDED_REPO_IDS }
  const net = offlineFetch()
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
  delete process.env.PROMOTION_EXCLUDED_REPO_IDS
  globalThis.__gitfunPool = { query }
  try { return await work() } finally {
    net.restore()
    globalThis.__gitfunPool = saved.pool
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url
    if (saved.excluded !== undefined) process.env.PROMOTION_EXCLUDED_REPO_IDS = saved.excluded
  }
}

test('the sitemap leaves out declined markets, and every token page while the do-not-promote set is unreadable', async () => {
  const sitemap = (await appModule('app/sitemap.js')).default
  const markets = { rows: [{ repoId: GOAT.repoId, mint: MINT, indexedAt: ROW.indexedAt }, OTHER] }
  const tokenUrls = async () => (await sitemap()).map(entry => entry.url).filter(url => url.includes('/token/'))
  const pages = async () => (await sitemap()).filter(entry => !entry.url.includes('/token/')).length
  await withDatabase(async sql => /from markets/.test(sql) ? markets
    : /from maintainer_opt_outs/.test(sql) ? { rows: [{ repoId: GOAT.repoId }] } : { rows: [] }, async () => {
    assert.deepEqual(await tokenUrls(), ['https://repo.ing/token/MintOther'])
  })
  // Fails closed, as the home lists and the strips do: no token page at all, the site's own pages still listed.
  const errors = console.error, warnings = console.warn
  console.error = () => {}; console.warn = () => {}
  try {
    await withDatabase(async sql => {
      if (/from maintainer_opt_outs/.test(sql)) throw Object.assign(Error('connection terminated'), { code: '57P01' })
      return /from markets/.test(sql) ? markets : { rows: [] }
    }, async () => {
      assert.deepEqual(await tokenUrls(), [])
      assert.ok(await pages() > 5)
    })
  } finally { console.error = errors; console.warn = warnings }
})

test('a declined market\'s page is noindex and its preview description leads with the decline', async () => {
  const page = await appModule('app/(site)/token/[mint]/page.jsx')
  const metadata = declined => withDatabase(async (sql, params = []) => /where m\.mint = \$1/.test(sql) && params[0] === MINT ? { rows: [ROW] }
    : /from maintainer_opt_outs/.test(sql) && declined ? { rows: [DECISION] } : { rows: [] },
  () => page.generateMetadata({ params: Promise.resolve({ mint: MINT }) }))
  const declined = await metadata(true)
  assert.deepEqual(declined.robots, { index: false })
  assert.equal(declined.description, `${LEAD} Trading stays open so holders can exit.`)
  assert.equal(declined.openGraph.description, declined.description)
  assert.equal(declined.twitter.description, declined.description)
  const normal = await metadata(false)
  assert.equal(normal.robots, undefined)
  assert.equal(normal.description, GOAT.description)
})

test('a declined model market\'s metadata is noindex too', async () => {
  const { modelTokenMetadata } = await appModule('app/components/hf/model-token-page.jsx')
  const before = process.env.HF_MARKETS_ENABLED
  process.env.HF_MARKETS_ENABLED = 'true'
  try {
    const declined = modelTokenMetadata(MODEL, { declined: true })
    assert.deepEqual(declined.robots, { index: false })
    assert.ok(declined.description.startsWith('The owner of openai-community/gpt2 has declined this market.'))
    assert.ok(declined.description.includes(HF_DISCLAIMER_SHORT))
    assert.equal(modelTokenMetadata(MODEL).robots, undefined)
  } finally { if (before === undefined) delete process.env.HF_MARKETS_ENABLED; else process.env.HF_MARKETS_ENABLED = before }
})
