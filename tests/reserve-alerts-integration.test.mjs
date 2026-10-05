import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { persistGraduationObservation, createReserveAlertDelivery, digestLedgerAlerts, feeLedgerAlertDetail, ledgerChecksAlertDetail, platformLedgerAlertDetail, pendingDelivery, reserveAlertText } from '../src/reserve-alerts.mjs'
import { DIGEST_SETTLE_MS, DIGEST_SPACING_MS } from '../src/ledger-digest.mjs'

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
    assert.deepEqual(await delivery().runOnce(), { status: 'OK', sent: 0, expired: 0, silenced: 0, digested: 0, results: [] })

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

test('ledger alerts go out as one message: planned from stored rows, an hour apart, expired when old, unsent with no destination', async () => {
  const url = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_reserve_alert_test'
  assert.equal(process.env.DATABASE_URL, url)
  const admin = new pg.Pool({ connectionString: url.replace('/repoing_reserve_alert_test', '/postgres') })
  let pool, created = false
  try {
    await admin.query('create database repoing_reserve_alert_test'); created = true
    pool = new pg.Pool({ connectionString: url }); await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    const markets = [998201, 998202].map(id => ({ githubRepoId: String(id), mint: `mint${id}`, pool: `curve${id}`, fullName: `local/ledger-${id}` }))
    for (const market of markets) {
      await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values($1,'local',$2,$3,1,0,false,now())", [market.githubRepoId, `ledger-${market.githubRepoId}`, market.fullName])
      await pool.query("insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol) values($1,'prepared',$2,$3,'wallet','creator','Ledger','LED')", [market.githubRepoId, market.mint, market.pool])
    }
    const MINUTE = 60_000, iso = at => new Date(at).toISOString()
    // The job's own clock, well before the database's: a message is due for sending as soon as it is written.
    const T0 = Date.parse('2026-01-05T08:00:00.000Z')
    let now = T0, keys = 0
    // As the monitor records them (src/ledger-alerts.mjs): one row per ledger episode, waiting for a message.
    const record = async (repoId, detail) => (await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,'RECONCILIATION_MISMATCH',$3) returning id`,
      [`${repoId ?? 'protocol'}:RECONCILIATION_MISMATCH:test:${++keys}`, repoId, JSON.stringify(detail)])).rows[0].id
    const fee = (market, reconciliation, lagging) => feeLedgerAlertDetail({ market, reconciliation, episode: { lagging, since: iso(now - 15 * MINUTE) }, observedAt: iso(now), now })
    const stored = async id => JSON.parse((await pool.query('select detail from graduation_alerts where id=$1', [id])).rows[0].detail)
    const messages = async () => (await pool.query(`select id,event_key,github_repo_id,detail from graduation_alerts where detail::jsonb->>'ledger'='digest' order by id`)).rows.map(row => ({ ...row, detail: JSON.parse(row.detail) }))
    const texts = []
    const delivery = (options = {}) => createReserveAlertDelivery({ pool, now: () => now, send: async ({ id, text }) => { texts.push({ id, text }); return { messageId: 'fixture' } }, ...options })

    // Rows from before ledger alerts were sent at all, and a stock ledger's row, are never part of a message.
    const before = await record(markets[0].githubRepoId, { status: 'MISMATCH' })
    const stock = await record(markets[0].githubRepoId, { ledger: 'stock', status: 'MISMATCH', reason: 'CUSTODY_SHORTFALL', lagging: false, since: iso(now) })

    // Two ledgers recorded on neighbouring passes: nothing goes out until the newer has settled, then one message, sent by
    // the run that wrote it. Two workers running at once write it once.
    const real = await record(markets[0].githubRepoId, fee(markets[0], { status: 'MISMATCH', difference: -5n }, false))
    now += 80_000
    const unread = await record(markets[1].githubRepoId, fee(markets[1], { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }, true))
    now += DIGEST_SETTLE_MS - 1
    assert.deepEqual(await delivery().runOnce(), { status: 'OK', sent: 0, expired: 0, silenced: 0, digested: 0, results: [] })
    assert.deepEqual((await stored(real)).delivery, { status: 'digest', queuedAt: iso(T0) })
    now += 1
    const both = await Promise.all([delivery().runOnce(), delivery().runOnce()])
    assert.deepEqual(both.map(run => run.sent ?? 0).sort(), [0, 1])
    assert.equal(both.reduce((sum, run) => sum + (run.digested ?? 0), 0), 2)
    const [first] = await messages()
    assert.equal((await messages()).length, 1)
    assert.deepEqual([first.event_key, first.github_repo_id, first.detail.count, first.detail.rows, first.detail.delivery.status], [`protocol:RECONCILIATION_MISMATCH:digest:${real}`, null, 2, 2, 'sent'])
    assert.deepEqual(texts, [{ id: first.id, text: ['repo.ing · 2 ledgers need review', 'local/ledger-998201: Fee ledger does not match the chain', 'local/ledger-998202: Fee ledger could not be checked',
      `Since: ${iso(T0 - 15 * MINUTE)}`, `Checked: ${iso(now)}`, 'https://repo.ing/operations/graduation', `Alert #${first.id}`].join('\n') }])
    for (const id of [real, unread]) assert.deepEqual([(await stored(id)).delivery.status, (await stored(id)).delivery.digest], ['digest', first.id], 'each row names its message')
    assert.deepEqual(await delivery().runOnce(), { status: 'OK', sent: 0, expired: 0, silenced: 0, digested: 0, results: [] }, 'nothing is planned or sent twice')
    const sentAt = now

    // Inside the hour a new problem waits, with whatever else is recorded meanwhile; a ledger recorded twice counts once.
    now = sentAt + 10 * MINUTE
    const platform = await record(null, platformLedgerAlertDetail({ revenue: { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] }, liquidity: { status: 'MATCH', problems: [] }, episode: { since: iso(now - 15 * MINUTE) }, now }))
    now = sentAt + 30 * MINUTE
    assert.equal((await delivery().runOnce()).digested, 0)
    const again = await record(markets[1].githubRepoId, fee(markets[1], { status: 'UNAVAILABLE', reason: 'RPC_RATE_LIMITED' }, true))
    const once = await record(markets[1].githubRepoId, fee(markets[1], { status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }, false))
    now = sentAt + DIGEST_SPACING_MS - 1
    assert.equal((await delivery().runOnce()).digested, 0)
    now = sentAt + DIGEST_SPACING_MS
    texts.length = 0
    const second = await delivery().runOnce()
    assert.deepEqual([second.status, second.sent, second.digested], ['OK', 1, 3])
    assert.match(texts[0].text, /^repo\.ing · 2 ledgers need review\nPlatform ledger does not match\nlocal\/ledger-998202: Fee ledger could not be reconciled\nSince: /)
    assert.deepEqual((await messages()).map(message => message.detail.count), [2, 2])
    for (const id of [platform, again, once]) assert.equal((await stored(id)).delivery.digest, (await messages())[1].id)

    // The hour is counted from the last message, not the first. One ledger alone is sent as its own alert.
    const secondAt = now
    now = secondAt + 10 * MINUTE
    const checks = ledgerChecksAlertDetail({ code: 'RPC_UNAVAILABLE', episode: { since: iso(now - 15 * MINUTE) }, now })
    await record(null, checks)
    now = secondAt + 15 * MINUTE
    assert.equal((await delivery().runOnce()).digested, 0)
    now = secondAt + DIGEST_SPACING_MS
    texts.length = 0
    assert.equal((await delivery().runOnce()).sent, 1)
    assert.equal(texts[0].text, reserveAlertText(texts[0].id, checks))
    assert.match(texts[0].text, /^repo\.ing · Ledger checks are not running\n/)

    // Planning that fails writes nothing, is reported, and does not keep a queued alert from going out. The next run plans
    // the same rows.
    now += DIGEST_SPACING_MS
    const waiting = await record(markets[0].githubRepoId, fee(markets[0], { status: 'MISMATCH', difference: -7n }, false))
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values('ops-wallet-low:ledger-test',null,'OPS_WALLET_LOW',$1)`,
      [JSON.stringify({ role: 'Builder payout signer', minimumLamports: '30000000', balanceLamports: '1000', observedAt: iso(now), delivery: { ...pendingDelivery(now), nextAttemptAt: '2020-01-01T00:00:00.000Z' } })])
    now += DIGEST_SETTLE_MS
    const count = async () => (await messages()).length, messagesBefore = await count()
    const faulty = db => ({ query: async (...args) => { if (String(args[0]).includes("'{delivery,digest}'")) throw Error('injected database failure'); return db.query(...args) } })
    texts.length = 0
    const failed = await delivery({ digest: (db, options) => digestLedgerAlerts(faulty(db), options) }).runOnce()
    assert.deepEqual([failed.status, failed.sent, failed.digested, failed.digestError], ['DELIVERY_REVIEW', 1, 0, 'LEDGER_DIGEST_FAILED'])
    assert.match(texts[0].text, /Low operating balance\nBuilder payout signer/)
    assert.equal(await count(), messagesBefore, 'the message was rolled back with the rest')
    assert.deepEqual((await stored(waiting)).delivery, { status: 'digest', queuedAt: iso(now - DIGEST_SETTLE_MS) })
    texts.length = 0
    const retried = await delivery().runOnce()
    assert.deepEqual([retried.status, retried.sent, retried.digested], ['OK', 1, 1])
    assert.match(texts[0].text, /^repo\.ing · Fee ledger does not match the chain\nlocal\/ledger-998201\nThe ledger shows more fees than the chain holds\.\n/)

    // With no destination the message is recorded unsent, and a destination set later is not handed it.
    now += DIGEST_SPACING_MS
    const unsent = await record(markets[0].githubRepoId, fee(markets[0], { status: 'MISMATCH', difference: -9n }, false))
    now += DIGEST_SETTLE_MS
    assert.deepEqual(await createReserveAlertDelivery({ pool, now: () => now }).runOnce(), { status: 'DESTINATION_REQUIRED', sent: 0, expired: 0, digested: 1 })
    const off = (await messages()).at(-1)
    assert.deepEqual(off.detail.delivery, { status: 'off', reason: 'DESTINATION_REQUIRED' })
    assert.equal((await stored(unsent)).delivery.digest, off.id)
    texts.length = 0
    assert.deepEqual(await delivery().runOnce(), { status: 'OK', sent: 0, expired: 0, silenced: 0, digested: 0, results: [] })
    assert.deepEqual(texts, [])

    // Rows left waiting while no job ran are expired, not sent, however many; the ones still news go out, 500 to a message.
    now += DIGEST_SPACING_MS
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) select 'old:'||n,998201,'RECONCILIATION_MISMATCH',$1 from generate_series(1,30) n`,
      [JSON.stringify({ ...fee(markets[0], { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }, true), delivery: { status: 'digest', queuedAt: iso(now - 7 * 3_600_000) } })])
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) select 'new:'||n,998202,'RECONCILIATION_MISMATCH',$1 from generate_series(1,520) n`,
      [JSON.stringify(fee(markets[1], { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }, true))])
    now += DIGEST_SETTLE_MS
    texts.length = 0
    const backlog = await delivery().runOnce()
    assert.deepEqual([backlog.status, backlog.sent, backlog.expired, backlog.digested], ['OK', 1, 30, 470], 'the oldest 500 rows: 30 expired, 470 in the message')
    assert.match(texts[0].text, /^repo\.ing · Fee ledger could not be checked\nlocal\/ledger-998202\n/)
    assert.equal((await pool.query(`select count(*)::int n from graduation_alerts where event_key like 'old:%' and detail::jsonb->'delivery'->>'status'='expired' and detail::jsonb->'delivery'->>'error'='ALERT_TOO_OLD'`)).rows[0].n, 30)
    assert.equal((await pool.query(`select count(*)::int n from graduation_alerts where event_key like 'new:%' and detail::jsonb->'delivery'->>'digest' is null`)).rows[0].n, 50, 'the rest wait for the next message')
    now += DIGEST_SPACING_MS
    assert.deepEqual([(await delivery().runOnce()).digested, (await delivery().runOnce()).digested], [50, 0])

    // Untouched throughout: the rows that were never ledger alerts of this kind.
    assert.deepEqual(await stored(before), { status: 'MISMATCH' })
    assert.equal((await stored(stock)).delivery, undefined)
    assert.equal((await pool.query(`select count(*)::int n from graduation_alerts where detail::jsonb->'delivery'->>'status' in ('pending','retry')`)).rows[0].n, 0)
  } finally { await pool?.end(); if (created) await admin.query('drop database repoing_reserve_alert_test'); await admin.end() }
})
