// The Hooks coin chart, trades and holders APIs: listed coins only, valid input only, rate-limited, and the trade index
// refreshed on demand (only when the chain has swaps the index lacks, at most every few seconds per coin, never waited
// on for long). No database or live RPC: stores and the index are fakes; holders read the canary's saved holdings.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoinActivityHandlers, createOnDemandIndexer, reportOnce } from '../app/lib/hooklab-coin-activity.mjs'
import { hookActivityRpc } from '../src/hooklab-coin-activity.mjs'
import { canary, canaryConnection } from './fixtures/hooklab-canary-trades.mjs'

const mint = canary.mint, pool = canary.pool, trader = 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9'
const market = { mint, name: 'Test Coin', symbol: 'TEST', decimals: 6, graduated: false, initialSupply: '1000000000000000', supply: '1000000000000000',
  pool: { swapCount: '2' } }
const trade = (swapCount, side) => ({ signature: `${'5'.repeat(87)}${swapCount}`, eventIndex: 10, side, trader, tradedAt: '2026-10-18T20:49:37.000Z',
  slot: '458573472', swapCount: String(swapCount), quoteAmount: '980295', baseAmount: '1112870787571', curveBase: '1125000000000000', curveQuote: '1000000001' })
function fakeStore({ indexed = 2n } = {}) {
  const calls = []
  return { calls, store: {
    async indexedSwapCount(p) { calls.push(['indexedSwapCount', p]); return indexed },
    async trades(p, options) { calls.push(['trades', p, options]); return { trades: [trade(2, 'sell'), trade(1, 'buy')].slice(0, options.limit), next: options.limit < 2 ? '2' : null } },
    async summary(p, options) { calls.push(['summary', p, options]); return { totalTrades: 2, volume24hLamports: '1980495', firstTradeAt: '2026-10-18T20:48:51.000Z',
      lastTradeAt: '2026-10-18T20:49:37.000Z', latest: { signature: 'x', swapCount: '2', tradedAt: '2026-10-18T20:49:37.000Z', curveBase: '1', curveQuote: '1', priceSol: 0.00000000089 } } },
    async candles(p, options) { calls.push(['candles', p, options]); return [{ time: 1792356300, open: 1, high: 2, low: 0.5, close: 1.5, volumeLamports: '1980495', count: 2 }] },
  } }
}
function setup({ listed = true, indexed = 2n, allowed = () => true, runtime, holdersTtlMs = 60_000 } = {}) {
  const db = fakeStore({ indexed }), ensured = [], rpcCalls = [], opened = []
  const service = runtime === undefined ? { market: async m => m === mint ? { market, wallet: null } : null, activity: hookActivityRpc(canaryConnection({ calls: rpcCalls })) } : runtime
  const handlers = createCoinActivityHandlers({ runtime: () => service, listed: async m => listed && m === mint ? { id: 'coin', name: 'Test Coin' } : null,
    openStore: () => { opened.push('open'); return { store: db.store, close: async () => opened.push('close') } },
    indexer: { ensure: async args => { ensured.push(args); return 'indexed' } }, allowed, holdersTtlMs })
  return { handlers, db, ensured, rpcCalls, opened }
}
const get = (handler, path, m = mint) => handler(new Request(`https://repo.ing/api/hook-lab/market/${m}/${path}`), { mint: m })

test('only listed Hooks coins with valid addresses, within the rate limit', async () => {
  const { handlers } = setup()
  for (const kind of ['trades', 'candles', 'holders']) {
    assert.equal((await get(handlers[kind], kind, 'not-a-mint')).status, 404)
    assert.equal((await get(handlers[kind], kind, `${mint}0`)).status, 404, 'not canonical base58')
    assert.equal((await get(handlers[kind], kind, '11111111111111111111111111111111')).status, 404, 'not listed')
    const unlisted = await get(setup({ listed: false }).handlers[kind], kind)
    assert.equal(unlisted.status, 404); assert.match((await unlisted.json()).error, /not listed/)
    assert.equal((await get(setup({ allowed: () => false }).handlers[kind], kind)).status, 429)
    assert.equal((await get(setup({ runtime: null }).handlers[kind], kind)).status, 503)
    assert.equal((await get(setup({ runtime: { market: async () => ({ market }) } }).handlers[kind], kind)).status, 503, 'no activity reads')
  }
  assert.equal((await get(handlers.trades, 'trades?before=abc')).status, 400)
  assert.equal((await get(handlers.trades, 'trades?limit=500')).status, 400)
  assert.equal((await get(handlers.candles, 'candles?interval=2m')).status, 400)
})

