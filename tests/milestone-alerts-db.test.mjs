import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createMilestoneAlerts, createMilestoneAlertStore, MILESTONE_ALERT_DEFAULTS } from '../src/milestone-alerts.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'

// Real PostgreSQL with every committed migration (0037_milestone_alerts): which markets are read, marks, claims,
// retries, constraints and the lock, then the whole job with fake senders.
const url = process.env.MILESTONE_ALERTS_TEST_DATABASE_URL
const ORIGIN = 'https://repo.ing'

async function seed(pool) {
  await pool.query('truncate milestone_alerts, milestone_alert_marks, graduation_observations, graduation_events, markets, repositories restart identity cascade')
  const market = async (id, { status = 'confirmed', finality = 'finalized', indexed = true } = {}) => {
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
      values($1,'octo',$2,$3,1,0,false,now())`, [id, `repo-${id}`, `octo/repo-${id}`])
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
      launch_slot,launch_finality,indexed_at,last_verified_at) values($1,$2,$3,$4,'w','w','Repo',$5,$6,1,$7,$8,now())`,
    [id, status, `Mint${id}`, `Pool${id}`, `R${id}`, `Sig${id}`, finality, indexed ? new Date() : null])
  }
  for (const id of [1, 2, 3, 4, 5]) await market(id)
  await market(6, { status: 'submitted', finality: 'confirmed', indexed: false })
  await observe(pool, 1, { reserveSol: 10n })
  await observe(pool, 2, { reserveSol: 60n })
  await observe(pool, 3, { reserveSol: 85n, graduated: true })
  await observe(pool, 4, { reserveSol: 70n, rowStatus: 'REVIEW' })
  await observe(pool, 5, { reserveSol: 70n, age: 600_000 })
  await observe(pool, 6, { reserveSol: 70n })
}

// Upserts a fresh observation (threshold 100 SOL) the way the graduation monitor stores it; graduation adds its evidence row.
async function observe(pool, id, options) {
  const columns = graduationColumns({ mint: `Mint${id}`, thresholdSol: 100n, ...options })
  await pool.query(`insert into graduation_observations(github_repo_id,checked_at,status,observation,error_code) values($1,now(),$2,$3,$4)
    on conflict (github_repo_id) do update set checked_at=excluded.checked_at,status=excluded.status,observation=excluded.observation,error_code=excluded.error_code`,
  [id, columns.status, columns.observation, columns.error_code])
  if (columns.migration_evidence_hash) await pool.query(`insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,reconciliation)
    values($1,$2,$3,1,$4,'{}','{}') on conflict (github_repo_id) do nothing`, [id, `sig-Mint${id}`, `pool-Mint${id}`, columns.migration_evidence_hash])
}

