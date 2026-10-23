import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { trendOperatorView } from '../src/trend-intake.mjs'
import { publicTrendCandidates } from '../src/public-trends.mjs'
import { readLaunchableTrends, searchListCandidates } from '../src/trend-launchable.mjs'

const url = process.env.PUBLIC_DISCOVERY_PROJECTION_TEST_DATABASE_URL
test('public projection preserves reader contracts and restores only redacted fresh discovery data', { skip: !url }, async () => {
  const parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname === '/repoing_public_projection_test')
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  let reader, setup = false
  try {
    await migrate(drizzle(admin), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await admin.query(`create role repoing_site_view_owner nologin; create role repoing_operational_public_reader nologin;
      create schema site_public authorization repoing_site_view_owner;
      revoke all on schema site_public from public;
      grant usage on schema public to repoing_site_view_owner;
      grant usage on schema site_public to repoing_operational_public_reader;
      alter role repoing_operational_public_reader set search_path=site_public,pg_catalog;
      alter role repoing_operational_public_reader set default_transaction_read_only=on`)
    setup = true
    // Recreate the exact typed-empty shape of the affected baseline views, including unused private fields.
    const names = ['trend_candidates', 'trend_observations', 'trend_signals', 'trend_source_health', 'trend_launches',
      'trend_reviews', 'trend_alerts', 'markets', 'repositories', 'bundles', 'repository_participation', 'maintainer_invites']
    for (const name of names) {
      const { rows } = await admin.query(`select attname,format_type(atttypid,atttypmod) as type from pg_attribute
        where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum`, [`public.${name}`])
      await admin.query(`create view site_public.${name} with (security_barrier=true) as select ${rows.map(r => `null::${r.type} as "${r.attname}"`).join(',')} where false;
        alter view site_public.${name} owner to repoing_site_view_owner;
        grant select on site_public.${name} to repoing_operational_public_reader`)
    }
    reader = new pg.Pool({ connectionString: url, options: '-c role=repoing_operational_public_reader -c search_path=site_public,pg_catalog -c default_transaction_read_only=on' })
    const metadata = async () => (await admin.query(`select c.oid,c.relname,c.relowner,c.relacl,c.reloptions,
      (select json_agg(json_build_array(a.attname,a.atttypid,a.atttypmod) order by a.attnum) from pg_attribute a
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='site_public' order by c.relname`)).rows
    const before = await metadata()
    const roleBefore = (await admin.query("select rolconfig from pg_roles where rolname='repoing_operational_public_reader'")).rows
    const sql = await readFile(new URL('../scripts/public-discovery-projection.sql', import.meta.url), 'utf8')
    assert.deepEqual((await trendOperatorView(reader)).candidates, [])
    await admin.query(sql)
    assert.deepEqual(await metadata(), before, 'view identity, types/order, owners, security barrier and existing ACLs unchanged')
    assert.deepEqual((await admin.query("select rolconfig from pg_roles where rolname='repoing_operational_public_reader'")).rows, roleBefore)
    await admin.query(sql) // Safe replacement is repeatable without DROP/credential/reader changes.
    assert.deepEqual(await metadata(), before)

    const now = Date.now(), iso = age => new Date(now - age).toISOString()
    for (let id = 201; id <= 212; id++) {
      await admin.query(`insert into trend_candidates(github_repo_id,full_name,description,observed_at,state,revision,approved_config,approved_discovery_version,approved_at)
        values($1,$2,'public description',now(),'approved',99,'PRIVATE_APPROVAL',2,now())`, [id, `owner/repo${id}`])
      for (const [age, stars] of [[0, 120], [7200000, 100]]) {
        const evidence = { repo: { id: String(id), fullName: `owner/repo${id}`, language: 'Rust',
          avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4', operator: 'PRIVATE_OPERATOR' },
          observedAt: iso(age), stars, forks: 5, releaseAt: null,
          activity: { complete: true, currentCommits: 2, previousCommits: 1, currentContributors: 2, previousContributors: 1, note: 'PRIVATE_ACTIVITY' },
          sources: { identity: 'PRIVATE_SOURCE' }, private: 'PRIVATE_EVIDENCE', signed_transaction: 'PRIVATE_SIGNED' }
        await admin.query('insert into trend_observations(github_repo_id,observed_at,evidence,evidence_hash) values($1,$2,$3,$4)',
          [id, iso(age), JSON.stringify(evidence), 'PRIVATE_HASH'])
      }
      await admin.query(`insert into trend_signals(github_repo_id,source,url,note,occurred_at,expires_at,operator)
        values($1,'github_trending','https://github.com/trending?PRIVATE_QUERY','PRIVATE_NOTE',now(),now()+interval '1 hour','PRIVATE_OPERATOR'),
          ($1,'manual','https://x.com/PRIVATE_MANUAL','PRIVATE_MANUAL',now(),now()+interval '1 day','PRIVATE_OPERATOR')`, [id])
    }
    await admin.query(`insert into trend_source_health(source,status,detail) values('intake','OK','{"private":"PRIVATE_HEALTH"}'),
      ('PRIVATE_SOURCE','OK','{}');
      update trend_candidates set observed_at=now()-interval '7 hours' where github_repo_id=202;
      update trend_candidates set error='PRIVATE_ERROR' where github_repo_id=203;
      update trend_candidates set state='rejected' where github_repo_id=204;
      update trend_candidates set observed_at=now()+interval '2 minutes' where github_repo_id=205;
      insert into maintainer_opt_outs(github_repo_id,kind,github_user_id) values(206,'opt_out',1);
      insert into repositories(github_repo_id,owner,name,full_name,avatar_url,stars,forks,archived,github_updated_at)
        select id,'owner','repo'||id,'owner/repo'||id,'https://avatars.githubusercontent.com/u/1',1,1,id=207,now() from generate_series(207,212) id;
      insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol)
        values(208,'submitted','fixture','fixture','T','T'),(210,'failed','fixture','fixture','T','T');
      insert into repository_participation(github_repo_id,github_user_id,github_login,enabled,opted_in_at) values(210,1,'PRIVATE_LOGIN',false,now());
      insert into maintainer_invites(github_repo_id,dismissed_at,operator_github_user_id) values(211,now(),1);
      insert into bundles(bundle_id,github_repo_id,address,creator_wallet,token_name,token_symbol,target_lamports,min_deposit_lamports,deadline,status)
        values(209,209,'fixture-bundle','fixture-wallet','T','T',1000000000,50000000,now()+interval '1 day','raising')`)
    // Malformed JSON must not take down all candidates; unknown/nested fields must never leak.
    await admin.query("insert into trend_observations(github_repo_id,observed_at,evidence,evidence_hash) values(201,now()-interval '1 minute','{invalid PRIVATE_MALFORMED','bad')")
    const view = await trendOperatorView(reader, now)
    assert.deepEqual(view.candidates.map(c => c.repoId).sort(), ['201', '212'])
    assert.equal(view.candidates[0].revision, null)
    assert.equal(view.candidates[0].approvedConfig, null)
    assert.equal(view.candidates[0].state, 'detected')
    assert.equal(view.candidates[0].score.inputs.stars.delta, 20)
    assert.equal(view.candidates[0].score.inputs.manualSignals, 0)
    assert.deepEqual(view.sources.map(s => s.detail), [{}])
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/)
    const launchable = await readLaunchableTrends(reader, { now, config: 'PRIVATE_APPROVAL', discoveryEnabled: true })
    const candidates = searchListCandidates(publicTrendCandidates(view.candidates, { now, config: 'PRIVATE_APPROVAL' }), launchable, new Set(['212']))
    assert.deepEqual(candidates.map(c => c.repoId), ['201'])
    assert.equal(candidates[0].launchable, true)
    assert.equal(candidates[0].ready, false)
    assert.equal(launchable[0].reviewed, false)
    assert.equal(launchable[0].launchHref, '/launch/201')
    for (const table of ['trend_candidates', 'trend_observations', 'trend_signals', 'trend_source_health']) {
      assert.doesNotMatch(JSON.stringify((await reader.query(`select * from site_public.${table}`)).rows), /PRIVATE_/)
      await assert.rejects(() => reader.query(`select * from public.${table}`), error => error.code === '42501')
    }
    assert.equal((await reader.query('show default_transaction_read_only')).rows[0].default_transaction_read_only, 'on')
    await assert.rejects(() => reader.query("update site_public.trend_candidates set full_name='forged/repo'"))
    assert.equal((await reader.query('select * from trend_reviews')).rowCount, 0)
    assert.equal((await reader.query('select * from trend_launches')).rowCount, 0)
  } finally {
    await reader?.end()
    await admin.query('rollback')
    if (setup) await admin.query(`drop schema site_public cascade; drop owned by repoing_site_view_owner;
      drop owned by repoing_operational_public_reader; drop role repoing_site_view_owner; drop role repoing_operational_public_reader`)
    await admin.end()
  }
})
