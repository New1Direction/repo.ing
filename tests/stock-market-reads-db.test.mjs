import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { readMarketChart } from '../src/market-chart.mjs'
import { evidenceHash } from '../src/graduation-state.mjs'
import { recordChartBlock } from '../src/chart-ordering.mjs'
import { readProtocolAnalytics } from '../src/protocol-analytics.mjs'
import { readStockAnalytics } from '../src/stock-analytics.mjs'
import { isStockMarket, readStockMarketChart, stockSpotPrice } from '../src/stock-market-chart.mjs'
import { splitCurveFee } from '../src/stock-fee-policy.mjs'
import { readGraduationRace } from '../app/lib/graduation-race.mjs'
import { withStockStats } from '../app/lib/stock-market-stats.mjs'
import { readStockActivity, readStockTraders } from '../app/lib/stock-market-activity.mjs'
import { readStockCurve } from '../app/lib/stock-market-stats.mjs'
import { createStockUnitsCache } from '../app/lib/stock-units.mjs'
import { createMarketNotifications } from '../src/market-notifications.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Stock-paired market reads (docs/STOCK_QUOTES.md) on real PostgreSQL with every migration (0054's stock ledgers included).
// Golden: the SOL market list, a SOL market, SOL charts (curve and graduated), protocolStats, /stats analytics (all time and
// 24h) and the graduation race read identically before and after stock-paired markets, their stock ledgers and stray SOL
// rows filed under a stock market are added. Partition: SOL markets + stock markets = every canonical market, no overlap.
// Then the stock reads themselves: chart, row figures, per-asset totals, activity and traders.
const URL_ = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_stock_reads_test'
const key = n => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7 + 1) % 256))
const SQRT = 1n << 64n
const sqrt = n => (SQRT * BigInt(n)).toString()
const META = quoteAssetById('meta-xstock'), MSFT = quoteAssetById('msft-xstock')
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
const now = Date.now(), at = ago => new Date(now - ago)

const SOL_A = { repoId: '990100', mint: key(1), pool: key(2) }
const SOL_B = { repoId: '990101', mint: key(3), pool: key(4), damm: key(5) }
const S1 = { repoId: '94911145', mint: key(11), pool: key(12), asset: META, name: 'facebook/docusaurus' }
const S2 = { repoId: '41881900', mint: key(13), pool: key(14), damm: key(15), asset: MSFT, name: 'microsoft/vscode' }
const S3 = { repoId: '10270250', mint: key(16), pool: key(17), asset: META, name: 'facebook/react' }
const RESERVED = { repoId: '10270251', mint: key(18), pool: key(19), asset: META, name: 'facebook/unlaunched' }
const FOREIGN_POOL = key(30), OTHER_DAMM = key(31)

