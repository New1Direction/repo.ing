import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { quoteAssetById, quoteStamp, resolveQuoteAsset } from '../src/quote-assets.mjs'
import { chartSpotPrice, readMarketChart } from '../src/market-chart.mjs'
import { isStockMarket, readStockMarketChart, stockChartBar, stockChartMigration, stockQuoteOf, stockSpotPrice, stockTradeScope, stockTradeScopeParams } from '../src/stock-market-chart.mjs'
import { formatQuoteAmount, formatStockCompact, stockAmountLabel, stockDisplayUnits, stockRawUsd, stockRowDisplay } from '../app/lib/stock-display.mjs'
import { chartQuote } from '../app/lib/chart-quote.mjs'
import { chartSeries } from '../app/lib/chart-display.mjs'
import { phoneMarketSummary, stockMarketSummary } from '../app/lib/phone-market-summary.mjs'
import { stockCurveProgress, stockGraduation, stockRowStats, unavailableStockRow, withStockStats } from '../app/lib/stock-market-stats.mjs'
import { UNITS_WAIT_MS, createStockUnitsCache, unitsWithin } from '../app/lib/stock-units.mjs'
import { readOnlyTools } from '../app/lib/mcp-read-tools.mjs'
import { activityEvents } from '../app/lib/market-activity.mjs'
import { chartReader } from '../app/lib/market-charts.mjs'
import { homeMarketTabs } from '../app/lib/market-order.mjs'
import { selectMoreMarkets } from '../app/lib/more-markets.mjs'
import { formatSolDisplay } from '../app/lib/format.mjs'

// Stock-paired market reads (docs/STOCK_QUOTES.md): prices in the stock's decimals, amounts shown as wallets show the stock
// (raw × today's multiplier, truncated), USD at the stock's own price per whole raw token, and SOL paths unchanged.
const SQRT = 1n << 64n
const META = quoteAssetById('meta-xstock')
const MULTIPLIER = '1.0028515433272898'
const INFO = { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, uiMultiplier: MULTIPLIER, validForSeconds: 120, usdPrice: 712.5 }
const stamped = { repoId: '94911145', mint: 'MarketMint1111111111111111111111111111111', pool: 'CurvePool11111111111111111111111111111111',
  ...quoteStamp(resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })) }

test('stock spot price: Q64.64 sqrt price in the stock\'s decimals (8), never SOL\'s 9', () => {
  assert.equal(stockSpotPrice(SQRT.toString(), 6, 8), 0.01)
  assert.equal(stockSpotPrice((SQRT * 2n).toString(), 6, 8), 0.04)
  // The same sqrt price is 10× cheaper in SOL's 9 decimals: a SOL reading of a stock pool would be off by 10×.
  assert.equal(chartSpotPrice(SQRT.toString()), 0.001)
  const raw = '184467440737095516'
  assert.equal(stockSpotPrice(raw, 6, 8), getPriceFromSqrtPrice(new BN(raw), 6, 8).toNumber())
  assert.throws(() => stockSpotPrice(raw), /decimals/, 'the quote decimals are required')
  assert.throws(() => stockSpotPrice(raw, 6, 19), /decimals/)
  assert.throws(() => stockSpotPrice('0', 6, 8), /Invalid chart price evidence/)
  assert.throws(() => stockSpotPrice('-1', 6, 8), /Invalid chart price evidence/)
  assert.throws(() => stockSpotPrice('12abc', 6, 8), /Invalid chart price evidence/)
})

test('stock chart bars keep raw stock volume and withhold prices while ordering is unproven', () => {
  const bar = stockChartBar({ time: '600', open: SQRT.toString(), high: (SQRT * 2n).toString(), low: SQRT.toString(), close: (SQRT * 2n).toString(), volume: '9007199254740993', count: '3' }, 8)
  assert.deepEqual(bar, { time: 600, open: 0.01, high: 0.04, low: 0.01, close: 0.04, volumeQuote: '9007199254740993', count: 3 })
  assert.deepEqual(stockChartBar({ time: '60', volume: '5', count: '2', ambiguous: true }, 8), { time: 60, volumeQuote: '5', count: 2, orderingPending: true, priceEvidenceMissing: false })
  assert.throws(() => stockChartBar({ time: 'x', volume: '1', count: '1' }, 8), /bar evidence/)
  assert.throws(() => stockChartBar({ time: '1', volume: '1', count: '0' }, 8), /trade count/)
  assert.equal(JSON.stringify(bar).includes('Lamports'), false)
})

