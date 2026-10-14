import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createGuideDrafts, createGuideEvents, createLaunchGuide, createPreflightService, GuideError, readGuideState } from '../src/launch-guide.mjs'
import { activeSchedule, createLaunchSchedules } from '../src/launch-schedules.mjs'
import { guideEvent } from '../app/lib/launch-guide-funnel.mjs'

// Real PostgreSQL with every committed migration (0073_launch_guide): drafts owned by one GitHub account and resumed, the plan's
// size and the published state enforced by the table, conversion events limited to fixed values, and the guide end to end:
// select (fresh admin check), preflight against repo.ing's records, publish into launch_schedules exactly once.
const url = process.env.LAUNCH_GUIDE_TEST_DATABASE_URL
const HOUR = 3_600_000
const wallet = () => Keypair.generate().publicKey.toBase58()
const TERMS = { config: 'Cfg1111111111111111111111111111111111111111', feeKnown: true, allocation: true, launchFee: null,
  presets: { 100: '250000000', 200: '520000000', 300: '856011397' } }

async function open() {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_launch_guide_test', 'Disposable launch guide database required')
  const pool = new pg.Pool({ connectionString: url })
  await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  await pool.query(`truncate launch_guide_events, launch_guide_drafts, launch_schedules, bundles, maintainer_opt_outs, markets, repositories restart identity cascade`)
  return pool
}
const repoRow = id => ({ id, full_name: `octo/r${id}`, name: `r${id}`, owner: { login: 'octo' }, private: false, archived: false, stargazers_count: 150,
  forks_count: 3, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })
