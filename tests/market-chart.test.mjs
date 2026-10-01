import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { chartWindow, chartSpotPrice, chartBar, readMarketChart, chartMigration } from '../src/market-chart.mjs'
import { chartSeries, chartPriceLabel } from '../app/lib/chart-display.mjs'
import { evidenceHash } from '../src/graduation-state.mjs'
import { recordChartBlock } from '../src/chart-ordering.mjs'

const sqrt = 1n << 64n
const now = Date.parse('2026-09-27T04:00:00.000Z')

test('chart windows are bounded and full history does not use a last-120-trade slice', () => {
  assert.equal(chartWindow('24h', null, now).start, '2026-09-26T04:00:00.000Z')
  assert.equal(chartWindow('unexpected', null, now).range, 'all')
  const all = chartWindow('all', '2025-01-01T00:00:00Z', now)
  assert.ok((now - Date.parse(all.start)) / 1000 / all.interval <= 500)
  assert.equal(chartWindow('1h', null, now).interval, 60)
})
test('spot price honors 6 token decimals and 9 SOL decimals without rounding tiny prices to zero', () => {
  assert.equal(chartSpotPrice(sqrt.toString()), 0.001)
  assert.equal(chartSpotPrice((sqrt * 2n).toString()), 0.004)
  assert.throws(() => chartSpotPrice('0'), /Invalid/)
  assert.equal(chartPriceLabel(0.00000000101), '1.010e-9')
  assert.equal(chartPriceLabel(NaN), '—')
})
test('ambiguous slot ordering keeps exact volume but withholds invented open/close', () => {
  const bar = chartBar({ time: '600', volume: '9007199254740993', count: '2', ambiguous: true })
  assert.equal(bar.volumeLamports, '9007199254740993')
  assert.equal(bar.open, undefined)
  assert.equal(bar.orderingPending, true)
})
test('whitespace maintains elapsed time; empty periods never become fake candles or volume', () => {
  const bar = { open: 1, high: 3, low: 1, close: 2, volumeLamports: '1000000000' }
  const { prices, volumes } = chartSeries({ interval: 60, candles: [{ time: 60, ...bar }, { time: 240, ...bar }] }, 100)
  assert.deepEqual(prices[1], { time: 120 })
  assert.deepEqual(volumes[2], { time: 180 })
  assert.equal(prices[3].high, 300)
  assert.equal(volumes[3].value, 1)
  assert.deepEqual(chartSeries({ interval: 60, candles: [] }), { prices: [], volumes: [] })
})