test('real PostgreSQL: milestone alert store and job', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_milestone_alerts_test', 'Disposable milestone alerts test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await seed(pool)
    const store = createMilestoneAlertStore(pool)

    const rows = await store.progressRows()
    assert.deepEqual(rows.map(row => row.githubRepoId), ['1', '2', '3', '5'], 'public markets with VERIFIED observations only')
    assert.deepEqual([rows[0].mint, rows[0].tokenSymbol, rows[0].fullName], ['Mint1', 'R1', 'octo/repo-1'])
    assert.equal(rows[2].migration_evidence_hash.length, 64)

    // The whole job, telegram only: the first run marks, later crossings post once.
    const sent = []
    const job = createMilestoneAlerts({ store, sleep: async () => {}, senders: { telegram: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: String(sent.length) } } },
      config: { ...MILESTONE_ALERT_DEFAULTS, channels: ['telegram'], since: new Date(Date.now() - 3600_000), origin: ORIGIN, maxPerRun: 100, excluded: new Set(['3']) } })
    assert.deepEqual(await job.runOnce(), { posts: [], interrupted: [] })
    const marks = async () => (await pool.query(`select github_repo_id::text as repo, milestone from milestone_alert_marks where channel='telegram' order by 1`)).rows
    assert.deepEqual(await marks(), [{ repo: '1', milestone: 0 }, { repo: '2', milestone: 50 }], 'stale market 5 and do-not-promote market 3 are not marked')
    assert.deepEqual(sent, [])

    await observe(pool, 1, { reserveSol: 31n })
    await observe(pool, 2, { reserveSol: 91n })
    await observe(pool, 5, { reserveSol: 80n })
    await Promise.all([job.runOnce(), job.runOnce()])
    assert.deepEqual(sent.map(text => text.split('\n')[0]), ['📈 $R2 passed 90% of the way to graduating on repo.ing — 9 SOL to go.',
      '📈 $R1 passed 25% of the way to graduating on repo.ing — 69 SOL to go.'])
    assert.equal(sent[0].split('\n')[2], `${ORIGIN}/token/Mint2`)
    assert.deepEqual((await job.runOnce()).posts, [], 'never posted twice')
    const { rows: stored } = await pool.query(`select github_repo_id::text as repo, milestone, status, attempts, sent_at is not null as "hasSentAt", message_id
      from milestone_alerts order by id`)
    assert.deepEqual(stored, [{ repo: '2', milestone: 90, status: 'sent', attempts: 1, hasSentAt: true, message_id: '1' },
      { repo: '1', milestone: 25, status: 'sent', attempts: 1, hasSentAt: true, message_id: '2' }])
    assert.deepEqual((await marks()).find(m => m.repo === '5'), { repo: '5', milestone: 75 }, 'first fresh sight of market 5 only marks it')

    // Claims: one winner, never a lower milestone after a higher one, retries claimed once.
    const post = { githubRepoId: '1', mint: 'Mint1', milestone: 50 }
    const claims = await Promise.all([0, 1, 2].map(() => store.claim({ channel: 'x', post, maxAttempts: 3 })))
    assert.equal(claims.filter(Boolean).length, 1, 'exactly one concurrent claim wins')
    assert.equal(await store.claim({ channel: 'x', post: { ...post, milestone: 25 }, maxAttempts: 3 }), null, 'lower than a claimed milestone')
    const id = claims.find(Boolean)
    assert.ok(await store.sentRecently('x') >= 1)
    await store.finish(id, { status: 'failed', error: 'HTTP 429', nextAttemptAt: new Date(Date.now() + 60_000) })
    const state = await store.channelState('x')
    assert.deepEqual(state.alerts.get('1').map(a => [a.id, a.milestone, a.status, a.attempts]), [[id, 50, 'failed', 1]])
    assert.ok(state.alerts.get('1')[0].nextAttemptAt > new Date())
    assert.equal(await store.claim({ channel: 'x', post: { ...post, alertId: id }, maxAttempts: 3 }), id)
    assert.equal(await store.claim({ channel: 'x', post: { ...post, alertId: id }, maxAttempts: 3 }), null, 'a retry is claimed once')
    await pool.query(`update milestone_alerts set updated_at=now()-interval '11 minutes' where id=$1`, [id])
    assert.ok((await store.expireStale(10 * 60_000)).some(row => row.id === id))
    assert.deepEqual((await pool.query('select status, attempts from milestone_alerts where id=$1', [id])).rows[0], { status: 'unknown', attempts: 2 })
    assert.equal(await store.claim({ channel: 'x', post: { ...post, alertId: id }, maxAttempts: 3 }), null, 'unknown is never retried')
    const higher = await store.claim({ channel: 'x', post: { ...post, milestone: 75 }, maxAttempts: 3 })
    assert.ok(higher && higher !== id, 'a higher milestone is claimed after a lower one')

    // Marks: taken once, re-taken (never lowered) only when older than the cutoff.
    const since = new Date(Date.now() - 60_000)
    await store.mark('x', [{ githubRepoId: '2', milestone: 75 }], since)
    await store.mark('x', [{ githubRepoId: '2', milestone: 25 }], since)
    assert.deepEqual((await store.channelState('x')).marks.get('2').milestone, 75, 'a current mark never moves')
    await pool.query(`update milestone_alert_marks set marked_at=now()-interval '1 hour' where github_repo_id=2 and channel='x'`)
    await store.mark('x', [{ githubRepoId: '2', milestone: 50 }], since)
    const retaken = (await store.channelState('x')).marks.get('2')
    assert.equal(retaken.milestone, 75, 'never lowered')
    assert.ok(retaken.markedAt >= since, 're-taken after the cutoff')

    // The do-not-promote list: a repository's marks are dropped on every channel; an out-of-range id matches nothing.
    await store.forgetMarks(['2', '99999999999999999999'])
    assert.equal((await store.channelState('x')).marks.get('2'), undefined)
    const telegramMarks = (await store.channelState('telegram')).marks
    assert.deepEqual([telegramMarks.has('2'), telegramMarks.has('1')], [false, true], 'other repositories keep theirs')

    // Constraints.
    await assert.rejects(pool.query(`insert into milestone_alerts(github_repo_id,mint,channel,milestone,status) values(2,'m','telegram',90,'sending')`), /milestone_alerts_repo_channel_milestone_unique/)
    await assert.rejects(pool.query(`insert into milestone_alerts(github_repo_id,mint,channel,milestone,status) values(2,'m','telegram',60,'sending')`), /milestone_alerts_milestone_check/)
    await assert.rejects(pool.query(`insert into milestone_alerts(github_repo_id,mint,channel,milestone,status) values(2,'m','email',25,'sending')`), /milestone_alerts_channel_check/)
    await assert.rejects(pool.query(`insert into milestone_alerts(github_repo_id,mint,channel,milestone,status) values(2,'m','x',100,'sent')`), /milestone_alerts_sent_check/)
    await assert.rejects(pool.query(`insert into milestone_alert_marks(github_repo_id,channel,milestone) values(1,'telegram',0)`), /milestone_alert_marks_pkey/)
    await assert.rejects(pool.query(`insert into milestone_alert_marks(github_repo_id,channel,milestone) values(4,'telegram',10)`), /milestone_alert_marks_milestone_check/)
    // Launch alerts are untouched: their own table and unique index still apply.
    await pool.query(`insert into launch_alerts(github_repo_id,mint,channel,status) values(1,'Mint1','x','sending')`)
    await assert.rejects(pool.query(`insert into launch_alerts(github_repo_id,mint,channel,status) values(1,'Mint1','x','sending')`), /launch_alerts_repo_channel_unique/)

    const inner = await store.withLock(async () => (await store.withLock(async () => 'nested')).locked)
    assert.deepEqual(inner, { locked: true, value: false }, 'a second holder is refused while the lock is held')
  } finally { await pool.end() }
})

