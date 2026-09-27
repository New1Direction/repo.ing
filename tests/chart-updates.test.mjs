import test from 'node:test'
import assert from 'node:assert/strict'
import { chartUpdatePlan, chartInitialRange, chartTradeAge, chartSeries } from '../app/lib/chart-display.mjs'

const bar = (time, value) => ({ time, value })
test('unchanged polling does no chart writes; new trades only update the tail', () => {
  const previous = [bar(60, 1), bar(120, 2)]
  assert.deepEqual(chartUpdatePlan(previous, structuredClone(previous)), { reset: false, bars: [] })
  assert.deepEqual(chartUpdatePlan(previous, [bar(60, 1), bar(120, 3), bar(180, 4)]), { reset: false, bars: [bar(120, 3), bar(180, 4)] })
  assert.deepEqual(chartUpdatePlan(previous, [...previous, bar(180, 4)]).bars, [bar(180, 4)])
})
test('historical correction, rolling period, changed units and revoked evidence replace history', () => {
  const previous = [bar(60, 1), bar(120, 2), bar(180, 3)]
  for (const next of [[bar(60, 9), ...previous.slice(1)], previous.slice(1), [bar(120, 2), bar(180, 3), bar(240, 4)], previous.map(b => bar(b.time, b.value * 100)), [{ time: 60 }, ...previous.slice(1)]]) {
    assert.deepEqual(chartUpdatePlan(previous, next), { reset: true, bars: next })
  }
  assert.deepEqual(chartUpdatePlan(null, previous), { reset: true, bars: previous })
})
test('withholding and then verifying the latest price retains its volume independently', () => {
  const candles = [{ time: 60, open: 1, high: 2, low: 1, close: 2, volumeLamports: '10' }]
  const known = chartSeries({ candles, interval: 60 })
  const withheld = chartSeries({ candles: [{ time: 60, orderingPending: true, volumeLamports: '10' }], interval: 60 })
  assert.deepEqual(chartUpdatePlan(known.prices, withheld.prices), { reset: false, bars: [{ time: 60 }] })
  assert.equal(withheld.volumes[0].value, known.volumes[0].value)
  assert.deepEqual(chartUpdatePlan(withheld.prices, known.prices).bars, known.prices)
})
test('sparse candles have a bounded initial width without adding any price points', () => {
  const range = chartInitialRange(1, 'candles')
  assert.ok(range.to - range.from >= 40)
  assert.ok(range.from <= 0 && range.to >= 0)
  const full = chartInitialRange(500, 'candles')
  assert.ok(full.from < 0 && full.to >= 499)
  assert.ok(chartInitialRange(1, 'line').to - chartInitialRange(1, 'line').from < range.to - range.from)
})
test('last trade age communicates a quiet market independently of poll freshness', () => {
  const now = Date.parse('2026-09-27T10:00:00Z')
  assert.equal(chartTradeAge('2026-09-27T09:59:40Z', now), 'just now')
  assert.equal(chartTradeAge('2026-09-27T09:45:00Z', now), '15m ago')
  assert.equal(chartTradeAge('2026-09-26T10:00:00Z', now), '1d ago')
  assert.equal(chartTradeAge(undefined, now), null)
})