async function repository(db, repoId, fullName) {
  const [owner, name] = fullName.split('/')
  await db.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
    values($1,$2,$3,$4,500,20,false,now())`, [repoId, owner, name, fullName])
}
async function market(db, m, { stock = null, status = 'confirmed', indexed = true } = {}) {
  await db.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
      launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version)
    values($1,$2,$3,$4,'Launcher1111','Creator1111','Fixture','FIX',$5,10,$6,$7,$7,$8,$9,$10)`,
  [m.repoId, status, m.mint, m.pool, `launch-${m.repoId}`, indexed ? 'finalized' : null, indexed ? new Date(now - 30 * DAY) : null,
    stock?.assetId ?? null, stock?.mint ?? null, stock ? 1 : null])
}
const solTrade = (db, pool, signature, slot, time, direction, input, output, price) => db.query(`insert into trade_events(pool,signature,event_index,slot,
  traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader) values($1,$2,0,$3,$4,$5,$6,$7,$8,'Trader1111')`,
[pool, signature, slot, time, direction, input, output, price])
const stockTrade = (db, m, { venue = 'dbc', pool = m.pool, signature, index = 0, slot, time, direction = 'buy', quote, base, price, trader = 'StockTrader1' }) =>
  db.query(`insert into stock_trade_events(github_repo_id,asset_id,quote_mint,venue,pool,signature,event_index,slot,traded_at,direction,quote_amount,
    base_amount,next_sqrt_price,trader) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [m.repoId, m.asset.assetId, m.asset.mint, venue, pool, signature, index, slot, time, direction, quote, base, price, trader])
function stockFee(db, m, { pool = m.pool, signature, slot, creator, partner, time }) {
  const { launcherAmount, accumulatorAmount } = splitCurveFee({ creatorAmount: BigInt(creator), partnerAmount: BigInt(partner) })
  return db.query(`insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,
    launcher_amount,accumulator_amount,policy_version,created_at) values($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,1,$11)`,
  [m.repoId, m.asset.assetId, m.asset.mint, pool, signature, slot, creator, partner, String(launcherAmount), String(accumulatorAmount), time])
}
const observation = (percent, age) => JSON.stringify({ phase: 'CURVE', status: 'active', reserveLamports: String(85_000_000n * BigInt(percent)),
  thresholdLamports: '8500000000', remainingLamports: String(8_500_000_000n - 85_000_000n * BigInt(percent)), progressPercent: percent,
  checkedAt: at(age).toISOString(), chainTime: at(age).toISOString() })

async function seedSol(db) {
  for (const [m, name] of [[SOL_A, 'local/alpha'], [SOL_B, 'local/beta']]) { await repository(db, m.repoId, name); await market(db, m) }
  await solTrade(db, SOL_A.pool, 'sol-a1', 100, at(3 * HOUR), 'buy', '2000000000', '1000000000', sqrt(1))
  await solTrade(db, SOL_A.pool, 'sol-a2', 101, at(2 * HOUR), 'sell', '500000000', '400000000', sqrt(2))
  await solTrade(db, SOL_A.pool, 'sol-a0', 50, at(3 * DAY), 'buy', '7000000000', '9000000000', sqrt(1))
  await db.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot,created_at)
    values($1,$2,$3,'sol-fee-a1',0,30000000,'So11111111111111111111111111111111111111112','dbc_creator_quote',100,$4)`, [SOL_A.repoId, SOL_A.mint, SOL_A.pool, at(3 * HOUR)])
  await db.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at)
    values($1,'Builder1111',20000000,'So11111111111111111111111111111111111111112','sol-paid-a','settled',$2)`, [SOL_A.repoId, at(HOUR)])
  await db.query("insert into graduation_observations(github_repo_id,checked_at,status,observation) values($1,now(),'VERIFIED',$2)", [SOL_A.repoId, observation(40, 10_000)])
  // SOL_B graduated into a DAMM pool its migration evidence names: the chart continues there from the migration slot.
  await solTrade(db, SOL_B.pool, 'sol-b1', 200, at(6 * HOUR), 'buy', '3000000000', '2000000000', sqrt(1))
  const migration = { mint: SOL_B.mint, curve: SOL_B.pool, pool: SOL_B.damm, signature: 'sol-b-migration', slot: 205 }
  await db.query(`insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,reconciliation) values($1,$2,$3,205,$4,$5,'{}')`,
    [SOL_B.repoId, migration.signature, SOL_B.damm, evidenceHash(migration), JSON.stringify({ migration })])
  await db.query(`insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,next_sqrt_price,base_amount,trader)
    values($1,$2,'sol-b-damm',0,206,$3,1500000000,'sell','{}',$4,700000000,'Trader1111')`, [SOL_B.repoId, SOL_B.damm, at(5 * HOUR), sqrt(3)])
}

async function seedStock(db) {
  for (const m of [S1, S2, S3, RESERVED]) await repository(db, m.repoId, m.name)
  for (const m of [S1, S2, S3]) await market(db, m, { stock: m.asset })
  await market(db, RESERVED, { stock: RESERVED.asset, status: 'reserved', indexed: false })
  // S1 (METAx, on its curve): three curve trades, a trade filed under another pool and a DAMM trade before any graduation (both
  // never count), two fee splits plus one under another pool, observations (the newest wins), payouts.
  await stockTrade(db, S1, { signature: 's1-t1', slot: 1001, time: at(2 * HOUR), quote: '100000000', base: '50000000000', price: sqrt(1) })
  await stockTrade(db, S1, { signature: 's1-t2', slot: 1002, time: at(HOUR), direction: 'sell', quote: '40000000', base: '20000000000', price: sqrt(2) })
  await stockTrade(db, S1, { signature: 's1-t0', slot: 900, time: at(3 * DAY), quote: '300000000', base: '90000000000', price: sqrt(1) })
  await stockTrade(db, S1, { pool: FOREIGN_POOL, signature: 's1-foreign', slot: 1003, time: at(30 * MINUTE), quote: '999999999', base: '1', price: sqrt(9) })
  await stockTrade(db, S1, { venue: 'damm', pool: OTHER_DAMM, signature: 's1-damm-early', slot: 1004, time: at(20 * MINUTE), quote: '888888888', base: '1', price: sqrt(9) })
  // Exactly one fee row per swap, on the swap's own (signature, event_index); a zero-fee swap gets a zero row.
  await stockFee(db, S1, { signature: 's1-t1', slot: 1001, creator: '497000', partner: '203000', time: at(2 * HOUR) })
  await stockFee(db, S1, { signature: 's1-t2', slot: 1002, creator: '0', partner: '0', time: at(HOUR) })
  await stockFee(db, S1, { signature: 's1-t0', slot: 900, creator: '994', partner: '406', time: at(3 * DAY) })
  await stockFee(db, S1, { pool: FOREIGN_POOL, signature: 's1-foreign', slot: 1003, creator: '99400', partner: '40600', time: at(30 * MINUTE) })
  const observe = (m, { pool = m.pool, age, reserve, threshold = '10000000000', migrated = false }) => db.query(`insert into stock_graduation_observations(
    github_repo_id,asset_id,quote_mint,pool,slot,observed_at,quote_reserve,migration_threshold,is_migrated) values($1,$2,$3,$4,1,$5,$6,$7,$8)`,
  [m.repoId, m.asset.assetId, m.asset.mint, pool, at(age), reserve, threshold, migrated])
  await observe(S1, { age: HOUR, reserve: '1' })
  await observe(S1, { age: MINUTE, reserve: '3000000000' })
  // A settled payout always carries its signature, settlement time and receipt; a pending one has neither time nor receipt.
  await db.query(`insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,amount,status,signature,settled_at,receipt)
    values($1,$2,$3,'Launcher1111',100000,'settled','s1-payout',$4,'{"verified":true}'),($1,$2,$3,'Launcher1111',5000,'pending',null,null,null)`,
  [S1.repoId, META.assetId, META.mint, at(30 * MINUTE)])
  // S2 (MSFTx) graduated: a curve trade, then DAMM trades only in the pool its graduation names, from the migration slot on.
  await stockTrade(db, S2, { signature: 's2-t1', slot: 2001, time: at(5 * HOUR), quote: '200000000', base: '80000000000', price: sqrt(1) })
  await db.query(`insert into stock_graduation_events(github_repo_id,asset_id,quote_mint,dbc_pool,damm_pool,migration_signature,slot,evidence)
    values($1,$2,$3,$4,$5,'s2-migration',2005,'{}')`, [S2.repoId, MSFT.assetId, MSFT.mint, S2.pool, S2.damm])
  await stockTrade(db, S2, { venue: 'damm', pool: S2.damm, signature: 's2-d0', slot: 2004, time: at(4.5 * HOUR), quote: '777777777', base: '1', price: sqrt(9) })
  await stockTrade(db, S2, { venue: 'damm', pool: S2.damm, signature: 's2-d1', slot: 2006, time: at(4 * HOUR), direction: 'sell', quote: '50000000', base: '9000000000', price: sqrt(3) })
  await stockTrade(db, S2, { venue: 'damm', pool: OTHER_DAMM, signature: 's2-dx', slot: 2007, time: at(3.5 * HOUR), quote: '666666666', base: '1', price: sqrt(9) })
  const checkpoint = (pool, side, slot, credit, launcher) => db.query(`insert into stock_damm_fee_checkpoints(github_repo_id,asset_id,quote_mint,damm_pool,side,
    position,slot,cumulative_earned,cumulative_claimed,credit,launcher_cumulative,launcher_credit,accumulator_credit,policy_version,created_at)
    values($1,$2,$3,$4,$5,'Position1111',$6,$7,0,$7,$8,$8,$9,1,$10)`, [S2.repoId, MSFT.assetId, MSFT.mint, pool, side, slot, credit, launcher, String(BigInt(credit) - BigInt(launcher)), at(3 * HOUR)])
  await checkpoint(S2.damm, 'creator', 2010, '497', '150')
  await checkpoint(S2.damm, 'partner', 2010, '100', '0')
  await checkpoint(OTHER_DAMM, 'creator', 2011, '99999', '30181')
  await observe(S2, { age: MINUTE, reserve: '10000000000', migrated: true })
  // A reservation that never launched: its rows (allowed by its stamp) never count anywhere.
  await stockTrade(db, RESERVED, { signature: 'reserved-t1', slot: 3001, time: at(HOUR), quote: '555555555', base: '1', price: sqrt(1) })
  // Stray SOL rows filed under a stock market (what a SOL path writing for a stock market would leave): SOL reads ignore them.
  await solTrade(db, S1.pool, 'stray-sol-trade', 1005, at(HOUR), 'buy', '9000000000', '1', sqrt(5))
  await db.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot,created_at)
    values($1,$2,$3,'stray-sol-fee',0,70000000,'So11111111111111111111111111111111111111112','dbc_creator_quote',1005,$4)`, [S1.repoId, S1.mint, S1.pool, at(HOUR)])
  await db.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at)
    values($1,'Builder1111',60000000,'So11111111111111111111111111111111111111112','stray-sol-claim','settled',$2)`, [S1.repoId, at(HOUR)])
  await db.query("insert into graduation_observations(github_repo_id,checked_at,status,observation) values($1,now(),'VERIFIED',$2)", [S1.repoId, observation(70, 10_000)])
  await db.query(`insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,reconciliation) values($1,'stray-migration',$2,1006,'hash','{}','{}')`,
    [S3.repoId, key(40)])
}

// Every SOL read this PR must leave unchanged. server.mjs is imported fresh per snapshot, so no memoized list carries over.
async function snapshot(db, tag) {
  const server = await import(`../app/lib/server.mjs?${tag}`)
  const listed = await server.listMarkets()
  assert.equal(listed.unavailable, undefined, `${tag}: ${listed.unavailable}`)
  const a = (await server.marketByMint(SOL_A.mint)).market, b = (await server.marketByMint(SOL_B.mint)).market
  const charts = {}
  for (const range of ['all', '24h', '1h']) charts[range] = [await readMarketChart(db, a, range, now), await readMarketChart(db, b, range, now)]
  return { server, markets: listed.markets, a, b, charts, stats: await server.protocolStats(),
    all: await readProtocolAnalytics(db, { now: new Date(now) }), day: await readProtocolAnalytics(db, { now: new Date(now), range: '24h' }),
    race: await readGraduationRace(db, { now, excluded: new Set() }) }
}

test('stock-paired markets: SOL reads unchanged, partitioned totals, and the stock ledger reads', { timeout: 180_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  // No network: RPC reads fail at once (port 1) and the price feed is never called.
  process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
  const realFetch = globalThis.fetch
  globalThis.fetch = async url => { if (String(url).startsWith('http://127.0.0.1:1')) return realFetch(url); throw Error('network is off in this test') }
  const admin = new pg.Pool({ connectionString: URL_.replace(/repoing_stock_reads_test$/, 'postgres') })
  let db, created = false
  try {
    await admin.query('drop database if exists repoing_stock_reads_test with (force)')
    await admin.query('create database repoing_stock_reads_test'); created = true
    db = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(db), { migrationsFolder: 'drizzle' })
    await seedSol(db)
    const before = await snapshot(db, 'before')
    assert.deepEqual((await readStockAnalytics(db, { now: new Date(now) })), { range: 'all', since: null, until: new Date(now).toISOString(), hasActivity: false, assets: [] })
    await seedStock(db)
    const after = await snapshot(db, 'after')

    await t.test('golden: the SOL list, SOL markets, SOL charts, protocolStats, /stats and the race read exactly as before', () => {
      assert.ok(before.markets.length === 2 && before.a && before.charts.all[0].totalTrades === 3 && before.charts.all[1].graduation, 'fixture is live')
      assert.deepEqual(after.markets.filter(row => !isStockMarket(row)), before.markets)
      assert.deepEqual(after.a, before.a); assert.deepEqual(after.b, before.b)
      assert.deepEqual(after.charts, before.charts)
      assert.deepEqual(after.stats, before.stats)
      assert.deepEqual(after.all, before.all); assert.deepEqual(after.day, before.day)
      assert.deepEqual(after.race, before.race)
      assert.deepEqual(before.race.map(racer => racer.repoId), [SOL_A.repoId], 'the stock market\'s stray SOL observation never races')
      assert.deepEqual(after.stats.stats, { markets: '2', trades: '4', volumeLamports: '12400000000', earnedLamports: '30000000', paidLamports: '20000000' })
      assert.deepEqual([after.all.totals.markets, after.all.totals.graduated, after.all.totals.trades], [2, 1, 5])
      // SOL rows carry no stock fields at all.
      for (const row of after.markets.filter(row => !isStockMarket(row))) for (const field of ['stock', 'quoteAssetId', 'quoteMint']) assert.equal(field in row, false, field)
    })

    await t.test('partition: SOL markets + stock markets = every canonical market, no overlap', async () => {
      const { rows: [{ all, sol, stock }] } = await db.query(`select count(*)::int as all, count(*) filter (where quote_asset_id is null)::int as sol,
        count(*) filter (where quote_asset_id is not null)::int as stock from markets where status='confirmed' and indexed_at is not null and launch_finality='finalized'`)
      assert.deepEqual({ all, sol, stock }, { all: 5, sol: 2, stock: 3 })
      const stockTotals = await readStockAnalytics(db, { now: new Date(now) })
      assert.equal(after.all.totals.markets + stockTotals.assets.reduce((sum, asset) => sum + asset.markets, 0), all)
      assert.equal(Number(after.stats.stats.markets) + stock, all)
      const listedStock = after.markets.filter(isStockMarket), listedSol = after.markets.filter(row => !isStockMarket(row))
      assert.equal(listedStock.length + listedSol.length, all)
      assert.deepEqual(listedStock.map(row => row.repoId).sort(), [S1.repoId, S2.repoId, S3.repoId].sort())
    })

    const s1 = (await after.server.marketByMint(S1.mint)).market, s2 = (await after.server.marketByMint(S2.mint)).market
    const s3 = (await after.server.marketByMint(S3.mint)).market

    await t.test('stock chart: both venues bound to the market, priced in the stock\'s decimals, raw stock volume', async () => {
      const curve = await readStockMarketChart(db, s1, 'all', now)
      assert.deepEqual(curve.quote, { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8 })
      assert.equal(curve.totalTrades, 3)
      assert.deepEqual(curve.trades.map(trade => trade.signature), ['s1-t0', 's1-t1', 's1-t2'])
      assert.equal(curve.volume24hQuote, '140000000')
      assert.equal(curve.latest.signature, 's1-t2'); assert.equal(curve.latest.priceQuote, 0.04)
      assert.equal(curve.latest.priceQuote, stockSpotPrice(sqrt(2), 6, 8))
      assert.deepEqual(Object.keys(curve.trades[0]).sort(), ['direction', 'eventIndex', 'priceQuote', 'quoteAmount', 'signature', 'tokenBaseUnits', 'tradedAt', 'venue'])
      assert.equal(curve.candles.reduce((sum, bar) => sum + BigInt(bar.volumeQuote), 0n), 440000000n)
      assert.equal(curve.source, 'finalized-dbc-swaps'); assert.equal(curve.graduation, null)
      assert.doesNotMatch(JSON.stringify(curve), /Lamports|priceSol|solLamports/)
      const graduated = await readStockMarketChart(db, s2, 'all', now)
      assert.deepEqual(graduated.trades.map(trade => [trade.signature, trade.venue]), [['s2-t1', 'DBC'], ['s2-d1', 'DAMM']])
      assert.deepEqual(graduated.graduation, { pool: S2.damm, slot: '2005', signature: 's2-migration', indexedTrades: 1 })
      assert.equal(graduated.latest.priceQuote, 0.09); assert.equal(graduated.volume24hQuote, '250000000')
      assert.equal(graduated.source, 'finalized-dbc-and-damm-swaps')
      assert.equal((await readStockMarketChart(db, s3, 'all', now)).totalTrades, 0)
      await assert.rejects(readStockMarketChart(db, after.a, 'all', now), /NOT_A_STOCK_MARKET/)
    })

    await t.test('stock row figures: raw price and volume, progress from the stock tables, no SOL value claimed', async () => {
      const rows = new Map(after.markets.map(row => [row.repoId, row]))
      const row1 = rows.get(S1.repoId), row2 = rows.get(S2.repoId), row3 = rows.get(S3.repoId)
      // The list reads today's units through the RPC, which is off here: the raw figures stay, the converted ones are null.
      assert.deepEqual(row1.stock, { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, price: 0.04, volume24h: '140000000', uiMultiplier: null, usdPrice: null })
      assert.equal(row1.priceSol, null); assert.equal(row1.volume24hLamports, null)
      assert.equal(row1.bondingPercent, 30); assert.equal(row1.graduated, false)
      assert.deepEqual([row2.stock.price, row2.stock.volume24h, row2.bondingPercent, row2.graduated], [0.09, '250000000', 100, true])
      assert.deepEqual([row3.stock.price, row3.stock.volume24h, row3.bondingPercent, row3.graduated], [null, '0', null, false])
      // The token page's single read carries the same figures, without the RPC.
      assert.deepEqual(s1.stock, row1.stock); assert.equal(s1.bondingPercent, 30); assert.equal(s1.priceSol, null)
      // With today's units in the cache, the row carries them as given.
      const units = { uiMultiplier: '1.0028515433272898', usdPrice: 712.5, validForSeconds: 120 }
      const cache = createStockUnitsCache({ info: async id => ({ assetId: id, symbol: 'METAx', decimals: 8, ...units }) })
      await cache.within('meta-xstock', {})
      const [withUnits] = await withStockStats([s1], { db, connection: {}, withUnits: true, now, units: cache })
      assert.deepEqual([withUnits.stock.uiMultiplier, withUnits.stock.usdPrice], [units.uiMultiplier, units.usdPrice])
      // A stale newest observation draws no progress.
      assert.equal((await withStockStats([s1], { db, now: now + 10 * MINUTE }))[0].bondingPercent, null)
      // A stamp the registry no longer matches is unavailable on its own; other rows keep their figures.
      const broken = { ...s3, quoteMint: MSFT.mint }
      const [bad, good] = await withStockStats([broken, s1], { db, now })
      assert.equal(bad.stock.unavailable, true); assert.equal(bad.priceSol, null); assert.equal(good.stock.price, 0.04)
      // A SOL-only list is returned as it came, with no query.
      const solOnly = [after.a, after.b]
      assert.equal(await withStockStats(solOnly, { db: { query: () => assert.fail('no query for SOL rows') } }), solOnly)
    })

    await t.test('per-asset totals: volume, fees, launcher and accumulator credits in each stock, canonical markets only', async () => {
      const all = await readStockAnalytics(db, { now: new Date(now) })
      assert.equal(all.hasActivity, true)
      assert.deepEqual(all.assets, [
        { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, mint: META.mint, markets: 2, trades: 3, volume: '440000000', fees: '701400',
          launcher: '150300', accumulator: '551100', active: true },
        { assetId: 'msft-xstock', symbol: 'MSFTx', decimals: 8, mint: MSFT.mint, markets: 1, trades: 2, volume: '250000000', fees: '597',
          launcher: '150', accumulator: '447', active: true },
      ])
      const day = await readStockAnalytics(db, { now: new Date(now), range: '24h' })
      assert.deepEqual(day.assets.map(({ assetId, trades, volume, fees, launcher, accumulator }) => ({ assetId, trades, volume, fees, launcher, accumulator })), [
        { assetId: 'meta-xstock', trades: 2, volume: '140000000', fees: '700000', launcher: '150000', accumulator: '550000' },
        { assetId: 'msft-xstock', trades: 2, volume: '250000000', fees: '597', launcher: '150', accumulator: '447' },
      ])
      // Every fee unit is routed exactly once.
      for (const asset of all.assets) assert.equal(BigInt(asset.launcher) + BigInt(asset.accumulator), BigInt(asset.fees))
    })

    await t.test('activity and traders: stock trades and fee splits of the market only, settled launcher payouts, today\'s units', async () => {
      const cache = createStockUnitsCache({ info: async assetId => { assert.equal(assetId, 'meta-xstock'); return { assetId, uiMultiplier: '1.0028', validForSeconds: 120 } } })
      const activity = await readStockActivity(db, s1, { connection: null, units: cache })
      assert.deepEqual(activity.quote, { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, uiMultiplier: '1.0028' })
      assert.deepEqual(activity.trades.map(trade => [trade.signature, trade.inputBaseUnits, trade.outputBaseUnits]),
        [['s1-t2', '20000000000', '40000000'], ['s1-t1', '100000000', '50000000000'], ['s1-t0', '300000000', '90000000000']])
      // The zero-fee swap's zero row is left out; each shown row takes its own swap's time.
      assert.deepEqual(activity.fees.map(fee => [fee.signature, fee.launcherBaseUnits, fee.accumulatorBaseUnits]), [['s1-t1', '150000', '550000'], ['s1-t0', '300', '1100']])
      assert.deepEqual(activity.fees.map(fee => fee.occurredAt.toISOString()), [at(2 * HOUR).toISOString(), at(3 * DAY).toISOString()])
      assert.deepEqual(activity.payouts.map(payout => [payout.signature, payout.amountBaseUnits]), [['s1-payout', '100000']])
      // Without the stock's multiplier the feed still lists every row; its stock amounts wait ('—' on the page).
      const unitless = await readStockActivity(db, s1, { units: createStockUnitsCache({ info: async () => { throw Error('mint read failed') } }) })
      assert.equal(unitless.quote.uiMultiplier, null); assert.equal(unitless.trades.length, 3)
      assert.deepEqual((await readStockTraders(db, s2, 20)).map(row => row.signature), ['s2-d1', 's2-t1'])
    })

    await t.test('graduation bar: fresh progress of the market\'s own curve in raw stock units, or its recorded graduation', async () => {
      const curve = await readStockCurve(db, s1, now)
      assert.deepEqual({ ...curve, checkedAt: undefined, validUntil: undefined }, { quote: { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8 }, phase: 'CURVE',
        status: 'active', reserve: '3000000000', threshold: '10000000000', remaining: '7000000000', progressPercent: 30, destination: null,
        checkedAt: undefined, validUntil: undefined })
      assert.equal(Date.parse(curve.validUntil) - Date.parse(curve.checkedAt), 300_000)
      await assert.rejects(readStockCurve(db, s1, now + 10 * MINUTE), /STALE_PROGRESS/)
      await assert.rejects(readStockCurve(db, s3, now), /PROGRESS_NOT_INDEXED/)
      const graduated = await readStockCurve(db, s2, now)
      assert.deepEqual([graduated.phase, graduated.status, graduated.progressPercent, graduated.destination],
        ['GRADUATED', 'graduated', 100, { pool: S2.damm, url: `https://app.meteora.ag/dammv2/${S2.damm}` }])
      assert.doesNotMatch(JSON.stringify([curve, graduated]), /Lamports/)
    })

    await t.test('live updates: a stock trade on a live market reaches the hub as a trade hint; a reservation\'s does not', async () => {
      const hub = createMarketNotifications({ connectionString: URL_ }), seen = []
      try {
        const stop = hub.subscribe(S1.mint, event => seen.push(event))
        const until = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), JSON.stringify(seen)) }
        await until(() => seen.length === 1)
        await stockTrade(db, RESERVED, { signature: 'reserved-t2', slot: 3002, time: at(MINUTE), quote: '1', base: '1', price: sqrt(1) })
        await stockTrade(db, S1, { signature: 's1-live', slot: 1100, time: at(MINUTE), quote: '1', base: '1', price: sqrt(1) })
        await until(() => seen.length === 2)
        assert.deepEqual(seen, [{ mint: S1.mint, kind: 'resync' }, { mint: S1.mint, kind: 'trade' }])
        stop()
      } finally { hub.close() }
    })

    await t.test('ordering: different transactions in one slot withhold the latest price until the block order is known', async () => {
      const [first, second] = [bs58.encode(Buffer.alloc(64, 7)), bs58.encode(Buffer.alloc(64, 9))]
      await stockTrade(db, S3, { signature: first, slot: 5000, time: at(10 * MINUTE), quote: '1000', base: '1', price: sqrt(1) })
      await stockTrade(db, S3, { signature: second, slot: 5000, time: at(10 * MINUTE), quote: '2000', base: '1', price: sqrt(2) })
      const pending = await readStockMarketChart(db, s3, '1h', now)
      assert.equal(pending.latest, null); assert.equal(pending.latestOrderingPending, true)
      assert.equal(pending.candles.at(-1).orderingPending, true); assert.equal(pending.candles.at(-1).volumeQuote, '3000')
      await recordChartBlock(db, { slot: 5000, blockhash: 'verified', previousBlockhash: 'previous', parentSlot: 4999, signatures: [second, first] })
      const resolved = await readStockMarketChart(db, s3, '1h', now)
      assert.equal(resolved.latestOrderingPending, false); assert.equal(resolved.latest.signature, first); assert.equal(resolved.latest.priceQuote, 0.01)
      assert.deepEqual([resolved.candles.at(-1).open, resolved.candles.at(-1).close], [0.04, 0.01])
      // A graduation record naming another curve stops the chart instead of splicing in another pool.
      await db.query(`insert into stock_graduation_events(github_repo_id,asset_id,quote_mint,dbc_pool,damm_pool,migration_signature,slot,evidence)
        values($1,$2,$3,$4,$5,'s3-migration',6000,'{}')`, [S3.repoId, META.assetId, META.mint, FOREIGN_POOL, key(41)])
      await assert.rejects(readStockMarketChart(db, s3, 'all', now), /CHART_MIGRATION_MISMATCH/)
    })
  } finally {
    globalThis.fetch = realFetch
    await globalThis.__gitfunPool?.end().catch(() => {}); globalThis.__gitfunPool = undefined
    await db?.end()
    if (created) await dropTestDatabase(admin, 'repoing_stock_reads_test')
    await admin.end()
  }
})
