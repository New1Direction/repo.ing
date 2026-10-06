import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import bs58 from 'bs58'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Connection, Keypair } from '@solana/web3.js'
import { graduationOperatorView, publicMarketSQL } from '../src/graduation-readiness.mjs'
import { STOCK_MARKET_SQL, createStockGraduationMonitor, stockGraduationOperatorView } from '../src/stock-graduation-monitor.mjs'
import { recordStockDammCheckpoints, recordStockGraduationEvent, recordStockObservation } from '../src/stock-graduation.mjs'
import { STOCK_DAMM_QUARANTINE, indexStockDammTrades } from '../src/stock-damm-trades.mjs'
import { clearFinalizedTransactionCache } from '../src/finalized-transaction.mjs'
import { registerRpcEndpoint } from '../src/rpc-usage.mjs'
import { SOL_QUOTE, resolveQuoteAsset } from '../src/quote-assets.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// The stock graduation ledgers (migration 0054) on real PostgreSQL: the SOL and stock graduation jobs split the indexed markets
// exactly; observations, the migration proof and DAMM fee checkpoints are written as the stock fee policy says; and the DAMM
// swap indexer records real swaps (tests/fixtures/stock-damm-graduation.json) and quarantines one it cannot match.
const URL_ = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_stock_graduation_test'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/stock-damm-graduation.json', import.meta.url), 'utf8'))
const META = resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })
const MSFT = resolveQuoteAsset('msft-xstock', { repoId: '41881900', ownerId: '6154722', ownerType: 'Organization' }, { enabled: true })
const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (94911145,'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z'),
  (41881900,'microsoft','vscode','microsoft/vscode',null,null,180000,35000,false,'2026-10-01T00:00:00Z'),
  (10270250,'facebook','react','facebook/react',null,null,240000,49000,false,'2026-10-01T00:00:00Z'),
  (1296269,'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-10-01T00:00:00Z'),
  (7,'fixture','pending','fixture/pending',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (8,'fixture','early','fixture/early',null,null,1,0,false,'2026-10-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
  (94911145,'confirmed','${fixture.market.mint}','${fixture.market.curve}','Launcher','${fixture.market.creator}','Docusaurus','DOCUSAURUS','LaunchDocs','Hash',100,10,'finalized',now(),now(),'meta-xstock','${META.mint}',1),
  (41881900,'confirmed','MintCode','PoolCode','Launcher','Creator','VSCode','VSCODE','LaunchCode','Hash',100,10,'finalized',now(),now(),'msft-xstock','${MSFT.mint}',1),
  (10270250,'submitted','MintReact','PoolReact','Launcher','Creator','React','REACT','LaunchReact','Hash',100,null,null,null,null,'meta-xstock','${META.mint}',1),
  (1296269,'confirmed','MintSol','PoolSol','Launcher','Creator','Hello','HELLO','LaunchSol','Hash',100,10,'finalized',now(),now(),null,null,null),
  (7,'submitted','MintPending','PoolPending','Launcher','Creator','Pending','PEND','LaunchPending','Hash',100,null,null,null,null,null,null,null);
-- A contributor early access market (docs/EARLY_ACCESS.md): SOL-quoted, but a transfer-hook pool neither graduation job lists yet.
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,early_access_end,transfer_hook_program) values
  (8,'confirmed','MintEarly','PoolEarly','Launcher','Creator','Early','EARLY','LaunchEarly','Hash',100,10,'finalized',now(),now(),now(),'Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep');`
const ALL_INDEXED = `select m.github_repo_id::text as "githubRepoId" from markets m join repositories r on r.github_repo_id=m.github_repo_id
  where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'`
const ids = rows => rows.map(row => row.githubRepoId ?? row.repoId).sort()

const state = (overrides = {}) => ({ repoId: '94911145', assetId: 'meta-xstock', quoteMint: META.mint, curve: fixture.market.curve, slot: 100,
  chainTime: new Date().toISOString(), phase: 'CURVE', reserveBaseUnits: '700000000', thresholdBaseUnits: '1400000000', ...overrides })
const migration = { signature: fixture.transactions.migration.transaction.signatures[0], slot: fixture.transactions.migration.slot,
  curve: fixture.market.curve, pool: fixture.dammPool, creatorPosition: Keypair.generate().publicKey.toBase58(), partnerPosition: Keypair.generate().publicKey.toBase58() }
const graduated = (fees, overrides = {}) => state({ phase: 'GRADUATED', reserveBaseUnits: '1400000000', migration, migrationHash: 'a'.repeat(64),
  positionEvidence: {}, accountEvidence: [], fees: { slot: fees.slot, creator: { position: migration.creatorPosition, earned: fees.creator, claimed: '0' },
    partner: { position: migration.partnerPosition, earned: fees.partner, claimed: fees.partnerClaimed ?? '0' } }, ...overrides })

test('stock graduation ledgers on PostgreSQL', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const admin = new pg.Pool({ connectionString: URL_.replace(/repoing_stock_graduation_test$/, 'postgres') })
  let pool, created = false
  try {
    await admin.query('drop database if exists repoing_stock_graduation_test')
    await admin.query('create database repoing_stock_graduation_test'); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await pool.query(SEED)
    const market = (await pool.query(`${STOCK_MARKET_SQL} and m.github_repo_id=94911145`)).rows[0]

    await t.test('partition: the SOL and stock graduation jobs split every indexed market but early access ones, with no overlap', async () => {
      const all = ids((await pool.query(ALL_INDEXED)).rows), sol = ids((await pool.query(publicMarketSQL)).rows)
      const stock = ids((await pool.query(STOCK_MARKET_SQL)).rows)
      assert.deepEqual(sol, ['1296269'])
      assert.deepEqual(stock, ['41881900', '94911145'])
      assert.deepEqual([...sol, ...stock, '8'].sort(), all, 'SOL + stock = every indexed market but the early access one')
      assert.equal(sol.filter(id => stock.includes(id)).length, 0, 'no market in both')
      // The operator views split the same way.
      const view = await graduationOperatorView(pool, {})
      assert.deepEqual(ids(view.markets), sol)
      const stockView = await stockGraduationOperatorView(pool)
      assert.deepEqual(ids(stockView), stock)
      assert.deepEqual(stockView.map(row => [row.assetId, row.phase, row.openQuarantines]), [['msft-xstock', 'UNOBSERVED', 0], ['meta-xstock', 'UNOBSERVED', 0]])
    })

    await t.test('observations: a new reading when something changed or the last is a heartbeat old; never for a SOL market', async () => {
      assert.equal(await recordStockObservation(pool, state()), 'inserted')
      assert.equal(await recordStockObservation(pool, state({ slot: 101 })), null, 'nothing new yet')
      assert.equal(await recordStockObservation(pool, state({ slot: 102, reserveBaseUnits: '1050000000' })), 'inserted')
      // A heartbeat with nothing new refreshes the newest reading in place: one row per change, not one per minute.
      await new Promise(resolve => setTimeout(resolve, 5))
      const later = new Date().toISOString()
      assert.equal(await recordStockObservation(pool, state({ slot: 103, reserveBaseUnits: '1050000000', chainTime: later }), { now: () => Date.now() + 61_000 }), 'refreshed')
      // The newest reading, as the curve route reads it (observed_at is the finalized chain time of the read).
      const { rows: readings } = await pool.query(`select quote_reserve::text, migration_threshold::text, is_migrated, slot::text from stock_graduation_observations
        where github_repo_id = 94911145 order by observed_at desc, id desc`)
      assert.deepEqual(readings.map(row => [row.quote_reserve, row.slot]), [['1050000000', '103'], ['700000000', '100']])
      const { rows: [newest] } = await pool.query(`select observed_at from stock_graduation_observations where github_repo_id = 94911145
        order by observed_at desc, id desc limit 1`)
      assert.equal(newest.observed_at.toISOString(), later)
      assert.deepEqual([readings[0].migration_threshold, readings[0].is_migrated], ['1400000000', false])
      await assert.rejects(recordStockObservation(pool, state({ repoId: '1296269', reserveBaseUnits: '1' })), /does not match a stock-paired market/)
      await assert.rejects(recordStockObservation(pool, state({ assetId: 'msft-xstock', quoteMint: MSFT.mint, reserveBaseUnits: '2' })), /does not match a stock-paired market/)
    })

    await t.test('the migration proof is kept once; a different proof later is a conflict', async () => {
      const fees = { slot: '200', creator: '0', partner: '0' }
      assert.equal(await recordStockGraduationEvent(pool, graduated(fees)), true)
      assert.equal(await recordStockGraduationEvent(pool, graduated(fees)), false)
      await assert.rejects(recordStockGraduationEvent(pool, graduated(fees, { migration: { ...migration, signature: bs58.encode(Buffer.alloc(64, 9)) } })), /DUPLICATE_GRADUATION_CONFLICT/)
      await assert.rejects(recordStockGraduationEvent(pool, graduated(fees, { migrationHash: 'b'.repeat(64) })), /DUPLICATE_GRADUATION_CONFLICT/)
      assert.equal(await recordStockObservation(pool, graduated(fees)), 'inserted')
      assert.equal(await recordStockObservation(pool, graduated(fees), { now: () => Date.now() + 3_600_000 }), null, 'a migrated curve never changes: no heartbeat')
      const { rows: [event] } = await pool.query('select asset_id, quote_mint, dbc_pool, damm_pool, migration_signature, slot::text from stock_graduation_events')
      assert.deepEqual(event, { asset_id: 'meta-xstock', quote_mint: META.mint, dbc_pool: fixture.market.curve, damm_pool: fixture.dammPool,
        migration_signature: migration.signature, slot: String(migration.slot) })
      const { rows: [reading] } = await pool.query('select is_migrated from stock_graduation_observations order by observed_at desc, id desc limit 1')
      assert.equal(reading.is_migrated, true)
    })

    await t.test('DAMM fee checkpoints: the creator side pays the launcher floor(earned * 150 / 497) as a running total, the partner side none', async () => {
      assert.deepEqual(await recordStockDammCheckpoints(pool, graduated({ slot: '200', creator: '0', partner: '0' })), [], 'nothing earned yet')
      const first = await recordStockDammCheckpoints(pool, graduated({ slot: '210', creator: '1000', partner: '571' }))
      assert.deepEqual(first.map(row => [row.side, row.credit, row.launcherCredit, row.accumulatorCredit]), [['creator', '1000', '301', '699'], ['partner', '571', '0', '571']])
      assert.deepEqual(await recordStockDammCheckpoints(pool, graduated({ slot: '210', creator: '1000', partner: '571' })), [], 'a slot is checkpointed once')
      assert.deepEqual(await recordStockDammCheckpoints(pool, graduated({ slot: '205', creator: '2000', partner: '571' })), [], 'never an older slot')
      // The running total: floor(2000 * 150 / 497) = 603, so the launcher is credited 302 for this 1000, where splitting the 1000 on its
      // own would give floor(1000 * 150 / 497) = 301 again and lose a unit to rounding every checkpoint. A claim leaves earnings as they were.
      const second = await recordStockDammCheckpoints(pool, graduated({ slot: '220', creator: '2000', partner: '571', partnerClaimed: '571' }))
      assert.deepEqual(second.map(row => [row.side, row.credit, row.launcherCredit, row.accumulatorCredit]), [['creator', '1000', '302', '698']])
      const { rows } = await pool.query(`select side, sum(credit)::text as credit, sum(launcher_credit)::text as launcher, sum(accumulator_credit)::text as accumulator,
        max(launcher_cumulative)::text as cumulative, min(policy_version) as policy from stock_damm_fee_checkpoints group by side order by side`)
      assert.deepEqual(rows, [{ side: 'creator', credit: '2000', launcher: '603', accumulator: '1397', cumulative: '603', policy: 1 },
        { side: 'partner', credit: '571', launcher: '0', accumulator: '571', cumulative: '0', policy: 1 }])
      await assert.rejects(recordStockDammCheckpoints(pool, graduated({ slot: '230', creator: '1999', partner: '571' })),
        error => error.code === 'STOCK_DAMM_CUMULATIVE_DECREASED')
      await assert.rejects(recordStockDammCheckpoints(pool, graduated({ slot: '240', creator: '3000', partner: '600' }, { fees: { slot: '240',
        creator: { position: Keypair.generate().publicKey.toBase58(), earned: '3000', claimed: '0' }, partner: { position: migration.partnerPosition, earned: '600', claimed: '0' } } })),
      /MIGRATION_EVIDENCE_INCOMPLETE/)
      const [docs] = (await stockGraduationOperatorView(pool)).filter(row => row.repoId === '94911145')
      assert.deepEqual([docs.phase, docs.dammPool, docs.dammLauncherCredited, docs.dammAccumulatorCredited], ['GRADUATED', fixture.dammPool, '603', '1968'])
    })

    await t.test('the DAMM swap indexer records real swaps once, both providers agreeing, and quarantines a swap it cannot match', async () => {
      // Two providers over the captured transactions: one getTransaction answer per signature, newest-first pool history.
      const transactions = new Map(Object.values(fixture.transactions).map(tx => [tx.transaction.signatures[0], tx]))
      const history = [], providers = []
      const provider = name => {
        const url = `https://${name}.stock-graduation.invalid`
        registerRpcEndpoint(url, async (_, init) => {
          const { params: [signature] } = JSON.parse(init.body)
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: transactions.get(signature) ?? null }), { status: 200 })
        })
        const connection = Object.assign(Object.create(new Connection(url)), { getSignaturesForAddress: async () => provider.history?.[name] ?? history })
        providers.push(connection)
        return connection
      }
      const primary = provider('primary'), verification = provider('verification')
      const order = ['siteSell', 'siteBuy', 'directSell', 'directBuy', 'migration']
      history.push(...order.map(name => ({ signature: fixture.transactions[name].transaction.signatures[0], slot: fixture.transactions[name].slot, err: null })))
      const run = () => indexStockDammTrades({ db: pool, connection: primary, verification, market, quote: META,
        graduation: { pool: fixture.dammPool, signature: migration.signature, slot: migration.slot } })
      // The first pass reads the migration transaction itself (no swap in it here), then the four swaps after it.
      const first = await run()
      assert.deepEqual([first.transactions, first.remaining, first.inserted, first.quarantined, first.openQuarantines], [5, 0, 4, [], 0])
      const { rows } = await pool.query(`select signature, venue, direction, quote_amount::text, asset_id, quote_mint from stock_trade_events order by slot, event_index`)
      assert.deepEqual(rows.map(row => [row.signature, row.venue, row.direction, row.asset_id, row.quote_mint]),
        ['directBuy', 'directSell', 'siteBuy', 'siteSell'].map((name, i) => [fixture.transactions[name].transaction.signatures[0], 'damm', i % 2 ? 'sell' : 'buy', 'meta-xstock', META.mint]))
      // quote_amount as on the curve rows: a buy's stock without the pool's fee (0.5 METAx paid), a sell's stock received.
      assert.deepEqual(rows.map(row => row.quote_amount), ['198000000', '104284101', '49400054', '48815461'])
      assert.deepEqual((await run()).transactions, 0, 'the cursor is at the newest swap')
      assert.equal((await pool.query('select count(*)::int as n from damm_trade_events')).rows[0].n, 0, 'never the SOL ledger')

      // A newer swap whose event is missing: quarantined (a durable alert), never skipped; the cursor moves on.
      const broken = structuredClone(fixture.transactions.siteBuy), signature = bs58.encode(Buffer.alloc(64, 42))
      broken.transaction.signatures[0] = signature
      const group = broken.meta.innerInstructions.find(g => g.instructions.some(ix => Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d'))
      group.instructions = group.instructions.filter(ix => Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex') !== 'e445a52e51cb9a1d')
      transactions.set(signature, broken)
      history.unshift({ signature, slot: broken.slot + 10, err: null })
      const quarantined = await run()
      assert.deepEqual([quarantined.transactions, quarantined.inserted, quarantined.quarantined, quarantined.openQuarantines], [1, 0, [signature], 1])
      const { rows: [alert] } = await pool.query('select kind, detail, acknowledged_at from graduation_alerts where kind=$1', [STOCK_DAMM_QUARANTINE])
      assert.deepEqual([alert.kind, JSON.parse(alert.detail).signature, JSON.parse(alert.detail).code, alert.acknowledged_at], [STOCK_DAMM_QUARANTINE, signature, 'STOCK_DAMM_SWAP_UNMATCHED', null])
      assert.equal((await stockGraduationOperatorView(pool)).find(row => row.repoId === '94911145').openQuarantines, 1)
      // Retried every run until it parses (here: the providers now return the full transaction); then recorded and acknowledged.
      const repaired = structuredClone(fixture.transactions.siteBuy)
      repaired.transaction.signatures[0] = signature
      transactions.set(signature, repaired)
      clearFinalizedTransactionCache()
      const retried = await run()
      assert.deepEqual([retried.inserted, retried.quarantined, retried.openQuarantines], [1, [], 0])
      assert.ok((await pool.query('select acknowledged_at from graduation_alerts where kind=$1', [STOCK_DAMM_QUARANTINE])).rows[0].acknowledged_at)

      // Providers that disagree about the pool's history stop the pass; so does a "swap" before the migration.
      history.unshift({ signature: bs58.encode(Buffer.alloc(64, 43)), slot: broken.slot + 20, err: null })
      provider.history = { verification: history.slice(1) }
      await assert.rejects(run(), /RPC_DISAGREEMENT/)
      provider.history = null
      transactions.set(history[0].signature, { ...structuredClone(fixture.transactions.directBuy), slot: migration.slot - 1,
        transaction: { ...structuredClone(fixture.transactions.directBuy.transaction), signatures: [history[0].signature] } })
      await assert.rejects(indexStockDammTrades({ db: pool, connection: primary, verification, market, quote: META,
        graduation: { pool: fixture.dammPool, signature: migration.signature, slot: migration.slot } }), /DAMM_TRADE_PRECEDES_MIGRATION/)
      await assert.rejects(indexStockDammTrades({ db: pool, connection: primary, verification, market, quote: SOL_QUOTE, graduation: { pool: fixture.dammPool } }),
        /STOCK_QUOTE_MINT_REQUIRED/)
    })

    await t.test('a swap bundled into the migration transaction is indexed; a long backlog is worked off over capped passes', async () => {
      await pool.query('delete from stock_trade_events where pool = $1', [fixture.dammPool])
      await pool.query('delete from stock_pool_cursors where pool = $1', [fixture.dammPool])
      const transactions = new Map(Object.values(fixture.transactions).map(tx => [tx.transaction.signatures[0], tx]))
      const order = ['siteSell', 'siteBuy', 'directSell'].map(name => fixture.transactions[name])
      const providers = ['primary', 'verification'].map(name => {
        const url = `https://${name}.stock-bundled.invalid`
        registerRpcEndpoint(url, async (_, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1,
          result: transactions.get(JSON.parse(init.body).params[0]) ?? null }), { status: 200 }))
        return Object.assign(Object.create(new Connection(url)), { getSignaturesForAddress: async () =>
          [...order, fixture.transactions.directBuy].map(tx => ({ signature: tx.transaction.signatures[0], slot: tx.slot, err: null })) })
      })
      // As if the migration had carried the first swap on the new pool: the migration transaction is the direct buy.
      const bundled = fixture.transactions.directBuy
      const run = () => indexStockDammTrades({ db: pool, connection: providers[0], verification: providers[1], market, quote: META, maxTransactions: 2,
        graduation: { pool: fixture.dammPool, signature: bundled.transaction.signatures[0], slot: bundled.slot } })
      const first = await run()
      assert.deepEqual([first.transactions, first.remaining, first.inserted], [3, 1, 3], 'the migration transaction and two after it')
      const second = await run()
      assert.deepEqual([second.transactions, second.remaining, second.inserted], [1, 0, 1])
      const { rows } = await pool.query('select signature from stock_trade_events where pool = $1 order by slot, event_index', [fixture.dammPool])
      assert.deepEqual(rows.map(row => row.signature), ['directBuy', 'directSell', 'siteBuy', 'siteSell'].map(name => fixture.transactions[name].transaction.signatures[0]))
      // A stored row under the same key must be the same event: anything else stops the pass, never passed over.
      await pool.query(`update stock_trade_events set quote_amount = quote_amount + 1 where signature = $1`, [bundled.transaction.signatures[0]])
      await pool.query('delete from stock_pool_cursors where pool = $1', [fixture.dammPool])
      await assert.rejects(run(), /STOCK_TRADE_ROW_CONFLICT/)
    })

    await t.test('a market the monitor cannot verify is REVIEW with a code and one alert, never skipped', async () => {
      const connection = new Connection('http://127.0.0.1:1')
      const monitor = createStockGraduationMonitor({ pool, connection, verification: null, config: Keypair.generate().publicKey.toBase58(), env: { NODE_ENV: 'test' } })
      const result = await monitor.processMarket(market)
      assert.deepEqual([result.status, result.code], ['REVIEW', 'VERIFICATION_RPC_REQUIRED'])
      assert.deepEqual((await monitor.processMarket(market)).alerts, [], 'one alert per code')
      assert.equal((await pool.query("select count(*)::int as n from graduation_alerts where kind='STOCK_GRADUATION_REVIEW'")).rows[0].n, 1)
      assert.deepEqual((await monitor.runOnce()).map(row => [row.status, row.code]), [['REVIEW', 'VERIFICATION_RPC_REQUIRED']])
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, 'repoing_stock_graduation_test')
    await admin.end()
  }
})
