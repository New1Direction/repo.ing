// The Hooks coin trade index against a disposable database with exactly the production schema, reading the canary's
// real mainnet history from read-only fixtures. No live RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { MIGRATIONS, migrationSchema, productionSchema } from '../scripts/hooklab-production-schema.mjs'
import { hookCoinTradeStore, indexHookCoinTrades } from '../src/hooklab-coin-trades.mjs'
import { hookActivityRpc } from '../src/hooklab-coin-activity.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { createCoinActivityHandlers, createOnDemandIndexer } from '../app/lib/hooklab-coin-activity.mjs'
import { CANARY_BUY, CANARY_CLAIM, CANARY_LAUNCH, CANARY_SELL, canary, canaryConnection, clone } from './fixtures/hooklab-canary-trades.mjs'

const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
const coin = { mint: canary.mint, pool: canary.pool }
async function withDatabase(work) {
  const root = new pg.Pool(config), name = `coin_trades_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await root.query(`create database ${name}`); pool = new pg.Pool({ ...config, database: name })
    await pool.query(productionSchema().sql)
    for (const migration of Object.keys(MIGRATIONS)) await pool.query(migrationSchema(migration).sql)
    await work(pool)
  } finally { await pool?.end(); await dropTestDatabase(root, name); await root.end() }
}
const rpcWith = (options = {}) => { const calls = []; return { calls, rpc: hookActivityRpc(canaryConnection({ ...options, calls })) } }
const methods = calls => calls.map(call => call.method)

test('indexes the canary from its launch, oldest first, then reads only what is new', () => withDatabase(async pool => {
  const store = hookCoinTradeStore(pool), { rpc, calls } = rpcWith()
  assert.equal(await store.indexedSwapCount(coin.pool), 0n)
  assert.deepEqual(await indexHookCoinTrades({ rpc, store, coin }), { status: 'indexed', transactions: 4, trades: 2, remaining: 0 })
  assert.deepEqual(methods(calls), ['getSignaturesForAddress', 'getTransaction', 'getTransaction', 'getTransaction', 'getTransaction'])
  assert.deepEqual(calls.slice(1).map(call => call.params[0]), [CANARY_LAUNCH, CANARY_BUY, CANARY_SELL, CANARY_CLAIM], 'oldest first')
  assert.equal(calls[0].params[1].commitment, 'finalized'); assert.equal(calls[1].params[1].commitment, 'finalized')
  assert.deepEqual(await store.cursor(coin.pool), { mint: coin.mint, signature: CANARY_CLAIM, slot: 458573623 })
  assert.equal(await store.indexedSwapCount(coin.pool), 2n)
  // Caught up: one signature read from the cursor, no transaction reads, nothing inserted.
  calls.length = 0
  assert.deepEqual(await indexHookCoinTrades({ rpc, store, coin }), { status: 'current', transactions: 0, trades: 0, remaining: 0 })
  assert.deepEqual(methods(calls), ['getSignaturesForAddress']); assert.equal(calls[0].params[1].until, CANARY_CLAIM)
}))

test('trades read newest first, one page at a time', () => withDatabase(async pool => {
  const store = hookCoinTradeStore(pool)
  await indexHookCoinTrades({ rpc: rpcWith().rpc, store, coin })
  const all = await store.trades(coin.pool, { limit: 20 })
  assert.equal(all.next, null)
  assert.deepEqual(all.trades.map(t => [t.signature, t.side, t.swapCount, t.quoteAmount, t.baseAmount, t.trader]), [
    [CANARY_SELL, 'sell', '2', '980295', '1112870787571', 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9'],
    [CANARY_BUY, 'buy', '1', '1000200', '1112870787571', 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9']])
  assert.equal(all.trades[0].tradedAt, '2026-10-18T20:49:37.000Z'); assert.equal(all.trades[0].eventIndex, 10); assert.equal(all.trades[0].slot, '458573472')
  const first = await store.trades(coin.pool, { limit: 1 })
  assert.deepEqual([first.trades.map(t => t.swapCount), first.next], [['2'], '2'])
  const second = await store.trades(coin.pool, { limit: 1, before: first.next })
  assert.deepEqual([second.trades.map(t => t.swapCount), second.next], [['1'], null])
  assert.deepEqual(await store.trades('11111111111111111111111111111111', { limit: 5 }), { trades: [], next: null })
}))

test('a small budget walks forward a few transactions at a time to the same result', () => withDatabase(async pool => {
  const store = hookCoinTradeStore(pool), { rpc } = rpcWith()
  assert.deepEqual(await indexHookCoinTrades({ rpc, store, coin, maxTransactions: 1 }), { status: 'indexed', transactions: 1, trades: 0, remaining: 3 })
  assert.equal((await store.cursor(coin.pool)).signature, CANARY_LAUNCH)
  assert.deepEqual(await indexHookCoinTrades({ rpc, store, coin, maxTransactions: 2 }), { status: 'indexed', transactions: 2, trades: 2, remaining: 1 })
  assert.deepEqual(await indexHookCoinTrades({ rpc, store, coin, maxTransactions: 2 }), { status: 'indexed', transactions: 1, trades: 0, remaining: 0 })
  assert.equal((await pool.query('select count(*)::int n from hook_lab_coin_trades')).rows[0].n, 2)
}))

test('replaying history never stores a trade twice', () => withDatabase(async pool => {
  const store = hookCoinTradeStore(pool)
  await indexHookCoinTrades({ rpc: rpcWith().rpc, store, coin })
  await pool.query('delete from hook_lab_coin_trade_cursors')
  assert.deepEqual(await indexHookCoinTrades({ rpc: rpcWith().rpc, store, coin }), { status: 'indexed', transactions: 4, trades: 0, remaining: 0 })
  assert.equal((await pool.query('select count(*)::int n from hook_lab_coin_trades')).rows[0].n, 2)
}))

test('RPC answers that disagree stop the run before the cursor passes them', () => withDatabase(async pool => {
  const store = hookCoinTradeStore(pool)
  const moved = clone(canary.transactions[CANARY_BUY]); moved.slot += 5
  await assert.rejects(indexHookCoinTrades({ rpc: rpcWith({ transactions: { ...canary.transactions, [CANARY_BUY]: moved } }).rpc, store, coin }), /HOOK_TRADE_SLOT_MISMATCH/)
  assert.equal((await store.cursor(coin.pool)).signature, CANARY_LAUNCH, 'stopped before the disagreeing swap')
  await assert.rejects(indexHookCoinTrades({ rpc: rpcWith({ transactions: { ...canary.transactions, [CANARY_BUY]: null } }).rpc, store, coin }), /HOOK_TRADE_TRANSACTION_MISSING/)
  await pool.query('delete from hook_lab_coin_trade_cursors')
  const shuffled = [canary.signatures[1], canary.signatures[0], ...canary.signatures.slice(2)]
  await assert.rejects(indexHookCoinTrades({ rpc: rpcWith({ signatures: shuffled }).rpc, store, coin }), /HOOK_TRADE_HISTORY_ORDER/)
  const forged = canary.signatures.map((item, i) => i ? item : { ...item, signature: 'not-a-signature' })
  await assert.rejects(indexHookCoinTrades({ rpc: rpcWith({ signatures: forged }).rpc, store, coin }), /HOOK_TRADE_HISTORY_INVALID/)
  assert.equal((await pool.query('select count(*)::int n from hook_lab_coin_trades')).rows[0].n, 0)
}))

test('a cursor another run moved stops this run without writing', () => withDatabase(async pool => {
  const store = hookCoinTradeStore(pool)
  await indexHookCoinTrades({ rpc: rpcWith().rpc, store, coin, maxTransactions: 1 })
  const [trade] = (await store.trades(coin.pool, { limit: 1 })).trades
  assert.equal(trade, undefined)
  await assert.rejects(store.record({ ...coin, previous: null, signature: CANARY_BUY, slot: 458573264, trades: [] }), /HOOK_TRADE_CURSOR_MOVED/)
  await assert.rejects(store.record({ ...coin, previous: CANARY_SELL, signature: CANARY_BUY, slot: 458573264, trades: [] }), /HOOK_TRADE_CURSOR_MOVED/)
  assert.equal((await store.cursor(coin.pool)).signature, CANARY_LAUNCH)
}))

test('candles: open and close follow the swap counter; volume is the SOL traders paid and received', () => withDatabase(async pool => {
  const store = hookCoinTradeStore(pool)
  await indexHookCoinTrades({ rpc: rpcWith().rpc, store, coin })
  const buyPrice = 1000990198 / 1123887129212429 * 1e6 / 1e9, sellPrice = 1000000001 / 1125000000000000 * 1e6 / 1e9
  const [bar, ...rest] = await store.candles(coin.pool, { seconds: 300, decimals: 6 })
  assert.equal(rest.length, 0)
  assert.equal(bar.time, 1792356300); assert.equal(bar.count, 2); assert.equal(bar.volumeLamports, '1980495')
  for (const [key, expected] of [['open', buyPrice], ['high', buyPrice], ['low', sellPrice], ['close', sellPrice]]) {
    assert.ok(Math.abs(bar[key] / expected - 1) < 1e-12, `${key} ${bar[key]} vs ${expected}`)
  }
  assert.deepEqual((await store.candles(coin.pool, { seconds: 60, decimals: 6 })).map(b => [b.time, b.count, b.volumeLamports]),
    [[1792356480, 1, '1000200'], [1792356540, 1, '980295']])
  // The window ends at the last trade, at most `bars` intervals long.
  assert.deepEqual((await store.candles(coin.pool, { seconds: 60, decimals: 6, bars: 1 })).map(b => b.time), [1792356540])
  const summary = await store.summary(coin.pool, { now: Date.parse('2026-10-19T12:00:00Z') })
  assert.deepEqual({ ...summary, latest: { ...summary.latest, priceSol: undefined } }, { totalTrades: 2, volume24hLamports: '1980495',
    firstTradeAt: '2026-10-18T20:48:51.000Z', lastTradeAt: '2026-10-18T20:49:37.000Z',
    latest: { signature: CANARY_SELL, swapCount: '2', tradedAt: '2026-10-18T20:49:37.000Z', curveBase: '1125000000000000', curveQuote: '1000000001', priceSol: undefined } })
  assert.equal((await store.summary(coin.pool, { now: Date.parse('2026-10-20T12:00:00Z') })).volume24hLamports, '0')
  assert.deepEqual(await store.candles('11111111111111111111111111111111', { seconds: 60, decimals: 6 }), [])
}))

test('the table refuses rows a decoder could never produce', () => withDatabase(async pool => {
  const row = ['x'.repeat(64), 0, 'Swapped', 'bridged-sol', coin.pool, coin.mint, 1, new Date(), '1', 'buy', coin.mint, '1', '1', '0', '1', '1']
  const insert = values => pool.query(`insert into hook_lab_coin_trades(signature,event_index,event,quote_asset,pool,mint,slot,traded_at,swap_count,side,trader,
    quote_amount,base_amount,quote_fee,curve_base,curve_quote) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, values)
  await insert(row)
  await assert.rejects(insert(row.map((v, i) => i === 0 ? 'y'.repeat(64) : v)), /hook_lab_coin_trades_pool_swap_count_key/, 'one row per swap counter')
  await assert.rejects(insert(row.map((v, i) => i === 0 ? 'z'.repeat(64) : i === 9 ? 'hold' : i === 8 ? '2' : v)), /check/)
  await assert.rejects(insert(row.map((v, i) => i === 0 ? 'z'.repeat(64) : i === 2 ? 'Minted' : i === 8 ? '2' : v)), /check/)
}))

