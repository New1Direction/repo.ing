import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFile } from 'node:fs/promises'
import { quoteAssetById } from '../src/quote-assets.mjs'

// Migration 0055 (read indexes for the stock ledgers of 0054) on real PostgreSQL, migrated from empty to the latest journal
// entry: it adds exactly its three indexes and nothing else, re-applying it changes nothing, and each read it is for uses
// its index once a market has a history (a month of trades and fee events, a year of settled collections).
const DB = 'repoing_stock_ledger_indexes_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const META = quoteAssetById('meta-xstock'), DOCS = '94911145'
const STOCK = `${DOCS}, '${META.assetId}', '${META.mint}'`
const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (${DOCS},'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
  (${DOCS},'confirmed','MintDocs','PoolDocs','LauncherDocs','CreatorDocs','Docusaurus','DOCUSAURUS','LaunchDocs','Hash',100,12,'finalized',now(),now(),
    '${META.assetId}','${META.mint}',1);
insert into stock_trade_events(github_repo_id,asset_id,quote_mint,venue,pool,signature,event_index,slot,traded_at,direction,quote_amount,
    base_amount,next_sqrt_price,trader)
  select ${STOCK},'dbc','PoolDocs','Trade' || g,0,g,now() - g * interval '1 minute','buy',1,1,'1','Trader' from generate_series(1, 43200) g;
insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,launcher_amount,
    accumulator_amount,policy_version)
  select ${STOCK},'PoolDocs','Trade' || g,0,g,10,4,3,11,1 from generate_series(1, 43200) g;
insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,source,reviewed_amount,actual_amount,launcher_amount,accumulator_amount,
    terms_hash,status,signature,receipt,settled_at)
  select ${STOCK},'dbc_creator',10,10,3,7,repeat('a', 64),case when g % 10 = 0 then 'settled' else 'aborted' end,
    case when g % 10 = 0 then 'Collect' || g end,case when g % 10 = 0 then '{}'::jsonb end,case when g % 10 = 0 then now() end
  from generate_series(1, 365) g;
analyze stock_trade_events; analyze stock_fee_events; analyze stock_fee_collections;`
const INDEXES = {
  stock_trade_events_repo_traded_at: 'CREATE INDEX stock_trade_events_repo_traded_at ON public.stock_trade_events USING btree (github_repo_id, traded_at)',
  stock_fee_events_repo_slot: 'CREATE INDEX stock_fee_events_repo_slot ON public.stock_fee_events USING btree (github_repo_id, slot DESC, event_index DESC)',
  stock_fee_collections_repo_status: 'CREATE INDEX stock_fee_collections_repo_status ON public.stock_fee_collections USING btree (github_repo_id, status)',
}
const catalog = async pool => Object.fromEntries((await pool.query(`select indexname, indexdef from pg_indexes
  where schemaname = 'public' order by indexname`)).rows.map(row => [row.indexname, row.indexdef]))
const statements = async () => (await readFile('drizzle/0055_stock_ledger_indexes.sql', 'utf8')).split('--> statement-breakpoint')

test('migration 0055 adds the stock ledgers\' read indexes and nothing else', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  assert.ok(journal.entries.some(entry => entry.tag === '0055_stock_ledger_indexes'), '0055 is in the journal')
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  let created = false, pool
  try {
    await admin.query(`drop database if exists ${DB}`)
    await admin.query(`create database ${DB}`); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    const after = await catalog(pool)

    await t.test('the three indexes exist exactly as written', () => {
      for (const [name, definition] of Object.entries(INDEXES)) assert.equal(after[name], definition, name)
    })

    await t.test('0055 adds nothing but its indexes: without them the catalog is as 0054 left it', async () => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        for (const name of Object.keys(INDEXES)) await client.query(`drop index ${name}`)
        const without = await catalog(client)
        assert.deepEqual(Object.keys(after).filter(name => !(name in without)).sort(), Object.keys(INDEXES).sort())
      } finally {
        await client.query('rollback')
        client.release()
      }
    })

    await t.test('re-applying 0055 changes nothing', async () => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        for (const statement of await statements()) await client.query(statement)
        await client.query('commit')
      } finally { client.release() }
      assert.deepEqual(await catalog(pool), after)
    })

    await t.test('each read it is for uses its index', async () => {
      await pool.query(SEED)
      const client = await pool.connect()
      try {
        await client.query('begin')
        // A year of collections is a few pages, cheapest to scan whole; with sequential scans off, the plan shows the index
        // the planner picks among the table's indexes from their statistics.
        await client.query('set local enable_seqscan = off')
        for (const [read, index] of [
          [`select coalesce(sum(quote_amount), 0) from stock_trade_events where github_repo_id = 94911145
            and traded_at >= now() - interval '24 hours'`, 'stock_trade_events_repo_traded_at'],
          [`select signature, event_index from stock_fee_events where github_repo_id = 94911145
            order by slot desc, event_index desc limit 30`, 'stock_fee_events_repo_slot'],
          [`select coalesce(sum(launcher_amount), 0) from stock_fee_collections where github_repo_id = 94911145
            and status = 'settled'`, 'stock_fee_collections_repo_status'],
        ]) {
          const plan = (await client.query(`explain ${read}`)).rows.map(row => row['QUERY PLAN']).join('\n')
          assert.match(plan, new RegExp(`\\b${index}\\b`), `${read}\n${plan}`)
        }
      } finally {
        await client.query('rollback')
        client.release()
      }
    })
  } finally {
    await pool?.end()
    if (created) await admin.query(`drop database if exists ${DB}`)
    await admin.end()
  }
})
