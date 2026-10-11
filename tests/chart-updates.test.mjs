import test from 'node:test'
import assert from 'node:assert/strict'
import { chartFollowRange, chartUpdatePlan, chartInitialRange, chartTradeAge, chartSeries, chartZoomRange } from '../app/lib/chart-display.mjs'

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
test('a view at the end follows a growing or shrinking tail and never turns inside out', () => {
  // Grows: the right edge moves out, the left edge stays
  assert.deepEqual(chartFollowRange({ from: -3, to: 492 }, 489, 493), { from: -3, to: 496 })
  // Shrinks a little: still wide, keeps its left edge
  assert.deepEqual(chartFollowRange({ from: -3, to: 982 }, 979, 735), { from: -3, to: 738 })
  // Shrinks past a narrow view: moves whole instead of putting from after to
  assert.deepEqual(chartFollowRange({ from: 960, to: 982 }, 979, 735), { from: 716, to: 738 })
  // Not at the end, or nothing changed: leave it
  assert.equal(chartFollowRange({ from: 100, to: 400 }, 979, 735), null)
  assert.equal(chartFollowRange({ from: -3, to: 982 }, 979, 979), null)
  assert.equal(chartFollowRange(null, 979, 990), null)
})
test('zooming in keeps the right edge but never loses the last trade into the GitHub tail', () => {
  // No tail: unchanged behaviour, anchored on the right edge
  assert.deepEqual(chartZoomRange({ from: 0, to: 100 }, 0.7, null), { from: 30, to: 100 })
  // A tail of 500 after 500 trades: the newest pins stay while the last trade still fits
  assert.deepEqual(chartZoomRange({ from: -3, to: 1003 }, 0.7, 499), { from: 1003 - 1006 * 0.7, to: 1003 })
  // A short history in a long tail: the right edge comes in just enough to keep the last trade on screen
  const zoomed = chartZoomRange({ from: -2.5, to: 64.5 }, 0.7, 14)
  assert.ok(zoomed.from <= 14 - 2 + 1e-9 && zoomed.to <= 64.5 && Math.abs(zoomed.to - zoomed.from - 67 * 0.7) < 1e-9)
  // Zooming out always keeps the right edge
  assert.deepEqual(chartZoomRange({ from: 12, to: 40 }, 1.4, 14), { from: 40 - 28 * 1.4, to: 40 })
})
