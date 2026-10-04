import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFile, mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HF_MARKET_REF_MAX, HF_MARKET_REF_MIN, marketSource } from '../src/market-identity.mjs'
import { createPulseStore } from '../src/dev-pulse.mjs'
import { createLaunchAlertStore } from '../src/launch-alerts.mjs'
import { createMilestoneAlertStore } from '../src/milestone-alerts.mjs'
import { createMaintainerInvites } from '../src/maintainer-invites.mjs'
import { createVerificationBonusAccrual } from '../src/verification-bonus-accrual.mjs'
import { createWalletBinding } from '../src/wallet-binding.mjs'
import { database, listMarkets, marketByRepo } from '../app/lib/server.mjs'
import { selectWaiting } from '../app/lib/waiting.mjs'
import { POST as resolve } from '../app/api/resolve/route.js'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Migration 0049 on real PostgreSQL. The database is brought to the migration just before 0049, seeded with
// representative rows, then upgraded: every existing row must read back identically (checksums over each table's and
// view's pre-0049 columns, and the builder_fee_credits ledger), every cross-range write must be refused, and with a
// Hugging Face market present each GitHub-only read must still see GitHub markets only.
const URL_ = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_market_source_test'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const A = '1384142609', B = '1296269', C = '7', D = '99', E = '100'

const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at,github_created_at) values
  (${A},'New1Direction','Waternot','New1Direction/Waternot','Water','https://avatars.githubusercontent.com/u/1',120,4,false,'2026-09-01T00:00:00Z','2025-01-01T00:00:00Z'),
  (${B},'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-09-02T00:00:00Z',null),
  (${C},'legacy','archived','legacy/archived',null,null,1,0,true,'2020-01-01T00:00:00Z',null),
  (${D},'fixture','stamped','fixture/stamped',null,null,30,1,false,'2026-09-03T00:00:00Z','2025-01-01T00:00:00Z'),
  (${E},'fixture','waiting','fixture/waiting',null,null,40,2,false,'2026-09-03T00:00:00Z','2025-01-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,discovery_version,builder_allocation_version,
    launch_block_time,verification_bonus_lamports) values
  (${A},'confirmed','MintA','PoolA','LauncherA','Creator','Waternot','WTR','LaunchA','HashA',100,10,'finalized',now(),now(),2,1,now(),250000000),
  (${B},'reserved',null,null,'LauncherB','Creator','Hello','HELLO',null,null,null,null,null,null,null,null,null,null,null),
  (${D},'confirmed','MintD','PoolD','LauncherD','Creator','Stamped','STMP','LaunchD','HashD',100,10,'finalized',now(),now(),2,null,now() - interval '2 days',5000000),
  (${E},'confirmed','MintE','PoolE','LauncherE','Creator','Waiting','WAIT','LaunchE','HashE',100,10,'finalized',now(),now(),null,null,now(),null);
insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot) values
  (${A},'MintA','PoolA','FeeA1',0,1234567,'${SOL_MINT}','dbc_creator_quote',11),
  (${A},'MintA','PoolA','FeeA2',0,7654321,'${SOL_MINT}','dbc_creator_quote',12),
  (${E},'MintE','PoolE','FeeE1',0,600000000,'${SOL_MINT}','dbc_creator_quote',13);
insert into damm_fee_events(github_repo_id,pool,position,slot,amount_base_units,cumulative_earned,cumulative_claimed,evidence_hash,evidence) values
  (${A},'DammA','PositionA',14,5000,5000,0,repeat('a',64),'{}');
insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader) values
  ('PoolA','TradeA',0,15,'2026-09-14T00:00:00Z','buy','100000000','5000','123456','TraderA');
insert into discovery_fee_events(github_repo_id,pool,signature,event_index,partner_amount,slot,traded_at) values
  (${A},'PoolA','TradeA',0,4000,15,'2026-09-14T00:00:00Z');
insert into repo_verifications(github_repo_id,github_user_id,github_login,permission,verified_at) values
  (${A},285551516,'New1Direction','admin','2026-09-11T00:00:00Z'), (${D},501,'maintainer','admin',now() - interval '1 day');
