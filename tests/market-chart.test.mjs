import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { chartWindow, storedPrice, chartBar, readMarketChart, chartMigration } from '../src/market-chart.mjs'
import { chartSeries, chartPriceLabel } from '../app/lib/chart-display.mjs'
import { evidenceHash } from '../src/graduation-state.mjs'
import { recordChartBlock } from '../src/chart-ordering.mjs'

const now = Date.parse('2026-09-27T04:00:00.000Z')
// The price a trade paid (price_sol), k² thousandths of a SOL: 0.001, 0.004, 0.009, …
const price = k => String(k * k / 1000)
// A dedicated local test database only, never the production tunnel.
const testDatabase = () => {
  const url = new URL(process.env.CHART_TEST_DATABASE_URL)
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(['55441', '55911'].includes(url.port), 'Use the dedicated chart test DB, never the production tunnel')
  return url
}
// Real repo.ing trades on mint 59PXVf… (6 decimals): the lamports paid over the base units, each at its mint's decimals.
const REAL = { mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', supply: '999850848836751', decimals: 6,
  sell: { base: '172810998534', lamports: '133581983', price: '0.000000772994682822333098' },
  buy: { base: '3854573608862', lamports: '2970000000', price: '0.000000770513239952588184' } }
const CHART_TABLES = [
  'create temporary table trade_events(pool text,signature text,event_index integer,slot bigint,traded_at timestamptz,direction text,input_base_units text,output_base_units text,next_sqrt_price text,price_sol numeric)',
  'create temporary table finalized_chart_blocks(slot bigint primary key,blockhash text,previous_blockhash text,parent_slot bigint,signatures text[],checked_at timestamptz default now())',
  'create temporary table finalized_chart_positions(slot bigint,signature text,transaction_index integer,primary key(slot,signature))',
  'create temporary table damm_trade_events(github_repo_id bigint,pool text,signature text,event_index integer,slot bigint,traded_at timestamptz,quote_amount bigint,direction text,next_sqrt_price text,base_amount bigint,price_sol numeric)',
  'create temporary table graduation_events(github_repo_id bigint,pool text,signature text,slot bigint,evidence text,evidence_hash text)',
  'create temporary table mint_facts(mint text primary key,decimals smallint not null,supply numeric(39,0) not null,slot bigint not null,read_at timestamptz default now())',
  'create temporary table sol_usd_minutes(minute timestamptz primary key,usd numeric not null,source text not null)',
]