// Contributor early access (docs/EARLY_ACCESS.md, step 7a): while a market's window is open its transfer hook refuses buyers off its
// list, so its progress is not posted; after the window, or once it graduated (the filling swap revoked the hook), it is.
test('real PostgreSQL: an early access market\'s milestones are held while its window is open, unless it graduated', { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await seed(pool)
    for (const [id, endsInMs, graduated] of [[7, 3_600_000, false], [8, -60_000, false], [9, 3_600_000, true]]) {
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
        values($1,'octo',$2,$3,1,0,false,now())`, [id, `repo-${id}`, `octo/repo-${id}`])
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
        launch_slot,launch_finality,indexed_at,last_verified_at,early_access_end,transfer_hook_program)
        values($1,'confirmed',$2,$3,'w','w','Repo',$4,$5,1,'finalized',now(),now(),$6,'Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep')`,
      [id, `Mint${id}`, `Pool${id}`, `R${id}`, `Sig${id}`, new Date(Date.now() + endsInMs)])
      await observe(pool, id, { reserveSol: graduated ? 85n : 80n, graduated })
    }
    const rows = await createMilestoneAlertStore(pool).progressRows()
    assert.deepEqual(rows.map(row => row.githubRepoId), ['1', '2', '3', '5', '8', '9'], 'market 7 (window open) is held')
  } finally { await pool.end() }
})
