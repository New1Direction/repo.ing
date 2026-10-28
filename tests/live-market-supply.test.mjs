import test from 'node:test'
import assert from 'node:assert/strict'
import { liveChart } from '../app/lib/live-market.mjs'
import { phoneMarketSummary } from '../app/lib/phone-market-summary.mjs'

// A /trades payload as the chart API answers it (src/market-chart.mjs), with the mint's on-chain supply.
const payload = {
  interval: 3600, volume24hLamports: '1440000000000',
  latest: { priceSol: 0.00000096, solUsd: 102.5 },
  supply: { baseUnits: '999850848836751', decimals: 6 },
  candles: [{ time: 1793210400, open: 0.0000009, close: 0.00000096 }],
  trades: [],
}

test('the live card keeps the on-chain supply and the latest SOL/USD price from the chart payload', () => {
  // Act
  const chart = liveChart(payload)

  // Assert
  assert.deepEqual(chart.supply, { baseUnits: '999850848836751', decimals: 6 })
  assert.deepEqual(chart.latest, { priceSol: 0.00000096, solUsd: 102.5 })
})

test('the live card shows a market cap, not a dash, once the chart carries the supply', () => {
  // Arrange
  const chart = liveChart(payload)

  // Act
  const summary = phoneMarketSummary({ priceSol: null, chart, now: 1793214000000 })

  // Assert: 0.00000096 SOL × 999,850,848.84 tokens × $102.50 ≈ $98.4K
  assert.notEqual(summary.marketCap, '—')
  assert.match(summary.marketCap, /^\$98(\.\d)?k$/i)
})

test('without supply in the chart the market row supply still gives a market cap', () => {
  // Arrange
  const chart = liveChart({ ...payload, supply: undefined })

  // Act
  const summary = phoneMarketSummary({ chart, supply: { baseUnits: '999850848836751', decimals: 6 }, now: 1793214000000 })

  // Assert
  assert.notEqual(summary.marketCap, '—')
})

test('a malformed supply is dropped rather than guessed', () => {
  assert.equal(liveChart({ ...payload, supply: { baseUnits: '-5', decimals: 6 } }).supply, null)
  assert.equal(liveChart({ ...payload, supply: { baseUnits: '100', decimals: 'six' } }).supply, null)
})