// GitHub as the guide sees it: repositories by id and name, a week of commits; every request counted.
function fakeGithub() {
  const calls = []
  const fetchImpl = async target => {
    const path = new URL(target).pathname
    calls.push(path)
    const byId = /^\/repositories\/(\d+)$/.exec(path)?.[1], byName = /^\/repos\/octo\/r(\d+)$/.exec(path)?.[1]
    const body = byId || byName ? repoRow(Number(byId ?? byName)) : /\/commits$/.test(path) ? [{ author: { id: 1 } }] : null
    return { status: body ? 200 : 404, ok: Boolean(body), json: async () => body, headers: new Headers() }
  }
  return { fetchImpl, calls }
}
const persist = pool => async repoId => pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
  values($1,'octo',$2,$3,150,3,false,now()) on conflict do nothing`, [String(repoId), `r${repoId}`, `octo/r${repoId}`])

function guideFor(pool, { github = fakeGithub(), admin = () => true, session = { githubUserId: '501', githubLogin: 'octo' }, events = [] } = {}) {
  const preflight = createPreflightService({ pool, fetchImpl: github.fetchImpl, readTerms: async () => TERMS, readBalance: async () => 5_000_000_000,
    lineage: async () => ({ forkOf: null }) })
  const adminChecks = []
  const verifyAdmin = async repoId => { adminChecks.push(String(repoId)); const ok = admin(String(repoId)); if (ok instanceof Error) throw ok; return { admin: ok, githubLogin: session.githubLogin, permission: ok ? 'admin' : 'write' } }
  const schedules = createLaunchSchedules({ pool, persistRepository: persist(pool), verifyAdmin: async ({ githubRepoId }) => {
    adminChecks.push(`schedule:${githubRepoId}`)
    if (!admin(String(githubRepoId))) throw new Error('not admin')
    return { githubUserId: BigInt(session.githubUserId), githubLogin: session.githubLogin }
  } })
  const guide = createLaunchGuide({ pool, preflight, verifyAdmin, schedules, persistRepository: persist(pool), record: async event => { events.push(guideEvent(event)) } })
  return { guide, session, github, adminChecks, events }
}
const plan = (overrides = {}) => ({ scheduledAt: new Date(Date.now() + 26 * HOUR).toISOString(), windowMinutes: 60, launcherWallet: wallet(), supplyBps: 300,
  note: 'Release 1.0 ships today.', acknowledged: true, ...overrides })

test('real PostgreSQL: drafts belong to one GitHub account, resume, keep their plan small, and are pruned after 30 days', { skip: !url }, async () => {
  const pool = await open()
  try {
    // The migration runs again cleanly (every statement is idempotent).
    const sql = readFileSync(new URL('../drizzle/0073_launch_guide.sql', import.meta.url), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) await pool.query(statement.replace(/^SET LOCAL.*$/m, ''))
    const drafts = createGuideDrafts(pool)
    const first = await drafts.open({ githubUserId: '501', repoId: '7001', adminLogin: 'octo', adminCheckedAt: new Date() })
    assert.equal(first.resumed, false)
    assert.equal(first.step, 'preflight')
    const again = await drafts.open({ githubUserId: '501', repoId: '7001', adminLogin: 'octo', adminCheckedAt: new Date() })
    assert.equal(again.resumed, true)
    assert.equal(again.id, first.id, 'one open draft per account and repository')
    // Another account cannot read, change or discard it.
    assert.equal(await drafts.get(first.id, '502'), null)
    await assert.rejects(drafts.save(first.id, '502', { step: 'plan' }), error => error instanceof GuideError && error.status === 404)
    assert.equal(await drafts.discard(first.id, '502'), false)
    const saved = await drafts.save(first.id, '501', { step: 'plan', plan: { supplyBps: 200, launcherWallet: 'abc', extra: 'dropped' } })
    assert.deepEqual(saved.plan, { supplyBps: 200, launcherWallet: 'abc' })
    assert.equal(saved.step, 'plan')
    assert.deepEqual((await drafts.list('501')).map(item => item.id), [first.id])
    await assert.rejects(drafts.save(first.id, '501', { step: 'launch' }), GuideError)
    // The table refuses an oversized plan, a published draft without its schedule, and a model id, whatever the application does.
    await assert.rejects(pool.query(`update launch_guide_drafts set plan = jsonb_build_object('note', repeat('x', 5000)) where id = $1`, [first.id]), error => error.code === '23514')
    await assert.rejects(pool.query(`update launch_guide_drafts set status = 'published' where id = $1`, [first.id]), error => error.code === '23514')
    await assert.rejects(pool.query(`insert into launch_guide_drafts (github_user_id, github_repo_id) values (1, 4503599627370497)`), error => error.code === '23514')
    // Pruning: a draft untouched for 31 days goes; a fresh one stays.
    const stale = await drafts.open({ githubUserId: '501', repoId: '7002', adminLogin: 'octo', adminCheckedAt: new Date() })
    await pool.query(`update launch_guide_drafts set updated_at = now() - interval '31 days' where id = $1`, [stale.id])
    assert.equal(await drafts.prune(), 1)
    assert.equal(await drafts.get(stale.id, '501'), null)
    assert.ok(await drafts.get(first.id, '501'))
    assert.equal(await drafts.discard(first.id, '501'), true)
    assert.equal(await drafts.get(first.id, '501'), null)
  } finally { await pool.end() }
})

test('real PostgreSQL: conversion events store fixed values only and expire after 180 days', { skip: !url }, async () => {
  const pool = await open()
  try {
    const events = createGuideEvents(pool)
    await events.record(guideEvent({ event: 'guide_view', source: 'launch' }))
    await events.record(guideEvent({ event: 'preflight_run', outcome: 'ready', repoId: '42' }))
    await events.record(guideEvent({ event: 'step_view', step: 'plan', source: 'launch' }))
    for (const [column, value] of [['event', 'claim_view'], ['source', 'ads'], ['outcome', 'maybe'], ['step', 'pay']]) {
      await assert.rejects(pool.query(`insert into launch_guide_events(event, ${column === 'event' ? 'source' : column}) values ($1, $2)`,
        column === 'event' ? [value, null] : ['guide_view', value]), error => error.code === '23514', `${column}=${value}`)
    }
    const columns = (await pool.query(`select column_name from information_schema.columns where table_name = 'launch_guide_events' order by ordinal_position`)).rows.map(row => row.column_name)
    assert.deepEqual(columns, ['id', 'event', 'step', 'source', 'outcome', 'repo_id', 'created_at'], 'no column can hold a person')
    const summary = await events.summary()
    assert.deepEqual(summary.map(row => [row.event, row.step, row.outcome, row.source, row.month]).sort(),
      [['guide_view', null, null, 'launch', 1], ['preflight_run', null, 'ready', null, 1], ['step_view', 'plan', null, 'launch', 1]])
    await pool.query(`update launch_guide_events set created_at = now() - interval '181 days' where event = 'guide_view'`)
    assert.equal(await events.prune(), 1)
  } finally { await pool.end() }
})

test('real PostgreSQL: the guide selects with a fresh admin check, publishes the scheduled launch once, and refuses what the preflight refuses', { skip: !url }, async () => {
  const pool = await open()
  try {
    const { guide, session, github, adminChecks, events } = guideFor(pool, { admin: repoId => repoId !== '7102' })
    // Not an admin: no draft, an answer that says so.
    const refused = await guide.select(session, '7102')
    assert.equal(refused.draft, null)
    assert.equal(refused.maintainer.status, 'not-admin')
    assert.equal(refused.maintainer.permission, 'write')
    // An admin gets a draft; the preflight reads GitHub once and answers from repo.ing's records.
    const { draft } = await guide.select(session, '7101', { source: 'launch' })
    assert.equal(draft.repoId, '7101')
    const checked = await guide.check(session, draft.id)
    assert.equal(checked.preflight.verdict, 'needs-action', 'no plan yet')
    assert.equal(checked.profile.githubRequests, 2)
    assert.ok(checked.draft.preflight, 'the preflight is stored on the draft for resuming')
    // Saving the plan and checking again: GitHub is not read again and the admin check is reused (fresh for 15 minutes).
    const before = adminChecks.length
    const ready = await guide.check(session, draft.id, { plan: plan({ acknowledged: false }) })
    assert.equal(ready.preflight.verdict, 'ready')
    assert.equal(ready.profile.githubRequests, 0)
    assert.equal(adminChecks.length, before)
    // Publishing needs the acknowledgement, then writes the schedule with the config's exact preset for 3%.
    await assert.rejects(guide.publish(session, draft.id), error => error instanceof GuideError && error.code === 'NOT_ACKNOWLEDGED')
    await guide.drafts.save(draft.id, session.githubUserId, { plan: { ...ready.draft.plan, acknowledged: true } })
    const published = await guide.publish(session, draft.id, { source: 'launch' })
    assert.equal(published.alreadyPublished, false)
    assert.equal(published.schedule.maxInitialBuyLamports, '856011397')
    assert.equal(published.schedule.announcedBy, 'octo')
    assert.equal(published.draft.status, 'published')
    assert.equal(published.draft.scheduleId, published.schedule.id)
    assert.ok(adminChecks.includes('schedule:7101'), 'publishing checks admin access with GitHub again')
    const row = await activeSchedule(pool, '7101')
    assert.equal(row.launcherWallet, ready.draft.plan.launcherWallet)
    assert.equal(row.note, 'Release 1.0 ships today.')
    // Again: the same schedule, nothing new.
    const twice = await guide.publish(session, draft.id)
    assert.equal(twice.alreadyPublished, true)
    assert.equal(twice.schedule.id, published.schedule.id)
    assert.equal((await pool.query('select count(*)::int as n from launch_schedules')).rows[0].n, 1)
    assert.equal(github.calls.filter(path => path === '/repositories/7101').length, 1, 'GitHub read once for the whole flow')
    // Events: fixed values only, in order.
    assert.deepEqual(events.map(event => [event.event, event.outcome, event.source]), [
      ['repo_selected', 'not-admin', null], ['repo_selected', 'admin', 'launch'], ['preflight_run', 'needs-action', null], ['preflight_run', 'ready', null], ['publish', 'scheduled', 'launch']])
  } finally { await pool.end() }
})

test('real PostgreSQL: publish is refused with the preflight when a market, opt-out or schedule appears, and recovers its own lost schedule', { skip: !url }, async () => {
  const pool = await open()
  try {
    const { guide, session, events } = guideFor(pool)
    const start = async repoId => {
      const { draft } = await guide.select(session, repoId)
      await guide.check(session, draft.id, { plan: plan() })
      return draft
    }
    // A market launched by someone else after the plan was checked: refused, with what is missing.
    const raced = await start('7201')
    await persist(pool)('7201')
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,
        launch_finality,indexed_at,last_verified_at,launch_block_time) values (7201,'confirmed','MintRaced','PoolRaced',$1,'creator','T','TKN','SigRaced',1,'finalized',now(),now(),now())`, [wallet()])
    await assert.rejects(guide.publish(session, raced.id), error => error.code === 'PREFLIGHT_NOT_READY' && error.detail.missing.includes('no_market'))
    assert.equal((await guide.drafts.get(raced.id, session.githubUserId)).status, 'draft')
    assert.equal(events.at(-1).outcome, 'refused')
    // An incomplete plan never reaches the preflight.
    const { draft: empty } = await guide.select(session, '7202')
    await assert.rejects(guide.publish(session, empty.id), error => error.code === 'PLAN_INCOMPLETE')
    // A publish whose response was lost: the schedule exists (same admin, wallet and time), so publishing again adopts it.
    const lost = await start('7203')
    const stored = await guide.drafts.get(lost.id, session.githubUserId)
    await createLaunchSchedules({ pool, persistRepository: persist(pool), verifyAdmin: async () => ({ githubUserId: 501n, githubLogin: 'octo' }) })
      .create({ repoId: '7203', scheduledAt: stored.plan.scheduledAt, windowMinutes: stored.plan.windowMinutes, launcherWallet: stored.plan.launcherWallet,
        maxInitialBuyLamports: '856011397', note: stored.plan.note })
    const adopted = await guide.publish(session, lost.id)
    assert.equal(adopted.alreadyPublished, true, 'the schedule the lost publish wrote is adopted, not refused')
    assert.equal(adopted.draft.status, 'published')
    assert.equal(adopted.draft.scheduleId, adopted.schedule.id)
    assert.equal((await pool.query(`select count(*)::int as n from launch_schedules where github_repo_id = 7203`)).rows[0].n, 1)
    // Someone else's schedule for another repository: the same refusal, with the schedule's facts.
    await persist(pool)('7204')
    await createLaunchSchedules({ pool, verifyAdmin: async () => ({ githubUserId: 9n, githubLogin: 'other-admin' }) })
      .create({ repoId: '7204', scheduledAt: new Date(Date.now() + 3 * HOUR).toISOString(), launcherWallet: wallet() })
    const other = await start('7204')
    const blocked = await guide.publish(session, other.id).catch(error => error)
    assert.equal(blocked.code, 'PREFLIGHT_NOT_READY')
    assert.match(blocked.detail.preflight.requirements.find(item => item.id === 'no_schedule').detail, /other-admin/)
    // A ScheduleError from the schedule itself (for example a lapsed admin) surfaces unchanged and records a refusal.
    const { guide: lapsed, session: lapsedSession, events: lapsedEvents } = guideFor(pool, { admin: repoId => repoId !== 'never' })
    const draft = (await lapsed.select(lapsedSession, '7205')).draft
    await lapsed.check(lapsedSession, draft.id, { plan: plan({ scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString() }) })
    await pool.query(`update launch_guide_drafts set plan = plan || jsonb_build_object('scheduledAt', $2::text) where id = $1`, [draft.id, new Date(Date.now() + 59 * 60_000).toISOString()])
    await assert.rejects(lapsed.publish(lapsedSession, draft.id), error => error.code === 'PREFLIGHT_NOT_READY' && error.detail.missing.includes('launch_time'))
    assert.equal(lapsedEvents.at(-1).outcome, 'refused')
  } finally { await pool.end() }
})

