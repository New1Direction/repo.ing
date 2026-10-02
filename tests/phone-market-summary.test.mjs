import test from 'node:test'
import assert from 'node:assert/strict'
import { change24h, formatUsdPrice, phoneMarketSummary, sparklinePath, sparklinePoints, SPARKLINE_POINTS } from '../app/lib/phone-market-summary.mjs'
import { publishMarketSnapshot, readMarketSnapshot, subscribeMarketSnapshot } from '../app/lib/market-snapshot.mjs'

const NOW = 1_790_900_000, HOUR = 3600
const bar = (time, open, close = open, extra = {}) => ({ time, open, high: Math.max(open, close), low: Math.min(open, close), close, volumeLamports: '1', count: 1, ...extra })

test('24h change compares with the last close at or before 24h ago, else the first recorded price', () => {
  const candles = [bar(NOW - 30 * HOUR, 1e-8, 2e-8), bar(NOW - 25 * HOUR, 2e-8, 4e-8), bar(NOW - 2 * HOUR, 4e-8, 5e-8)]
  assert.ok(Math.abs(change24h(candles, HOUR, 6e-8, NOW) - 50) < 1e-9, 'from the 4e-8 close 25h ago')
  // A market younger than a day (or a window starting inside it) compares with its first price.
  assert.ok(Math.abs(change24h([bar(NOW - 3 * HOUR, 2e-8, 3e-8)], 300, 1e-8, NOW) + 50) < 1e-9)
  // Bars withheld for ordering evidence never count.
  assert.ok(Math.abs(change24h([bar(NOW - 26 * HOUR, 9, 9, { orderingPending: true }), bar(NOW - 25 * HOUR, 2, 4)], HOUR, 5, NOW) - 25) < 1e-9)
  assert.equal(change24h([], HOUR, 1, NOW), null)
  assert.equal(change24h(candles, HOUR, null, NOW), null)
})

test('the sparkline spans the last 24h from the close before it, thinned to a fixed size', () => {
  const candles = [bar(NOW - 48 * HOUR, 1), bar(NOW - 25 * HOUR, 1, 2), bar(NOW - 10 * HOUR, 2, 3), bar(NOW - HOUR, 3, 4)]
  assert.deepEqual(sparklinePoints(candles, HOUR, NOW), [2, 3, 4])
  assert.deepEqual(sparklinePoints([bar(NOW - 40 * HOUR, 5, 6)], HOUR, NOW), [6, 6], 'no trade in 24h: flat at the last price')
  const dense = Array.from({ length: 500 }, (_, i) => bar(NOW - 86_000 + i * 60, i + 1, i + 2))
  const points = sparklinePoints(dense, 60, NOW)
  assert.ok(points.length <= SPARKLINE_POINTS + 1 && points.length > SPARKLINE_POINTS / 2)
  assert.equal(points.at(-1), 501, 'always ends on the latest close')
  assert.deepEqual(sparklinePoints([], HOUR, NOW), [])
  assert.equal(sparklinePath([1], 96, 34), '')
  assert.equal(sparklinePath([1, 1], 96, 34), 'M2.0 17.0 L94.0 17.0')
  assert.equal(sparklinePath([1, 3], 100, 30), 'M2.0 28.0 L98.0 2.0')
})

test('summary: USD with a SOL price, SOL without one, server values until the chart loads', () => {
  const chart = { candles: [bar(NOW - 25 * HOUR, 2e-8, 2e-8), bar(NOW - HOUR, 2e-8, 3e-8)], interval: HOUR,
    latest: { priceSol: 3e-8 }, volume24hLamports: '12500000000', fetchedAt: new Date(NOW * 1000).toISOString() }
  const metrics = { solUsd: 150, supplyBaseUnits: '1000000000000000', supplyDecimals: 6 }
  const usd = phoneMarketSummary({ priceSol: 1e-8, volume24hLamports: '0', chart, metrics, now: NOW * 1000 })
  assert.deepEqual({ ...usd, change: Math.round(usd.change) }, { price: '$0.0000045', change: 50, marketCap: '$4.5k', volume: '$1.9k', spark: [2e-8, 3e-8] })
  const sol = phoneMarketSummary({ priceSol: 1e-8, volume24hLamports: '0', chart, metrics: null, now: NOW * 1000 })
  assert.deepEqual([sol.price, sol.marketCap, sol.volume], ['3.000e-8 SOL', '30 SOL', '12.5 SOL'], 'the chart headline\'s own SOL format')
  const server = phoneMarketSummary({ priceSol: 2.5e-8, volume24hLamports: '3000000000' })
  assert.deepEqual(server, { price: '2.500e-8 SOL', change: null, marketCap: '25 SOL', volume: '3 SOL', spark: [] })
  assert.deepEqual(phoneMarketSummary({}), { price: '—', change: null, marketCap: '—', volume: '—', spark: [] })
  assert.deepEqual([formatUsdPrice(1234.567), formatUsdPrice(0.012345), formatUsdPrice(0), formatUsdPrice(NaN)], ['$1,234.57', '$0.01235', '—', '—'])
})

test('chart snapshots reach subscribers for their mint only, merged with what was already published', () => {
  const scope = new EventTarget(), seen = []
  const stop = subscribeMarketSnapshot('mint-a', snapshot => seen.push(snapshot), scope)
  publishMarketSnapshot('mint-a', { metrics: { solUsd: 1 } }, scope)
  publishMarketSnapshot('mint-b', { metrics: { solUsd: 2 } }, scope)
  publishMarketSnapshot('mint-a', { latest: { priceSol: 3 } }, scope)
  stop()
  publishMarketSnapshot('mint-a', { latest: { priceSol: 4 } }, scope)
  assert.deepEqual(seen, [{ metrics: { solUsd: 1 } }, { metrics: { solUsd: 1 }, latest: { priceSol: 3 } }])
  assert.deepEqual(readMarketSnapshot('mint-a', scope), { metrics: { solUsd: 1 }, latest: { priceSol: 4 } })
  assert.equal(readMarketSnapshot('mint-c', scope), null)
})
