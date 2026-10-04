import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import bs58 from 'bs58'
import BN from 'bn.js'
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createStockFeeIndexer } from '../src/stock-fee-indexer.mjs'
import { createChartOrdering } from '../src/chart-ordering.mjs'
import { readMarketChart } from '../src/market-chart.mjs'
import { resolveQuoteAsset } from '../src/quote-assets.mjs'
import { createStockFeeAccrual, stockFeeSplit } from '../src/stock-fee-accrual.mjs'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Stock-pair curve indexing on real PostgreSQL (docs/STOCK_QUOTES.md): the SOL and stock indexers split the indexed markets
// between them with no overlap, the SOL indexer's output does not change when a stock market exists, the stock accrual writes
// both stock ledgers (migration 0054) and nothing else, and chart ordering, which now also orders stock trades, gives SOL
// exactly its golden output.
const URL_ = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_stock_curve_indexing_test'
const META = resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })
const MSFT = resolveQuoteAsset('msft-xstock', { repoId: '41881900', ownerId: '6154722', ownerType: 'Organization' }, { enabled: true })
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const sig = n => bs58.encode(Buffer.alloc(64, n))
const hash = n => bs58.encode(Buffer.alloc(32, n))

const REPOS = `insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (1296269,'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-10-01T00:00:00Z'),
  (10270250,'facebook','react','facebook/react',null,null,240000,49000,false,'2026-10-01T00:00:00Z'),
  (7,'fixture','submitted','fixture/submitted',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (8,'fixture','unindexed','fixture/unindexed',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (94911145,'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z'),
  (41881900,'microsoft','vscode','microsoft/vscode',null,null,180000,35000,false,'2026-10-01T00:00:00Z')`
const MARKET_COLUMNS = `github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
  last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version`
// Two indexed SOL markets, two SOL markets that are not indexed (excluded from both indexers).
const SOL_MARKETS = `insert into markets(${MARKET_COLUMNS}) values
  (1296269,'confirmed','${key(12)}','${key(11)}','L','C','Hello','HELLO','${sig(11)}','H',100,10,'finalized',now(),now(),null,null,null),
  (10270250,'confirmed','${key(22)}','${key(21)}','L','C','React','REACT','${sig(21)}','H',100,10,'finalized',now(),now(),null,null,null),
  (7,'submitted','${key(32)}','${key(31)}','L','C','Sub','SUB','${sig(31)}','H',100,null,null,null,null,null,null,null),
  (8,'confirmed','${key(52)}','${key(51)}','L','C','Unidx','UNIDX','${sig(51)}','H',100,null,null,null,null,null,null,null)`
// An indexed DOCUSAURUS / METAx market and a VSCODE / MSFTx reservation that is not indexed.
const STOCK_MARKETS = `insert into markets(${MARKET_COLUMNS}) values
  (94911145,'confirmed','${key(42)}','${key(41)}','L','C','Docusaurus','DOCUSAURUS','${sig(41)}','H',100,10,'finalized',now(),now(),'${META.assetId}','${META.mint}',1),
  (41881900,'prepared',null,null,'L','C','VSCode','VSCODE',null,null,null,null,null,null,null,'${MSFT.assetId}','${MSFT.mint}',1)`

// Every pool's finalized history is just its launch: enough for both indexers to walk a cursor without a chain.
const launches = new Map([[key(11), sig(11)], [key(21), sig(21)], [key(41), sig(41)]])
const connection = { getSignaturesForAddress: async poolKey => [{ signature: launches.get(poolKey.toBase58()), slot: 1, err: null }] }
function solIndexer(pool, touched) {
  return createExternalFeeIndexer({ pool, connection, config: key(90), graduatedFees: { read: async () => null }, recordTrade: async () => 0,
    accrual: { recordTradeFees: async ({ githubRepoId }) => { touched.push(String(githubRepoId)); return { creditedBaseUnits: 0n, eventKeys: [] } } } })
}
function stockIndexer(pool, touched) {
  return createStockFeeIndexer({ pool, connection, config: key(90), accrual: { checkCurve: async () => ({}),
    recordTradeFees: async ({ githubRepoId }) => { touched.push(String(githubRepoId)); return { creditedBaseUnits: 0n, creditedPartnerUnits: 0n, eventKeys: [] } } } })
}
const solTables = async pool => Object.fromEntries(await Promise.all([
  ['cursors', 'select pool, last_signature, last_slot::text from pool_fee_cursors order by pool'],
  ['fees', 'select signature, event_index from fee_events order by signature, event_index'],
  ['trades', 'select signature, event_index from trade_events order by signature, event_index'],
  ['discovery', 'select signature, event_index from discovery_fee_events order by signature, event_index'],
  ['alerts', 'select event_key, kind from graduation_alerts order by event_key'],
].map(async ([name, sql]) => [name, (await pool.query(sql)).rows])))