test('a stock chart joins only the DAMM pool its own recorded graduation names', () => {
  const quote = stockQuoteOf(stamped)
  const row = { github_repo_id: stamped.repoId, asset_id: 'meta-xstock', quote_mint: META.mint, dbc_pool: stamped.pool, damm_pool: 'DammPool', migration_signature: 'sig', slot: '42' }
  assert.equal(stockChartMigration(stamped, quote, null), null)
  assert.deepEqual(stockChartMigration(stamped, quote, row), { pool: 'DammPool', slot: '42', signature: 'sig' })
  for (const wrong of [{ github_repo_id: '1' }, { asset_id: 'msft-xstock' }, { quote_mint: quoteAssetById('msft-xstock').mint }, { dbc_pool: 'OtherCurve' },
    { damm_pool: null }, { migration_signature: '' }, { slot: null }]) assert.throws(() => stockChartMigration(stamped, quote, { ...row, ...wrong }), /CHART_MIGRATION_MISMATCH/)
  // The predicate binds the stamp, the curve and the recorded pool from the migration slot, from the given parameter on.
  assert.match(stockTradeScope('t', 4), /t\.github_repo_id=\$4 and t\.asset_id=\$5 and t\.quote_mint=\$6/)
  assert.match(stockTradeScope('t', 4), /t\.venue='dbc' and t\.pool=\$7\) or \(t\.venue='damm' and t\.pool=\$8 and t\.slot>=\$9/)
  assert.deepEqual(stockTradeScopeParams(stamped, quote, null), [stamped.repoId, 'meta-xstock', META.mint, stamped.pool, null, null])
})

test('quote dispatch: stamped markets read the stock ledger, every other market the SOL chart as before', async () => {
  assert.equal(isStockMarket(stamped), true)
  assert.equal(isStockMarket({ repoId: '1', quoteAssetId: null, quoteMint: null }), false)
  assert.equal(isStockMarket({ repoId: '1' }), false)
  assert.equal(chartReader({ repoId: '1', quoteAssetId: null, quoteMint: null }), readMarketChart)
  assert.equal(chartReader(stamped), readStockMarketChart)
  assert.throws(() => stockQuoteOf({ repoId: '1' }), /NOT_A_STOCK_MARKET/)
  assert.throws(() => stockQuoteOf({ ...stamped, quoteMint: quoteAssetById('msft-xstock').mint }), /differs/)
})

test('display units: raw × today\'s multiplier, truncated as Token-2022 truncates; USD at the price per whole raw token', () => {
  const units = stockDisplayUnits(INFO)
  assert.equal(units.symbol, 'METAx'); assert.equal(units.decimals, 8); assert.equal(units.multiplier, Number(MULTIPLIER)); assert.equal(units.usdPrice, 712.5)
  // 1 METAx raw is 1.00285154 METAx in a wallet (truncated at the 8th place).
  assert.equal(stockAmountLabel('100000000', units), '1 METAx')
  assert.equal(stockAmountLabel('12345678900', units), '123.81 METAx')
  assert.equal(stockAmountLabel('3', stockDisplayUnits({ ...INFO, uiMultiplier: '1.5' })), '<0.000001 METAx')
  assert.equal(stockAmountLabel('150', stockDisplayUnits({ ...INFO, uiMultiplier: '1.5' })), '0.00000225 METAx'.replace('0.00000225', formatQuoteAmount('225', 8)))
  // USD never applies the display multiplier: Jupiter's xStock price is for the raw amount (src/tip-tokens.mjs).
  assert.equal(stockRawUsd('100000000', units), 712.5)
  assert.equal(stockRawUsd('100000000', stockDisplayUnits({ ...INFO, usdPrice: null })), null)
  for (const unusable of [null, {}, { ...INFO, uiMultiplier: null }, { ...INFO, uiMultiplier: '-1' }, { ...INFO, decimals: 19 }, { ...INFO, symbol: 7 }]) {
    assert.equal(stockDisplayUnits(unusable), null)
  }
  assert.equal(stockAmountLabel('100', null), '—')
})