test('real PostgreSQL chart aggregation: canonical pool, 120+ history, OHLC, same-slot guards and periods', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.CHART_TEST_DATABASE_URL)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, '55441', 'Use the dedicated chart test DB, never the production tunnel')
  const client = new pg.Client({ connectionString: url.href })
  await client.connect()
  try {
    await client.query('begin')
    await client.query(`create temporary table trade_events(pool text,signature text,event_index integer,slot bigint,traded_at timestamptz,direction text,input_base_units text,output_base_units text,next_sqrt_price text)`)
    await client.query(`create temporary table finalized_chart_blocks(slot bigint primary key,blockhash text,previous_blockhash text,parent_slot bigint,signatures text[],checked_at timestamptz default now())`)
    await client.query('create temporary table finalized_chart_positions(slot bigint,signature text,transaction_index integer,primary key(slot,signature))')
    await client.query('create temporary table damm_trade_events(github_repo_id bigint,pool text,signature text,event_index integer,slot bigint,traded_at timestamptz,quote_amount bigint,direction text,next_sqrt_price text,base_amount bigint)')
    await client.query('create temporary table graduation_events(github_repo_id bigint,pool text,signature text,slot bigint,evidence text,evidence_hash text)')
    const insert = async (pool, signature, index, slot, at, direction, input, output, price) => client.query('insert into trade_events values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [pool, signature, index, slot, at, direction, input, output, String(price)])
    const market = { pool: 'canonical-pool' }
    assert.equal((await readMarketChart(client, market, 'all', now)).totalTrades, 0)
    for (let i = 0; i < 130; i++) await insert(market.pool, `sig${i}`, 0, i + 1, new Date(now - 3600000 + i * 1000), i % 2 ? 'sell' : 'buy', '1000000', '2000000', sqrt * BigInt(i + 1))
    await insert('other-pool', 'other', 0, 999, new Date(now - 2000), 'buy', '99999999999', '1', sqrt)
    const all = await readMarketChart(client, market, 'all', now)
    assert.equal(all.totalTrades, 130)
    assert.equal(all.trades.length, 120)
    assert.equal(all.candles.reduce((n, b) => n + b.count, 0), 130)
    assert.equal(all.volume24hLamports, '195000000')
    assert.equal(all.candles[0].open, 0.001)
    assert.equal(all.latest.priceSol, chartSpotPrice(sqrt * 130n))
    assert.equal(all.candles.at(-1).close, all.latest.priceSol)
    const quiet = await readMarketChart(client, market, '1h', now + 3600000)
    assert.equal(quiet.candles.length, 0)
    assert.equal(quiet.totalTrades, 130)
    // Two instructions in ONE transaction retain known order.
    await insert(market.pool, 'one-tx', 1, 200, new Date(now - 2000), 'buy', '3', '1', sqrt * 2n)
    await insert(market.pool, 'one-tx', 2, 200, new Date(now - 2000), 'buy', '4', '1', sqrt * 3n)
    assert.equal((await readMarketChart(client, market, '1h', now)).latest.priceSol, 0.009)
    // Different transactions in one slot must not claim a known latest price.
    await insert(market.pool, 'second-tx', 0, 200, new Date(now - 2000), 'sell', '1', '7', sqrt * 4n)
    const ambiguous = await readMarketChart(client, market, '1h', now)
    assert.equal(ambiguous.latest, null)
    assert.equal(ambiguous.candles.at(-1).orderingPending, true)
    assert.equal(ambiguous.candles.at(-1).volumeLamports, '14')
    assert.equal(ambiguous.volume24hLamports, '195000014')
    // Finalized block order is deliberately opposite alphabetical signature order.
    const proof = {slot:200,blockhash:'verified',previousBlockhash:'previous',parentSlot:199,signatures:['second-tx','one-tx']}
    await recordChartBlock(client, proof)
    await recordChartBlock(client, proof)
    assert.equal((await client.query('select count(*)::integer as n from finalized_chart_blocks')).rows[0].n,1)
    // The indexed trades' places in the block are stored once, so chart reads never search the full signature list.
    assert.deepEqual((await client.query('select signature,transaction_index from finalized_chart_positions order by transaction_index')).rows,
      [{signature:'second-tx',transaction_index:1},{signature:'one-tx',transaction_index:2}])
    const resolved = await readMarketChart(client,market,'1h',now)
    assert.equal(resolved.latestOrderingPending,false)
    assert.equal(resolved.latest.signature,'one-tx')
    assert.equal(resolved.latest.priceSol,0.009)
    assert.equal(resolved.candles.at(-1).open,0.016)
    assert.equal(resolved.candles.at(-1).close,0.009)
    assert.equal(resolved.candles.at(-1).volumeLamports,'14')
    assert.equal(resolved.volume24hLamports,ambiguous.volume24hLamports)
    await assert.rejects(recordChartBlock(client,{...proof,signatures:[...proof.signatures].reverse()}),/CHART_EVIDENCE_CONFLICT/)
    assert.deepEqual((await client.query('select signatures from finalized_chart_blocks')).rows[0].signatures,proof.signatures)
    // A newly indexed signature not in the proof cannot silently receive an order.
    await insert(market.pool,'missing-proof',0,200,new Date(now-2000),'buy','1','1',sqrt)
    const missing=await readMarketChart(client,market,'1h',now)
    assert.equal(missing.latestOrderingPending,true)
    assert.equal(missing.candles.at(-1).orderingPending,true)
    // The canonical migrated pool continues the chart; unrelated pools/repos and
    // pre-migration trades never enter the series, even if their mints match.
    market.repoId='991';market.mint='test-mint'
    const migration={mint:market.mint,curve:market.pool,pool:'damm-pool',signature:'migration',slot:250}
    await client.query('insert into graduation_events values($1,$2,$3,$4,$5,$6)',[991,migration.pool,migration.signature,250,JSON.stringify({migration}),evidenceHash(migration)])
    const addDamm=(repo,pool,sig,slot,price)=>client.query('insert into damm_trade_events values($1,$2,$3,0,$4,$5,10,\'buy\',$6)',[repo,pool,sig,slot,new Date(now-1000),price?.toString()??null])
    await addDamm(991,'damm-pool','damm-first',251,sqrt*5n)
    await addDamm(992,'damm-pool','wrong-repo',999,sqrt)
    await addDamm(991,'other-pool','wrong-pool',999,sqrt)
    await addDamm(991,'damm-pool','before-migration',249,sqrt)
    const migrated=await readMarketChart(client,market,'all',now)
    assert.equal(migrated.source,'finalized-dbc-and-damm-swaps')
    assert.equal(migrated.graduation.indexedTrades,1)
    assert.equal(migrated.latest.signature,'damm-first')
    assert.equal(migrated.latest.priceSol,.025)
    assert.equal(migrated.volume24hLamports,BigInt(missing.volume24hLamports)+10n+'')
    await addDamm(991,'damm-pool','damm-second',251,sqrt*6n)
    assert.equal((await readMarketChart(client,market,'all',now)).latest,null)
    await recordChartBlock(client,{slot:251,blockhash:'verified',previousBlockhash:'previous',parentSlot:250,signatures:['damm-second','damm-first']})
    assert.equal((await readMarketChart(client,market,'all',now)).latest.signature,'damm-first')
    await addDamm(991,'damm-pool','legacy-missing-price',252,null)
    const withheld=await readMarketChart(client,market,'all',now)
    assert.equal(withheld.latest,null)
    assert.equal(withheld.candles.at(-1).priceEvidenceMissing,true)
    assert.equal(withheld.volume24hLamports,BigInt(migrated.volume24hLamports)+20n+'')

  } finally { await client.query('rollback'); await client.end() }
})