// Finalized blocks as two agreeing RPCs return them (other transactions in between), stock trades' transactions included.
const s = n => sig(100 + n), st = n => sig(150 + n)
const BLOCKS = {
  100: [sig(201), s(2), sig(202), s(1), s(11), st(5)],
  101: [s(3), st(4), sig(203)],
  102: [s(5), sig(204), s(4)],
  103: [s(7), s(6)],
  106: [st(3), st(2)],
}
const rpc = endpoint => ({ rpcEndpoint: endpoint, getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  getBlockSignatures: async (slot, commitment) => {
    assert.equal(commitment, 'finalized')
    return { blockhash: hash(slot), previousBlockhash: hash(slot - 1), parentSlot: slot - 1, signatures: [...BLOCKS[slot]] }
  } })
const at = minute => new Date(Date.parse('2026-10-04T10:00:00Z') + minute * 60_000).toISOString()
const solTrade = (pool, n, slot, minute, direction, price) => pool.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,
  input_base_units,output_base_units,next_sqrt_price,trader) values($1,$2,0,$3,$4,$5,$6,$7,$8,null)`,
[key(11), s(n), slot, at(minute), direction, direction === 'buy' ? '1000000' : '5000000', direction === 'buy' ? '5000000' : '990000', price])
const dammTrade = (pool, n, slot, minute) => pool.query(`insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,
  quote_amount,next_sqrt_price,direction,evidence,base_amount) values(1296269,$1,$2,0,$3,$4,700000,'18446744073709551616','buy','{}',1)`,
[key(13), s(n), slot, at(minute)])
const stockTrade = (pool, n, slot, minute) => pool.query(`insert into stock_trade_events(github_repo_id,asset_id,quote_mint,venue,pool,signature,
  event_index,slot,traded_at,direction,quote_amount,base_amount,next_sqrt_price,trader) values(94911145,$1,$2,'dbc',$3,$4,0,$5,$6,'buy',100000,4000,
  '18446744073709551616',$7)`, [META.assetId, META.mint, key(41), st(n), slot, at(minute), key(60 + n)])
const positions = async pool => (await pool.query(`select slot::text, signature, transaction_index from finalized_chart_positions
  order by slot, transaction_index`)).rows
const blocks = async pool => (await pool.query('select slot::text, blockhash, parent_slot::text, signatures from finalized_chart_blocks order by slot')).rows
const NOW = Date.parse('2026-10-04T12:00:00Z')

// The SOL golden output: what chart ordering recorded for these SOL trades before stock trades existed.
const SOL_GOLDEN_RUNS = [{ status: 'checked', verified: 3, pending: 0, errors: [] }, { status: 'checked', verified: 0, pending: 0, errors: [] }]
const SOL_GOLDEN_POSITIONS = [
  { slot: '100', signature: s(2), transaction_index: 2 }, { slot: '100', signature: s(1), transaction_index: 4 },
  { slot: '100', signature: s(11), transaction_index: 5 },
  { slot: '102', signature: s(5), transaction_index: 1 }, { slot: '102', signature: s(4), transaction_index: 3 },
  { slot: '103', signature: s(7), transaction_index: 1 }, { slot: '103', signature: s(6), transaction_index: 2 },
]
const SOL_GOLDEN_BLOCKS = [100, 102, 103].map(slot => ({ slot: String(slot), blockhash: hash(slot), parent_slot: String(slot - 1), signatures: BLOCKS[slot] }))

test('stock curve indexing on PostgreSQL: partitioned markets, unchanged SOL indexing and chart ordering', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL ?? URL_, URL_)
  const admin = new pg.Pool({ connectionString: URL_.replace(/repoing_stock_curve_indexing_test$/, 'postgres') })
  let pool, created = false
  try {
    await admin.query('drop database if exists repoing_stock_curve_indexing_test with (force)')
    await admin.query('create database repoing_stock_curve_indexing_test'); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await pool.query(REPOS)
    await pool.query(SOL_MARKETS)

    await t.test('the SOL indexer gives exactly the same output once a stock market exists, and never touches it', async () => {
      const before = [], after = []
      const solOnly = await solIndexer(pool, before).runOnce()
      const tablesBefore = await solTables(pool)
      await pool.query('truncate pool_fee_cursors')
      await pool.query(STOCK_MARKETS)
      const withStock = await solIndexer(pool, after).runOnce()
      assert.deepEqual(withStock, solOnly)
      assert.deepEqual(await solTables(pool), tablesBefore)
      assert.deepEqual(after, ['1296269', '10270250'])
      assert.deepEqual(withStock.map(result => [result.githubRepoId, result.status]), [['1296269', 'OK'], ['10270250', 'OK']])
    })

    await t.test('SOL markets + stock markets = every indexed market, with no overlap', async () => {
      const solTouched = [], stockTouched = []
      const sol = (await solIndexer(pool, solTouched).runOnce()).map(result => result.githubRepoId)
      const stock = (await stockIndexer(pool, stockTouched).runOnce()).map(result => result.githubRepoId)
      const { rows } = await pool.query(`select github_repo_id::text as id, quote_asset_id is not null as stock from markets where status = 'confirmed'
        and indexed_at is not null and launch_finality = 'finalized' order by github_repo_id`)
      assert.deepEqual([...sol, ...stock].sort(), rows.map(row => row.id).sort(), 'together: every indexed market')
      assert.equal(sol.filter(id => stock.includes(id)).length, 0, 'no market in both')
      assert.deepEqual(stock, rows.filter(row => row.stock).map(row => row.id))
      assert.deepEqual(stock, ['94911145'])
      assert.deepEqual(stockTouched, ['94911145'])
      assert.ok(!solTouched.includes('94911145'))
      // Each indexer keeps its own cursors: the stock pool only in stock_pool_cursors, SOL pools only in pool_fee_cursors.
      assert.deepEqual((await pool.query('select pool, github_repo_id::text, venue, last_signature from stock_pool_cursors')).rows,
        [{ pool: key(41), github_repo_id: '94911145', venue: 'dbc', last_signature: sig(41) }])
      assert.deepEqual((await pool.query('select pool from pool_fee_cursors order by pool')).rows.map(row => row.pool), [key(11), key(21)].sort())
    })

    await t.test('the stock accrual writes both stock ledgers in one transaction, once, and no SOL table', async () => {
      // The DOCUSAURUS / METAx buy and sell captured from the local stock-pair validator, on a market stamped with their pool.
      const STOCK = JSON.parse(readFileSync(new URL('./fixtures/dbc-stock-swaps-local.json', import.meta.url)))
      const creator = Keypair.generate().publicKey
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at)
        values (11,'facebook','jest','facebook/jest',null,null,1,0,false,'2026-10-01T00:00:00Z')`)
      await pool.query(`insert into markets(${MARKET_COLUMNS}) values (11,'confirmed',$1,$2,'L',$3,'Jest','JEST',$4,'H',100,10,'finalized',now(),now(),$5,$6,1)`,
        [STOCK.market.mint, STOCK.market.pool, creator.toBase58(), STOCK.launch.transaction.signatures[0], META.assetId, META.mint])
      const solBefore = await solTables(pool)
      const program = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'finalized').state.getProgram()
      const dbc = { connection: { rpcEndpoint: 'fake-db-test' }, commitment: 'finalized', state: { getProgram: () => program,
        getPool: async () => ({ poolState: { config: new PublicKey(STOCK.market.config), baseMint: new PublicKey(STOCK.market.mint), creator,
          isMigrated: 0, creatorQuoteFee: new BN(0), partnerQuoteFee: new BN(0) } }),
        getPoolConfig: async () => ({ quoteMint: new PublicKey(META.mint), quoteTokenFlag: 1, collectFeeMode: 0, creatorTradingFeePercentage: 71 }) } }
      const raw = new Map(['launch', 'buy', 'sell'].map(name => [STOCK[name].transaction.signatures[0], STOCK[name]]))
      const accrual = createStockFeeAccrual({ pool, connection: dbc.connection, config: key(90), stockConfigs: new Map([[META.assetId, new PublicKey(STOCK.market.config)]]),
        dbc, loadTransaction: async (_connection, signature) => normalizeFinalizedTransaction(structuredClone(raw.get(signature)), signature) })
      const signatures = [...raw.keys()]
      const first = await accrual.recordTradeFees({ githubRepoId: '11', signatures, allowNonSwap: true })
      const [buy, sell] = [14416799, 8882687].map(fee => stockFeeSplit({ tradingFee: new BN(fee), creatorPercentage: 71 }))
      assert.equal(first.creditedBaseUnits, buy.creatorAmount + sell.creatorAmount)
      const fees = (await pool.query(`select signature, event_index, creator_amount::text, partner_amount::text, launcher_amount::text,
        accumulator_amount::text, policy_version from stock_fee_events where github_repo_id = 11 order by slot`)).rows
      assert.deepEqual(fees.map(row => [row.signature, row.event_index, row.creator_amount, row.partner_amount, row.launcher_amount, row.accumulator_amount, row.policy_version]), [
        [signatures[1], 0, '10235927', '4180872', '3089313', '11327486', 1],
        [signatures[2], 0, String(sell.creatorAmount), String(sell.partnerAmount), String(sell.launcherAmount), String(sell.accumulatorAmount), 1]])
      const trades = (await pool.query(`select signature, venue, direction, quote_amount::text, base_amount::text, traded_at from stock_trade_events
        where github_repo_id = 11 order by slot`)).rows
      assert.deepEqual(trades.map(row => [row.signature, row.venue, row.direction, row.quote_amount, row.base_amount, row.traded_at.toISOString()]), [
        [signatures[1], 'dbc', 'buy', '31979002', '53455273178753', new Date(1791129998000).toISOString()],
        [signatures[2], 'dbc', 'sell', '20875643', '53455273178753', new Date(1791130000000).toISOString()]])
      // The same evidence again (as the worker and the trade route both may record it): nothing new, nothing contradicted.
      const again = await accrual.recordTradeFees({ githubRepoId: '11', signatures: [signatures[2], signatures[1]] })
      assert.deepEqual([again.creditedBaseUnits, again.creditedPartnerUnits, again.eventKeys], [0n, 0n, [`${signatures[2]}:0`, `${signatures[1]}:0`]])
      assert.equal((await pool.query('select count(*)::int as n from stock_fee_events where github_repo_id = 11')).rows[0].n, 2)
      // A stored row the chain contradicts stops the market, and the whole transaction is rolled back.
      await pool.query('update stock_trade_events set quote_amount = quote_amount + 1 where signature = $1', [signatures[2]])
      await assert.rejects(accrual.recordTradeFees({ githubRepoId: '11', signatures: [signatures[2]] }), /stock_trade_events row contradicts/)
      assert.deepEqual(await solTables(pool), solBefore, 'SOL ledgers and alerts untouched')
    })

    await t.test('chart ordering gives SOL trades their golden output', async () => {
      for (const [n, slot, minute, direction, price] of [[1, 100, 1, 'buy', '18446744073709551616'], [2, 100, 1, 'sell', '18446744073709551617'],
        [3, 101, 2, 'buy', '18446744073709551618'], [4, 102, 3, 'buy', '18446744073709551619'], [10, 104, 5, 'sell', '18446744073709551620']]) {
        await solTrade(pool, n, slot, minute, direction, price)
      }
      for (const [n, slot, minute] of [[5, 102, 3], [6, 103, 4], [7, 103, 4]]) await dammTrade(pool, n, slot, minute)
      const ordering = createChartOrdering({ pool, connection: rpc('primary'), verification: rpc('secondary') })
      const first = await ordering.runOnce()
      await solTrade(pool, 11, 100, 1, 'buy', '18446744073709551621')
      const second = await ordering.runOnce()
      assert.deepEqual([first, second], SOL_GOLDEN_RUNS)
      assert.deepEqual(await positions(pool), SOL_GOLDEN_POSITIONS)
      assert.deepEqual(await blocks(pool), SOL_GOLDEN_BLOCKS)
    })

    await t.test('stock trades are ordered too; SOL positions and the SOL chart stay exactly as they were', async () => {
      const solMarket = { pool: key(11), repoId: '1296269', mint: key(12) }
      const chartBefore = await readMarketChart(pool, solMarket, 'all', NOW)
      assert.equal(chartBefore.trades.length, 6)
      // Alone in slot 105; two in slot 106; one beside a lone SOL trade (slot 101); one in an already recorded block (slot 100).
      for (const [n, slot, minute] of [[1, 105, 6], [2, 106, 7], [3, 106, 7], [4, 101, 2], [5, 100, 1]]) await stockTrade(pool, n, slot, minute)
      const ordering = createChartOrdering({ pool, connection: rpc('primary'), verification: rpc('secondary') })
      assert.deepEqual(await ordering.runOnce(), { status: 'checked', verified: 2, pending: 0, errors: [] })
      const all = await positions(pool)
      const golden = new Set(SOL_GOLDEN_POSITIONS.map(position => position.signature))
      assert.deepEqual(all.filter(position => golden.has(position.signature)), SOL_GOLDEN_POSITIONS)
      assert.deepEqual(all.filter(position => !golden.has(position.signature)), [
        { slot: '100', signature: st(5), transaction_index: 6 },
        // The lone SOL trade's block is recorded for the stock trade beside it; alone among SOL trades, its order is unchanged.
        { slot: '101', signature: s(3), transaction_index: 1 }, { slot: '101', signature: st(4), transaction_index: 2 },
        { slot: '106', signature: st(3), transaction_index: 1 }, { slot: '106', signature: st(2), transaction_index: 2 },
      ])
      assert.deepEqual(await readMarketChart(pool, solMarket, 'all', NOW), chartBefore)
      assert.deepEqual(await ordering.runOnce(), { status: 'checked', verified: 0, pending: 0, errors: [] })
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, 'repoing_stock_curve_indexing_test')
    await admin.end()
  }
})