test('stock amounts read like SOL amounts: two places from one up, about four significant digits below, never 0', () => {
  assert.equal(formatQuoteAmount('100000000', 8), '1')
  assert.equal(formatQuoteAmount('123456789', 8), '1.23')
  assert.equal(formatQuoteAmount('1234567', 8), '0.01235')
  assert.equal(formatQuoteAmount('99', 8), '<0.000001')
  assert.equal(formatQuoteAmount('0', 8), '0')
  assert.equal(formatQuoteAmount(null, 8), '—')
  // With SOL's 9 decimals the rule is formatSolDisplay's.
  for (const raw of ['999', '1000', '123456789', '2000000000', '987654321012']) assert.equal(formatQuoteAmount(raw, 9), formatSolDisplay(raw))
  assert.equal(formatStockCompact(40_114_061.7, 'METAx'), '40.1m METAx')
  assert.equal(formatStockCompact(0.004, 'METAx'), '<0.01 METAx')
  assert.equal(formatStockCompact(NaN, 'METAx'), '—')
})

test('a stock row shows USD at the stock\'s price, else the stock as wallets show it, and nothing without units', () => {
  const stock = { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, price: 0.04, volume24h: '140000000', uiMultiplier: MULTIPLIER, usdPrice: 712.5 }
  const usd = stockRowDisplay(stock)
  assert.equal(usd.cap, '$28.5b'); assert.match(usd.capTitle, /40\.1m METAx.*USD estimate at the current METAx price/)
  // Volume in the stock, as SOL rows show SOL; its USD estimate (1.4 × $712.5) in the title.
  assert.equal(usd.volume, '1.4 METAx'); assert.equal(usd.volumeTitle, '1.4 METAx traded in 24 hours (≈ $997 at the current METAx price)')
  const noPrice = stockRowDisplay({ ...stock, usdPrice: null })
  assert.equal(noPrice.cap, '40.1m METAx'); assert.equal(noPrice.volume, '1.4 METAx')
  const noUnits = stockRowDisplay({ ...stock, uiMultiplier: null, usdPrice: null })
  assert.deepEqual([noUnits.cap, noUnits.volume], [null, '—'])
  assert.deepEqual([stockRowDisplay({ ...stock, price: null }).cap, stockRowDisplay({ unavailable: true }).volume], [null, '—'])
})

