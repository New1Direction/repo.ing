import test from 'node:test'
import assert from 'node:assert/strict'
import { bondingProgress, formatSolMarketCap, marketCapDisplay, MARKET_TOKEN_SUPPLY } from '../app/lib/market-display.mjs'
import { marketRowStats } from '../app/lib/market-row-stats.mjs'

const now = Date.parse('2026-09-30T12:00:00Z')
// sqrt price 0.01 · 2^64 → (0.01)^2 · 10^(6-9) = 1e-7 SOL per token → 100 SOL fully diluted cap.
const SQRT_1E_7 = String(184467440737095516n)
function observation({ percent = 62.5, phase = 'CURVE', age = 10_000 } = {}) {
  const at = new Date(now - age).toISOString(), threshold = 85_000_000_000n
  const reserve = threshold * BigInt(Math.round(percent * 100)) / 10000n
  return JSON.stringify({ phase, status: phase === 'GRADUATED' ? 'graduated' : 'active', reserveLamports: String(reserve), thresholdLamports: String(threshold),
    remainingLamports: String(threshold - reserve), progressPercent: percent, checkedAt: at, chainTime: at })
}

test('SOL market cap uses compact labels', () => {
  assert.equal(formatSolMarketCap(0.004), '<0.01 SOL')
  assert.equal(formatSolMarketCap(4.567), '4.57 SOL')
  assert.equal(formatSolMarketCap(123.45), '123.5 SOL')
  assert.equal(formatSolMarketCap(12_340), '12.3k SOL')
  assert.equal(formatSolMarketCap(2_000_000), '2m SOL')
  assert.equal(formatSolMarketCap(-1), '—')
  assert.equal(formatSolMarketCap(NaN), '—')
})

test('market cap is price × 1B supply, USD first and SOL without a SOL price', () => {
  assert.equal(MARKET_TOKEN_SUPPLY, 1_000_000_000)
  assert.equal(marketCapDisplay(1e-7, 150).value, '$15k')
  assert.match(marketCapDisplay(1e-7, 150).title, /100 SOL/)
  assert.equal(marketCapDisplay(1e-7, null).value, '100 SOL')
  assert.equal(marketCapDisplay(1e-7, 0).value, '100 SOL')
  assert.equal(marketCapDisplay(null, 150), null)
  assert.equal(marketCapDisplay(0, 150), null)
  assert.equal(marketCapDisplay(NaN, 150), null)
})

test('bonding progress clamps to 0–100, floors the label and fills graduated markets', () => {
  assert.deepEqual(bondingProgress({ bondingPercent: 62.9 }), { percent: 62.9, label: '62% to graduation' })
  assert.deepEqual(bondingProgress({ bondingPercent: 99.99 }), { percent: 99.99, label: '99% to graduation' })
  assert.equal(bondingProgress({ bondingPercent: 140 }).percent, 100)
  assert.equal(bondingProgress({ bondingPercent: -5 }).percent, 0)
  assert.deepEqual(bondingProgress({ bondingPercent: null, graduated: true }), { percent: 100, label: 'Graduated' })
  assert.equal(bondingProgress({ bondingPercent: null }), null)
  assert.equal(bondingProgress({ bondingPercent: '50' }), null)
  assert.equal(bondingProgress({}), null)
  assert.equal(bondingProgress(), null)
})

test('list row stats read the last trade price and fresh verified progress only', () => {
  const fresh = marketRowStats({ lastSqrtPrice: SQRT_1E_7, graduationStatus: 'VERIFIED', observation: observation() }, now)
  assert.ok(Math.abs(fresh.priceSol - 1e-7) < 1e-15)
  assert.equal(fresh.bondingPercent, 62.5); assert.equal(fresh.graduated, false)
  assert.deepEqual(marketRowStats({ lastSqrtPrice: SQRT_1E_7, graduationStatus: 'VERIFIED', observation: observation({ age: 3_600_000 }) }, now).bondingPercent, null)
  assert.deepEqual(marketRowStats({ graduationStatus: 'REVIEW', observation: observation() }, now), { priceSol: null, bondingPercent: null, graduated: false })
  // Graduation without matching durable migration evidence is not shown.
  assert.equal(marketRowStats({ graduationStatus: 'VERIFIED', observation: observation({ phase: 'GRADUATED', percent: 100 }) }, now).graduated, false)
  assert.equal(marketRowStats({ lastSqrtPrice: 'garbage' }, now).priceSol, null)
  assert.deepEqual(marketRowStats({}, now), { priceSol: null, bondingPercent: null, graduated: false })
})

test('listMarkets exposes only the derived numbers, never raw observation JSON', async () => {
  process.env.DATABASE_URL = 'postgres://mcap-test.invalid/db'
  globalThis.__gitfunPool = { query: async () => ({ rows: [{ repoId: '1', mint: 'm', indexedAt: new Date(), stars: '1', forks: '0', earned: '0', claimed: '0',
    volume24hLamports: '0', lastSqrtPrice: SQRT_1E_7, graduationStatus: 'VERIFIED', observation: observation({ age: 1000 }), graduationError: null, migrationEvidenceHash: null }] }) }
  const { listMarkets } = await import('../app/lib/server.mjs')
  const [market] = (await listMarkets()).markets
  for (const key of ['lastSqrtPrice', 'graduationStatus', 'observation', 'graduationError', 'migrationEvidenceHash']) assert.equal(key in market, false, key)
  assert.ok(market.priceSol > 0)
  assert.equal(typeof market.graduated, 'boolean')
})
