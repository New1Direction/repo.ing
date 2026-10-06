import test from 'node:test'
import assert from 'node:assert/strict'
import { HOME_MARKET_LIMIT, homeMarketTabs, orderMarkets } from '../app/lib/market-order.mjs'

const market = (i, volume) => ({ repoId: String(i), mint: `mint${i}`, fullName: `o/r${i}`, description: 'd', symbol: `S${i}`, tokenName: `T${i}`,
  wasVerified: i % 2 === 0, volume24hLamports: String(volume), earned: '10', claimed: '4', remaining: '6', stars: i,
  indexedAt: new Date(Date.UTC(2026, 0, 1, 0, i)), pool: `pool${i}`, launcherWallet: 'w', beneficiaryWallet: 'b', avatarUrl: 'https://avatars.githubusercontent.com/u/1', forks: 1 })

test('home tabs match the client ordering, top 5 only, with only rendered fields', () => {
  const markets = Array.from({ length: 41 }, (_, i) => market(i, (i * 7919) % 13))
  const tabs = homeMarketTabs(markets)
  for (const tab of ['Trending', 'New']) {
    assert.equal(tabs[tab].length, HOME_MARKET_LIMIT)
    assert.deepEqual(tabs[tab].map(m => m.mint), orderMarkets(markets, tab).slice(0, 5).map(m => m.mint))
  }
  assert.notDeepEqual(tabs.Trending.map(m => m.mint), tabs.New.map(m => m.mint))
  assert.deepEqual(Object.keys(tabs.New[0]).sort(), ['claimed', 'description', 'earned', 'fullName', 'mint', 'remaining', 'repoId', 'stars', 'symbol', 'tokenName', 'volume24hLamports', 'wasVerified', 'priceSol', 'bondingPercent', 'graduated', 'pulse', 'newRepo', 'officialLaunch'].sort())
  assert.deepEqual(homeMarketTabs([]), { Trending: [], 'Market cap': [], New: [] })
})

test('the Market cap tab ranks by last trade price × supply in USD, SOL rows and stock pairs together; no trade goes last', () => {
  const at = new Date('2026-10-01T00:00:00Z')
  const row = (mint, extra) => ({ repoId: mint, mint, fullName: `o/${mint}`, symbol: mint, indexedAt: at, volume24hLamports: '0', ...extra })
  // busy has more volume, valuable the higher price: Trending and Market cap disagree.
  const busy = row('busy', { priceSol: 0.0000000348, volume24hLamports: '63080000000' })
  const valuable = row('valuable', { priceSol: 0.0000000398, volume24hLamports: '14070000000' })
  const untraded = row('untraded', { priceSol: null })
  // A stock pair: 2e-8 METAx per token at $700 per METAx = $14,000 cap, above both SOL rows at $120 per SOL.
  const stock = row('stock', { priceSol: null, stock: { symbol: 'METAx', decimals: 8, uiMultiplier: 1, usdPrice: 700, price: 0.00000002 } })
  const hidden = row('hidden', { priceSol: 0.001, promoted: false })
  const markets = [untraded, busy, valuable, stock, hidden]
  assert.deepEqual(orderMarkets(markets, 'Market cap', { usdPerSol: 120 }).map(m => m.mint), ['stock', 'valuable', 'busy', 'untraded', 'hidden'],
    'by cap; a new repo under its promotion mark still comes last')
  assert.deepEqual(orderMarkets(markets, 'Trending').map(m => m.mint).slice(0, 2), ['busy', 'valuable'], 'Trending is unchanged: 24h volume')
  // Without a SOL price, SOL rows still rank among themselves; a stock pair has no comparable figure and goes last.
  assert.deepEqual(orderMarkets([stock, busy, valuable], 'Market cap').map(m => m.mint), ['valuable', 'busy', 'stock'])
  const tabs = homeMarketTabs(markets, { usdPerSol: 120 })
  assert.deepEqual(tabs['Market cap'].map(m => m.mint), ['hidden', 'stock', 'valuable', 'busy'],
    'the home tab lists traded markets only, a new repo under its mark in its real place')
})

test('home tabs show a new repository under its promotion mark in its real place; Explore still puts it last', () => {
  const at = new Date('2026-10-06T00:00:00Z')
  const row = (mint, volume, price, extra = {}) => ({ repoId: mint, mint, fullName: `o/${mint}`, symbol: mint, indexedAt: at,
    volume24hLamports: String(volume), priceSol: price, ...extra })
  const big = row('big', 60e9, 0.00000004), fresh = row('fresh', 14e9, 0.000000035, { promoted: false, newRepo: true }), small = row('small', 1e9, 0.00000003)
  const tabs = homeMarketTabs([small, fresh, big], { usdPerSol: 120 })
  assert.deepEqual(tabs.Trending.map(m => m.mint), ['big', 'fresh', 'small'], 'by 24h volume, the new repo included')
  assert.deepEqual(tabs['Market cap'].map(m => m.mint), ['big', 'fresh', 'small'], 'by market cap, the new repo included')
  assert.equal(tabs.Trending.find(m => m.mint === 'fresh').newRepo, true, 'its row keeps the "New repo" label')
  assert.deepEqual(orderMarkets([small, fresh, big], 'Trending').map(m => m.mint), ['big', 'small', 'fresh'], 'Explore keeps the promotion rule')
})
