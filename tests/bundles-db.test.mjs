import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { platformFeeRecord } from '../src/platform-fees.mjs'
import { discoverySummary } from '../src/discovery-rewards.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Bundle launches on real PostgreSQL (docs/BUNDLE_LAUNCH.md). Migration 0060: the database is brought to 0059 and seeded, then
// upgraded; existing rows read back identically with no bundle; the market stamp is SOL, GitHub, no early access, one market per
// bundle and immutable once the launch was sent; the bundles table keeps one live bundle per repository. Then the paths that
// treat partner fees as repo.ing's (platform DAMM fees, discovery rewards) never see a bundle market.
const DATABASE = 'repoing_bundles_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DATABASE}`
const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (1296269,'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-10-01T00:00:00Z'),
  (10270250,'facebook','react','facebook/react',null,null,240000,49000,false,'2026-10-01T00:00:00Z'),
  (94911145,'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z'),
  (41881900,'microsoft','vscode','microsoft/vscode',null,null,180000,35000,false,'2026-10-01T00:00:00Z'),
  (7,'fixture','submitted','fixture/submitted',null,null,1,0,false,'2026-10-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,launch_block_time,discovery_version) values
  (1296269,'confirmed','MintSol','PoolSol','Launcher','Creator','Hello','HELLO','LaunchSol','Hash',100,10,'finalized',now(),now(),now(),2),
  (10270250,'failed',null,null,'Launcher','Creator','React','REACT',null,null,null,null,null,null,null,null,null),
  (7,'submitted','MintSub','PoolSub','Launcher','Creator','Sub','SUB','LaunchSub','Hash',100,null,null,null,null,null,null);`
const marketsCanonical = async pool => (await pool.query(`select md5(string_agg(row(github_repo_id,status,mint,pool,launcher_wallet,
  creator_wallet,token_name,token_symbol,launch_signature,indexed_at,discovery_version)::text, E'\\n' order by github_repo_id)) as sum
  from markets`)).rows[0].sum
async function refused(pool, sql, check, params = []) {
  await assert.rejects(pool.query(sql, params), error => {
    assert.ok(error.constraint === check || error.message.includes(check), `${error.message} (${sql.slice(0, 90)})`)
    return true
  })
}

test('migration 0060 and bundle markets on PostgreSQL', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  const at = journal.entries.findIndex(entry => entry.tag === '0060_bundles')
  assert.ok(at > 0, '0060 is in the journal')
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DATABASE}$`), 'postgres') })
  const folder = await mkdtemp(join(tmpdir(), 'repoing-0060-'))
  let created = false, pool
  try {
    await admin.query(`drop database if exists ${DATABASE}`)
    await admin.query(`create database ${DATABASE}`); created = true
    pool = new pg.Pool({ connectionString: URL_, max: 8 })
    await mkdir(join(folder, 'meta'))
    const baseline = { ...journal, entries: journal.entries.slice(0, at) }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(baseline))
    for (const entry of baseline.entries) await copyFile(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
    await migrate(drizzle(pool), { migrationsFolder: folder })
    await pool.query(SEED)
    const before = await marketsCanonical(pool)

    await t.test('upgrading keeps every market with no bundle, and re-applying 0060 is a no-op', async () => {
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
      for (const statement of (await readFile('drizzle/0060_bundles.sql', 'utf8')).split('--> statement-breakpoint')) await pool.query(statement)
      assert.equal(await marketsCanonical(pool), before)
      assert.equal((await pool.query('select count(*)::int as n from markets where bundle_id is not null')).rows[0].n, 0)
    })

    await t.test('a bundle market is SOL, GitHub, without early access, one per bundle, and its stamp is fixed once sent', async () => {
      const insert = (repo, extra = '', values = '') => `insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,bundle_id${extra})
        values (${repo},'reserved','Signer','Creator','Docs','DOCS',5${values})`
      await refused(pool, insert(94911145, ',quote_asset_id,quote_mint,quote_registry_version', `,'msft-xstock','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',1`), 'markets_bundle_check')
      await refused(pool, insert(94911145, ',early_access_end,transfer_hook_program', `,now(),'Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep'`), 'markets_bundle_check')
      await refused(pool, `insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,bundle_id)
        values (94911145,'reserved','Signer','Creator','Docs','DOCS',0)`, 'markets_bundle_check')
      await pool.query(insert(94911145))
      await refused(pool, insert(41881900), 'markets_bundle_id_unique')
      // While nothing was sent, a reservation may be replaced; once sent, the stamp is fixed.
      await pool.query('update markets set bundle_id = 6 where github_repo_id = 94911145')
      await pool.query(`update markets set status='submitted', mint='MintBundle', pool='PoolBundle', launch_signature='LaunchBundle', blockhash='Hash',
        last_valid_block_height=100 where github_repo_id = 94911145`)
      await refused(pool, 'update markets set bundle_id = 7 where github_repo_id = 94911145', 'immutable')
      await refused(pool, 'update markets set bundle_id = null where github_repo_id = 94911145', 'immutable')
      // A plain market that was sent cannot become a bundle market either.
      await refused(pool, 'update markets set bundle_id = 9 where github_repo_id = 7', 'immutable')
    })

    await t.test('bundles: valid amounts and statuses, and one live bundle per repository', async () => {
      const bundle = (id, repo, status = 'opening', target = '5000000000', min = '500000000') => `insert into bundles(bundle_id,github_repo_id,address,
        creator_wallet,token_name,token_symbol,target_lamports,min_deposit_lamports,deadline,status) values (${id},${repo},'Bundle${id}','Launcher','Docs','DOCS',
        ${target},${min},now() + interval '1 day','${status}')`
      await pool.query(bundle(1, 41881900))
      await refused(pool, bundle(2, 41881900), 'bundles_one_live_per_repo')
      await pool.query(`update bundles set status='failed' where bundle_id = 1`)
      await pool.query(bundle(2, 41881900, 'raising'))
      await refused(pool, bundle(3, 10270250, 'opening', '5000000000', '6000000000'), 'bundles_amounts_check')
      await refused(pool, bundle(3, 10270250, 'raised'), 'bundles_status_check')
      await refused(pool, bundle(0, 10270250), 'bundles_id_check')
      await refused(pool, bundle(4, 999), 'foreign key')
      const ids = [(await pool.query(`select nextval('bundle_id_seq')::int as id`)).rows[0].id, (await pool.query(`select nextval('bundle_id_seq')::int as id`)).rows[0].id]
      assert.deepEqual(ids, [1, 2], 'bundle ids come from one sequence')
    })

    await t.test('repo.ing partner-fee paths never see a bundle market', async () => {
      await pool.query(`update markets set status='confirmed', launch_slot=12, launch_finality='finalized', indexed_at=now(), last_verified_at=now(),
        launch_block_time=now(), discovery_version=2 where github_repo_id = 94911145`)
      assert.ok(await platformFeeRecord(pool, 1296269), 'a plain SOL market has platform DAMM fees')
      assert.equal(await platformFeeRecord(pool, 94911145), null, 'a bundle market\'s partner position is the router\'s')
      assert.ok(await discoverySummary(pool, 1296269), 'a plain SOL market has discovery rewards')
      assert.equal(await discoverySummary(pool, 94911145), null, 'no discovery reward on a bundle market, even if stamped')
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, DATABASE)
    await admin.end()
    await rm(folder, { recursive: true, force: true })
  }
})
