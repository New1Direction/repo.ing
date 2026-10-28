import test from 'node:test'
import assert from 'node:assert/strict'
import { marketCategories } from '../app/lib/market-categories.mjs'
import { earningsBadge, badgeMarkdown } from '../app/lib/readme-badge.mjs'
import { emptyWatchlist, parseWatchlist, toggleWatched, applyPriceUpdates, priceChangeBps } from '../app/lib/watchlist.mjs'

const market = { repoId: '1148788086', mint: 'EMZx4nLuBLmqAmm1uKBZ8J2m1HckcyKrm5WquNA8xW8o', fullName: 'mattpocock/skills' }
const quote = (priceSol, event = 'signature:0') => ({ ...market, priceSol, event })

test('categories can overlap, do not use owner identity, and retain uncategorized projects', () => {
  assert.deepEqual(marketCategories({ fullName: 'AI/small', description: 'A simple photo gallery' }), ['other'])
  assert.deepEqual(marketCategories({ name: 'agent-cli', description: 'An editor for AI agents' }), ['ai', 'tools'])
  assert.deepEqual(marketCategories({ description: 'Database storage and monitoring' }), ['infra'])
  assert.deepEqual(marketCategories({ description: 'A game engine built in Godot' }), ['games'])
})

test('badge escapes repository text and keeps nonzero dust distinct from zero', () => {
  const svg = earningsBadge({ earned: '1', fullName: 'owner/<script>&"' })
  assert.ok(svg.includes('&lt;script&gt;&amp;&quot;'))
  assert.ok(svg.includes('&lt;0.0001 SOL'))
  assert.ok(!svg.includes('<script>'))
  assert.ok(earningsBadge({ earned: '0' }).includes('>0 SOL<'))
  assert.ok(earningsBadge({ unavailable: true }).includes('>unavailable<'))
  assert.equal(badgeMarkdown(market.repoId, market.mint), `[![Builder fees earned on repo.ing](https://repo.ing/api/badge/${market.repoId})](https://repo.ing/token/${market.mint})`)
  assert.throws(() => badgeMarkdown('12/../../x', market.mint))
  assert.throws(() => badgeMarkdown(market.repoId, 'javascript:bad'))
})

test('watchlist restores safely, deduplicates, and removes alert history on unwatch', () => {
  assert.deepEqual(parseWatchlist('{broken'), emptyWatchlist())
  assert.deepEqual(parseWatchlist('{"version":8,"items":[]}'), emptyWatchlist())
  let state = toggleWatched(emptyWatchlist(), market)
  state = { ...state, items: [...state.items, market, { ...market, repoId: '../bad' }], alertPercent: 42,
    prices: { [market.repoId]: '0.0000001', bad: '0.0000001' }, notifications: [{ id: 'old', repoId: 'bad', text: 'bad', at: 1, read: false }] }
  state = parseWatchlist(JSON.stringify(state))
  assert.equal(state.items.length, 1)
  assert.equal(state.alertPercent, 0)
  assert.deepEqual(Object.keys(state.prices), [market.repoId])
  assert.deepEqual(state.notifications, [])
  state = toggleWatched(state, market)
  assert.deepEqual(state.items, [])
  assert.deepEqual(state.prices, {})
  // A baseline saved as a sqrt price (before prices were stored per trade) is dropped, so the market re-seeds without an alert.
  const old = parseWatchlist(JSON.stringify({ version: 1, items: [market], alertPercent: 10, baselines: { [market.repoId]: '10000000000000000000' }, notifications: [] }))
  assert.deepEqual(old.prices, {})
  assert.equal('baselines' in old, false)
})

test('alerts seed without firing, compare exact price thresholds, and deduplicate replay', () => {
  let state = { ...toggleWatched(emptyWatchlist(), market), alertPercent: 10 }
  state = applyPriceUpdates(state, [quote('0.000000770513239952588184')], 1)
  assert.equal(state.notifications.length, 0)
  // 9.99…%: just under the threshold, compared exactly at the prices' full precision.
  state = applyPriceUpdates(state, [quote('0.000000847564563947847002', 'trade1:0')], 2)
  assert.equal(state.notifications.length, 0)
  state = applyPriceUpdates(state, [quote('0.00000084989611', 'trade2:0')], 3)
  assert.equal(state.notifications.length, 1)
  assert.match(state.notifications[0].text, /up 10.3%/)
  assert.equal(state.notifications[0].at, 3)
  state = applyPriceUpdates(state, [quote('0.00000084989611', 'trade2:0')], 4)
  assert.equal(state.notifications.length, 1)
  state = applyPriceUpdates(state, [quote('0.0000007', 'trade3:0')], 5)
  assert.equal(state.notifications.length, 2)
  assert.match(state.notifications[0].text, /down/)
  assert.equal(priceChangeBps('0.000000770513239952588184', '0.000000847564563947847002'), 999n)
  assert.equal(priceChangeBps('0.000000770513239952588184', '0.0000008475645639478470021'), 999n, 'scales differ: still exact')
  assert.equal(priceChangeBps('0.001', '0.0011'), 1000n)
})

test('disabled, malformed, unknown and wrong-mint updates never produce notifications', () => {
  const state = toggleWatched(emptyWatchlist(), market)
  assert.equal(applyPriceUpdates(state, [quote('0.0001')]), state)
  const enabled = { ...state, alertPercent: 25, prices: { [market.repoId]: '0.0001' } }
  const result = applyPriceUpdates(enabled, [quote('0'), quote('0.000'), quote('Infinity'), quote('-0.0005'), quote('5e-4'), quote(null),
    { ...quote('0.0005'), mint: 'wrong' }, { ...quote('0.0005'), repoId: '9' }])
  assert.equal(result.notifications.length, 0)
  assert.equal(result.prices[market.repoId], '0.0001')
  assert.equal(priceChangeBps('0', '2'), null)
})
