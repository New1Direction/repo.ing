import test from 'node:test'
import assert from 'node:assert/strict'
import { marketCategories } from '../app/lib/market-categories.mjs'
import { earningsBadge, badgeMarkdown } from '../app/lib/readme-badge.mjs'
import { emptyWatchlist, parseWatchlist, toggleWatched, applyPriceUpdates, priceChangeBps } from '../app/lib/watchlist.mjs'

const market = { repoId: '1148788086', mint: 'EMZx4nLuBLmqAmm1uKBZ8J2m1HckcyKrm5WquNA8xW8o', fullName: 'mattpocock/skills' }
const quote = (sqrtPrice, event = 'signature:0') => ({ ...market, sqrtPrice, event })

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
    baselines: { [market.repoId]: '10', bad: '10' }, notifications: [{ id: 'old', repoId: 'bad', text: 'bad', at: 1, read: false }] }
  state = parseWatchlist(JSON.stringify(state))
  assert.equal(state.items.length, 1)
  assert.equal(state.alertPercent, 0)
  assert.deepEqual(Object.keys(state.baselines), [market.repoId])
  assert.deepEqual(state.notifications, [])
  state = toggleWatched(state, market)
  assert.deepEqual(state.items, [])
  assert.deepEqual(state.baselines, {})
})

test('alerts seed without firing, compare exact price thresholds, and deduplicate replay', () => {
  let state = { ...toggleWatched(emptyWatchlist(), market), alertPercent: 10 }
  state = applyPriceUpdates(state, [quote('10000000000000000000')], 1)
  assert.equal(state.notifications.length, 0)
  // The sqrt ratio is squared: a 4% sqrt move is only an 8.16% price move.
  state = applyPriceUpdates(state, [quote('10400000000000000000', 'trade1:0')], 2)
  assert.equal(state.notifications.length, 0)
  state = applyPriceUpdates(state, [quote('10500000000000000000', 'trade2:0')], 3)
  assert.equal(state.notifications.length, 1)
  assert.match(state.notifications[0].text, /up 10.3%/)
  assert.equal(state.notifications[0].at, 3)
  state = applyPriceUpdates(state, [quote('10500000000000000000', 'trade2:0')], 4)
  assert.equal(state.notifications.length, 1)
  state = applyPriceUpdates(state, [quote('9900000000000000000', 'trade3:0')], 5)
  assert.equal(state.notifications.length, 2)
  assert.match(state.notifications[0].text, /down/)
  assert.equal(priceChangeBps('10000000000000000000', '10488088481701515469'), 999n)
})

test('disabled, malformed, unknown and wrong-mint updates never produce notifications', () => {
  const state = toggleWatched(emptyWatchlist(), market)
  assert.equal(applyPriceUpdates(state, [quote('100')]), state)
  const enabled = { ...state, alertPercent: 25, baselines: { [market.repoId]: '100' } }
  const result = applyPriceUpdates(enabled, [quote('0'), quote('Infinity'), { ...quote('500'), mint: 'wrong' }, { ...quote('500'), repoId: '9' }])
  assert.equal(result.notifications.length, 0)
  assert.equal(result.baselines[market.repoId], '100')
  assert.equal(priceChangeBps('0', '2'), null)
})