test('trades: newest first with a cursor for older pages; the index catches up first', async () => {
  const { handlers, db, ensured, opened } = setup({ indexed: 1n })
  const response = await get(handlers.trades, 'trades?limit=1')
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'public, max-age=5')
  const body = await response.json()
  assert.deepEqual(body, { status: 'available', decimals: 6, next: '2', syncing: 1, trades: [{ signature: trade(2).signature, eventIndex: 10, side: 'sell', trader,
    tradedAt: '2026-10-18T20:49:37.000Z', solLamports: '980295', tokenBaseUnits: '1112870787571', swapCount: '2' }] })
  assert.equal(ensured.length, 1)
  assert.deepEqual({ ...ensured[0], rpc: undefined }, { coin: { mint, pool }, rpc: undefined, chainSwapCount: 2n, indexedSwapCount: 1n })
  assert.deepEqual(db.calls.find(c => c[0] === 'trades'), ['trades', pool, { before: null, limit: 1 }])
  assert.deepEqual(opened, ['open', 'close'])
  const older = await get(handlers.trades, 'trades?before=2&limit=20')
  assert.equal(older.headers.get('cache-control'), 'public, max-age=60', 'an older page never changes')
  assert.deepEqual(db.calls.findLast(c => c[0] === 'trades'), ['trades', pool, { before: '2', limit: 20 }])
})

test('candles: one interval of SOL prices, with the volume and latest price', async () => {
  const { handlers, db } = setup()
  const body = await (await get(handlers.candles, 'candles?interval=5m')).json()
  assert.deepEqual(body, { status: 'available', interval: '5m', intervalSeconds: 300, decimals: 6, syncing: 0, totalTrades: 2, volume24hLamports: '1980495',
    firstTradeAt: '2026-10-18T20:48:51.000Z', lastTradeAt: '2026-10-18T20:49:37.000Z', latest: { priceSol: 0.00000000089, tradedAt: '2026-10-18T20:49:37.000Z' },
    candles: [{ time: 1792356300, open: 1, high: 2, low: 0.5, close: 1.5, volumeLamports: '1980495', count: 2 }] })
  assert.deepEqual(db.calls.find(c => c[0] === 'candles'), ['candles', pool, { seconds: 300, decimals: 6 }])
  assert.equal((await (await get(handlers.candles, 'candles')).json()).interval, '15m', 'defaults to 15 minutes')
})

test('holders: one token-program read per minute per coin, labelled, with each share of supply', async () => {
  const { handlers, rpcCalls } = setup({ holdersTtlMs: 60_000 })
  const response = await get(handlers.holders, 'holders')
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'public, max-age=30')
  const body = await response.json()
  assert.deepEqual([body.status, body.decimals, body.holderCount, body.supply], ['available', 6, 0, '1000000000000000'])
  assert.deepEqual(body.holders.map(h => [h.label, h.percent, h.rank]), [['Bonding curve', 75, null], ['Launch reserve', 25, null]])
  await get(handlers.holders, 'holders')
  assert.equal(rpcCalls.filter(c => c.method === 'getProgramAccounts').length, 1, 'cached for a minute')
})

