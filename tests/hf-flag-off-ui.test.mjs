import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

// With HF_MARKETS_ENABLED off, every shared surface the Hugging Face UI touched renders GitHub markets exactly as it did
// before model markets: the HTML (and copy) below is compared with tests/fixtures/github-ui.snapshot.json, which was
// rendered by the code on main before this change. A deliberate GitHub UI change regenerates it with
// UPDATE_GITHUB_UI_SNAPSHOT=1 node --test tests/hf-flag-off-ui.test.mjs
const SNAPSHOT = new URL('./fixtures/github-ui.snapshot.json', import.meta.url)
delete process.env.HF_MARKETS_ENABLED
// The same markup on every machine: dates in UTC, and no surface below formats with the machine's default locale.
process.env.TZ = 'UTC'

const { MarketTable, RepoAvatar, RepoIdentity, RepoStats, GitHubLink } = await appModule('app/components/ui.jsx')
const { HomeMarkets } = await appModule('app/components/home-markets.jsx')
const { ExploreList } = await appModule('app/components/explore-list.jsx')
const { MoreMarkets } = await appModule('app/components/more-markets.jsx')
const { TrustPanel } = await appModule('app/components/trust-panel.jsx')
const { GraduationRaceBoard } = await appModule('app/components/graduation-race.jsx')
const { ShareMarket } = await appModule('app/components/share-market.jsx')
const { ProtocolAnalytics } = await appModule('app/components/protocol-analytics.jsx')
const { homeMarketTabs } = await import('../app/lib/market-order.mjs')
const { selectMoreMarkets } = await import('../app/lib/more-markets.mjs')
const { tokenMetadataJson } = await import('../app/lib/token-metadata.mjs')
const { tokenJsonLd } = await import('../app/lib/json-ld.mjs')
const { shareText, xShareUrl } = await import('../app/lib/share-links.mjs')
const { buyAction, sellAction } = await import('../app/lib/solana-actions.mjs')
const { payoutShare } = await import('../src/market-share.mjs')

const NOW = Date.parse('2026-10-01T12:00:00Z')
// Mints are deliberately not base58 keys: nothing rendered here can reach an RPC.
const GITHUB = [
  { repoId: '1384142609', source: 'github', mint: 'MintGithubVerified', pool: 'PoolGithubVerified', fullName: 'New1Direction/Waternot', owner: 'New1Direction', name: 'Waternot',
    description: 'Water quality on a budget', symbol: 'WTR', tokenName: 'Waternot', wasVerified: true, beneficiaryWallet: 'BeneficiaryWallet111', volume24hLamports: '2500000000',
    earned: '125000000', claimed: '25000000', remaining: '100000000', stars: 1200, forks: 31, priceSol: 0.00000042, bondingPercent: 12.5, graduated: false,
    indexedAt: new Date(NOW - 3_600_000).toISOString(), promoted: true, newRepo: false, officialLaunch: false, avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    language: 'Rust', updatedAt: '2026-09-30T00:00:00Z', githubCreatedAt: '2025-01-01T00:00:00Z' },
  { repoId: '1296269', source: 'github', mint: 'MintGithubNew', pool: 'PoolGithubNew', fullName: 'octocat/Hello-World', owner: 'octocat', name: 'Hello-World', description: null,
    symbol: 'HELLO', tokenName: 'Hello', wasVerified: false, volume24hLamports: '0', earned: '0', claimed: '0', remaining: '0', stars: 3, forks: 0, priceSol: null,
    indexedAt: new Date(NOW - 7_200_000).toISOString(), promoted: false, newRepo: true, officialLaunch: false,
    pulse: { badge: { status: 'today', text: '3 commits today', title: '3 commits in the last 24 hours' } } },
  { repoId: '1388219884', source: 'github', mint: 'MintGithubOfficial', pool: 'PoolGithubOfficial', fullName: 'New1Direction/repo.ing', owner: 'New1Direction', name: 'repo.ing',
    description: 'The market layer for open source', symbol: 'REPOING', tokenName: 'repo.ing', wasVerified: true, volume24hLamports: '900000000', earned: '7',
    claimed: '0', remaining: '7', stars: 40, forks: 2, priceSol: 0.000001, graduated: true, indexedAt: new Date(NOW - 86_400_000).toISOString(), promoted: true,
    newRepo: false, officialLaunch: true },
]
const [verified, fresh, official] = GITHUB
const STATS = { range: 'all', bucket: 'day', updatedAt: '2026-10-01T00:00:00.000Z',
  totals: { volume: '6000000000', earned: '670000000', paid: '380000000', trades: 3, markets: 3, graduated: 1 },
  days: [{ bucket: '2026-09-30T00:00:00.000Z', volume: '6000000000', earned: '670000000', paid: '380000000' }], payouts: [],
  builders: { earned: { outside: '170000000', team: '500000000' }, paid: { outside: '80000000', team: '300000000' } }, platform: { status: 'REVIEW' } }
