import test from 'node:test'
import assert from 'node:assert/strict'
import { bondingProgress, formatSolMarketCap, marketCapDisplay, supplyTokens } from '../app/lib/market-display.mjs'
import { marketCapRank } from '../app/lib/market-order.mjs'
import { marketRowStats } from '../app/lib/market-row-stats.mjs'

const now = Date.parse('2026-09-30T12:00:00Z')
// 1e-7 SOL per token (the stored price_sol) × 1B tokens = 100 SOL.
const PRICE_1E_7 = '0.0000001'
const BILLION = { baseUnits: '1000000000000000', decimals: 6 }
// A real repo.ing mint's on-chain supply (mint_facts): 999,850,848.836751 tokens, not the 1B it launched with.
const REAL_SUPPLY = { baseUnits: '999850848836751', decimals: 6 }
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

test('market cap is price × the mint\'s on-chain supply, USD first and SOL without a SOL price', () => {
  assert.equal(marketCapDisplay(1e-7, BILLION, 150).value, '$15k')
  assert.match(marketCapDisplay(1e-7, BILLION, 150).title, /100 SOL/)
  assert.equal(marketCapDisplay(1e-7, BILLION, null).value, '100 SOL')
  assert.equal(marketCapDisplay(1e-7, BILLION, 0).value, '100 SOL')
  assert.equal(marketCapDisplay(null, BILLION, 150), null)
  assert.equal(marketCapDisplay(0, BILLION, 150), null)
  assert.equal(marketCapDisplay(NaN, BILLION, 150), null)
})

test('market cap uses the supply mint_facts recorded, and none before the mint is read', () => {
  // Arrange: 0.000000770513239952588184 SOL per token (a real trade) at $200 per SOL.
  const price = 0.000000770513239952588184
  // Act
  const cap = marketCapDisplay(price, REAL_SUPPLY, 200)
  // Assert: 999,850,848.836751 × price = 770.398… SOL ($154,079.7… at $200), not 1B × price = 770.513… SOL
  assert.equal(supplyTokens(REAL_SUPPLY), 999850848.836751)
  assert.equal(supplyTokens({ supplyBaseUnits: '999850848836751', supplyDecimals: 6 }), 999850848.836751, 'the metrics route\'s field names too')
  assert.equal(cap.value, '$154.1k')
  assert.equal(marketCapDisplay(price, REAL_SUPPLY, null).value, '770.4 SOL', '770.5 SOL at a fixed 1B supply')
  assert.ok(Math.abs(marketCapRank({ priceSol: price, supply: REAL_SUPPLY }, 200) - 999850848.836751 * price * 200) < 1e-6)
  assert.equal(marketCapDisplay(price, null, 200), null)
  assert.equal(marketCapDisplay(price, { baseUnits: 'garbage', decimals: 6 }, 200), null)
  assert.equal(marketCapRank({ priceSol: price, supply: null }, 200), null, 'never ranked at a guessed 1B supply')
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

test('list row stats read the last trade\'s stored price, the mint supply and fresh verified progress only', () => {
  const fresh = marketRowStats({ lastPriceSol: PRICE_1E_7, supplyBaseUnits: REAL_SUPPLY.baseUnits, supplyDecimals: 6, graduationStatus: 'VERIFIED', observation: observation() }, now)
  assert.equal(fresh.priceSol, 1e-7)
  assert.deepEqual(fresh.supply, REAL_SUPPLY)
  assert.equal(fresh.bondingPercent, 62.5); assert.equal(fresh.graduated, false)
  assert.deepEqual(marketRowStats({ lastPriceSol: PRICE_1E_7, graduationStatus: 'VERIFIED', observation: observation({ age: 3_600_000 }) }, now).bondingPercent, null)
  assert.deepEqual(marketRowStats({ graduationStatus: 'REVIEW', observation: observation() }, now), { priceSol: null, supply: null, bondingPercent: null, graduated: false })
  // Graduation without matching durable migration evidence is not shown.
  assert.equal(marketRowStats({ graduationStatus: 'VERIFIED', observation: observation({ phase: 'GRADUATED', percent: 100 }) }, now).graduated, false)
  assert.equal(marketRowStats({ lastPriceSol: 'garbage' }, now).priceSol, null)
  assert.equal(marketRowStats({ lastPriceSol: null, supplyBaseUnits: REAL_SUPPLY.baseUnits, supplyDecimals: 6 }, now).priceSol, null, 'not priced yet: no price')
  assert.deepEqual(marketRowStats({}, now), { priceSol: null, supply: null, bondingPercent: null, graduated: false })
})

test('listMarkets exposes only the derived numbers, never raw observation JSON', async () => {
  process.env.DATABASE_URL = 'postgres://mcap-test.invalid/db'
  globalThis.__gitfunPool = { query: async () => ({ rows: [{ repoId: '1', mint: 'm', indexedAt: new Date(), stars: '1', forks: '0', earned: '0', claimed: '0',
    platformCollected: '0',
    volume24hLamports: '0', lastPriceSol: PRICE_1E_7, supplyBaseUnits: REAL_SUPPLY.baseUnits, supplyDecimals: 6, graduationStatus: 'VERIFIED',
    observation: observation({ age: 1000 }), graduationError: null, migrationEvidenceHash: null }] }) }
  const { listMarkets } = await import('../app/lib/server.mjs')
  const [market] = (await listMarkets()).markets
  for (const key of ['lastPriceSol', 'supplyBaseUnits', 'supplyDecimals', 'graduationStatus', 'observation', 'graduationError', 'migrationEvidenceHash']) assert.equal(key in market, false, key)
  assert.equal(market.priceSol, 1e-7)
  assert.deepEqual(market.supply, REAL_SUPPLY, 'the row\'s supply is the mint\'s on-chain supply')
  assert.equal(typeof market.graduated, 'boolean')
})
