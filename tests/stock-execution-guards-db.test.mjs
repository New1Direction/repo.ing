import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFile } from 'node:fs/promises'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { STOCK_EXECUTION_ERRORS as E } from '../src/stock-execution.mjs'
import { createStockExecutionStore } from '../src/stock-execution-store.mjs'

// Migration 0056 (guards and a read index for stock execution) on real PostgreSQL, migrated from empty to the latest journal entry:
// it adds exactly its three indexes and nothing else, re-applying it changes nothing, a transaction signature can be stored on
// only one collection and one payout, and the custody gate's read of a stock's payouts uses its index.
const DB = 'repoing_stock_execution_guards_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const META = quoteAssetById('meta-xstock'), MSFT = quoteAssetById('msft-xstock'), DOCS = '94911145', VSCODE = '41881900', TERMINAL = '31439230'
const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (${DOCS},'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z'),
  (${VSCODE},'facebook','other','facebook/other',null,null,1,1,false,'2026-10-01T00:00:00Z'),
  (${TERMINAL},'microsoft','terminal','microsoft/terminal',null,null,90000,8000,false,'2026-10-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
  (${DOCS},'confirmed','MintDocs','PoolDocs','LauncherDocs','CreatorDocs','Docusaurus','DOCUSAURUS','LaunchDocs','Hash',100,12,'finalized',now(),now(),
    '${META.assetId}','${META.mint}',1),
  (${VSCODE},'confirmed','MintOther','PoolOther','LauncherOther','CreatorOther','Other','OTHER','LaunchOther','Hash',100,12,'finalized',now(),now(),
    '${META.assetId}','${META.mint}',1),
  (${TERMINAL},'confirmed','MintTerm','PoolTerm','LauncherTerm','CreatorTerm','Terminal','TERMINAL','LaunchTerm','Hash',100,12,'finalized',now(),now(),
    '${MSFT.assetId}','${MSFT.mint}',1);`
// A history of payouts across stocks, mostly another stock's, so the plan reflects reading one stock among several.
const HISTORY = `insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,amount,status,signature,receipt,settled_at)
  select ${TERMINAL},'${MSFT.assetId}','${MSFT.mint}','LauncherTerm',1000000,'settled','PaidTerm' || g,'{}'::jsonb,now() from generate_series(1, 5000) g;
  insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,amount,status,signature,receipt,settled_at)
  select ${DOCS},'${META.assetId}','${META.mint}','LauncherDocs',1000000,'settled','PaidDocs' || g,'{}'::jsonb,now() from generate_series(1, 50) g;
  analyze stock_launcher_payouts;`
const INDEXES = {
  stock_fee_collections_signature_unique: 'CREATE UNIQUE INDEX stock_fee_collections_signature_unique ON public.stock_fee_collections USING btree (signature) WHERE (signature IS NOT NULL)',
  stock_launcher_payouts_signature_unique: 'CREATE UNIQUE INDEX stock_launcher_payouts_signature_unique ON public.stock_launcher_payouts USING btree (signature) WHERE (signature IS NOT NULL)',
  stock_launcher_payouts_asset_status: 'CREATE INDEX stock_launcher_payouts_asset_status ON public.stock_launcher_payouts USING btree (asset_id, status)',
}
const catalog = async pool => Object.fromEntries((await pool.query(`select indexname, indexdef from pg_indexes
  where schemaname = 'public' order by indexname`)).rows.map(row => [row.indexname, row.indexdef]))
const statements = async () => (await readFile('drizzle/0056_stock_execution_guards.sql', 'utf8')).split('--> statement-breakpoint')
const collection = (repoId, source, signature, status = 'settled') => ({ text: `insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,
    source,reviewed_amount,actual_amount,launcher_amount,accumulator_amount,terms_hash,status,signature,receipt,settled_at)
  values ($1,$2,$3,$4,10,${status === 'settled' ? 10 : 'null'},3,7,repeat('a',64),$5,$6,${status === 'settled' ? "'{}'::jsonb,now()" : 'null,null'})`,
values: [repoId, META.assetId, META.mint, source, status, signature] })
const payout = (repoId, wallet, signature, status = 'settled') => ({ text: `insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,
    amount,status,signature,receipt,settled_at) values ($1,$2,$3,$4,5,$5,$6,${status === 'settled' ? "'{}'::jsonb,now()" : 'null,null'})`,
values: [repoId, META.assetId, META.mint, wallet, status, signature] })

test('migration 0056 adds the stock execution guards and nothing else', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  assert.ok(journal.entries.some(entry => entry.tag === '0056_stock_execution_guards'), '0056 is in the journal')
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  let created = false, pool
  try {
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB}`); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    const after = await catalog(pool)

    await t.test('the three indexes exist exactly as written', () => {
      for (const [name, definition] of Object.entries(INDEXES)) assert.equal(after[name], definition, name)
    })

    await t.test('0056 adds nothing but its indexes: without them the catalog is as 0055 left it', async () => {
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

    await t.test('re-applying 0056 changes nothing', async () => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        for (const statement of await statements()) await client.query(statement)
        await client.query('commit')
      } finally { client.release() }
      assert.deepEqual(await catalog(pool), after)
    })

    await t.test('a transaction signature is stored on one collection and one payout only', async () => {
      await pool.query(SEED)
      await pool.query(collection(DOCS, 'dbc_creator', 'Claim1'))
      // Another source, another market, another status: the same signature is still refused.
      for (const [repoId, source, status] of [[DOCS, 'dbc_partner', 'settled'], [VSCODE, 'dbc_creator', 'settled'], [DOCS, 'dbc_partner', 'pending']]) {
        await assert.rejects(pool.query(collection(repoId, source, 'Claim1', status)), { code: '23505', constraint: 'stock_fee_collections_signature_unique' })
      }
      await pool.query(payout(DOCS, 'LauncherDocs', 'Pay1'))
      await assert.rejects(pool.query(payout(VSCODE, 'LauncherOther', 'Pay1')), { code: '23505', constraint: 'stock_launcher_payouts_signature_unique' })
      await assert.rejects(pool.query(payout(DOCS, 'LauncherDocs', 'Pay1', 'pending')), { code: '23505', constraint: 'stock_launcher_payouts_signature_unique' })
      // Rows aborted before they were ever signed carry no signature, and may be many.
      for (let i = 0; i < 3; i++) {
        await pool.query(collection(DOCS, 'dbc_creator', null, 'aborted'))
        await pool.query(payout(DOCS, 'LauncherDocs', null, 'aborted'))
      }
      // A signature is per table: a collection's and a payout's may not collide in practice, but neither guard spans both.
      await pool.query(payout(DOCS, 'LauncherDocs', 'Claim1'))
      // The execution store tells this refusal apart from a second pending row: only the latter is "in flight".
      const store = createStockExecutionStore(pool)
      const row = { repoId: DOCS, assetId: META.assetId, quoteMint: META.mint, source: 'damm_creator', reviewedAmount: '1', launcherAmount: '0',
        accumulatorAmount: '1', termsHash: 'c'.repeat(64), signature: 'Claim1', signedTransaction: 'x', receipt: {} }
      await assert.rejects(store.insertCollection(pool, row), error => error.code === '23505' && error.constraint === 'stock_fee_collections_signature_unique')
      await store.insertCollection(pool, { ...row, signature: 'Claim2' })
      await assert.rejects(store.insertCollection(pool, { ...row, signature: 'Claim3' }), { code: E.IN_FLIGHT })
    })

    await t.test("the custody gate's read of a stock's payouts uses its index", async () => {
      await pool.query(HISTORY)
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('set local enable_seqscan = off')
        const read = `select coalesce(sum(amount), 0) from stock_launcher_payouts where asset_id = '${META.assetId}' and status = 'settled'`
        const plan = (await client.query(`explain ${read}`)).rows.map(row => row['QUERY PLAN']).join('\n')
        assert.match(plan, /\bstock_launcher_payouts_asset_status\b/, plan)
        assert.deepEqual(await createStockExecutionStore(client).custodyLedger(client, META.assetId), { collected: 10n, paid: 50_000_000n + 10n, pending: 0n, spent: 0n })
      } finally {
        await client.query('rollback')
        client.release()
      }
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, DB)
    await admin.end()
  }
})
