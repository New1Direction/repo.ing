import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createStockFeeIndexer } from '../src/stock-fee-indexer.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { SOL_INDEXER_MARKETS, STOCK_INDEXER_MARKETS, checkDatabase } from '../src/stock-readiness.mjs'

// The readiness database checks (src/stock-readiness.mjs, docs/STOCK_GO_LIVE.md) on real PostgreSQL: migration 0054's tables,
// functions and triggers; the SOL/stock market partition, which must be exactly the lists the two worker indexers walk; and no
// stock-paired market in any SOL ledger. Every read is in a READ ONLY transaction that is rolled back.
const DB = 'repoing_stock_readiness_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const META = quoteAssetById('meta-xstock'), MSFT = quoteAssetById('msft-xstock')
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const sig = n => bs58.encode(Buffer.alloc(64, n))
// Two indexed SOL markets, two SOL markets not indexed (a submitted launch, a confirmed one not indexed yet), an indexed
// DOCUSAURUS / METAx market and a VSCODE / MSFTx reservation. SOL ledger rows for the SOL markets, stock ledger rows for METAx.
const DOCS = '94911145'
const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (1296269,'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-10-01T00:00:00Z'),
  (10270250,'facebook','react','facebook/react',null,null,240000,49000,false,'2026-10-01T00:00:00Z'),
  (7,'fixture','submitted','fixture/submitted',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (8,'fixture','unindexed','fixture/unindexed',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (${DOCS},'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z'),
  (41881900,'microsoft','vscode','microsoft/vscode',null,null,180000,35000,false,'2026-10-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
  (1296269,'confirmed','${key(12)}','${key(11)}','L','C','Hello','HELLO','${sig(11)}','H',100,10,'finalized',now(),now(),null,null,null),
  (10270250,'confirmed','${key(22)}','${key(21)}','L','C','React','REACT','${sig(21)}','H',100,10,'finalized',now(),now(),null,null,null),
  (7,'submitted','${key(32)}','${key(31)}','L','C','Sub','SUB','${sig(31)}','H',100,null,null,null,null,null,null,null),
  (8,'confirmed','${key(52)}','${key(51)}','L','C','Unidx','UNIDX','${sig(51)}','H',100,null,null,null,null,null,null,null),
  (${DOCS},'confirmed','${key(42)}','${key(41)}','L','C','Docusaurus','DOCUSAURUS','${sig(41)}','H',100,10,'finalized',now(),now(),
    '${META.assetId}','${META.mint}',1),
  (41881900,'prepared',null,null,'L','C','VSCode','VSCODE',null,null,null,null,null,null,null,'${MSFT.assetId}','${MSFT.mint}',1);
insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader) values
  ('${key(11)}','${sig(61)}',0,11,'2026-10-01T00:00:00Z','buy','1000000000','35000000000','123456789','${key(60)}');
insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot) values
  (1296269,'${key(12)}','${key(11)}','${sig(61)}',0,9940000,'${SOL_MINT}','dbc_creator_quote',11);
insert into discovery_fee_events(github_repo_id,pool,signature,event_index,partner_amount,slot,traded_at) values
  (1296269,'${key(11)}','${sig(61)}',0,4060000,11,'2026-10-01T00:00:00Z');
insert into pool_fee_cursors(pool,last_signature,last_slot) values ('${key(11)}','${sig(61)}',11);
insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,next_sqrt_price,trader,base_amount) values
  (10270250,'${key(23)}','${sig(62)}',0,30,'2026-10-02T00:00:00Z',500000000,'sell','{}','123456789','${key(60)}',1000000);
insert into damm_fee_events(github_repo_id,pool,position,slot,amount_base_units,cumulative_earned,cumulative_claimed,evidence_hash,evidence) values
  (10270250,'${key(23)}','${key(24)}',31,5000,5000,0,repeat('a',64),'{}');
insert into platform_fee_events(github_repo_id,pool,position,slot,amount_base_units,cumulative_earned,cumulative_claimed,evidence_hash,evidence) values
  (10270250,'${key(23)}','${key(25)}',31,2000,2000,0,repeat('b',64),'{}');
insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at) values
  (1296269,'${key(60)}',9940000,'${SOL_MINT}','${sig(63)}','settled','2026-10-03T00:00:00Z');
insert into stock_trade_events(github_repo_id,asset_id,quote_mint,venue,pool,signature,event_index,slot,traded_at,direction,quote_amount,base_amount,
    next_sqrt_price,trader) values
  (${DOCS},'${META.assetId}','${META.mint}','dbc','${key(41)}','${sig(71)}',0,40,'2026-10-03T00:00:00Z','buy',100000000,4000,'18446744073709551616','${key(60)}');
insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,launcher_amount,
    accumulator_amount,policy_version) values
  (${DOCS},'${META.assetId}','${META.mint}','${key(41)}','${sig(71)}',0,40,1235927,504872,373016,1367783,1);`

// The worker's two indexers over a chain whose every pool history is just its launch (as tests/stock-curve-indexing-db.test.mjs).
const launches = new Map([[key(11), sig(11)], [key(21), sig(21)], [key(41), sig(41)]])
const connection = { getSignaturesForAddress: async pool => [{ signature: launches.get(pool.toBase58()), slot: 1, err: null }] }
const indexed = async indexer => (await indexer.runOnce()).map(result => String(result.githubRepoId))
const solIndexer = pool => createExternalFeeIndexer({ pool, connection, config: key(90), graduatedFees: { read: async () => null },
  recordTrade: async () => 0, accrual: { recordTradeFees: async () => ({ creditedBaseUnits: 0n, eventKeys: [] }) } })
const stockIndexer = pool => createStockFeeIndexer({ pool, connection, config: key(90), accrual: { checkCurve: async () => ({}),
  recordTradeFees: async () => ({ creditedBaseUnits: 0n, creditedPartnerUnits: 0n, eventKeys: [] }) } })

// A client that records every statement it is given.
const recording = client => {
  const statements = []
  return { statements, query: (sql, params) => { statements.push(sql.replace(/\s+/g, ' ').trim()); return client.query(sql, params) } }
}
const byName = items => Object.fromEntries(items.map(entry => [entry.name, entry]))

test('readiness database checks on PostgreSQL: migration 0054, the indexers\' partition, the SOL ledgers', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL ?? URL_, URL_)
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  let pool, client, created = false
  try {
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB}`); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await pool.query(SEED)
    client = await pool.connect()

    await t.test('a migrated database passes every check, read in READ ONLY transactions that are rolled back', async () => {
      const db = recording(client)
      const items = byName(await checkDatabase({ db }))
      assert.deepEqual(Object.keys(items), ['Migration 0054', 'Market partition', 'SOL ledgers'])
      assert.deepEqual(Object.values(items).map(entry => entry.status), ['PASS', 'PASS', 'PASS'], JSON.stringify(items))
      assert.equal(items['Migration 0054'].reason, '10 stock tables, 3 functions and 10 triggers present, every trigger enabled')
      assert.equal(items['Market partition'].reason, '3 indexed markets: 2 SOL (the SOL indexer\'s list) + 1 stock (the stock indexer\'s list), none in both')
      assert.equal(items['SOL ledgers'].reason, 'no stock-paired market in any of the 12 SOL fee, trade, claim and reward tables')
      const kinds = db.statements.map(sql => sql.startsWith('select ') ? 'select' : sql)
      assert.deepEqual(kinds.filter(kind => kind !== 'select'), Array(3).fill(['begin transaction read only', "set local statement_timeout = '30s'", 'rollback']).flat())
      assert.equal((await client.query('show transaction_read_only')).rows[0].transaction_read_only, 'off', 'no transaction left open')
    })

    await t.test('the partition checked is exactly what the SOL and stock indexers walk', async () => {
      const lists = async where => (await client.query(`select github_repo_id::text as id from markets where ${where} order by github_repo_id`)).rows.map(row => row.id)
      const sol = await indexed(solIndexer(pool)), stock = await indexed(stockIndexer(pool))
      assert.deepEqual(sol, await lists(SOL_INDEXER_MARKETS))
      assert.deepEqual(stock, await lists(STOCK_INDEXER_MARKETS))
      assert.deepEqual([sol, stock], [['1296269', '10270250'], [DOCS]])
    })

    await t.test('a stock-paired market\'s rows in SOL ledgers fail, naming each ledger and the market', async () => {
      await client.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot) values
        (${DOCS},'${key(42)}','${key(41)}','${sig(81)}',0,1000,'${SOL_MINT}','dbc_creator_quote',41)`)
      await client.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price)
        values ('${key(41)}','${sig(81)}',0,41,'2026-10-03T00:00:00Z','buy','100','4000','18446744073709551616')`)
      await client.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at) values
        (${DOCS},'${key(60)}',1000,'${SOL_MINT}','${sig(82)}','settled','2026-10-03T00:00:00Z')`)
      try {
        const items = byName(await checkDatabase({ db: client }))
        assert.equal(items['SOL ledgers'].status, 'FAIL')
        assert.equal(items['SOL ledgers'].reason, `fee_events has 1 row(s) of stock-paired market(s) ${DOCS}; trade_events has 1 row(s) of ` +
          `stock-paired market(s) ${DOCS}; repo_claims has 1 row(s) of stock-paired market(s) ${DOCS}: stock pairs must stay in the stock ledgers`)
        assert.deepEqual([items['Migration 0054'].status, items['Market partition'].status], ['PASS', 'PASS'])
      } finally {
        await client.query(`delete from fee_events where signature = '${sig(81)}'`)
        await client.query(`delete from trade_events where signature = '${sig(81)}'`)
        await client.query(`delete from repo_claims where claim_signature = '${sig(82)}'`)
      }
      assert.equal(byName(await checkDatabase({ db: client }))['SOL ledgers'].status, 'PASS')
    })

    await t.test('a disabled or missing 0054 trigger or function fails', async () => {
      await client.query('alter table stock_fee_events disable trigger stock_ledger_market_check')
      await client.query('drop trigger repoing_stock_trade_update on stock_trade_events')
      await client.query('drop function stock_launcher_payout_wallet_check() cascade')
      const items = byName(await checkDatabase({ db: client }))
      assert.equal(items['Migration 0054'].status, 'FAIL')
      assert.equal(items['Migration 0054'].reason, 'function stock_launcher_payout_wallet_check() missing; trigger stock_ledger_market_check on ' +
        'stock_fee_events disabled; trigger stock_launcher_payout_wallet_check on stock_launcher_payouts missing; trigger repoing_stock_trade_update ' +
        'on stock_trade_events missing: apply migration 0054 as written')
      await client.query('drop table stock_settlement_receipts')
      assert.match(byName(await checkDatabase({ db: client }))['Migration 0054'].reason, /^table stock_settlement_receipts missing; function/)
    })
  } finally {
    client?.release()
    await pool?.end()
    if (created) await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.end()
  }
})