test('chart accessors: SOL reads exactly the SOL fields; a stock pair waits for its own units and never reads SOL fields', () => {
  const sol = chartQuote(null, { solUsd: 150 })
  const solTrade = { priceSol: 0.001, solLamports: '2500000000', priceQuote: 99, quoteAmount: '1' }
  assert.deepEqual([sol.symbol, sol.stock, sol.ready, sol.priceScale, sol.usdPerUnit], ['SOL', false, true, 1, 150])
  assert.equal(sol.price(solTrade), 0.001); assert.equal(sol.price(null), null)
  assert.equal(sol.amountLabel(sol.tradeAmount(solTrade)), `${formatSolDisplay('2500000000')} SOL`)
  assert.equal(sol.volume24h({ volume24hLamports: '7', volume24hQuote: '9' }), '7')
  const bar = { time: 60, open: 1, high: 1, low: 1, close: 1, volumeLamports: '2000000000', volumeQuote: '300000000' }
  assert.equal(sol.barVolume(bar), 2); assert.equal(sol.barVolumeAmount(bar), formatSolDisplay('2000000000'))
  assert.deepEqual(chartSeries({ interval: 60, candles: [bar] }).volumes, chartSeries({ interval: 60, candles: [bar] }, 1, sol.barVolume).volumes)
  const quote = { assetId: 'meta-xstock', symbol: 'METAx', name: 'Meta xStock', decimals: 8, mint: META.mint }
  const pending = chartQuote(quote, { solUsd: 150 })
  assert.deepEqual([pending.symbol, pending.stock, pending.ready, pending.priceScale, pending.usdPerUnit], ['METAx', true, false, null, null])
  assert.equal(pending.amountLabel('300000000'), '—'); assert.equal(pending.barVolumeAmount(bar), '—')
  assert.equal(chartQuote(quote, { quote: { ...INFO, assetId: 'msft-xstock' } }).ready, false, 'another asset\'s units are never used')
  assert.equal(chartQuote(quote, { quote: { ...INFO, decimals: 6 } }).ready, false)
  const stock = chartQuote(quote, { solUsd: 150, quote: INFO })
  assert.deepEqual([stock.ready, stock.priceScale, stock.usdPerUnit], [true, Number(MULTIPLIER), 712.5])
  assert.equal(stock.price(solTrade), 99)
  assert.equal(stock.amountLabel(stock.tradeAmount({ quoteAmount: '300000000' })), '3.01 METAx', '3 raw METAx is 3.00855462 in a wallet')
  assert.equal(stock.volume24h({ volume24hLamports: '7', volume24hQuote: '9' }), '9')
  // 300000000 × 1.0028515433272898 = 300855462.998…, truncated as Token-2022 truncates.
  assert.equal(stock.barVolume(bar), 300855462 / 1e8)
  assert.deepEqual(chartSeries({ interval: 60, candles: [bar] }, stock.priceScale, stock.barVolume).volumes[0].value, 3.00855462)
  const broken = chartQuote({ assetId: 'meta-xstock', unavailable: true }, { quote: INFO })
  assert.deepEqual([broken.symbol, broken.ready], ['meta-xstock', false])
})

test('phone summary: a stock pair in USD at its own price, else in the stock; SOL unchanged', () => {
  const quote = { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8 }
  const metrics = { solUsd: 150, quote: INFO, supplyBaseUnits: '1000000000000000', supplyDecimals: 6 }
  const chart = { latest: { priceQuote: 0.04 }, volume24hQuote: '140000000', interval: 3600, candles: [] }
  assert.deepEqual(stockMarketSummary({ quote, chart, metrics }), { price: '$28.5', change: null, marketCap: '$28.5b', volume: '$997', spark: [] })
  assert.deepEqual(stockMarketSummary({ quote, chart, metrics: { ...metrics, quote: { ...INFO, usdPrice: null } } }),
    { price: '0.040114 METAx', change: null, marketCap: '40.1m METAx', volume: '1.4 METAx', spark: [] })
  // Before the units arrive: the row's raw figures exist, but nothing is shown converted with a missing multiplier.
  assert.deepEqual(stockMarketSummary({ quote, stock: { price: 0.04, volume24h: '1' } }), { price: '—', change: null, marketCap: '—', volume: '—', spark: [] })
  assert.equal(stockMarketSummary({ quote, stock: { price: 0.04, volume24h: '140000000' }, metrics }).volume, '$997')
  // A SOL summary never reads stock fields.
  assert.deepEqual(phoneMarketSummary({ priceSol: null, volume24hLamports: null, chart: { latest: { priceQuote: 0.04 }, volume24hQuote: '9', interval: 60, candles: [] }, metrics: { solUsd: 150 } }),
    { price: '—', change: null, marketCap: '—', volume: '—', spark: [] })
})

