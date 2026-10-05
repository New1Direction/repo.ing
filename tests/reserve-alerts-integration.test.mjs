import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { persistGraduationObservation, createReserveAlertDelivery, feeLedgerAlertDetail } from '../src/reserve-alerts.mjs'

test('durable baseline/outbox: atomic rollback, restart, dedupe, delivery retries, expiry, backlog and replica lock', async () => {
  const url = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_reserve_alert_test'
  assert.equal(process.env.DATABASE_URL, url)
  const admin = new pg.Pool({ connectionString: url.replace('/repoing_reserve_alert_test', '/postgres') })
  let pool, db, created = false
  try {
    await admin.query('create database repoing_reserve_alert_test'); created = true
    pool = new pg.Pool({ connectionString: url }); await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values(998200,'local','reserve','local/reserve',1,0,false,now())")
    await pool.query("insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol) values(998200,'prepared','mint','curve','wallet','creator','Reserve','RES')")
    db = await pool.connect()
    const market = { githubRepoId: '998200', mint: 'mint', pool: 'curve', fullName: 'local/reserve' }
    let now = Date.now(), slot = 100
    const make = reserve => ({ repoId: '998200', mint: 'mint', curve: 'curve', config: 'config', phase: 'CURVE',
      reserveLamports: String(reserve), thresholdLamports: '85000000000', slots: [++slot, slot], checkedAt: new Date(now).toISOString(), chainTime: new Date(now).toISOString() })
    const previous = async () => (await pool.query('select * from graduation_observations where github_repo_id=998200')).rows[0]
    // notify: reserve notifications on (RESERVE_MOVE_NOTIFICATIONS), so each move is queued for delivery.
    const persist = async (state, client = db, notify = true) => persistGraduationObservation(client, { market, state, previous: await previous(), reconciliation: { status: 'MATCH' }, enabled: true, notify, now })
    await persist(make(100000000)); assert.equal((await pool.query('select count(*)::int n from graduation_alerts')).rows[0].n, 0)
    const current = make(150000000)
    const fault = { query: async (...args) => { if (args[0].startsWith('insert into graduation_observations')) throw Error('injected database failure'); return db.query(...args) } }
    await assert.rejects(persist(current, fault), /injected/)
    assert.equal((await pool.query('select count(*)::int n from graduation_alerts')).rows[0].n, 0)
    assert.equal(JSON.parse((await previous()).observation).reserveAlert.reserveLamports, '100000000')
    await persist(current); await persist(current)
    assert.equal((await pool.query('select count(*)::int n from graduation_alerts')).rows[0].n, 1)
    assert.equal((await createReserveAlertDelivery({ pool }).runOnce()).status, 'DESTINATION_REQUIRED')
    let sent = 0
    const delivery = () => createReserveAlertDelivery({ pool, now: () => now, reserveMoves: true, send: async ({ text }) => { sent++; assert.match(text, /Alert #/); if (sent === 1) throw Error('never expose token'); return { messageId: 'fixture' } } })
    assert.equal((await delivery().runOnce()).status, 'DELIVERY_REVIEW')
    assert.equal((await delivery().runOnce()).sent, 0)
    await pool.query("update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery,nextAttemptAt}',to_jsonb(now()-interval '1 second'))::text")
    await db.query("select pg_advisory_lock(hashtextextended('reserve-alert-delivery',0))")
    assert.equal((await delivery().runOnce()).status, 'BUSY')
    await db.query("select pg_advisory_unlock(hashtextextended('reserve-alert-delivery',0))")
    assert.equal((await delivery().runOnce()).sent, 1); assert.equal((await delivery().runOnce()).sent, 0)
    const detail = JSON.parse((await pool.query('select detail from graduation_alerts')).rows[0].detail)
    assert.equal(detail.deltaLamports, '50000000'); assert.equal(detail.delivery.attempts, 2); assert.equal(detail.delivery.status, 'sent')
    assert.doesNotMatch(JSON.stringify(detail), /never expose token/)
    now += 300001
    await persist(make(210000000))
    now += 6 * 3600000 + 1
    await pool.query("update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery,nextAttemptAt}',to_jsonb(now()-interval '1 second'))::text where id=(select max(id) from graduation_alerts)")
    const expired = await delivery().runOnce(); assert.equal(expired.sent, 0); assert.equal(expired.results[0].status, 'expired'); assert.equal(expired.expired, 1)

    // Reserve notifications off (the default): the move is recorded for the operations pages and never queued.
    now += 300001
    await persist(make(280000000), db, false)
    const quiet = JSON.parse((await pool.query('select detail from graduation_alerts order by id desc limit 1')).rows[0].detail)
    assert.equal(quiet.deltaLamports, '70000000'); assert.deepEqual(quiet.delivery, { status: 'off' })
    assert.deepEqual(await delivery().runOnce(), { status: 'OK', sent: 0, expired: 0, silenced: 0, results: [] })

    // A backlog (a destination configured late, a long receiver outage) expires in one run and never holds up the alerts
    // behind it. Due now by the database's clock; observed by the test's.
    const due = { status: 'pending', attempts: 0, nextAttemptAt: '2020-01-01T00:00:00.000Z' }, at = new Date(now).toISOString()
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) select 'backlog:'||n,998200,'RESERVE_MOVED',$1 from generate_series(1,40) n`,
      [JSON.stringify({ observedAt: new Date(now - 7 * 3600000).toISOString(), delivery: due })])
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values('ops-wallet-low:fixture',null,'OPS_WALLET_LOW',$1),('998200:RECONCILIATION_MISMATCH:fixture',998200,'RECONCILIATION_MISMATCH',$2)`,
      [JSON.stringify({ role: 'Builder payout signer', minimumLamports: '30000000', balanceLamports: '1000', observedAt: at, delivery: due }),
        JSON.stringify({ ...feeLedgerAlertDetail({ market, reconciliation: { status: 'MISMATCH', difference: 5n }, episode: { lagging: true, since: at }, observedAt: at, now }), delivery: due })])
    // A mismatch alert from before these were delivered carries no delivery, and is left as it is.
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values('998200:RECONCILIATION_MISMATCH:before',998200,'RECONCILIATION_MISMATCH','{"status":"MISMATCH"}')`)
    const texts = []
    const collect = async ({ text }) => { texts.push(text); return { messageId: 'fixture' } }
    const caughtUp = await createReserveAlertDelivery({ pool, now: () => now, reserveMoves: true, send: collect }).runOnce()
    assert.equal(caughtUp.status, 'OK'); assert.equal(caughtUp.expired, 40); assert.equal(caughtUp.sent, 2)
    assert.equal(caughtUp.results.filter(result => result.status === 'expired').length, 20, 'a run names at most 20 of the alerts it expired')
    assert.match(texts[0], /Low operating balance\nBuilder payout signer/); assert.match(texts[1], /Fee ledger behind the chain\nlocal\/reserve\n/)
    assert.equal((await pool.query(`select count(*)::int n from graduation_alerts where detail::jsonb->'delivery'->>'status' in ('pending','retry')`)).rows[0].n, 0)
    assert.equal((await pool.query(`select detail from graduation_alerts where event_key='998200:RECONCILIATION_MISMATCH:before'`)).rows[0].detail, '{"status":"MISMATCH"}')

    // Reserve notifications off (the worker's default): moves that are still queued, fresh or waiting for a retry, are
    // marked off and never sent, while a problem queued beside them is.
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) select 'queued:'||n,998200,'RESERVE_MOVED',$1 from generate_series(1,7) n`,
      [JSON.stringify({ observedAt: at, delivery: due })])
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values('queued:retry',998200,'RESERVE_MOVED',$1),('ops-wallet-low:second',null,'OPS_WALLET_LOW',$2)`,
      [JSON.stringify({ observedAt: at, delivery: { ...due, status: 'retry', attempts: 3 } }),
        JSON.stringify({ role: 'Fee collection signer', minimumLamports: '10000000', balanceLamports: '1000', observedAt: at, delivery: due })])
    texts.length = 0
    const quietRun = await createReserveAlertDelivery({ pool, now: () => now, send: collect }).runOnce()
    assert.deepEqual({ status: quietRun.status, sent: quietRun.sent, expired: quietRun.expired, silenced: quietRun.silenced }, { status: 'OK', sent: 1, expired: 0, silenced: 8 })
    assert.equal(texts.length, 1); assert.match(texts[0], /Low operating balance\nFee collection signer/)
    const { rows: off } = await pool.query(`select detail::jsonb->'delivery' as delivery from graduation_alerts where event_key like 'queued:%' order by id`)
    assert.equal(off.length, 8)
    for (const { delivery: marked } of off) assert.deepEqual([marked.status, marked.error], ['off', 'RESERVE_NOTIFICATIONS_OFF'])
    assert.equal(off.at(-1).delivery.attempts, 3, 'what was tried before is kept')
    // Nothing that was sent or expired before is touched.
    assert.equal((await pool.query(`select count(*)::int n from graduation_alerts where kind='RESERVE_MOVED' and detail::jsonb->'delivery'->>'status'='expired'`)).rows[0].n, 41)
    assert.equal((await pool.query(`select count(*)::int n from graduation_alerts where kind='RESERVE_MOVED' and detail::jsonb->'delivery'->>'status'='sent'`)).rows[0].n, 1)
    assert.equal((await pool.query('select count(*)::int n from trade_events')).rows[0].n, 0)
    assert.equal((await pool.query('select count(*)::int n from liquidity_intents')).rows[0].n, 0)
    assert.equal((await pool.query('select count(*)::int n from builder_reinvest_intents')).rows[0].n, 0)
  } finally { db?.release(); await pool?.end(); if (created) await admin.query('drop database repoing_reserve_alert_test'); await admin.end() }
})