test('the on-demand index runs only when the chain is ahead, once per coin at a time, and never holds a request long', async () => {
  let clock = 0, release
  const runs = [], closes = []
  const indexer = createOnDemandIndexer({ now: () => clock, minMs: 10_000, waitMs: 20, maxRunning: 1, onError: () => {},
    openStore: () => ({ store: 'db', close: async () => closes.push(clock) }),
    index: args => { runs.push(args); return new Promise(resolve => { release = resolve }) } })
  const coin = { mint, pool }, other = { mint: pool, pool: mint }
  assert.equal(await indexer.ensure({ coin, rpc: 'rpc', chainSwapCount: 2n, indexedSwapCount: 2n }), 'current')
  assert.equal(runs.length, 0, 'nothing new on chain: no RPC at all')
  assert.equal(await indexer.ensure({ coin, rpc: 'rpc', chainSwapCount: 3n, indexedSwapCount: 2n }), 'pending', 'a slow pass keeps running after the wait')
  assert.deepEqual(runs.map(r => [r.coin, r.store, r.rpc]), [[coin, 'db', 'rpc']])
  assert.equal(await indexer.ensure({ coin, rpc: 'rpc', chainSwapCount: 3n, indexedSwapCount: 2n }), 'pending', 'joins the pass in flight')
  assert.equal(await indexer.ensure({ coin: other, rpc: 'rpc', chainSwapCount: 3n, indexedSwapCount: 2n }), 'busy', 'bounded across coins')
  assert.equal(runs.length, 1)
  release({ status: 'indexed' }); await new Promise(r => setImmediate(r))
  assert.deepEqual(closes, [0], 'the pass closes its own database pool')
  clock = 5_000
  assert.equal(await indexer.ensure({ coin, rpc: 'rpc', chainSwapCount: 4n, indexedSwapCount: 3n }), 'recent')
  clock = 10_000
  const again = indexer.ensure({ coin, rpc: 'rpc', chainSwapCount: 4n, indexedSwapCount: 3n })
  release({ status: 'indexed' })
  assert.equal(await again, 'indexed'); assert.equal(runs.length, 2)
  // A failing pass is reported, and the coin waits out the interval before trying again.
  const errors = []
  const failing = createOnDemandIndexer({ now: () => 0, minMs: 10_000, waitMs: 50, onError: error => errors.push(error.code),
    openStore: () => ({ store: 'db', close: async () => {} }), index: async () => { throw Object.assign(Error('HOOK_TRADE_SLOT_MISMATCH'), { code: 'HOOK_TRADE_SLOT_MISMATCH' }) } })
  assert.equal(await failing.ensure({ coin, rpc: 'rpc', chainSwapCount: 2n, indexedSwapCount: 0n }), 'error')
  assert.deepEqual(errors, ['HOOK_TRADE_SLOT_MISMATCH'])
  assert.equal(await failing.ensure({ coin, rpc: 'rpc', chainSwapCount: 2n, indexedSwapCount: 0n }), 'recent')
})

test('a failing holders read answers 503 and is not retried for a few seconds', async () => {
  const calls = []
  const service = { market: async () => ({ market: { ...market, mint: pool } }), activity: { holdings: async () => { calls.push('gpa'); throw Error('provider refused') } } }
  const handlers = createCoinActivityHandlers({ runtime: () => service, listed: async () => ({ id: 'coin' }), openStore: () => { throw Error('no database needed') } })
  const read = () => handlers.holders(new Request(`https://repo.ing/api/hook-lab/market/${pool}/holders`), { mint: pool })
  assert.equal((await read()).status, 503); assert.equal((await read()).status, 503)
  assert.deepEqual(calls, ['gpa'])
})

test('failures are logged by code once a minute, a missing table by name', () => {
  // Later than anything earlier tests logged (the once-a-minute memory is per process).
  const lines = [], warn = console.warn, at = Date.now() + 3_600_000
  console.warn = line => lines.push(line)
  try {
    reportOnce(Object.assign(Error('relation does not exist'), { code: '42P01' }), at)
    reportOnce(Object.assign(Error('x'), { code: '42P01' }), at + 1_000)
    reportOnce(Object.assign(Error('HOOK_TRADE_SLOT_MISMATCH'), { code: 'HOOK_TRADE_SLOT_MISMATCH' }), at + 1_000)
    reportOnce(Error('https://secret.example/?api-key=1 failed'), at + 1_000)
  } finally { console.warn = warn }
  assert.deepEqual(lines.map(line => JSON.parse(line).hookCoinActivityError.code), ['HOOK_TRADES_NOT_MIGRATED', 'HOOK_TRADE_SLOT_MISMATCH', 'UNAVAILABLE'])
})