test('quiet history retains fine time buckets rather than flattening old trades as time passes', () => {
  const first = '2026-09-25T03:16:48Z', last = '2026-09-25T03:23:17Z'
  assert.equal(chartWindow('all', first, now, last).interval, 60)
})

test('single-price and tiny rounding differences get a stable, honest axis range', async () => {
  const { chartScaleRange } = await import('../app/lib/chart-display.mjs')
  const result = chartScaleRange({ priceRange: { minValue: 1e-9, maxValue: 1e-9 + 1e-24 } })
  assert.ok(result.priceRange.maxValue - result.priceRange.minValue > 3.9e-11)
  assert.equal(chartScaleRange(null), null)
  assert.ok(chartScaleRange({ priceRange: { minValue: 0, maxValue: 100 } }).priceRange.minValue >= 0)
})

test('migration proof binds immutable repo, curve, mint, destination, slot and receipt',()=>{
 const market={repoId:'991',pool:'curve',mint:'mint'}
 const migration={curve:'curve',mint:'mint',pool:'damm',slot:44,signature:'receipt'}
 const row={github_repo_id:991,pool:'damm',slot:44,signature:'receipt',evidence:JSON.stringify({migration}),evidence_hash:evidenceHash(migration)}
 assert.equal(chartMigration(market,row).pool,'damm')
 for(const patch of [{repoId:'992'},{pool:'wrong'},{mint:'wrong'}])assert.throws(()=>chartMigration({...market,...patch},row),/MISMATCH/)
 for(const patch of [{pool:'wrong'},{slot:45},{signature:'wrong'},{evidence_hash:'bad'}])assert.throws(()=>chartMigration(market,{...row,...patch}),/MISMATCH/)
})