// The /stats sections built from analytics data only (the receipts sections below them are fixed-data lists).
const statsSections = markup => markup.slice(markup.indexOf('<section class="analytics-hero"'), markup.indexOf('<section class="analytics-revenue"'))

function surfaces() {
  const racers = [{ repoId: verified.repoId, mint: verified.mint, fullName: verified.fullName, symbol: verified.symbol, progressPercent: 64.2,
    reserveLamports: '54570000000', thresholdLamports: '85000000000', remainingLamports: '30430000000', aboutToGraduate: true }]
  const receipt = { repoId: verified.repoId, status: 'settled', settledAt: '2026-09-30T00:00:00.000Z', claimSignature: 'ClaimSignature111', amountBaseUnits: '25000000' }
  return {
    'market-table': html(h(MarketTable, { markets: GITHUB, usdPerSol: 150 })),
    'market-table-empty': html(h(MarketTable, { markets: [], empty: 'No indexed markets yet.' })),
    'home-markets': html(h(HomeMarkets, { tabs: homeMarketTabs(GITHUB), usdPerSol: 150 })),
    'explore-list': html(h(ExploreList, { markets: GITHUB, usdPerSol: 150 })),
    'explore-list-filtered': html(h(ExploreList, { markets: GITHUB, usdPerSol: null }), { query: 'view=new&owner=verified' }),
    'more-markets': html(h(MoreMarkets, { markets: selectMoreMarkets(GITHUB, { now: NOW }) })),
    'more-markets-featured': html(h(MoreMarkets, { markets: selectMoreMarkets(GITHUB, { now: NOW }), featured: true })),
    'repo-identity': html(h(RepoIdentity, { repo: verified, heading: true }, h('span', null, 'ticker'))),
    'repo-identity-compact': html(h(RepoIdentity, { repo: fresh, compact: true })),
    // RepoStats formats with the default locale (toLocaleString / toLocaleDateString): values that read the same in any.
    'repo-stats': html(h(RepoStats, { repo: { ...verified, stars: 120, updatedAt: null }, detailed: true })),
    'github-link': html(h(GitHubLink, { repo: verified })) + html(h(GitHubLink, { repo: { ...verified, htmlUrl: 'https://github.com/New1Direction/Waternot' } })),
    'repo-avatar': [verified, { repoId: verified.repoId }, { avatarUrl: verified.avatarUrl }, {}].map(repo => html(h(RepoAvatar, { repo, size: 'large' }))).join('\n'),
    'trust-panel': html(h(TrustPanel, { market: verified })) + html(h(TrustPanel, { market: fresh, declined: { createdAt: '2026-09-01T00:00:00Z' } })),
    'graduation-race': html(h(GraduationRaceBoard, { markets: racers })),
    'share-market': html(h(ShareMarket, { mint: verified.mint, symbol: verified.symbol, fullName: verified.fullName, repoId: verified.repoId, more: h('a', { href: '#' }, 'More') })),
    'stats': statsSections(html(h(ProtocolAnalytics, { data: STATS, usdPerSol: 150 }))),
    'token-metadata': JSON.stringify([tokenMetadataJson({ mint: verified.mint, origin: 'https://repo.ing', market: { ...verified, name: 'Waternot', hasImage: false } }),
      tokenMetadataJson({ mint: verified.mint, origin: 'https://repo.ing', market: { repoId: verified.repoId, name: 'Waternot', symbol: 'WTR', hasImage: true, fullName: null } })]),
    'json-ld': JSON.stringify([tokenJsonLd(verified), tokenJsonLd(fresh)]),
    'share-text': JSON.stringify(['buy', 'sell', 'launch'].map(kind => shareText({ fullName: verified.fullName, symbol: verified.symbol, kind }))
      .concat(xShareUrl({ mint: verified.mint, fullName: verified.fullName, symbol: verified.symbol, kind: 'buy' }))),
    'blinks': JSON.stringify([buyAction(verified), sellAction(verified), buyAction(fresh, { tradingEnabled: false })]),
    'share-caption': payoutShare(verified, receipt, { status: 'settled', signature: receipt.claimSignature, amountBaseUnits: receipt.amountBaseUnits }).caption,
  }
}

test('flag off: GitHub markets render exactly as before Hugging Face markets on every shared surface', async () => {
  const current = surfaces()
  if (process.env.UPDATE_GITHUB_UI_SNAPSHOT === '1') await writeFile(SNAPSHOT, `${JSON.stringify(current, null, 1)}\n`)
  const expected = JSON.parse(await readFile(SNAPSHOT, 'utf8'))
  assert.deepEqual(Object.keys(current).sort(), Object.keys(expected).sort())
  for (const [name, markup] of Object.entries(expected)) assert.equal(current[name], markup, `${name} changed for GitHub markets`)
})
