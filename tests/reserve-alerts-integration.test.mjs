import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { persistGraduationObservation, createReserveAlertDelivery } from '../src/reserve-alerts.mjs'

test('durable baseline/outbox: atomic rollback, restart, dedupe, delivery retries, expiry and replica lock', async () => {
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
    const persist = async (state, client = db) => persistGraduationObservation(client, { market, state, previous: await previous(), reconciliation: { status: 'MATCH' }, enabled: true, now })
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
    const delivery = () => createReserveAlertDelivery({ pool, now: () => now, send: async ({ text }) => { sent++; assert.match(text, /Alert #/); if (sent === 1) throw Error('never expose token'); return { messageId: 'fixture' } } })
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
    const expired = await delivery().runOnce(); assert.equal(expired.sent, 0); assert.equal(expired.results[0].status, 'expired')
    assert.equal((await pool.query('select count(*)::int n from trade_events')).rows[0].n, 0)
    assert.equal((await pool.query('select count(*)::int n from liquidity_intents')).rows[0].n, 0)
    assert.equal((await pool.query('select count(*)::int n from builder_reinvest_intents')).rows[0].n, 0)
  } finally { db?.release(); await pool?.end(); if (created) await admin.query('drop database repoing_reserve_alert_test'); await admin.end() }
})