test('chart windows are bounded and full history does not use a last-120-trade slice', () => {
  assert.equal(chartWindow('24h', null, now).start, '2026-09-26T04:00:00.000Z')
  assert.equal(chartWindow('unexpected', null, now).range, 'all')
  const all = chartWindow('all', '2025-01-01T00:00:00Z', now)
  assert.ok((now - Date.parse(all.start)) / 1000 / all.interval <= 500)
  assert.equal(chartWindow('1h', null, now).interval, 60)
})
test('a stored trade price reads exactly as recorded, tiny prices included, and an unpriced trade has none', () => {
  // Arrange
  const recorded = [REAL.sell.price, REAL.buy.price, '0.001', '16.9']
  // Act
  const read = recorded.map(storedPrice)
  // Assert
  assert.deepEqual(read, [0.000000772994682822333098, 0.000000770513239952588184, 0.001, 16.9])
  assert.deepEqual([null, undefined, '0', '-1', 'NaN', 'garbage', ''].map(storedPrice), [null, null, null, null, null, null, null])
  assert.equal(chartPriceLabel(NaN), '—')
})
test('a candle is its trades\' stored prices with the SOL/USD price of its close; a bucket holding an unpriced trade is withheld', () => {
  // Arrange
  const priced = { time: '600', open: REAL.sell.price, high: REAL.sell.price, low: REAL.buy.price, close: REAL.buy.price, sol_usd: '187.42', volume: '3103581983', count: '2' }
  // Act
  const bar = chartBar(priced), withoutUsd = chartBar({ ...priced, sol_usd: null })
  const unpriced = chartBar({ ...priced, open: null, close: null, high: null, low: null, missing_price: true })
  // Assert
  assert.deepEqual(bar, { time: 600, open: 0.000000772994682822333098, high: 0.000000772994682822333098, low: 0.000000770513239952588184,
    close: 0.000000770513239952588184, solUsd: 187.42, volumeLamports: '3103581983', count: 2 })
  assert.equal(withoutUsd.solUsd, null, 'no SOL price recorded yet: none, never today\'s')
  assert.deepEqual(unpriced, { time: 600, volumeLamports: '3103581983', count: 2, orderingPending: true, priceEvidenceMissing: true })
  assert.throws(() => chartBar({ ...priced, close: null }), /Invalid chart price/)
})
test('chart prices are plain decimals at every size, never exponent notation', () => {
  // Below 0.000001: 4 significant digits, as many as the old exponent labels ("1.010e-9") showed; 5 from there up.
  assert.deepEqual([0.00000000101, 4.338e-7, 4.3381234e-7, 1e-15, 0.0000012345678, 0.5, 12345.678, 0].map(chartPriceLabel),
    ['0.00000000101', '0.0000004338', '0.0000004338', '0.000000000000001', '0.0000012346', '0.5', '12,346', '0'])
  for (let exponent = -18; exponent <= 3; exponent++) assert.doesNotMatch(chartPriceLabel(1.2345 * 10 ** exponent), /e/i)
  assert.deepEqual([-1, Infinity, null].map(chartPriceLabel), ['—', '—', '—'])
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

test('market cap mode: each candle at mint supply × its own close\'s SOL/USD price; a candle without one is a gap, never today\'s price', async () => {
  // Arrange: the mint's real supply and two candles at the same SOL price but different SOL/USD prices; one without any.
  const { chartQuote } = await import('../app/lib/chart-quote.mjs')
  const { supplyTokens } = await import('../app/lib/market-display.mjs')
  const supply = supplyTokens({ baseUnits: REAL.supply, decimals: REAL.decimals })
  const units = chartQuote(null, { solUsd: 999 })
  const capScale = bar => units.usdOf(bar) ? supply * units.usdOf(bar) : null
  const bar = (time, solUsd) => ({ time, open: 0.0000008, high: 0.0000008, low: 0.0000008, close: 0.0000008, solUsd, volumeLamports: '1000000000', count: 1 })
  const data = { interval: 60, candles: [bar(60, 100), bar(120, 200), bar(180, null), { time: 240, volumeLamports: '5', count: 1, orderingPending: true }] }
  // Act
  const { prices, volumes } = chartSeries(data, capScale)
  const price = chartSeries(data, 1)
  // Assert: 999,850,848.836751 × 0.0000008 SOL = 799.88… SOL, × $100 and × $200.
  assert.ok(Math.abs(prices[0].close - 999850848.836751 * 0.0000008 * 100) < 1e-6)
  assert.ok(Math.abs(prices[1].close - 999850848.836751 * 0.0000008 * 200) < 1e-6)
  assert.deepEqual(prices[2], { time: 180 }, 'no SOL/USD price recorded for it: a gap, not today\'s $999')
  assert.deepEqual(prices[3], { time: 240 })
  assert.deepEqual(volumes.map(v => v.value), [1, 1, 1, 5e-9], 'volume stays for every recorded candle')
  assert.deepEqual(price.prices.map(p => p.close ?? null), [0.0000008, 0.0000008, 0.0000008, null], 'Price (SOL) mode draws priceSol unchanged')
  assert.deepEqual(chartSeries(data, null), { prices: [], volumes: [] }, 'no supply: no market cap series')
  assert.equal(units.usdOf({ solUsd: 0 }), null)
})

test('real PostgreSQL chart aggregation: canonical pool, 120+ history, OHLC, same-slot guards and periods', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: testDatabase().href })
  await client.connect()
  try {
    await client.query('begin')
    for (const table of CHART_TABLES) await client.query(table)
    // Chart ordering places stock-pair trades too (src/chart-ordering.mjs); none here.
    await client.query('create temporary table stock_trade_events(slot bigint,signature text)')
    // next_sqrt_price is deliberately unrelated to price_sol: the chart never reads it.
    const insert = async (pool, signature, index, slot, at, direction, input, output, paid) => client.query('insert into trade_events values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [pool, signature, index, slot, at, direction, input, output, '18446744073709551616', paid])
    const market = { pool: 'canonical-pool' }
    assert.equal((await readMarketChart(client, market, 'all', now)).totalTrades, 0)
    for (let i = 0; i < 130; i++) await insert(market.pool, `sig${i}`, 0, i + 1, new Date(now - 3600000 + i * 1000), i % 2 ? 'sell' : 'buy', '1000000', '2000000', price(i + 1))
    await insert('other-pool', 'other', 0, 999, new Date(now - 2000), 'buy', '99999999999', '1', price(1))
    const all = await readMarketChart(client, market, 'all', now)
    assert.equal(all.totalTrades, 130)
    assert.equal(all.trades.length, 120)
    assert.equal(all.candles.reduce((n, b) => n + b.count, 0), 130)
    assert.equal(all.volume24hLamports, '195000000')
    assert.equal(all.candles[0].open, 0.001)
    assert.equal(all.latest.priceSol, 16.9)
    assert.equal(all.candles.at(-1).close, all.latest.priceSol)
    const quiet = await readMarketChart(client, market, '1h', now + 3600000)
    assert.equal(quiet.candles.length, 0)
    assert.equal(quiet.totalTrades, 130)
    // Two instructions in ONE transaction retain known order.
    await insert(market.pool, 'one-tx', 1, 200, new Date(now - 2000), 'buy', '3', '1', price(2))
    await insert(market.pool, 'one-tx', 2, 200, new Date(now - 2000), 'buy', '4', '1', price(3))
    assert.equal((await readMarketChart(client, market, '1h', now)).latest.priceSol, 0.009)
    // Different transactions in one slot must not claim a known latest price.
    await insert(market.pool, 'second-tx', 0, 200, new Date(now - 2000), 'sell', '1', '7', price(4))
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
    await insert(market.pool,'missing-proof',0,200,new Date(now-2000),'buy','1','1',price(1))
    const missing=await readMarketChart(client,market,'1h',now)
    assert.equal(missing.latestOrderingPending,true)
    assert.equal(missing.candles.at(-1).orderingPending,true)
    // The canonical migrated pool continues the chart; unrelated pools/repos and
    // pre-migration trades never enter the series, even if their mints match.
    market.repoId='991';market.mint='test-mint'
    const migration={mint:market.mint,curve:market.pool,pool:'damm-pool',signature:'migration',slot:250}
    await client.query('insert into graduation_events values($1,$2,$3,$4,$5,$6)',[991,migration.pool,migration.signature,250,JSON.stringify({migration}),evidenceHash(migration)])
    const addDamm=(repo,pool,sig,slot,paid)=>client.query('insert into damm_trade_events values($1,$2,$3,0,$4,$5,10,\'buy\',\'18446744073709551616\',null,$6)',[repo,pool,sig,slot,new Date(now-1000),paid])
    await addDamm(991,'damm-pool','damm-first',251,price(5))
    await addDamm(992,'damm-pool','wrong-repo',999,price(1))
    await addDamm(991,'other-pool','wrong-pool',999,price(1))
    await addDamm(991,'damm-pool','before-migration',249,price(1))
    const migrated=await readMarketChart(client,market,'all',now)
    assert.equal(migrated.source,'finalized-dbc-and-damm-swaps')
    assert.equal(migrated.graduation.indexedTrades,1)
    assert.equal(migrated.latest.signature,'damm-first')
    assert.equal(migrated.latest.priceSol,.025)
    assert.equal(migrated.volume24hLamports,BigInt(missing.volume24hLamports)+10n+'')
    await addDamm(991,'damm-pool','damm-second',251,price(6))
    assert.equal((await readMarketChart(client,market,'all',now)).latest,null)
    await recordChartBlock(client,{slot:251,blockhash:'verified',previousBlockhash:'previous',parentSlot:250,signatures:['damm-second','damm-first']})
    assert.equal((await readMarketChart(client,market,'all',now)).latest.signature,'damm-first')
    await addDamm(991,'damm-pool','not-priced-yet',252,null)
    const withheld=await readMarketChart(client,market,'all',now)
    assert.equal(withheld.latest,null)
    assert.equal(withheld.candles.at(-1).priceEvidenceMissing,true)
    assert.equal(withheld.volume24hLamports,BigInt(migrated.volume24hLamports)+20n+'')

  } finally { await client.query('rollback'); await client.end() }
})

