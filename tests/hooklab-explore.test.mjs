import test from 'node:test'
import assert from 'node:assert/strict'
import { exploreHookCoins, hiddenHookCoinMints, hookCoinRow, INTERNAL_TEST_COIN_MINTS } from '../app/lib/hooklab-explore.mjs'
import { hookCoinView, orderHookCoins } from '../app/lib/hooklab-explore-order.mjs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

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

test("repo.ing's own smoke-test coins never list publicly; HOOK_COINS_HIDDEN_MINTS adds more", async () => {
  const [smoke, burnSmoke] = INTERNAL_TEST_COIN_MINTS
  const coins = await exploreHookCoins({ env: { ...env, HOOK_COINS_HIDDEN_MINTS: ' m3 ,' }, configuration: () => ({}), now: later, database: fakeDatabase,
    store: listing([coin(smoke), coin('m1'), coin(burnSmoke), coin('m3')]), trades: () => ({ overview: async mints => { assert.deepEqual(mints, ['m1']); return new Map() } }) })
  assert.deepEqual(coins.map(c => c.mint), ['m1'])
  assert.deepEqual([...hiddenHookCoinMints({})], INTERNAL_TEST_COIN_MINTS)
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

test('the Explore strip lists only coins that traded in the last 24 hours, with their market cap, and is absent otherwise', async () => {
  const { HookCoinStrip } = await appModule('app/components/hooks-explore.jsx')
  const quiet = [coin('a'), coin('b', stats('0', 1e-7, 4)), coin('c', stats('5000', 1e-7))]
  assert.equal(html(h(HookCoinStrip, { coins: quiet, usdPerSol: 100 })), '')
  const markup = html(h(HookCoinStrip, { coins: [...quiet, coin('d', stats('2500000000', 3e-8))], usdPerSol: 100 }))
  assert.match(markup, /\$D<\/strong>/)
  assert.doesNotMatch(markup, /\$[ABC]<\/strong>/)
  assert.match(markup, /<span class="table-mcap"[^>]*>\$3k<\/span><small>2\.5 SOL 24h<\/small>/, 'cap = last price × 1B supply')
  assert.match(markup, /See all 4/)
})
