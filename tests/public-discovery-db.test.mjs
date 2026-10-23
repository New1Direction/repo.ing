import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createTrendIntake } from '../src/trend-intake.mjs'
import { createTrendSources } from '../src/trend-sources.mjs'
import { publicDiscoveryOptions, runPublicDiscovery } from '../scripts/run-public-discovery.mjs'

// Explicit opt-in; use a disposable, isolated local PostgreSQL cluster, not a shared database server.
const url = process.env.PUBLIC_DISCOVERY_TEST_DATABASE_URL
test('real PostgreSQL: exact discovery role supports intake/upserts and denies financial/approval writes', { skip: !url }, async () => {
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.pathname === '/repoing_public_discovery_test')
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  let limited, installed = false
  try {
    await migrate(drizzle(admin), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    const sql = await readFile(new URL('../scripts/public-discovery-role.sql', import.meta.url), 'utf8')
    // PUBLIC contamination must prevent installation, including authority columns on an otherwise allowed table.
    for (const [grant, revoke] of [
      ['grant update(state) on trend_candidates to public', 'revoke update(state) on trend_candidates from public'],
      ['grant select on markets to public', 'revoke select on markets from public'],
      ['grant usage on sequence trend_reviews_id_seq to public', 'revoke usage on sequence trend_reviews_id_seq from public'],
      ['grant create on schema public to public', 'revoke create on schema public from public'],
    ]) {
      await admin.query(grant)
      await assert.rejects(() => admin.query(sql), /UNSAFE_PUBLIC_DISCOVERY_PRIVILEGES/)
      await admin.query('rollback')
      await admin.query(revoke)
      assert.equal((await admin.query("select 1 from pg_roles where rolname='repoing_public_discovery'")).rowCount, 0)
    }
    await admin.query(sql); installed = true
    const env = { PUBLIC_DISCOVERY_DATABASE_URL: url, PROMOTION_EXCLUDED_REPO_IDS: '105' }
    limited = new pg.Pool(publicDiscoveryOptions(env).options)
    let time = Date.now(), reads = 0
    const repository = id => ({ id, name: `repo${id}`, full_name: `owner/repo${id}`, owner: { login: 'owner' },
      html_url: `https://github.com/owner/repo${id}`, private: false, archived: false, stargazers_count: 100, forks_count: 5 })
    const sources = createTrendSources({ now: () => time, pause: async () => {}, fetchImpl: async (value, options) => {
      const u = new URL(value); reads++
      assert.equal(options.redirect, 'error')
      assert.ok(!Object.keys(options.headers).some(key => key.toLowerCase() === 'authorization'))
      if (u.pathname === '/trending') return new Response('<h2><a href="/owner/repo101">trend</a></h2>')
      if (u.hostname === 'hn.algolia.com') return Response.json({ hits: [] })
      if (u.pathname === '/search/repositories') return Response.json({ items: [repository(101)], incomplete_results: false })
      if (u.pathname.endsWith('/releases/latest')) return new Response('', { status: 404 })
      if (u.pathname.endsWith('/commits')) return Response.json([])
      const id = Number(u.pathname.match(/(?:repo|repositories\/)(\d+)$/)?.[1])
      return Response.json(repository(id))
    } })
    const intake = createTrendIntake({ pool: limited, sources, discoveryOnly: true, excluded: new Set(['105']), now: () => time })
    assert.equal((await intake.runOnce()).results[0].status, 'OBSERVED')
    assert.equal(reads, 7, 'three seed requests plus four identity/evidence reads')
    assert.equal((await runPublicDiscovery({ env, sources })).status, 'WAITING', 'real entrypoint sets the role and closes its pool')
    let candidate = (await admin.query('select * from trend_candidates where github_repo_id=101')).rows[0]
    assert.equal(candidate.state, 'detected'); assert.equal(candidate.revision, 0)
    assert.equal(candidate.approved_config, null); assert.equal(candidate.approved_discovery_version, null)
    assert.equal((await admin.query('select count(*)::int n from trend_observations')).rows[0].n, 1)
    assert.equal((await admin.query('select count(*)::int n from trend_signals')).rows[0].n, 2)

    // A refresh updates only evidence metadata; existing explicit approvals are neither reset nor expanded.
    await admin.query("update trend_candidates set state='approved',revision=4,approved_config='operator-approved' where github_repo_id=101")
    time += 31 * 60000
    await intake.runOnce()
    candidate = (await admin.query('select * from trend_candidates where github_repo_id=101')).rows[0]
    assert.equal(candidate.state, 'approved'); assert.equal(candidate.revision, 4)
    assert.equal(candidate.approved_config, 'operator-approved')
    assert.equal((await admin.query('select count(*)::int n from trend_observations')).rows[0].n, 2)
    assert.equal((await admin.query('select count(*)::int n from trend_signals')).rows[0].n, 2)

    // Each of the three existing maintainer policy contracts suppresses observation before external I/O.
    const policy = [
      ["insert into maintainer_opt_outs(github_repo_id,kind,github_user_id) values(101,'opt_out',1)", 'delete from maintainer_opt_outs'],
      ["insert into repositories(github_repo_id,owner,name,full_name,avatar_url,stars,forks,archived,github_updated_at) values(101,'owner','repo101','owner/repo101','https://avatars.githubusercontent.com/u/1',1,1,false,now()); insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol) values(101,'failed','fixture','fixture','T','T'); insert into repository_participation(github_repo_id,github_user_id,github_login,enabled,opted_in_at) values(101,1,'owner',false,now())", 'delete from repository_participation'],
      ['insert into maintainer_invites(github_repo_id,dismissed_at,operator_github_user_id) values(101,now(),1)', 'delete from maintainer_invites'],
    ]
    for (const [setup, cleanup] of policy) {
      await admin.query(setup); time += 31 * 60000
      const before = reads
      const result = await intake.runOnce()
      assert.equal(result.results[0].status, 'EXCLUDED')
      assert.equal(reads - before, 3, 'only global seed feeds read, no repository calls')
      await admin.query(cleanup)
    }

    const denied = [
      "update trend_candidates set state='approved' where github_repo_id=101",
      'update trend_candidates set revision=99 where github_repo_id=101',
      'update trend_candidates set approved_discovery_version=2 where github_repo_id=101',
      "insert into trend_candidates(github_repo_id,full_name,observed_at,state) values(999,'bad/repo',now(),'approved')",
      'delete from trend_candidates', 'truncate trend_observations',
      "update trend_observations set evidence='forged'", "update trend_signals set operator='forged'",
      'select * from maintainer_opt_outs', 'select * from markets', 'update markets set discovery_version=2',
      "insert into trend_reviews(github_repo_id,from_state,to_state,operator,evidence) values(101,'detected','approved','bad','{}')",
      "select nextval('trend_reviews_id_seq')", "select setval('trend_signals_id_seq',1)",
      'create table public.discovery_escalation(id int)',
    ]
    for (const statement of denied) await assert.rejects(() => limited.query(statement), error => error.code === '42501', statement)
    assert.equal((await admin.query('select count(*)::int n from trend_reviews')).rows[0].n, 0)
    assert.equal((await admin.query('select count(*)::int n from trend_launches')).rows[0].n, 0)

    // Broken evidence insert rolls back candidate metadata and releases the session lock.
    await admin.query('revoke insert(evidence_hash) on trend_observations from repoing_public_discovery')
    time += 31 * 60000
    const before = (await admin.query('select observed_at from trend_candidates where github_repo_id=101')).rows[0].observed_at
    await assert.rejects(() => intake.runOnce(), error => error.code === '42501')
    assert.deepEqual((await admin.query('select observed_at from trend_candidates where github_repo_id=101')).rows[0].observed_at, before)
    assert.equal((await admin.query("select pg_try_advisory_lock(hashtextextended('trend-intake',0)) as locked")).rows[0].locked, true)
    await admin.query("select pg_advisory_unlock(hashtextextended('trend-intake',0))")
  } finally {
    await limited?.end()
    await admin.query('rollback')
    if (installed) { await admin.query('drop owned by repoing_public_discovery'); await admin.query('drop role repoing_public_discovery') }
    await admin.end()
  }
})
