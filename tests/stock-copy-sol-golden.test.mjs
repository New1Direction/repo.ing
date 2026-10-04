import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { appModule, h, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'

// SOL markets read exactly as before on every surface where a stock pair now says what its trades pay in its stock instead
// of "the repo's builders in SOL" (src/stock-pair-copy.mjs): the link-preview cards, the shared-return page and its metadata,
// the trade result's "Share on X" post, the launch kit and launch success. The output below is compared with
// tests/fixtures/stock-copy-sol.snapshot.json, which was rendered by the code on main before that change. The more-markets
// strip, token metadata, share text and trust panel are compared in tests/hf-flag-off-ui.test.mjs. A deliberate SOL copy
// change regenerates it with UPDATE_STOCK_COPY_SOL_SNAPSHOT=1 node --test tests/stock-copy-sol-golden.test.mjs
const SNAPSHOT = new URL('./fixtures/stock-copy-sol.snapshot.json', import.meta.url)
process.env.TZ = 'UTC'
delete process.env.HF_MARKETS_ENABLED

const MINT = '4Ss5JMkXAD9Z7cktFEdrqeMuT6jGMF1pVozTyPHZ6zT4', REPO_ID = '1384142609'
// A SOL market as the market reads return it (no stock stamp), and the same row for the shared-return page's database read.
const MARKET = { repoId: REPO_ID, mint: MINT, pool: 'PoolGithubVerified', tokenName: 'Waternot', symbol: 'WTR', indexedAt: new Date('2026-10-01T00:00:00Z'),
  allocationVersion: null, discoveryVersion: null, launcherWallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', verificationBonusLamports: null,
  quoteAssetId: null, quoteMint: null, owner: 'New1Direction', name: 'Waternot', fullName: 'New1Direction/Waternot', description: 'Water quality on a budget',
  avatarUrl: null, source: 'github', stars: 1200, forks: 31, updatedAt: null, githubCreatedAt: null, beneficiaryWallet: null, beneficiaryBoundAt: null,
  beneficiaryMethod: null, earned: '0', claimed: '0', volume24hLamports: '0', wasVerified: false, lastSqrtPrice: null, graduationStatus: null, observation: null,
  graduationError: null, migrationEvidenceHash: null }

const { MarketCard } = await appModule('app/lib/og-market-card.jsx')
const { ReturnCard } = await appModule('app/lib/og-return-card.jsx')
const { TradeResultCard } = await appModule('app/components/trade-result-card.jsx')
const { LaunchKit } = await appModule('app/components/launch-kit.jsx')
const { LaunchSuccess } = await appModule('app/components/launch-success.jsx')
const { launchPostText, launchPostUrl } = await import('../app/lib/builder-share.mjs')
const returnPage = await appModule('app/(site)/token/[mint]/return/[pct]/page.jsx')

// Nothing rendered here may reach a network.
const net = offlineFetch()
test.after(() => net.restore())

// The shared-return page reads its market from PostgreSQL: a fake read-only pool that knows this one market.
async function withSolMarket(work) {
  const saved = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
  globalThis.__gitfunPool = { query: async (sql, params = []) => ({ rows: /where m\.mint = \$1/.test(sql) && params[0] === MINT ? [MARKET] : [] }) }
  try { return await work() } finally {
    delete globalThis.__gitfunPool
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved
  }
}
// The page's own section: the header and footer around it are not this change's.
function returnSection(markup) {
  const start = markup.indexOf('<section class="inner-card return-share"'), end = markup.indexOf('</section>', start)
  assert.ok(start >= 0 && end > start, 'the shared-return section renders')
  return markup.slice(start, end + '</section>'.length)
}

async function surfaces() {
  const stats = [{ label: 'Price', value: '0.00000042 SOL' }]
  const confirmed = { state: 'confirmed', direction: 'buy', signature: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
    tokenDelta: '123456789', solDelta: '-100000000', feeIndexing: 'recorded' }
  const sold = { ...confirmed, direction: 'sell', tokenDelta: '-123456789', solDelta: '98000000' }
  const card = props => html(h(TradeResultCard, { symbol: 'WTR', mint: MINT, fullName: MARKET.fullName, source: 'github', onClose() {}, onCheck() {}, ...props }))
  const kit = { repoId: REPO_ID, fullName: MARKET.fullName, mint: MINT, symbol: 'WTR' }
  const { metadata, page } = await withSolMarket(async () => {
    const params = () => Promise.resolve({ mint: MINT, pct: '12.5' })
    return { metadata: await returnPage.generateMetadata({ params: params() }),
      page: returnSection(html(await resolveServer(await returnPage.default({ params: params() })), { wallet: true })) }
  })
  return {
    'og-market-card': html(h(MarketCard, { market: MARKET, logo: null, stats: [] })) + html(h(MarketCard, { market: MARKET, logo: null, stats })),
    'og-return-card': html(h(ReturnCard, { market: MARKET, logo: null, pct: 12.5 })) + html(h(ReturnCard, { market: MARKET, logo: null, pct: -5 })),
    'return-metadata': JSON.stringify(metadata),
    'return-page': page,
    'trade-result-card': card({ result: confirmed }) + card({ result: sold }),
    'launch-post': JSON.stringify([launchPostText({ symbol: 'WTR', fullName: MARKET.fullName }), launchPostUrl({ mint: MINT, symbol: 'WTR', fullName: MARKET.fullName })]),
    'launch-kit': html(h(LaunchKit, kit)) + html(h(LaunchKit, { ...kit, verified: true })),
    'launch-success': html(h(LaunchSuccess, { repo: { source: 'github', fullName: MARKET.fullName, repoId: REPO_ID }, launched: { mint: MINT, verified: false,
      signature: confirmed.signature }, symbol: 'WTR', image: null })),
  }
}

test('SOL markets: every surface the stock-pair copy touched renders exactly as on main', async () => {
  const current = await surfaces()
  if (process.env.UPDATE_STOCK_COPY_SOL_SNAPSHOT === '1') await writeFile(SNAPSHOT, `${JSON.stringify(current, null, 1)}\n`)
  const expected = JSON.parse(await readFile(SNAPSHOT, 'utf8'))
  assert.deepEqual(Object.keys(current).sort(), Object.keys(expected).sort())
  for (const [name, markup] of Object.entries(expected)) assert.equal(current[name], markup, `${name} changed for SOL markets`)
  // What the snapshot pins, in words: SOL copy still says the repo's builders are paid in SOL.
  assert.ok(expected['og-market-card'].includes('Every trade pays the repo’s builders in SOL.'))
  assert.match(expected['return-metadata'], /"description":"A trader's reported return on New1Direction\/Waternot\. Every trade pays the repo's builders in SOL\."/)
  assert.ok(expected['return-page'].includes('Every trade pays the repo’s builders in SOL.'))
  assert.ok(expected['launch-kit'].includes('Builders earn from every trade.') && expected['launch-kit'].includes('Copy README badge'))
})