test('stock graduation progress: fresh observations of the market\'s own curve, or its recorded graduation', () => {
  const now = Date.parse('2026-10-04T12:00:00Z'), quote = stockQuoteOf(stamped)
  const facts = { observedPool: stamped.pool, quoteReserve: '3000000000', migrationThreshold: '10000000000', isMigrated: false, observedAt: new Date(now - 60_000) }
  const curve = stockCurveProgress(facts, stamped, quote, null, now)
  assert.deepEqual([curve.phase, curve.status, curve.progressPercent, curve.reserve, curve.remaining], ['CURVE', 'active', 30, '3000000000', '7000000000'])
  assert.equal(curve.validUntil, new Date(now - 60_000 + 300_000).toISOString())
  assert.equal(stockCurveProgress({ ...facts, quoteReserve: '10000000000' }, stamped, quote, null, now).status, 'migrating')
  assert.equal(stockCurveProgress({ ...facts, isMigrated: true }, stamped, quote, null, now).progressPercent, 100)
  assert.throws(() => stockCurveProgress(null, stamped, quote, null, now), /PROGRESS_NOT_INDEXED/)
  for (const stale of [{ observedAt: new Date(now - 301_000) }, { observedAt: new Date(now + 6_000) }, { observedPool: 'OtherCurve' }]) {
    assert.throws(() => stockCurveProgress({ ...facts, ...stale }, stamped, quote, null, now), /STALE_PROGRESS/)
  }
  assert.throws(() => stockCurveProgress({ ...facts, migrationThreshold: '0' }, stamped, quote, null, now), /INVALID_THRESHOLD/)
  const graduated = stockCurveProgress(null, stamped, quote, { pool: 'DammPool', slot: '9', signature: 's' }, now)
  assert.deepEqual([graduated.phase, graduated.destination], ['GRADUATED', { pool: 'DammPool', url: 'https://app.meteora.ag/dammv2/DammPool' }])
  assert.deepEqual(stockGraduation(facts, stamped, quote, null, now), { bondingPercent: 30, graduated: false })
  assert.deepEqual(stockGraduation({ ...facts, observedPool: 'x' }, stamped, quote, null, now), { bondingPercent: null, graduated: false })
  assert.deepEqual(stockGraduation(null, stamped, quote, { pool: 'DammPool' }, now), { bondingPercent: 100, graduated: true })
})

test('stock row figures never claim a SOL value; SOL rows pass through without a query', async () => {
  const quote = stockQuoteOf(stamped), now = Date.now()
  const row = stockRowStats(stamped, quote, { lastSqrtPrice: (SQRT * 2n).toString(), volume24h: '140000000' }, null, INFO, now)
  assert.deepEqual(row, { priceSol: null, volume24hLamports: null, bondingPercent: null, graduated: false,
    stock: { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, price: 0.04, volume24h: '140000000', uiMultiplier: MULTIPLIER, usdPrice: 712.5 } })
  assert.equal(stockRowStats(stamped, quote, { lastSqrtPrice: 'garbage' }, null, null, now).stock.price, null)
  assert.deepEqual(unavailableStockRow(stamped).stock, { assetId: 'meta-xstock', symbol: 'METAx', unavailable: true })
  const sol = [{ repoId: '1', pool: 'p', priceSol: 0.001 }]
  assert.equal(await withStockStats(sol, { db: { query: () => assert.fail('no query for SOL rows') } }), sol)
  // A database failure leaves stamped rows unavailable and SOL rows as they were.
  const mixed = await withStockStats([...sol, stamped], { db: { query: async () => { throw Error('down') } } })
  assert.equal(mixed[0], sol[0]); assert.equal(mixed[1].stock.unavailable, true); assert.equal(mixed[1].priceSol, null)
})

test('lists carry a stock row\'s figures and never add a stock field to a SOL row', () => {
  const at = new Date('2026-10-01T00:00:00Z')
  const sol = { repoId: '1', mint: 'SolMint', fullName: 'a/b', symbol: 'A', indexedAt: at, volume24hLamports: '5', priceSol: 0.001, promoted: true }
  const stock = { repoId: '2', mint: 'StockMint', fullName: 'c/d', symbol: 'C', indexedAt: at, volume24hLamports: null, priceSol: null, promoted: true,
    quoteAssetId: 'meta-xstock', stock: { symbol: 'METAx', price: 0.04 } }
  const tabs = homeMarketTabs([sol, stock])
  assert.equal('stock' in tabs.New.find(row => row.mint === 'SolMint'), false)
  assert.deepEqual(tabs.New.find(row => row.mint === 'StockMint').stock, stock.stock)
  assert.deepEqual(tabs.Trending.map(row => row.mint), ['SolMint'], 'trending ranks SOL volume; a stock pair has none')
  const more = selectMoreMarkets([sol, stock], { now: at.getTime() })
  assert.equal('stock' in more.find(row => row.mint === 'SolMint'), false)
  assert.deepEqual(more.find(row => row.mint === 'StockMint').stock, stock.stock)
})

