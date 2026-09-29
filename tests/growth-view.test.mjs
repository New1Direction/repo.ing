import test from 'node:test'
import assert from 'node:assert/strict'
import { exploreGrowthView } from '../app/lib/growth-view.mjs'

test('explore highlights keep displayed lists and drop candidates and discoverer market details', () => {
  const leader = n => ({ wallet: `w${n}`, earned: '1', volume: '2', launched: 1, graduated: 0, markets: [{ repoId: '1', signature: 'x' }] })
  const growth = { checkedAt: 't', candidates: [{ score: {} }], newMarkets: [1], closest: [2], earners: [3], leaderboardPartial: false,
    leaders: [leader(1), leader(2), leader(3), leader(4)] }
  const view = exploreGrowthView(growth)
  assert.equal('candidates' in view, false)
  assert.deepEqual(view.leaders.map(l => l.wallet), ['w1', 'w2', 'w3'])
  assert.equal(view.leaders.some(l => 'markets' in l), false)
  assert.deepEqual([view.newMarkets, view.closest, view.earners], [[1], [2], [3]])
})
