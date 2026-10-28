import test from 'node:test'
import assert from 'node:assert/strict'
import { exploreHookCoins, hookCoinRow } from '../app/lib/hooklab-explore.mjs'
import { hookCoinView, orderHookCoins } from '../app/lib/hooklab-explore-order.mjs'

const env = { HOOK_OPEN_LAUNCHES: 'true', HOOK_LAUNCH_ADMIN_ADDRESS: 'admin' }
const coin = (mint, stats = null) => ({ mint, name: mint, symbol: mint.toUpperCase(), stats })
const stats = (volume24hLamports, priceSol, totalTrades = 1) => ({ volume24hLamports, priceSol, totalTrades, lastTradeAt: '2026-10-27T00:00:00.000Z' })

test('trending orders by 24h volume, then trade count; coins without trades keep their place at the end', () => {
  const coins = [coin('a'), coin('b', stats('10', 1e-6, 3)), coin('c', stats('900', 2e-6)), coin('d', stats('10', 1e-6, 9))]
  assert.deepEqual(orderHookCoins(coins).map(c => c.mint), ['c', 'd', 'b', 'a'])
  assert.deepEqual(orderHookCoins(coins, 'mcap').map(c => c.mint), ['c', 'b', 'd', 'a'])
  assert.deepEqual(orderHookCoins(coins, 'new').map(c => c.mint), ['a', 'b', 'c', 'd'])
  assert.deepEqual(coins.map(c => c.mint), ['a', 'b', 'c', 'd'], 'the input is not reordered')
})

test('an unknown view reads as trending', () => {
  assert.equal(hookCoinView('mcap'), 'mcap'); assert.equal(hookCoinView('watchlist'), 'trending'); assert.equal(hookCoinView(null), 'trending')
})

const fakeDatabase = () => { const pool = { ended: false, end: async () => { pool.ended = true } }; return pool }
const listing = coins => () => ({ launchedCoins: async limit => { assert.equal(limit, 100); return coins } })
let clock = 0
const later = () => (clock += 60_000)

test('each listed coin carries its trade figures, or null before its first indexed trade', async () => {
  let pool
  const coins = await exploreHookCoins({ env, configuration: () => ({}), now: later, database: () => (pool = fakeDatabase()), store: listing([coin('m1'), coin('m2')]),
    trades: () => ({ overview: async mints => { assert.deepEqual(mints, ['m1', 'm2']); return new Map([['m1', stats('5', 1e-6)]]) } }) })
  assert.deepEqual(coins.map(c => [c.mint, c.stats?.volume24hLamports ?? null]), [['m1', '5'], ['m2', null]])
  assert.equal(pool.ended, true)
})

test('a failed trade read keeps the list without figures; a failed listing read gives none', async () => {
  const noTrades = await exploreHookCoins({ env, configuration: () => ({}), now: later, database: fakeDatabase, store: listing([coin('m1')]),
    trades: () => ({ overview: async () => { throw new Error('down') } }) })
  assert.deepEqual(noTrades.map(c => [c.mint, c.stats]), [['m1', null]])
  const none = await exploreHookCoins({ env, configuration: () => ({}), now: later, database: fakeDatabase, store: () => ({ launchedCoins: async () => { throw new Error('down') } }) })
  assert.deepEqual(none, [])
})

test('nothing is read while site launches are off', async () => {
  assert.deepEqual(await exploreHookCoins({ env: {}, database: () => assert.fail('no database read') }), [])
})

test('a row names the coin, its image only when it has a profile, and its rules with the full fee', () => {
  const base = { id: 'r1', mint: 'm1', name: 'Smoke', symbol: 'SMK', capBps: 200, creatorFeeBps: 200, burnBps: 300, stats: null }
  assert.deepEqual(hookCoinRow({ ...base, profile: null }), { mint: 'm1', name: 'Smoke', symbol: 'SMK', image: null,
    rules: 'Max 2% per wallet · 5% total fee (2% creator + 3% burn)', stats: null, capBps: 200, creatorFeeBps: 200, burnBps: 300, holderBps: 0 })
  assert.match(hookCoinRow({ ...base, profile: {} }).image, /r1\/image\?w=128$/)
  assert.equal(hookCoinRow({ ...base, burnBps: 0, profile: null }).rules, 'Max 2% per wallet · 2% creator fee')
})