test('activity rows: a stock pair\'s fee splits and launcher payouts, raw, beside the SOL kinds', () => {
  const events = activityEvents({ stockFees: [{ signature: 'f', eventIndex: 0, occurredAt: new Date('2026-10-04T10:00:00Z'), launcherBaseUnits: '150000', accumulatorBaseUnits: '550000' }],
    launcherPayouts: [{ signature: 'p', occurredAt: new Date('2026-10-04T11:00:00Z'), amountBaseUnits: '100000' }] })
  assert.deepEqual(events, [
    { type: 'launcher-payout', signature: 'p', occurredAt: '2026-10-04T11:00:00.000Z', amountBaseUnits: '100000' },
    { type: 'stock-fee', signature: 'f', eventIndex: 0, occurredAt: '2026-10-04T10:00:00.000Z', launcherBaseUnits: '150000', accumulatorBaseUnits: '550000' },
  ])
  assert.deepEqual(activityEvents({ fees: [{ signature: 'x', eventIndex: 1, occurredAt: '2026-10-04T09:00:00.000Z', amountBaseUnits: '7' }] }),
    [{ type: 'fee', signature: 'x', eventIndex: 1, occurredAt: '2026-10-04T09:00:00.000Z', amountBaseUnits: '7' }])
})

test('units cache: answers at once, refreshes in the background within UNITS_WAIT_MS, and serves units only while they hold', async () => {
  assert.equal(await unitsWithin(async () => 'units', 'meta-xstock'), 'units')
  assert.equal(await unitsWithin(async () => { throw Error('rpc down') }, 'meta-xstock'), null)
  const quick = Date.now()
  assert.equal(await unitsWithin(() => new Promise(() => {}), 'meta-xstock', 50), null)
  assert.ok(Date.now() - quick < 1000)
  let clock = 1_000_000, reads = 0, answer = { ...INFO, validForSeconds: 60 }
  const cache = createStockUnitsCache({ now: () => clock, info: async (assetId, { connection }) => { reads++; assert.equal(connection, 'rpc'); return typeof answer === 'function' ? answer() : answer } })
  // Cold: nothing yet, and a refresh starts in the background; within() waits for it.
  assert.equal(cache.current('meta-xstock', () => 'rpc'), null)
  assert.equal((await cache.within('meta-xstock', () => 'rpc')).uiMultiplier, MULTIPLIER)
  assert.equal(reads, 1)
  // Warm: served from the cache, with the time it still holds; no read until it is due.
  clock += 10_000
  assert.equal(cache.current('meta-xstock', 'rpc').validForSeconds, 50); assert.equal(reads, 1)
  // A failed refresh keeps the last units only while they hold, then there are none.
  answer = () => { throw Error('rpc down') }
  clock += 25_000
  assert.equal(cache.current('meta-xstock', 'rpc').uiMultiplier, MULTIPLIER, 'due for a refresh, still valid')
  assert.equal(await cache.within('meta-xstock', 'rpc').then(u => u.uiMultiplier), MULTIPLIER)
  clock += 30_000
  assert.equal(cache.current('meta-xstock', 'rpc'), null, 'lapsed: never a stale multiplier')
  assert.equal(await cache.within('meta-xstock', 'rpc'), null)
  // A hanging read never makes within() wait past the bound.
  const hanging = createStockUnitsCache({ waitMs: 50, info: () => new Promise(() => {}) })
  const started = Date.now()
  assert.equal(await hanging.within('meta-xstock', 'rpc'), null)
  assert.ok(Date.now() - started < 1000)
})