test('end to end: the first chart read indexes the coin, later reads cost no RPC until the chain moves', () => withDatabase(async pool => {
  const calls = [], openStore = () => ({ store: hookCoinTradeStore(pool), close: async () => {} })
  let swapCount = '2'
  const service = { market: async () => ({ market: { mint: coin.mint, symbol: 'HLCANARY', decimals: 6, graduated: false, initialSupply: '1000000000000000',
    supply: '1000000000000000', pool: { swapCount } }, wallet: null }), activity: hookActivityRpc(canaryConnection({ calls })) }
  const handlers = createCoinActivityHandlers({ runtime: () => service, listed: async () => ({ id: 'listed' }), openStore,
    indexer: createOnDemandIndexer({ openStore, minMs: 0, waitMs: 5_000 }) })
  const get = async path => (await handlers[path.split('?')[0]](new Request(`https://repo.ing/api/hook-lab/market/${coin.mint}/${path}`), { mint: coin.mint })).json()
  const candles = await get('candles?interval=5m')
  assert.deepEqual([candles.totalTrades, candles.syncing, candles.candles.length, candles.candles[0].count, candles.volume24hLamports], [2, 0, 1, 2, '1980495'])
  assert.equal(methods(calls).filter(m => m === 'getTransaction').length, 4)
  const trades = await get('trades')
  assert.deepEqual(trades.trades.map(t => [t.side, t.solLamports]), [['sell', '980295'], ['buy', '1000200']])
  assert.equal(calls.length, 5, 'the trades read cost no RPC: the index already matched the chain')
  swapCount = '3'
  // The market cache (3 s) still says 2 for this coin; once it reads 3, a pass finds nothing finalized yet and says so.
  await new Promise(resolve => setTimeout(resolve, 3_100))
  const ahead = await get('trades')
  assert.equal(ahead.syncing, 1); assert.deepEqual(methods(calls.slice(5)), ['getSignaturesForAddress'])
}))
