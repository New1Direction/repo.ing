import test from 'node:test'
import assert from 'node:assert/strict'
import { chartSpotPrice, LIVE_TRADE_MAX_AGE_SECONDS, mergeLiveTrades, readLiveTrades } from '../src/market-chart.mjs'

const sqrt = 1n << 64n
const now = Date.parse('2026-10-05T03:00:30.000Z')
const minute = Date.parse('2026-10-05T03:00:00.000Z') / 1000
const finalized = (overrides = {}) => ({ range: '1h', start: new Date(now - 3600_000).toISOString(), end: new Date(now).toISOString(),
  interval: 60, intervalLabel: '1 minute',
  candles: [{ time: minute - 60, open: 0.001, high: 0.002, low: 0.001, close: 0.002, volumeLamports: '1000', count: 2 },
    { time: minute, open: 0.004, high: 0.004, low: 0.004, close: 0.004, volumeLamports: '500', count: 1 }],
  trades: [{ signature: 'final', eventIndex: 0, direction: 'buy', venue: 'DAMM', tradedAt: new Date(minute * 1000 + 5000).toISOString(),
    priceSol: 0.004, solLamports: '500', tokenBaseUnits: '7' }],
  volume24hLamports: '1500', totalTrades: 3, latest: null, latestOrderingPending: false, fetchedAt: new Date(now).toISOString(),
  source: 'finalized-dbc-and-damm-swaps', graduation: null, ...overrides })
const row = (signature, seconds, price, lamports, direction = 'buy') => ({ signature, eventIndex: 0, slot: '900', direction, venue: 'DAMM',
  tradedAt: new Date(minute * 1000 + seconds * 1000), nextSqrtPrice: (sqrt * price).toString(), solLamports: lamports, tokenBaseUnits: '3' })

test('a live trade in the newest finalized bucket keeps its open, extends its range and becomes the close and latest price', () => {
  const chart = mergeLiveTrades(finalized(), [row('live-1', 20, 3n, '250', 'sell'), row('live-2', 25, 1n, '50')], now)
  const bar = chart.candles.at(-1)
  assert.deepEqual(bar, { time: minute, open: 0.004, high: 0.009, low: 0.001, close: 0.001, volumeLamports: '800', count: 3, live: true })
  assert.deepEqual(chart.candles[0], finalized().candles[0], 'older buckets are untouched')
  assert.deepEqual(chart.trades.map(trade => [trade.signature, trade.pending ?? false]), [['final', false], ['live-1', true], ['live-2', true]])
  assert.deepEqual(chart.latest, { signature: 'live-2', eventIndex: 0, direction: 'buy', venue: 'DAMM', tradedAt: new Date(minute * 1000 + 25000).toISOString(),
    priceSol: chartSpotPrice(sqrt.toString()), solLamports: '50', tokenBaseUnits: '3', pending: true })
  assert.equal(chart.totalTrades, 5)
  assert.equal(chart.volume24hLamports, '1800')
  assert.deepEqual(chart.live, { trades: 2 })
  assert.equal(chart.latestOrderingPending, false)
  assert.equal(chart.source, 'finalized-dbc-and-damm-swaps+confirmed', 'the payload says it includes confirmed trades')
})

test('a swap that finalized between the chart\'s reads is counted once, as finalized', () => {
  const chart = mergeLiveTrades(finalized(), [{ ...row('final', 20, 3n, '500'), eventIndex: 0 }, row('live', 25, 1n, '50')], now)
  assert.deepEqual(chart.trades.map(trade => [trade.signature, trade.pending ?? false]), [['final', false], ['live', true]])
  assert.equal(chart.totalTrades, 4)
  assert.equal(chart.candles.at(-1).volumeLamports, '550')
  assert.deepEqual(chart.live, { trades: 1 })
  // Only already-finalized rows: the finalized chart, unchanged.
  const base = finalized()
  assert.equal(mergeLiveTrades(base, [{ ...row('final', 20, 3n, '500'), eventIndex: 0 }], now), base)
})

test('a live trade after the newest bucket opens a new live candle at its own price', () => {
  const chart = mergeLiveTrades(finalized(), [row('next', 70, 2n, '9')], now)
  assert.equal(chart.candles.length, 3)
  assert.deepEqual(chart.candles.at(-1), { time: minute + 60, open: 0.004, high: 0.004, low: 0.004, close: 0.004, volumeLamports: '9', count: 1, live: true })
})

test('a bucket withholding prices for unproven order keeps withholding them while live volume is added', () => {
  const pending = finalized({ candles: [{ time: minute, volumeLamports: '500', count: 2, orderingPending: true, priceEvidenceMissing: false }] })
  const chart = mergeLiveTrades(pending, [row('live', 20, 3n, '100')], now)
  assert.deepEqual(chart.candles, [{ time: minute, volumeLamports: '600', count: 3, orderingPending: true, priceEvidenceMissing: false, live: true }])
  assert.equal(chart.latest.signature, 'live', 'the live trade still gives the latest price')
})

test('the finalized chart is returned unchanged without readable live trades, and the trade list stays at 120', () => {
  const base = finalized()
  assert.equal(mergeLiveTrades(base, [], now), base)
  assert.equal(mergeLiveTrades(base, [{ ...row('zero', 20, 1n, '5'), nextSqrtPrice: '0' }], now), base)
  const full = finalized({ trades: Array.from({ length: 120 }, (_, i) => ({ ...base.trades[0], signature: `f${i}` })) })
  const merged = mergeLiveTrades(full, [row('newest', 20, 1n, '5')], now)
  assert.equal(merged.trades.length, 120)
  assert.equal(merged.trades.at(-1).signature, 'newest')
  assert.equal(merged.trades[0].signature, 'f1')
  // Volume older than a day is not counted as 24h volume (a live trade is minutes old, but the rule is the same as finalized).
  assert.equal(mergeLiveTrades(base, [row('live', 20, 1n, '5')], now + 2 * 86_400_000).volume24hLamports, '1500')
})

test('live trades are read for the canonical curve and verified DAMM pools from the newest finalized slot, and absent before 0057', async () => {
  const calls = []
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ signature: 'x' }] } } }
  const market = { repoId: '1388219884', pool: 'curve-pool' }
  assert.deepEqual(await readLiveTrades(db, market, { pool: 'damm-pool' }, '453444279'), [{ signature: 'x' }])
  assert.deepEqual(calls[0].params, ['1388219884', ['curve-pool', 'damm-pool'], '453444279', LIVE_TRADE_MAX_AGE_SECONDS])
  assert.match(calls[0].sql, /not exists \(select 1 from trade_events t where t\.signature = l\.signature and t\.event_index = l\.event_index\)/)
  assert.match(calls[0].sql, /not exists \(select 1 from damm_trade_events d where d\.signature = l\.signature and d\.event_index = l\.event_index\)/)
  await readLiveTrades(db, market, null, null)
  assert.deepEqual(calls[1].params.slice(1, 3), [['curve-pool'], '0'])
  assert.deepEqual(await readLiveTrades(db, { pool: 'no-repo-id' }, null, null), [])
  assert.equal(calls.length, 2)
  const missing = { query: async () => { throw Object.assign(Error('relation "live_trade_events" does not exist'), { code: '42P01' }) } }
  assert.deepEqual(await readLiveTrades(missing, market, null, '1'), [])
  const broken = { query: async () => { throw Object.assign(Error('timeout'), { code: '57014' }) } }
  await assert.rejects(readLiveTrades(broken, market, null, '1'), /timeout/)
})