test('stamped rows take units from the cache without waiting; a stalled or failing read leaves them null and SOL rows untouched', async () => {
  const db = { query: async sql => ({ rows: /stock_graduation_events/.test(sql) ? [] : [{ repoId: stamped.repoId, lastSqrtPrice: (SQRT * 2n).toString(), volume24h: '5' }] }) }
  const sol = { repoId: '1', pool: 'p', priceSol: 0.001 }
  const stalled = createStockUnitsCache({ info: () => new Promise(() => {}) })
  const started = Date.now()
  const rows = await withStockStats([sol, stamped], { db, connection: {}, withUnits: true, units: stalled })
  assert.ok(Date.now() - started < 500, 'the list never waits for units')
  assert.equal(rows[0], sol)
  assert.deepEqual([rows[1].stock.price, rows[1].stock.volume24h, rows[1].stock.uiMultiplier, rows[1].stock.usdPrice], [0.04, '5', null, null])
  // Once the cache holds units, the next list carries them.
  const warm = createStockUnitsCache({ info: async () => ({ ...INFO }) })
  await warm.within('meta-xstock', {})
  const [row] = await withStockStats([stamped], { db, connection: {}, withUnits: true, units: warm })
  assert.deepEqual([row.stock.uiMultiplier, row.stock.usdPrice], [MULTIPLIER, 712.5])
  // A connection that cannot even be made leaves the units null too.
  const noRpc = createStockUnitsCache()
  const [plain] = await withStockStats([stamped], { db, connection: () => { throw Error('SOLANA_RPC_URL is required in production') }, withUnits: true, units: noRpc })
  assert.equal(plain.stock.uiMultiplier, null); assert.equal(plain.stock.price, 0.04)
})

test('listMarkets never waits on a hanging RPC: a stamped row comes back at once without units, the SOL row as it was', async () => {
  // Every outbound request hangs (the RPC meter takes this fetch on its first use).
  const realFetch = globalThis.fetch
  globalThis.fetch = () => new Promise(() => {})
  process.env.DATABASE_URL = 'postgres://stock-hang-test.invalid/db'
  process.env.SOLANA_RPC_URL = 'http://127.0.0.1:9/hang'
  const solRow = { repoId: '1', mint: 'SolMint', pool: 'SolPool', indexedAt: new Date(), stars: '7', forks: '0', earned: '10', claimed: '0', volume24hLamports: '5' }
  const stockRow = { ...solRow, repoId: stamped.repoId, mint: stamped.mint, pool: stamped.pool, volume24hLamports: '0', quoteAssetId: stamped.quoteAssetId, quoteMint: stamped.quoteMint }
  globalThis.__gitfunPool = { query: async sql => ({ rows: /from markets m join repositories r/.test(sql) ? [solRow, stockRow]
    : /stock_graduation_events/.test(sql) ? [] : [{ repoId: stamped.repoId, lastSqrtPrice: (SQRT * 2n).toString(), volume24h: '5' }] }) }
  try {
    const { listMarkets } = await import('../app/lib/server.mjs?hang')
    const started = Date.now()
    const { markets, unavailable } = await listMarkets()
    assert.ok(Date.now() - started < UNITS_WAIT_MS, `listMarkets took ${Date.now() - started} ms`)
    assert.equal(unavailable, undefined)
    const [sol, stock] = markets
    assert.equal(sol.volume24hLamports, '5'); assert.equal('stock' in sol, false); assert.equal('quoteAssetId' in sol, false)
    assert.deepEqual([stock.priceSol, stock.volume24hLamports, stock.stock.price, stock.stock.uiMultiplier], [null, null, 0.04, null])
  } finally { globalThis.fetch = realFetch; globalThis.__gitfunPool = undefined; delete process.env.DATABASE_URL; delete process.env.SOLANA_RPC_URL }
})

