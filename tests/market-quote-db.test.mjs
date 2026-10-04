import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFile, mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quoteStamp, resolveQuoteAsset } from '../src/quote-assets.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Migration 0053 (market quote asset) on real PostgreSQL: the database is brought to 0052, seeded with SOL markets (confirmed
// and indexed, failed, submitted, ambiguous, and an indexed row in a pre-send status), then upgraded. Existing rows must read back identically with null quote columns; a stock stamp must be all-or-none,
// never an explicit SOL, GitHub-only, and immutable once the launch was sent; re-applying the file changes nothing.
const URL_ = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_market_quote_test'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const META = resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })
const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (94911145,'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z'),
  (10270250,'facebook','react','facebook/react',null,null,240000,49000,false,'2026-10-01T00:00:00Z'),
  (41881900,'microsoft','vscode','microsoft/vscode',null,null,180000,35000,false,'2026-10-01T00:00:00Z'),
  (1296269,'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-10-01T00:00:00Z'),
  (7,'fixture','submitted','fixture/submitted',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (8,'fixture','ambiguous','fixture/ambiguous',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (9,'fixture','indexed','fixture/indexed',null,null,1,0,false,'2026-10-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at) values
  (1296269,'confirmed','MintSol','PoolSol','Launcher','Creator','Hello','HELLO','LaunchSol','Hash',100,10,'finalized',now(),now()),
  (10270250,'failed',null,null,'Launcher','Creator','React','REACT',null,null,null,null,null,null,null),
  (7,'submitted','MintSub','PoolSub','Launcher','Creator','Sub','SUB','LaunchSub','Hash',100,null,null,null,null),
  (8,'ambiguous','MintAmb','PoolAmb','Launcher','Creator','Amb','AMB','LaunchAmb','Hash',100,null,null,null,null),
  (9,'prepared','MintIdx','PoolIdx','Launcher','Creator','Idx','IDX',null,'Hash',100,11,'finalized',now(),now());`
const marketsCanonical = async pool => (await pool.query(`select md5(string_agg(row(github_repo_id,status,mint,pool,launcher_wallet,
  creator_wallet,token_name,token_symbol,launch_signature,indexed_at)::text, E'\\n' order by github_repo_id)) as sum from markets`)).rows[0].sum
async function refused(pool, sql, check, params = []) {
  await assert.rejects(pool.query(sql, params), error => {
    assert.ok(error.constraint === check || error.message.includes(check), `${error.message} (${sql.slice(0, 70)})`)
    return true
  })
}

test('migration 0053 leaves SOL markets as they were and guards every stock stamp', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  const at = journal.entries.findIndex(entry => entry.tag === '0053_market_quote_asset')
  assert.ok(at > 0, '0053 is in the journal')
  const admin = new pg.Pool({ connectionString: URL_.replace(/repoing_market_quote_test$/, 'postgres') })
  const folder = await mkdtemp(join(tmpdir(), 'repoing-0053-'))
  let created = false, pool
  try {
    await admin.query('drop database if exists repoing_market_quote_test')
    await admin.query('create database repoing_market_quote_test'); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await mkdir(join(folder, 'meta'))
    const baseline = { ...journal, entries: journal.entries.slice(0, at) }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(baseline))
    for (const entry of baseline.entries) await copyFile(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
    await migrate(drizzle(pool), { migrationsFolder: folder })
    await pool.query(SEED)
    const before = await marketsCanonical(pool)

    await t.test('upgrading keeps every market row, SOL stays null, and re-applying 0053 is a no-op', async () => {
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
      for (const statement of (await readFile('drizzle/0053_market_quote_asset.sql', 'utf8')).split('--> statement-breakpoint')) await pool.query(statement)
      assert.equal(await marketsCanonical(pool), before)
      const { rows } = await pool.query('select count(*)::int as n from markets where quote_asset_id is not null or quote_mint is not null or quote_registry_version is not null')
      assert.equal(rows[0].n, 0)
    })

    await t.test('a stock reservation stores the exact asset, mint and registry version', async () => {
      const stamp = quoteStamp(META)
      await pool.query(`insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,quote_asset_id,quote_mint,quote_registry_version)
        values (94911145,'reserved','Launcher','Creator','Docusaurus','DOCUSAURUS',$1,$2,$3)`, [stamp.quoteAssetId, stamp.quoteMint, stamp.quoteRegistryVersion])
      const { rows: [row] } = await pool.query('select quote_asset_id, quote_mint, quote_registry_version from markets where github_repo_id = 94911145')
      assert.deepEqual(row, { quote_asset_id: 'meta-xstock', quote_mint: META.mint, quote_registry_version: META.registryVersion })
    })

    await t.test('partial stamps, an explicit SOL stamp, a ticker as id, a malformed mint and version 0 are refused', async () => {
      const insert = values => `insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,quote_asset_id,quote_mint,quote_registry_version) values ${values}`
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE','msft-xstock',null,1)`), 'markets_quote_asset_check')
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE',null,'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',null)`), 'markets_quote_asset_check')
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE','msft-xstock','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',null)`), 'markets_quote_asset_check')
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE',null,null,1)`), 'markets_quote_asset_check')
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE','sol','${SOL_MINT}',1)`), 'markets_quote_asset_check')
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE','msft-xstock','${SOL_MINT}',1)`), 'markets_quote_asset_check')
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE','MSFTx','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',1)`), 'markets_quote_asset_check')
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE','msft-xstock','not a mint',1)`), 'markets_quote_asset_check')
      await refused(pool, insert(`(41881900,'reserved','L','C','VSCode','VSCODE','msft-xstock','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',0)`), 'markets_quote_asset_check')
      // A Hugging Face model market can never carry a stock pair.
      const { rows: [model] } = await pool.query(`insert into hf_models(hf_id,repo_path,owner_handle,owner_kind) values (repeat('a',24),'meta-llama/x','meta-llama','org') returning market_ref::text as id`)
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at,source,hf_model_ref)
        values ($1,'meta-llama','x','meta-llama/x',0,0,false,now(),'huggingface',$1)`, [model.id])
      await refused(pool, `insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,quote_asset_id,quote_mint,quote_registry_version)
        values (${model.id},'reserved','L','C','Model','MODEL','meta-xstock','${META.mint}',1)`, 'markets_quote_asset_check')
    })

    await t.test('an unsent reservation may change pair; a sent or indexed launch never can', async () => {
      // failed → a new attempt with a stock pair, then back to SOL before anything was sent
      await pool.query(`update markets set status='reserved', quote_asset_id='meta-xstock', quote_mint=$1, quote_registry_version=1 where github_repo_id=10270250`, [META.mint])
      await pool.query(`update markets set status='prepared' where github_repo_id=10270250`)
      await pool.query(`update markets set quote_asset_id=null, quote_mint=null, quote_registry_version=null where github_repo_id=10270250`)
      await refused(pool, `update markets set quote_asset_id='meta-xstock', quote_mint='${META.mint}', quote_registry_version=1 where github_repo_id=7`, 'immutable once its launch was sent')
      await refused(pool, `update markets set quote_asset_id='meta-xstock', quote_mint='${META.mint}', quote_registry_version=1 where github_repo_id=1296269`, 'immutable once its launch was sent')
      await refused(pool, `update markets set quote_asset_id='meta-xstock', quote_mint='${META.mint}', quote_registry_version=1 where github_repo_id=8`, 'immutable once its launch was sent')
      await refused(pool, `update markets set quote_asset_id='meta-xstock', quote_mint='${META.mint}', quote_registry_version=1 where github_repo_id=9`, 'immutable once its launch was sent')
      // A failed stock attempt's stamp is cleared by a later SOL attempt on the same row (reserve() writes nulls for SOL).
      await pool.query(`update markets set status='failed', quote_asset_id='meta-xstock', quote_mint=$1, quote_registry_version=1 where github_repo_id=10270250`, [META.mint])
      await pool.query(`update markets set status='reserved', quote_asset_id=null, quote_mint=null, quote_registry_version=null where github_repo_id=10270250`)
      assert.deepEqual((await pool.query('select status, quote_asset_id from markets where github_repo_id=10270250')).rows[0], { status: 'reserved', quote_asset_id: null })
      // Nor in the same statement that sends the launch.
      await refused(pool, `update markets set status='submitted', launch_signature='LaunchReact', mint='MintReact', pool='PoolReact', quote_asset_id='meta-xstock', quote_mint='${META.mint}', quote_registry_version=1 where github_repo_id=10270250`, 'immutable once its launch was sent')
      // the stamped reservation, once sent, keeps its stamp; other columns still update
      await pool.query(`update markets set status='submitted', mint='MintDocs', pool='PoolDocs', launch_signature='LaunchDocs' where github_repo_id=94911145`)
      await refused(pool, `update markets set quote_asset_id=null, quote_mint=null, quote_registry_version=null where github_repo_id=94911145`, 'immutable once its launch was sent')
      await refused(pool, `update markets set quote_registry_version=2 where github_repo_id=94911145`, 'immutable once its launch was sent')
      await pool.query(`update markets set status='confirmed' where github_repo_id=94911145`)
      const { rows: [row] } = await pool.query('select status, quote_asset_id from markets where github_repo_id=94911145')
      assert.deepEqual(row, { status: 'confirmed', quote_asset_id: 'meta-xstock' })
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, 'repoing_market_quote_test')
    await admin.end()
    await rm(folder, { recursive: true, force: true })
  }
})