insert into repo_beneficiaries(github_repo_id,github_user_id,wallet,bound_at) values (${A},285551516,'BeneficiaryA','2026-09-11T00:01:00Z');
insert into wallet_binding_challenges(github_repo_id,github_user_id,wallet,nonce,expires_at,consumed_at) values
  (${A},285551516,'BeneficiaryA',repeat('b',48),'2026-09-11T00:05:00Z','2026-09-11T00:01:00Z');
insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at) values
  (${A},'BeneficiaryA',1000000,'${SOL_MINT}','ClaimA','settled','2026-09-12T00:00:00Z');
insert into builder_allocation_claims(github_repo_id,github_user_id,mint,wallet,amount,status,signature,signed_transaction,last_valid_block_height,settled_at) values
  (${A},285551516,'MintA','BeneficiaryA',10000000000000,'settled','AllocA','tx',200,'2026-09-12T00:00:00Z');
insert into repository_participation(github_repo_id,github_user_id,github_login,enabled,opted_in_at) values (${A},285551516,'New1Direction',true,'2026-09-12T00:00:00Z');
insert into verification_bonuses(github_repo_id,status,amount,launcher_wallet,verification_id,verifier_github_user_id,verifier_login,verified_at,activated_at,evidence)
  select ${A},'pending_review',250000000,'LauncherA',id,285551516,'New1Direction','2026-09-11T00:00:00Z','2026-09-10T00:00:00Z','{"rulesVersion":1}'
  from repo_verifications where github_repo_id = ${A};
insert into maintainer_invites(github_repo_id,invited_at,operator_github_user_id,operator_login) values (${B},'2026-09-13T00:00:00Z',77,'op');
insert into maintainer_opt_outs(github_repo_id,kind,github_user_id,created_at,withdrawn_at,withdrawn_by_github_user_id) values
  (${C},'opt_out',501,'2026-09-01T00:00:00Z','2026-09-02T00:00:00Z',501);
insert into repo_streams(github_repo_id,url,live_until,updated_by_github_user_id,updated_at) values (${A},'https://twitch.tv/builder',null,285551516,'2026-09-14T00:00:00Z');
insert into repo_pulse_state(github_repo_id,full_name,default_branch,stars,pushed_at,etags,checked_at,next_check_at) values
  (${A},'New1Direction/Waternot','main',120,'2026-09-14T00:00:00Z','{"repo":"W/abc"}','2026-09-14T00:00:00Z','2026-09-14T00:10:00Z');
insert into repo_pulse_events(github_repo_id,kind,source_id,occurred_at,title,detail,url) values
  (${A},'commit',repeat('c',40),'2026-09-14T00:00:00Z','Fix things','dev','https://github.com/New1Direction/Waternot/commit/c');
insert into repo_pulse_star_hours(github_repo_id,hour,stars_total) values (${A},'2026-09-14T00:00:00Z',120);
insert into trend_candidates(github_repo_id,full_name,state,revision,observed_at) values (${B},'octocat/Hello-World','detected',0,'2026-09-14T00:00:00Z');
insert into trend_signals(github_repo_id,source,url,note,occurred_at,expires_at) values
  (${B},'hn','https://news.ycombinator.com/item?id=1','story','2026-09-14T00:00:00Z','2026-09-21T00:00:00Z');
insert into trend_observations(github_repo_id,observed_at,evidence,evidence_hash) values (${B},'2026-09-14T00:00:00Z','{}',repeat('d',64));
insert into repo_tips(id,github_repo_id,donor_wallet,tip_wallet,mint,token_program,decimals,symbol,requested_amount,status,message,transaction,last_valid_block_height,refund_after) values
  ('00000000-0000-4000-8000-000000000001',${A},'DonorA','TipWallet','${SOL_MINT}','11111111111111111111111111111111',9,'SOL',5000000,'prepared','thanks','tx',300,'2026-10-14T00:00:00Z');
insert into parts_funds(id,github_repo_id,title,goal_cents,deadline,status,created_by,created_at) values
  ('00000000-0000-4000-8000-000000000002',${A},'GPU for CI',50000,'2026-12-01T00:00:00Z','open','285551516','2026-09-14T00:00:00Z');
