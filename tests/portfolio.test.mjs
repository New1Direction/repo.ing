import test from 'node:test'
import assert from 'node:assert/strict'
import { holdingValueLamports, latestSlotTrade, portfolioSummary, sortHoldingsByValue, withHoldingValues } from '../app/lib/portfolio.mjs'
import { clearPriceCache, latestMarketPrices } from '../app/lib/portfolio-prices.mjs'
import { chartSpotPrice } from '../src/market-chart.mjs'
import { evidenceHash } from '../src/graduation-state.mjs'

const sqrt = 1n << 64n

test('holding value is balance times SOL-per-token price in lamports', () => {
  assert.equal(holdingValueLamports('1000000', 0.001), '1000000') // 1 token at 0.001 SOL
  assert.equal(holdingValueLamports('250000000000', 0.000004), '1000000000') // 250k tokens → 1 SOL
  assert.equal(holdingValueLamports('1', 0.000000001), '0')
})

test('zero price, zero balance and missing inputs never invent value', () => {
  assert.equal(holdingValueLamports('5000000', 0), '0')
  assert.equal(holdingValueLamports('0', 0.5), '0')
  assert.equal(holdingValueLamports('5000000', null), null)
  assert.equal(holdingValueLamports('5000000', NaN), null)
  assert.equal(holdingValueLamports('5000000', -1), null)
  assert.equal(holdingValueLamports(null, 0.5), null)
})

test('portfolio totals exclude unpriced holdings and count them separately', () => {
  const markets = withHoldingValues([
    { repoId: '1', balanceBaseUnits: '2000000' },
    { repoId: '2', balanceBaseUnits: '1000000' },
    { repoId: '3', balanceBaseUnits: '1000000' },
    { repoId: '4', balanceBaseUnits: '0' },
  ], new Map([['1', 0.5], ['2', 0], ['4', 9]]))
  assert.deepEqual(markets.map(m => m.valueLamports), ['1000000000', '0', null, '0'])
  assert.deepEqual(portfolioSummary(markets), { valueLamports: '1000000000', holdings: 3, unpriced: 1 })
  assert.deepEqual(portfolioSummary([]), { valueLamports: '0', holdings: 0, unpriced: 0 })
})

test('holdings sort by value descending with unpriced holdings last in original order', () => {
  const sorted = sortHoldingsByValue([
    { mint: 'a', valueLamports: null }, { mint: 'b', valueLamports: '10' }, { mint: 'c', valueLamports: '900' },
    { mint: 'd', valueLamports: null }, { mint: 'e', valueLamports: '0' },
  ])
  assert.deepEqual(sorted.map(m => m.mint), ['c', 'b', 'e', 'a', 'd'])
})

test('latest price follows the chart ordering and withholds ambiguous same-slot trades', () => {
  assert.equal(latestSlotTrade([]), null)
  const oneTx = [{ signature: 'x', eventIndex: 1, transactionIndex: null, nextSqrtPrice: 'a' }, { signature: 'x', eventIndex: 2, transactionIndex: null, nextSqrtPrice: 'b' }]
  assert.equal(latestSlotTrade(oneTx).nextSqrtPrice, 'b')
  const twoTx = [...oneTx, { signature: 'y', eventIndex: 0, transactionIndex: null, nextSqrtPrice: 'c' }]
  assert.equal(latestSlotTrade(twoTx), null)
  // Finalized block order wins over signature order.
  const ordered = [{ signature: 'a', eventIndex: 0, transactionIndex: 2, nextSqrtPrice: 'late' }, { signature: 'z', eventIndex: 5, transactionIndex: 1, nextSqrtPrice: 'early' }]
  assert.equal(latestSlotTrade(ordered).nextSqrtPrice, 'late')
})

function stubDb({ graduations = [], trades = [] }) {
  const calls = []
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params })
    return { rows: sql.includes('graduation_events') ? graduations : trades }
  } }
}

test('prices for curve and graduated markets load in two batched queries and are cached briefly', async () => {
  clearPriceCache()
  const migration = { curve: 'curve-b', mint: 'mint-b', pool: 'damm-b', slot: 44, signature: 'receipt' }
  const db = stubDb({
    graduations: [{ github_repo_id: '2', pool: 'damm-b', slot: '44', signature: 'receipt', evidence: JSON.stringify({ migration }), evidence_hash: evidenceHash(migration) }],
    trades: [
      { repoId: '1', signature: 's1', eventIndex: 0, transactionIndex: 0, nextSqrtPrice: sqrt.toString() },
      { repoId: '2', signature: 's2', eventIndex: 0, transactionIndex: 3, nextSqrtPrice: (sqrt * 2n).toString() },
      { repoId: '2', signature: 's3', eventIndex: 0, transactionIndex: 1, nextSqrtPrice: sqrt.toString() },
    ],
  })
  const markets = [{ repoId: '1', pool: 'curve-a', mint: 'mint-a' }, { repoId: '2', pool: 'curve-b', mint: 'mint-b' }, { repoId: '3', pool: 'curve-c', mint: 'mint-c' }]
  const prices = await latestMarketPrices(db, markets, 1000)
  assert.equal(prices.get('1'), 0.001)
  assert.equal(prices.get('2'), chartSpotPrice((sqrt * 2n).toString()))
  assert.equal(prices.get('3'), null) // no trades yet
  assert.equal(db.calls.length, 2)
  assert.deepEqual(db.calls[1].params, [['1', '2', '3'], ['curve-a', 'curve-b', 'curve-c'], [null, 'damm-b', null], [null, '44', null]])
  await latestMarketPrices(db, markets, 5000)
  assert.equal(db.calls.length, 2)
  await latestMarketPrices(db, markets, 20000)
  assert.equal(db.calls.length, 4)
})

test('a graduation record that fails its proof withholds that market price only', async () => {
  clearPriceCache()
  const migration = { curve: 'curve-b', mint: 'mint-b', pool: 'damm-b', slot: 44, signature: 'receipt' }
  const db = stubDb({
    graduations: [{ github_repo_id: '2', pool: 'damm-b', slot: '44', signature: 'receipt', evidence: JSON.stringify({ migration }), evidence_hash: 'tampered' }],
    trades: [{ repoId: '1', signature: 's1', eventIndex: 0, transactionIndex: null, nextSqrtPrice: sqrt.toString() }],
  })
  const prices = await latestMarketPrices(db, [{ repoId: '1', pool: 'curve-a', mint: 'mint-a' }, { repoId: '2', pool: 'curve-b', mint: 'mint-b' }], 0)
  assert.equal(prices.get('1'), 0.001)
  assert.equal(prices.get('2'), null)
  assert.deepEqual(db.calls[1].params[0], ['1'])
})

test('no held markets means no price queries', async () => {
  clearPriceCache()
  const db = stubDb({})
  assert.equal((await latestMarketPrices(db, [])).size, 0)
  assert.equal(db.calls.length, 0)
})
