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
  assert.deepEqual(Object.keys(tabs.New[0]).sort(), ['claimed', 'description', 'earned', 'fullName', 'mint', 'remaining', 'repoId', 'stars', 'symbol', 'tokenName', 'volume24hLamports', 'wasVerified', 'priceSol', 'bondingPercent', 'graduated', 'pulse'].sort())
  assert.deepEqual(homeMarketTabs([]), { Trending: [], New: [] })
})