insert into parts_fund_items(id,fund_id,position,name,url,unit_price_cents,quantity) values
  ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',0,'GPU','https://example.com/gpu',50000,1);
insert into graduation_observations(github_repo_id,checked_at,status,observation) values (${A},now(),'VERIFIED','{}');
insert into launch_alerts(github_repo_id,mint,channel,status,message_id,sent_at) values (${A},'MintA','x','sent','1850000000000000001','2026-09-10T01:00:00Z');`

async function columnsByRelation(pool) {
  const { rows } = await pool.query(`select c.table_name as name, array_agg(c.column_name::text order by c.ordinal_position) as columns
    from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type in ('BASE TABLE', 'VIEW') group by c.table_name order by 1`)
  return Object.fromEntries(rows.map(row => [row.name, row.columns]))
}
async function checksums(pool, relations) {
  const sums = {}
  for (const [name, columns] of Object.entries(relations)) {
    const { rows: [row] } = await pool.query(`select count(*)::int as n, md5(coalesce(string_agg(r, E'\\n' order by r), '')) as sum
      from (select row(${columns.map(column => `"${column}"`).join(', ')})::text as r from "${name}") rows`)
    sums[name] = `${row.n}:${row.sum}`
  }
  return sums
}
const credits = async pool => (await pool.query(`select github_repo_id::text as "repoId", pool, asset, count(*)::int as n,
  sum(amount_base_units)::text as total from builder_fee_credits group by 1, 2, 3 order by 1, 2, 3`)).rows
async function refused(pool, sql, constraint, params = []) {
  await assert.rejects(pool.query(sql, params), error => {
    assert.equal(error.constraint, constraint, `${error.message} (${sql.slice(0, 60)})`)
    return true
  })
}

test('migration 0049 keeps every existing row, refuses cross-range ids, and GitHub-only reads ignore model markets', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  const at = journal.entries.findIndex(entry => entry.tag === '0049_market_source')
  assert.ok(at > 0, '0049 is in the journal')
  // drizzle applies only entries newer than the last applied one, so every "when" must exceed the one before it.
  journal.entries.forEach((entry, i) => assert.ok(i === 0 || entry.when > journal.entries[i - 1].when, `${entry.tag} is out of order`))
  const admin = new pg.Pool({ connectionString: URL_.replace(/repoing_market_source_test$/, 'postgres') })
  const folder = await mkdtemp(join(tmpdir(), 'repoing-0049-'))
  let created = false, pool
  try {
    await admin.query('create database repoing_market_source_test'); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await mkdir(join(folder, 'meta'))
    const baseline = { ...journal, entries: journal.entries.slice(0, at) }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(baseline))
    for (const entry of baseline.entries) await copyFile(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
    await migrate(drizzle(pool), { migrationsFolder: folder })
    await pool.query(SEED)
    const relations = await columnsByRelation(pool)
    const before = await checksums(pool, relations), creditsBefore = await credits(pool)
    assert.deepEqual(creditsBefore, [{ repoId: E, pool: 'PoolE', asset: SOL_MINT, n: 1, total: '600000000' },
      { repoId: A, pool: 'PoolA', asset: SOL_MINT, n: 3, total: '8893888' }])

    await t.test('upgrading changes no existing row, the fee ledger included, and re-applying is a no-op', async () => {
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
      // 0049 and every later migration, in journal order: 0052 relaxes two of 0049's checks, which 0049 alone would add back.
      for (const entry of journal.entries.slice(at)) {
        for (const statement of (await readFile(`drizzle/${entry.tag}.sql`, 'utf8')).split('--> statement-breakpoint')) await pool.query(statement)
      }
      assert.equal((await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, journal.entries.length)
      assert.deepEqual(await checksums(pool, relations), before)
      assert.deepEqual(await credits(pool), creditsBefore)
      const { rows } = await pool.query('select source, hf_model_ref, count(*)::int as n from repositories group by 1, 2')
      assert.deepEqual(rows, [{ source: 'github', hf_model_ref: null, n: 5 }])
    })

    let hf
    await t.test('the registry hands out frozen model ids from 2^52+1', async () => {
      const { rows: [sequence] } = await pool.query(`select start_value::text as start, min_value::text as min, max_value::text as max, cycle
        from pg_sequences where sequencename = 'hf_market_ref_seq'`)
      assert.deepEqual(sequence, { start: String(HF_MARKET_REF_MIN), min: String(HF_MARKET_REF_MIN), max: String(HF_MARKET_REF_MAX), cycle: false })
      await refused(pool, `insert into hf_models(hf_id,repo_path,owner_handle,owner_kind) values ('ABC','a/b','a','user')`, 'hf_models_hf_id_check')
      await refused(pool, `insert into hf_models(market_ref,hf_id,repo_path,owner_handle,owner_kind) values (42,repeat('e',24),'a/b','a','user')`, 'hf_models_market_ref_check')
      await refused(pool, `insert into hf_models(hf_id,repo_path,owner_handle,owner_kind) values (repeat('e',24),'a/b','a','team')`, 'hf_models_owner_kind_check')
      const { rows: [row] } = await pool.query(`insert into hf_models(hf_id,repo_path,owner_handle,owner_kind,owner_subject,gated,base_models)
        values ('0123456789abcdef01234567','octocat/Hello-World','octocat','user','89abcdef0123456789abcdef',true,'["meta/base"]') returning market_ref::text`)
      hf = row.market_ref
      // The refused inserts above still drew from the sequence (nextval never rolls back): ids are unique, not gapless.
      assert.equal(marketSource(hf), 'huggingface')
      await refused(pool, `insert into hf_models(hf_id,repo_path,owner_handle,owner_kind) values ('0123456789abcdef01234567','x/y','x','org')`, 'hf_models_hf_id_unique')
      await assert.rejects(pool.query(`update hf_models set hf_id = repeat('f',24) where market_ref = $1`, [hf]), /identity is immutable/)
      await assert.rejects(pool.query(`update hf_models set market_ref = market_ref + 1 where market_ref = $1`, [hf]), /identity is immutable/)
      await pool.query(`update hf_models set repo_path = 'octocat/Hello-World-v2', path_confirmed_at = now() where market_ref = $1`, [hf])
      await pool.query(`update hf_models set repo_path = 'octocat/Hello-World' where market_ref = $1`, [hf])
    })

    await t.test('repositories: the id range and the source must agree, and a model row points at its registry row', async () => {
      const insert = (id, source, ref) => `insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at,source,hf_model_ref)
        values (${id},'octocat','Hello-World','octocat/Hello-World',0,0,false,now(),'${source}',${ref})`
      await refused(pool, insert(hf, 'github', 'null'), 'repositories_source_range')
      await refused(pool, insert(hf, 'huggingface', 'null'), 'repositories_source_range')
      await refused(pool, insert('42', 'huggingface', '42'), 'repositories_source_range')
      await refused(pool, insert('42', 'github', hf), 'repositories_source_range')
      await refused(pool, insert('4503599627370496', 'github', 'null'), 'repositories_source_range')
      await refused(pool, insert('4503599627370496', 'huggingface', '4503599627370496'), 'repositories_source_range')
      await refused(pool, insert('7000000000000001', 'huggingface', '7000000000000001'), 'repositories_source_range')
      await refused(pool, insert(`${hf} + 1`, 'huggingface', `${hf} + 1`), 'repositories_hf_model_ref_hf_models_market_ref_fk')
      await refused(pool, insert('43', 'gitlab', 'null'), 'repositories_source_range')
      await pool.query(insert(hf, 'huggingface', hf))
      await refused(pool, `update repositories set source = 'github', hf_model_ref = null where github_repo_id = $1`, 'repositories_source_range', [hf])
    })

    await t.test('markets: a model market never carries the verification bonus (0052 lets it carry the builder allocation)', async () => {
      const market = extra => `insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
          launch_slot,launch_finality,indexed_at,last_verified_at,discovery_version,launch_block_time${extra.columns}) values
        (${hf},'confirmed','MintH','PoolH','LauncherH','Creator','Hello','HELLO','LaunchH',10,'finalized',now(),now(),2,now()${extra.values})`
      await refused(pool, market({ columns: ',verification_bonus_lamports', values: ',5000000' }), 'markets_hf_no_bonus')
      await refused(pool, market({ columns: ',builder_allocation_version,verification_bonus_lamports', values: ',1,5000000' }), 'markets_hf_no_bonus')
      await pool.query(market({ columns: '', values: '' }))
      await pool.query('update markets set builder_allocation_version = 1 where github_repo_id = $1', [hf])
      await pool.query('update markets set builder_allocation_version = null where github_repo_id = $1', [hf])
    })

    await t.test('every GitHub-only table refuses a model id', async () => {
      // builder_allocation_claims left this list in 0052: a model id is accepted there under a Hugging Face authority only.
      const tables = ['verification_bonuses', 'verification_bonus_payouts', 'builder_reinvest_intents', 'repo_tips',
        'tip_transfers', 'parts_funds', 'parts_pledges', 'parts_transfers', 'parts_updates', 'repo_streams', 'repo_pulse_events', 'repo_pulse_state',
        'repo_pulse_star_hours', 'trend_candidates', 'trend_launches', 'trend_observations', 'trend_reviews', 'trend_signals',
        'repository_participation', 'maintainer_invites']
      const { rows } = await pool.query(`select conrelid::regclass::text as name, convalidated as valid, pg_get_constraintdef(oid) as def
        from pg_constraint where contype = 'c' and conname = conrelid::regclass::text || '_github_only' order by 1`)
      assert.deepEqual(rows, [...tables].sort().map(name => ({ name, valid: true, def: 'CHECK ((github_repo_id < \'4503599627370496\'::bigint))' })))
      const { rows: [verification] } = await pool.query(`insert into repo_verifications(github_repo_id,github_user_id,github_login,permission) values ($1,7,'o','admin') returning id`, [hf])
      for (const [table, sql] of [
        ['verification_bonuses', `insert into verification_bonuses(github_repo_id,status,amount,launcher_wallet,verification_id,verifier_github_user_id,verifier_login,verified_at,activated_at,evidence)
          values (${hf},'pending_review',250000000,'LauncherH',${verification.id},7,'o',now(),now(),'{}')`],
        ['repository_participation', `insert into repository_participation(github_repo_id,github_user_id,github_login,enabled,opted_in_at) values (${hf},7,'o',true,now())`],
        ['maintainer_invites', `insert into maintainer_invites(github_repo_id,invited_at,operator_github_user_id) values (${hf},now(),77)`],
        ['repo_streams', `insert into repo_streams(github_repo_id,url,updated_by_github_user_id) values (${hf},'https://twitch.tv/model',7)`],
        ['repo_pulse_state', `insert into repo_pulse_state(github_repo_id) values (${hf})`],
        ['repo_pulse_star_hours', `insert into repo_pulse_star_hours(github_repo_id,hour,stars_total) values (${hf},now(),1)`],
        ['trend_candidates', `insert into trend_candidates(github_repo_id,full_name,observed_at) values (${hf},'octocat/Hello-World',now())`],
        ['repo_tips', `insert into repo_tips(id,github_repo_id,donor_wallet,tip_wallet,mint,token_program,decimals,symbol,requested_amount,status,message,transaction,last_valid_block_height,refund_after)
          values (gen_random_uuid(),${hf},'D','T','${SOL_MINT}','P',9,'SOL',1,'prepared','m','tx',1,now())`],
      ]) await refused(pool, sql, `${table}_github_only`)
      await refused(pool, `insert into builder_allocation_claims(github_repo_id,github_user_id,mint,wallet,amount,status,signature,signed_transaction,last_valid_block_height)
        values (${hf},7,'MintH','W',10000000000000,'pending','AllocH','tx',1)`, 'builder_allocation_claims_source_range')
    })

    await t.test('GitHub-only reads see GitHub markets only, with a model market of the same owner/name present', async () => {
      // The model market qualifies for these reads except by source: confirmed, indexed, VERIFIED progress, fees waiting. The
      // bonus accrual read is the exception: markets_hf_no_bonus already keeps a model market unstamped, so its source
      // join is a second safeguard and this only checks that the GitHub candidate survives it.
      await pool.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot)
        values ($1,'MintH','PoolH','FeeH1',0,700000000,'${SOL_MINT}','dbc_creator_quote',16)`, [hf])
      await pool.query(`insert into graduation_observations(github_repo_id,checked_at,status,observation) values ($1,now(),'VERIFIED','{}')`, [hf])
      await pool.query(`delete from repo_verifications where github_repo_id = $1`, [hf])
      assert.deepEqual((await createPulseStore(pool).due(50, new Set())).map(row => row.repoId).sort(), [A, D, E].sort())
      const alerts = await createLaunchAlertStore(pool).candidates({ channel: 'telegram', since: new Date(0), maxAgeMs: 30 * 86_400_000, maxAttempts: 3, limit: 50 })
      assert.deepEqual(alerts.map(row => row.githubRepoId).sort(), [A, D, E].sort())
      assert.deepEqual((await createMilestoneAlertStore(pool).progressRows()).map(row => row.githubRepoId), [A])
      const invites = createMaintainerInvites({ pool, env: {}, verifiedFee: async repoId => (await pool.query(
        'select sum(amount_base_units)::text as total from builder_fee_credits where github_repo_id = $1', [repoId])).rows[0].total, repoMeta: async () => null })
      assert.deepEqual((await invites.list()).candidates.map(row => row.repoId), [E])
      assert.deepEqual(await createVerificationBonusAccrual({ pool, graceMs: 0 }).candidates(), [D])

      const { markets } = await listMarkets()
      assert.deepEqual(Object.fromEntries(markets.map(market => [market.repoId, market.source])), { [A]: 'github', [D]: 'github', [E]: 'github', [hf]: 'huggingface' })
      assert.equal((await marketByRepo(hf)).market.source, 'huggingface')
      assert.deepEqual(selectWaiting(markets).map(market => market.repoId), [E])

      // octocat/Hello-World has no live GitHub market; the model market with that path must not answer for the GitHub URL.
      const oldFetch = globalThis.fetch, requested = []
      globalThis.fetch = async url => {
        requested.push(String(url))
        return Response.json({ id: Number(B), name: 'Hello-World', full_name: 'octocat/Hello-World', owner: { login: 'octocat', avatar_url: null },
          private: false, visibility: 'public', archived: false, updated_at: '2026-09-30T00:00:00Z', stargazers_count: 3001, forks_count: 900 })
      }
      try {
        const response = await resolve(new Request('https://repo.ing/api/resolve', { method: 'POST', body: JSON.stringify({ url: 'github.com/octocat/Hello-World' }) }))
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { repoId: B, mint: null })
        assert.deepEqual(requested, ['https://api.github.com/repos/octocat/Hello-World'])
      } finally { globalThis.fetch = oldFetch }
      assert.equal((await pool.query('select source from repositories where github_repo_id = $1', [B])).rows[0].source, 'github')
    })

    await t.test('a GitHub batch binding that names a model market writes nothing', async () => {
      const wallet = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw', nonce = 'e'.repeat(48)
      await pool.query(`insert into wallet_binding_challenges(github_repo_id,github_user_id,wallet,nonce,expires_at)
        values ($1,42,$2,$3,now() + interval '5 minutes')`, [hf, wallet, nonce])
      await assert.rejects(createWalletBinding({ pool }).bindBatch({ nonces: [nonce], githubUserId: '42', wallet, signature: Buffer.alloc(64) }),
        /A github authority cannot act for a huggingface market/)
      assert.equal((await pool.query('select consumed_at from wallet_binding_challenges where nonce = $1', [nonce])).rows[0].consumed_at, null)
      assert.equal((await pool.query('select count(*)::int as n from repo_beneficiaries where github_repo_id = $1', [hf])).rows[0].n, 0)
    })
  } finally {
    await database()?.end().catch(() => {}); delete globalThis.__gitfunPool
    await pool?.end()
    if (created) await dropTestDatabase(admin, 'repoing_market_source_test')
    await admin.end(); await rm(folder, { recursive: true, force: true })
  }
})