test('real PostgreSQL live trades: only unfinalized swaps of the canonical pools, from the newest finalized slot, at most two minutes old', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: testDatabase().href })
  await client.connect()
  try {
    await client.query('begin')
    for (const table of CHART_TABLES) await client.query(table)
    // The 0057 table's columns, types and key (its trigger and foreign key need the full schema), with 0089's price_sol.
    await client.query(`create temporary table live_trade_events(signature varchar(88) not null,event_index integer not null,github_repo_id bigint not null,
      venue varchar(4) not null,pool varchar(44) not null,slot bigint not null,traded_at timestamptz not null,direction varchar(4) not null,
      quote_amount numeric(20,0) not null,base_amount numeric(20,0),next_sqrt_price numeric(39,0) not null,received_at timestamptz default now() not null,
      price_sol numeric,primary key(signature,event_index))`)
    const market = { pool: 'curve-pool', repoId: '991', mint: 'test-mint' }
    const final = (signature, slot, seconds, k) => client.query('insert into trade_events values($1,$2,0,$3,$4,$5,$6,$7,$8,$9)',
      [market.pool, signature, slot, new Date(now - seconds * 1000), 'buy', '1000', '10', '18446744073709551616', price(k)])
    const live = (signature, slot, seconds, k, { pool = market.pool, venue = 'DBC', receivedAgo = 0, lamports = '100' } = {}) => client.query(
      `insert into live_trade_events(signature,event_index,github_repo_id,venue,pool,slot,traded_at,direction,quote_amount,base_amount,next_sqrt_price,received_at,price_sol)
       values($1,0,991,$2,$3,$4,$5,'sell',$6,7,18446744073709551616,now()-make_interval(secs=>$7),$8)`,
      [signature, venue, pool, slot, new Date(now - seconds * 1000), lamports, receivedAgo, k === null ? null : price(k)])
    await final('f1', 100, 120, 2)
    await final('f2', 110, 60, 3)
    await live('f2', 110, 60, 3) // now finalized: the ledger's row is shown, once
    await live('older', 105, 90, 9) // older than the newest finalized slot and never finalized: dropped
    await live('stale', 120, 20, 9, { receivedAgo: 200 }) // over two minutes old: dropped
    await live('elsewhere', 121, 15, 9, { pool: 'other-pool' }) // not this market's canonical pool
    await live('same-slot', 110, 59, 4) // the newest finalized slot itself, but a swap the ledger does not hold yet
    await live('live-a', 111, 30, 5, { lamports: '200' })
    await live('live-b', 112, 10, 6, { lamports: '300' })
    await live('unpriced', 112, 9, null, { lamports: '400' }) // not priced yet: left out, never guessed

    const finalized = await readMarketChart(client, market, '1h', now)
    assert.equal(finalized.live, undefined)
    assert.equal(finalized.latest.signature, 'f2')
    assert.equal(finalized.totalTrades, 2)

    const shown = await readMarketChart(client, market, '1h', now, { live: true })
    assert.deepEqual(shown.trades.map(trade => [trade.signature, trade.pending ?? false]),
      [['f1', false], ['f2', false], ['same-slot', true], ['live-a', true], ['live-b', true]])
    assert.deepEqual(shown.live, { trades: 3 })
    assert.equal(shown.totalTrades, 5)
    assert.equal(shown.latest.signature, 'live-b')
    assert.equal(shown.latest.priceSol, 0.036)
    assert.equal(shown.latest.solLamports, '300')
    assert.equal(shown.volume24hLamports, String(2 * 1000 + 100 + 200 + 300))
    assert.equal(shown.candles.at(-1).close, 0.036)
    assert.equal(shown.candles.at(-1).live, true)
    assert.equal(shown.candles.reduce((n, bar) => n + bar.count, 0), 5)

    // Graduated: the verified DAMM destination's live swaps continue the chart; another pool's never do.
    const migration = { mint: market.mint, curve: market.pool, pool: 'damm-pool', signature: 'migration', slot: 250 }
    await client.query('insert into graduation_events values($1,$2,$3,$4,$5,$6)', [991, migration.pool, migration.signature, 250, JSON.stringify({ migration }), evidenceHash(migration)])
    await live('damm-live', 260, 5, 8, { pool: 'damm-pool', venue: 'DAMM' })
    await live('damm-elsewhere', 261, 4, 8, { pool: 'unverified-pool', venue: 'DAMM' })
    const graduated = await readMarketChart(client, market, 'all', now, { live: true })
    assert.equal(graduated.latest.signature, 'damm-live')
    assert.equal(graduated.latest.venue, 'DAMM')
    assert.equal(graduated.live.trades, 4)
    // Once the finalized DAMM ledger holds it, the live row is no longer shown.
    await client.query("insert into damm_trade_events values(991,'damm-pool','damm-live',0,260,$1,100,'sell','18446744073709551616',7,$2)", [new Date(now - 5000), price(8)])
    const caughtUp = await readMarketChart(client, market, 'all', now, { live: true })
    assert.equal(caughtUp.live, undefined)
    assert.equal(caughtUp.latest.signature, 'damm-live')
    assert.equal(caughtUp.latest.pending, undefined)
    // A live read that fails for any reason leaves the finalized chart as it is.
    await live('after-break', 300, 1, 9, { pool: 'damm-pool', venue: 'DAMM' })
    const failing = { query: (sql, params) => /from live_trade_events/.test(sql)
      ? Promise.reject(Object.assign(Error('canceling statement due to statement timeout'), { code: '57014' })) : client.query(sql, params) }
    const broken = await readMarketChart(failing, market, 'all', now, { live: true })
    assert.equal(broken.live, undefined)
    assert.deepEqual(broken, await readMarketChart(client, market, 'all', now))
    assert.equal((await readMarketChart(client, market, 'all', now, { live: true })).live.trades, 1, 'the same rows read fine without the failure')
  } finally { await client.query('rollback'); await client.end() }
})