test('MCP tools: a stock pair\'s volume in its stock and no builder fees, never a SOL zero; SOL rows unchanged', async () => {
  const origin = 'https://repo.ing'
  const sol = { repoId: '123456', mint: 'RepoMint111111111111111111111111111111111', fullName: 'acme/widget', symbol: 'WIDGET', tokenName: 'Widget', description: 'd',
    volume24hLamports: '12500000000', earned: '2000000000', claimed: '500000000', graduated: false, bondingPercent: 42.7, indexedAt: '2026-09-30T12:00:00.000Z',
    promoted: true, newRepo: false, beneficiaryWallet: null, source: 'github' }
  const stock = { ...sol, repoId: stamped.repoId, mint: 'DocuMint111111111111111111111111111111111', fullName: 'facebook/docusaurus', symbol: 'DOCUSAURUS',
    tokenName: 'Docusaurus', volume24hLamports: null, earned: '0', claimed: '0', bondingPercent: 30, indexedAt: '2026-10-03T00:00:00.000Z', priceSol: null,
    quoteAssetId: stamped.quoteAssetId, quoteMint: stamped.quoteMint,
    stock: { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, price: 0.04, volume24h: '140000000', uiMultiplier: MULTIPLIER, usdPrice: 712.5 } }
  const sources = rows => ({ origin: () => origin, modelsEnabled: () => false, markets: async () => ({ markets: rows }), race: async () => ({ markets: [] }),
    excluded: async () => new Set(), decision: async () => null, usdPerSol: async () => 150, totals: async () => null,
    fees: async repoId => { assert.notEqual(repoId, stamped.repoId, 'a stock pair is never reconciled for builder fees'); return { status: 'MATCH', onchainCreatorFee: 1n } } })
  const call = async (rows, name, args) => {
    const tool = readOnlyTools(sources(rows)).find(entry => entry.definition.name === name)
    const answer = await tool.call(tool.input.parse(args), new Request(`${origin}/api/mcp/readonly`))
    return { text: answer.content[0].text, data: answer.structuredContent }
  }
  const found = await call([sol, stock], 'find_market', { project: 'facebook/docusaurus' })
  assert.match(found.text, /24h volume: 1\.4 METAx/)
  assert.match(found.text, /Paired with METAx: its trading fees are paid in METAx, to its launcher and to the METAx accumulator; its repository's owners have no builder fees to claim\./)
  assert.doesNotMatch(found.text, /SOL|Claim page/)
  const [fact] = found.data.markets
  assert.deepEqual([fact.pair, fact.volume24h], [{ assetId: 'meta-xstock', symbol: 'METAx' }, { baseUnits: '140000000', decimals: 8, symbol: 'METAx', shown: '1.4 METAx' }])
  for (const field of ['volume24hLamports', 'builderFees', 'claimUrl']) assert.equal(field in fact, false, field)
  // Without today's units the volume is not converted: no line at all, the raw amount in the data.
  const unitless = await call([{ ...stock, stock: { ...stock.stock, uiMultiplier: null, usdPrice: null } }], 'find_market', { project: 'facebook/docusaurus' })
  assert.doesNotMatch(unitless.text, /24h volume|SOL/); assert.equal('shown' in unitless.data.markets[0].volume24h, false)
  const earned = await call([sol, stock], 'builder_earnings', { project: 'facebook/docusaurus' })
  assert.match(earned.text, /facebook\/docusaurus \(\$DOCUSAURUS\): Paired with METAx/); assert.doesNotMatch(earned.text, /SOL/)
  assert.equal(earned.data.markets[0].builderEarnings, 'none')
  const newest = await call([sol, stock], 'trending_markets', { sort: 'newest' })
  assert.match(newest.text, /facebook\/docusaurus \(\$DOCUSAURUS\) · launched 2026-10-03 · 1\.4 METAx 24h volume · 30% to graduation/)
  assert.match(newest.text, /acme\/widget \(\$WIDGET\) · launched 2026-09-30 · 12\.5 SOL 24h volume · 42% to graduation/)
  const stockEntry = newest.data.markets.find(entry => entry.mint === stock.mint)
  assert.equal('volume24hLamports' in stockEntry, false); assert.equal(stockEntry.volume24h.baseUnits, '140000000')
  // By volume (SOL) a stock pair, with no SOL volume, is not listed; the SOL row reads as before.
  assert.deepEqual((await call([sol, stock], 'trending_markets', { sort: 'volume' })).data.markets.map(entry => [entry.mint, entry.volume24hLamports]), [[sol.mint, '12500000000']])
})