test('real PostgreSQL: the preflight reads a launch in progress, opt-outs, Group launch raises, tickers and schedules in two queries', { skip: !url }, async () => {
  const pool = await open()
  try {
    for (const id of [7301, 7302, 7303, 7304, 7305, 7306]) await persist(pool)(id)
    let queries = 0
    const db = { query: (...args) => { queries += 1; return pool.query(...args) } }
    const empty = await readGuideState(db, '7301', { symbol: 'FREE' })
    assert.deepEqual(empty, { market: null, optOut: null, liveBundleId: null, symbolTaken: false, schedule: null })
    assert.equal(queries, 2)
    await pool.query(`insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol) values (7302,'prepared',$1,'creator','T','HELD')`, [wallet()])
    assert.deepEqual((await readGuideState(pool, '7302')).market, { status: 'prepared', mint: null })
    // A ticker held by another repository's review; the same ticker for the repository itself is its own.
    assert.equal((await readGuideState(pool, '7301', { symbol: 'held' })).symbolTaken, true)
    assert.equal((await readGuideState(pool, '7302', { symbol: 'HELD' })).symbolTaken, false)
    // A declined repository does not hold its ticker (src/launch-symbols.mjs).
    await pool.query(`insert into maintainer_opt_outs(github_repo_id,kind,github_user_id) values (7302,'decline',501)`)
    assert.equal((await readGuideState(pool, '7301', { symbol: 'HELD' })).symbolTaken, false)
    assert.deepEqual((await readGuideState(pool, '7302')).optOut, { kind: 'decline' })
    await pool.query(`insert into bundles(bundle_id,github_repo_id,address,creator_wallet,token_name,token_symbol,target_lamports,min_deposit_lamports,deadline,status)
      values (77,7303,'BundleAddr77',$1,'Group','GRP',1000000000,50000000,now() + interval '1 day','raising')`, [wallet()])
    assert.equal((await readGuideState(pool, '7303')).liveBundleId, '77')
    assert.equal((await readGuideState(pool, '7301', { symbol: 'grp' })).symbolTaken, true, 'a live raise holds its ticker')
    // Only a schedule that still holds the repository counts: an upcoming one does; a lapsed window does not.
    const schedules = createLaunchSchedules({ pool, verifyAdmin: async () => ({ githubUserId: 501n, githubLogin: 'octo' }) })
    await schedules.create({ repoId: '7304', scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString(), launcherWallet: wallet() })
    assert.equal((await readGuideState(pool, '7304')).schedule.state, 'upcoming')
    await schedules.create({ repoId: '7305', scheduledAt: new Date(Date.now() - 3 * HOUR).toISOString(), windowMinutes: 30, launcherWallet: wallet() }, { now: Date.now() - 5 * HOUR })
    assert.equal((await readGuideState(pool, '7305')).schedule, null)
  } finally { await pool.end() }
})