test('real PostgreSQL: candles open, close, high and low at the prices trades paid, each with its close\'s SOL/USD price, and the mint supply', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: testDatabase().href })
  await client.connect()
  try {
    // Arrange: two real repo.ing trades in the 03:00 bucket (sell, then buy), one in 03:01 with no SOL price recorded before it
    // ... and one not priced yet in 03:02. SOL/USD is recorded for 02:59 and 03:00 only.
    await client.query('begin')
    for (const table of CHART_TABLES) await client.query(table)
    await client.query('create temporary table stock_trade_events(slot bigint,signature text)')
    const market = { pool: 'real-curve', mint: REAL.mint }
    const at = minute => new Date(Date.UTC(2026, 8, 27, 3, minute, 30))
    const trade = (signature, slot, minute, side, paid) => client.query('insert into trade_events values($1,$2,0,$3,$4,$5,$6,$7,$8,$9)',
      [market.pool, signature, slot, at(minute), side, side === 'buy' ? REAL.buy.lamports : REAL.sell.base, side === 'buy' ? REAL.buy.base : REAL.sell.lamports,
        '18446744073709551616', paid])
    await trade('real-sell', 10, 0, 'sell', REAL.sell.price)
    await trade('real-buy', 11, 0, 'buy', REAL.buy.price)
    await client.query(`insert into sol_usd_minutes values ('2026-09-27T02:59:00Z', 180, 'test'), ('2026-09-27T03:00:00Z', 190.5, 'test'),
      ('2026-09-27T03:05:00Z', 999, 'later: never used for an earlier candle')`)
    await client.query('insert into mint_facts values($1,$2,$3,1,now())', [REAL.mint, REAL.decimals, REAL.supply])
    const end = Date.UTC(2026, 8, 27, 3, 10)
    // Act
    const first = await readMarketChart(client, market, '1h', end)
    await trade('later-buy', 12, 1, 'buy', REAL.buy.price)
    await client.query(`delete from sol_usd_minutes where minute >= '2026-09-27T03:00:00Z'`)
    await trade('unpriced', 13, 2, 'buy', null)
    const second = await readMarketChart(client, market, '1h', end)
    await client.query(`update sol_usd_minutes set minute = '2026-09-27T02:30:00Z', usd = 175 where minute = '2026-09-27T02:59:00Z'`)
    const afterGap = await readMarketChart(client, market, '1h', end)
    // Assert
    assert.deepEqual(first.candles, [{ time: Date.UTC(2026, 8, 27, 3, 0) / 1000, open: 0.000000772994682822333098, high: 0.000000772994682822333098,
      low: 0.000000770513239952588184, close: 0.000000770513239952588184, solUsd: 190.5, volumeLamports: String(133581983 + 2970000000), count: 2 }])
    assert.deepEqual([first.latest.signature, first.latest.priceSol, first.latest.solUsd], ['real-buy', 0.000000770513239952588184, 190.5])
    assert.deepEqual(first.supply, { baseUnits: REAL.supply, decimals: 6 })
    assert.deepEqual(second.candles.map(bar => [bar.close ?? null, bar.solUsd ?? null, bar.priceEvidenceMissing ?? false]),
      [[0.000000770513239952588184, 180, false], [0.000000770513239952588184, 180, false], [null, null, true]],
      'each candle at the newest SOL price at or before its close; the unpriced trade\'s bucket withholds its prices')
    assert.equal(second.candles.at(-1).volumeLamports, REAL.buy.lamports, 'its volume is kept')
    assert.deepEqual(afterGap.candles.slice(0, 2).map(bar => bar.solUsd), [175, 175],
      'a feed gap longer than the recent window still finds the newest SOL price before it, never none')
    assert.equal(second.latest, null, 'the newest trade is not priced yet, so no latest price is claimed')
    assert.equal((await readMarketChart(client, { pool: 'no-facts', mint: 'UnknownMint' }, '1h', end)).supply, null)
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
