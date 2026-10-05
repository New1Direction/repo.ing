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

test('real PostgreSQL: wallet prices and P&L order use stored positions, so a cleared block list changes nothing', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const { default: pg } = await import('pg')
  const { latestMarketPrices, clearPriceCache } = await import('../app/lib/portfolio-prices.mjs')
  const { walletTrades } = await import('../app/lib/holding-pnl.mjs')
  const url = new URL(process.env.CHART_TEST_DATABASE_URL)
  assert.equal(url.port, '55441', 'Use the dedicated chart test DB, never the production tunnel')
  const db = new pg.Client({ connectionString: url.href }); await db.connect()
  try {
    await db.query('begin')
    await db.query(`create temporary table trade_events(pool text, signature text, event_index integer, slot bigint, traded_at timestamptz, direction text,
      input_base_units text, output_base_units text, next_sqrt_price text, trader text)`)
    await db.query(`create temporary table damm_trade_events(github_repo_id bigint, pool text, signature text, event_index integer, slot bigint, traded_at timestamptz,
      quote_amount bigint, direction text, next_sqrt_price text, base_amount bigint, trader text)`)
    await db.query('create temporary table graduation_events(github_repo_id bigint, pool text, signature text, slot bigint, evidence text, evidence_hash text)')
    await db.query('create temporary table finalized_chart_blocks(slot bigint primary key, blockhash text, previous_blockhash text, parent_slot bigint, signatures text[] not null)')
    await db.query('create temporary table finalized_chart_positions(slot bigint, signature text, transaction_index integer, primary key(slot, signature))')
    const q64 = 1n << 64n
    // Two transactions in one slot. Block order is B then A, the reverse of their signatures' alphabetical order.
    await db.query(`insert into trade_events values ('curve-901','sig-A',0,50,now(),'buy','1000','10',$1,'W'), ('curve-901','sig-B',0,50,now(),'sell','5','900',$2,'W')`,
      [(q64 * 2n).toString(), (q64 * 3n).toString()])
    await db.query(`insert into finalized_chart_blocks values (50,'h','p',49,$1)`, [['other', 'sig-B', 'sig-A']])
    await db.query(`insert into finalized_chart_positions values (50,'sig-B',2), (50,'sig-A',3)`)
    const market = { repoId: '901', pool: 'curve-901', mint: 'Mint901' }
    const read = async () => { clearPriceCache(); return { price: (await latestMarketPrices(db, [market])).get('901'),
      order: (await walletTrades(db, 'W', [market])).get('901').map(trade => trade.direction) } }
    const before = await read()
    assert.deepEqual(before, { price: 0.004, order: ['sell', 'buy'] })
    await db.query(`update finalized_chart_blocks set signatures = '{}'`)
    assert.deepEqual(await read(), before)
  } finally { await db.query('rollback'); await db.end() }
})
