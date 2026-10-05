import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { persistGraduationObservation, clearLedgerAlerts, createLedgerDigestStore, createReserveAlertDelivery, digestLedgerAlerts, feeLedgerAlertDetail, ledgerChecksAlertDetail,
  marketPassAlertDetail, platformLedgerAlertDetail, pendingDelivery, reserveAlertText } from '../src/reserve-alerts.mjs'
import { DIGEST_REMINDER_MS, DIGEST_SETTLE_MS, DIGEST_SPACING_MS } from '../src/ledger-digest.mjs'

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

test('ledger alerts go out as one message: news an hour apart, reminders every six, one at a time; cleared rows dropped, old rows expired', async () => {
  const url = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_reserve_alert_test'
  assert.equal(process.env.DATABASE_URL, url)
  const admin = new pg.Pool({ connectionString: url.replace('/repoing_reserve_alert_test', '/postgres') })
  let pool, probe, created = false
  try {
    await admin.query('create database repoing_reserve_alert_test'); created = true
    pool = new pg.Pool({ connectionString: url }); await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    const markets = [998201, 998202, 998203].map(id => ({ githubRepoId: String(id), mint: `mint${id}`, pool: `curve${id}`, fullName: `local/ledger-${id}` }))
    for (const market of markets) {
      await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values($1,'local',$2,$3,1,0,false,now())", [market.githubRepoId, `ledger-${market.githubRepoId}`, market.fullName])
      await pool.query("insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol) values($1,'prepared',$2,$3,'wallet','creator','Ledger','LED')", [market.githubRepoId, market.mint, market.pool])
    }
    const [one, two, three] = markets, MINUTE = 60_000, HOUR = 3_600_000, iso = at => new Date(at).toISOString()
    // The job's own clock, well before the database's: a message is due for sending as soon as it is written.
    const T0 = Date.parse('2026-01-05T08:00:00.000Z')
    let now = T0, keys = 0
    // As the monitor records them (src/ledger-alerts.mjs): one row per ledger, kind and period, waiting for a message.
    const record = async (repoId, detail) => (await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,'RECONCILIATION_MISMATCH',$3) returning id`,
      [`${repoId ?? 'protocol'}:RECONCILIATION_MISMATCH:test:${++keys}`, repoId, JSON.stringify(detail)])).rows[0].id
    const episode = (kind, lagging, repeat = false) => ({ kind, lagging, repeat, since: iso(now - 15 * MINUTE) })
    const difference = (market, repeat = false) => feeLedgerAlertDetail({ market, reconciliation: { status: 'MISMATCH', difference: -5n }, episode: episode('difference', false, repeat), observedAt: iso(now), now })
    const unread = (market, reason = 'RPC_UNAVAILABLE') => feeLedgerAlertDetail({ market, reconciliation: { status: 'UNAVAILABLE', reason }, episode: episode('unchecked', true), observedAt: iso(now), now })
    const stored = async id => JSON.parse((await pool.query('select detail from graduation_alerts where id=$1', [id])).rows[0].detail)
    // Read by pattern, never by casting every row: one row here holds text jsonb refuses. (jsonb_set rewrites a detail with a
    // space after each colon, so both spacings are matched.)
    const messages = async () => (await pool.query(`select id,event_key,github_repo_id,detail from graduation_alerts where detail ~ '"ledger": ?"digest"' order by id`)).rows.map(row => ({ ...row, detail: JSON.parse(row.detail) }))
    const due = () => pool.query(`update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery,nextAttemptAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text))::text where detail ~ '"status": ?"retry"'`)
    const texts = [], receiver = { fail: null }
    const send = async ({ id, text }) => { if (receiver.fail) throw Object.assign(Error('NOTIFICATION_SEND_FAILED'), { code: receiver.fail }); texts.push({ id, text }); return { messageId: 'fixture' } }
    const delivery = (options = {}) => createReserveAlertDelivery({ pool, now: () => now, send, ...options })
    const quiet = { status: 'OK', sent: 0, expired: 0, silenced: 0, digested: 0, results: [] }
    // Whether the delivery lock is free, asked from a connection of its own: the lock is re-entrant for the one that holds it.
    probe = new pg.Client({ connectionString: url })
    await probe.connect()
    const lockFree = async () => {
      const { rows: [{ locked }] } = await probe.query("select pg_try_advisory_lock(hashtextextended('reserve-alert-delivery',0)) as locked")
      if (locked) await probe.query("select pg_advisory_unlock(hashtextextended('reserve-alert-delivery',0))")
      return locked
    }

    // Never part of a message: a row from before ledger alerts were sent at all, a stock ledger's row, and a stock row
    // whose text jsonb refuses. The queue must not even cast that last one.
    const before = await record(one.githubRepoId, { status: 'MISMATCH' })
    const stock = await record(one.githubRepoId, { ledger: 'stock', status: 'MISMATCH', reason: 'CUSTODY_SHORTFALL', lagging: false, since: iso(now) })
    const refused = '{"ledger":"stock","status":"ERROR","reason":"read failed: \\u0000","since":"2026-01-05T08:00:00.000Z"}'
    await assert.rejects(pool.query('select $1::jsonb', [refused]), /unsupported Unicode escape/)
    const poison = (await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values('poison',$1,'RECONCILIATION_MISMATCH',$2) returning id`, [one.githubRepoId, refused])).rows[0].id

    // Two ledgers recorded on neighbouring passes: nothing goes out until the newer has settled, then one message, sent by
    // the run that wrote it. Two workers running at once write it once.
    const real = await record(one.githubRepoId, difference(one))
    now += 80_000
    const failing = await record(two.githubRepoId, unread(two))
    now += DIGEST_SETTLE_MS - 1
    assert.deepEqual(await delivery().runOnce(), quiet)
    assert.deepEqual((await stored(real)).delivery, { status: 'digest', queuedAt: iso(T0) })
    now += 1
    const both = await Promise.all([delivery().runOnce(), delivery().runOnce()])
    assert.deepEqual(both.map(run => run.sent ?? 0).sort(), [0, 1])
    assert.equal(both.reduce((sum, run) => sum + (run.digested ?? 0), 0), 2)
    const [first] = await messages()
    assert.equal((await messages()).length, 1)
    assert.deepEqual([first.event_key, first.github_repo_id, first.detail.count, first.detail.rows, first.detail.reminder, first.detail.delivery.status],
      [`protocol:RECONCILIATION_MISMATCH:digest:${real}`, null, 2, 2, false, 'sent'])
    assert.deepEqual(texts, [{ id: first.id, text: ['repo.ing · 2 ledgers need review', 'local/ledger-998201: Fee ledger does not match the chain', 'local/ledger-998202: Fee ledger could not be checked',
      `Since: ${iso(T0 - 15 * MINUTE)}`, 'https://repo.ing/operations/graduation', `Alert #${first.id}`].join('\n') }])
    for (const id of [real, failing]) assert.deepEqual([(await stored(id)).delivery.status, (await stored(id)).delivery.digest], ['digest', first.id], 'each row names its message')
    assert.deepEqual(await delivery().runOnce(), quiet, 'nothing is planned or sent twice')
    assert.equal(await lockFree(), true, 'every run gives the delivery lock back')
    const firstAt = now

    // Inside the hour, news waits. With it goes whatever else was recorded: the same trouble again for a ledger already
    // announced (a reminder), and a ledger recorded twice counts once, by its most urgent row.
    now = firstAt + 10 * MINUTE
    const platform = await record(null, platformLedgerAlertDetail({ revenue: { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] }, liquidity: { status: 'MATCH', problems: [] }, episode: episode('difference', false), now }))
    now = firstAt + 30 * MINUTE
    assert.equal((await delivery().runOnce()).digested, 0)
    const again = await record(two.githubRepoId, unread(two, 'RPC_RATE_LIMITED')), found = await record(two.githubRepoId, difference(two))
    now = firstAt + DIGEST_SPACING_MS - 1
    assert.equal((await delivery().runOnce()).digested, 0)
    now = firstAt + DIGEST_SPACING_MS
    texts.length = 0
    const second = await delivery().runOnce()
    assert.deepEqual([second.status, second.sent, second.digested], ['OK', 1, 3])
    assert.match(texts[0].text, /^repo\.ing · 2 ledgers need review\nPlatform ledger does not match\nlocal\/ledger-998202: Fee ledger does not match the chain\nSince: /)
    assert.deepEqual((await messages()).map(message => [message.detail.count, message.detail.reminder]), [[2, false], [2, false]])
    for (const id of [platform, again, found]) assert.equal((await stored(id)).delivery.digest, (await messages())[1].id)
    const secondAt = now

    // The hour is counted from the last message, not the first. One ledger alone is sent as its own alert.
    now = secondAt + 10 * MINUTE
    const checks = ledgerChecksAlertDetail({ code: 'RPC_UNAVAILABLE', episode: episode('unchecked', true), now })
    const checksRow = await record(null, checks)
    now = secondAt + 15 * MINUTE
    assert.equal((await delivery().runOnce()).digested, 0)
    now = secondAt + DIGEST_SPACING_MS
    texts.length = 0
    assert.equal((await delivery().runOnce()).sent, 1)
    assert.equal(texts[0].text, reserveAlertText(texts[0].id, checks))
    assert.match(texts[0].text, /^repo\.ing · Ledger checks are not running\n/)
    const thirdAt = now

    // A repeat of what a message already announced is a reminder: it waits until the last message is six hours old.
    now = thirdAt + 10 * MINUTE
    const repeat = await record(one.githubRepoId, difference(one, true))
    for (const at of [thirdAt + DIGEST_SPACING_MS, thirdAt + DIGEST_REMINDER_MS - 1]) { now = at; assert.deepEqual(await delivery().runOnce(), quiet) }
    now = thirdAt + DIGEST_REMINDER_MS
    texts.length = 0
    const reminded = await delivery().runOnce()
    assert.deepEqual([reminded.sent, reminded.digested], [1, 1])
    assert.equal((await messages()).at(-1).detail.reminder, true)
    assert.match(texts[0].text, /^repo\.ing · Fee ledger does not match the chain\nlocal\/ledger-998201\n/)
    const fourthAt = now

    // The monitor marks a ledger that matched again (clearLedgerAlerts), once. A real difference that comes back after that
    // is news. Trouble that normally clears by itself is a reminder even after it cleared, and when it clears again before
    // its turn it is dropped, never sent.
    now = fourthAt + 5 * MINUTE
    await clearLedgerAlerts(pool, [real, repeat, before, stock, poison], iso(now))
    await clearLedgerAlerts(pool, [real, repeat], iso(now + HOUR))
    assert.deepEqual([(await stored(real)).clearedAt, (await stored(repeat)).clearedAt, (await stored(before)).clearedAt, (await stored(stock)).clearedAt], [iso(now), iso(now), undefined, undefined])
    now = fourthAt + 62 * MINUTE
    const back = await record(one.githubRepoId, difference(one))
    now += DIGEST_SETTLE_MS
    const returned = await delivery().runOnce()
    assert.deepEqual([returned.sent, returned.digested, (await messages()).at(-1).detail.reminder], [1, 1, false], 'news an hour after the last message, not a reminder in six')
    assert.equal((await stored(back)).delivery.digest, (await messages()).at(-1).id)
    const backAt = now
    // News again an hour later, and a repeat recorded meanwhile rides along with it.
    now = backAt + 61 * MINUTE
    const lapse = await record(null, ledgerChecksAlertDetail({ code: 'RPC_RATE_LIMITED', episode: episode('unchecked', true), now }))
    const riding = await record(two.githubRepoId, difference(two, true))
    now += DIGEST_SETTLE_MS
    const carried = await delivery().runOnce()
    assert.deepEqual([carried.sent, carried.digested], [1, 2])
    assert.deepEqual([(await messages()).at(-1).detail.count, (await messages()).at(-1).detail.reminder], [2, false])
    for (const id of [lapse, riding]) assert.equal((await stored(id)).delivery.digest, (await messages()).at(-1).id)
    const fifthAt = now
    now = fifthAt + 70 * MINUTE
    const flap = await record(null, ledgerChecksAlertDetail({ code: 'RPC_RATE_LIMITED', episode: episode('unchecked', true), now }))
    now += DIGEST_SETTLE_MS
    assert.deepEqual(await delivery().runOnce(), quiet, 'the same trouble again inside six hours waits for a reminder')
    await clearLedgerAlerts(pool, [flap], iso(now))
    now += 2 * MINUTE
    assert.deepEqual(await delivery().runOnce(), quiet)
    assert.deepEqual((await stored(flap)).delivery, { status: 'off', reason: 'CLEARED', queuedAt: iso(fifthAt + 70 * MINUTE) })

    // One message at a time. A message the receiver refuses is tried again and says why by code; while it waits, nothing
    // new is written, however much is recorded. It is never given up on before it is too old to send.
    now = fifthAt + 3 * HOUR
    const held = await record(three.githubRepoId, difference(three))
    now += DIGEST_SETTLE_MS
    receiver.fail = 'HTTP_503'
    const refusedRun = await delivery().runOnce()
    const stuck = (await messages()).at(-1)
    assert.deepEqual([refusedRun.status, refusedRun.sent, refusedRun.digested, refusedRun.results], ['DELIVERY_REVIEW', 0, 1, [{ id: stuck.id, status: 'retry', error: 'HTTP_503' }]])
    const { delivery: waitingDelivery } = await stored(stuck.id)
    assert.deepEqual([waitingDelivery.status, waitingDelivery.error, waitingDelivery.errorCode, waitingDelivery.attempts], ['retry', 'NOTIFICATION_SEND_FAILED', 'HTTP_503', 1])
    const sixthAt = now
    now = sixthAt + 30 * MINUTE
    const behindIt = await record(two.githubRepoId, marketPassAlertDetail({ market: two, code: 'STALE_PROGRESS', transient: true, episode: episode('unchecked', true), now }))
    for (const at of [sixthAt + 61 * MINUTE, sixthAt + 2 * HOUR, sixthAt + 3 * HOUR]) {
      now = at
      await due()
      const run = await delivery().runOnce()
      assert.deepEqual([run.sent, run.digested, run.results.map(result => result.status)], [0, 0, ['retry']], 'no second message behind an undelivered one')
    }
    await pool.query(`update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery,attempts}','40'::jsonb)::text where id=$1`, [stuck.id])
    await due()
    await delivery().runOnce()
    assert.deepEqual([(await stored(stuck.id)).delivery.status, (await stored(stuck.id)).delivery.attempts], ['retry', 41], 'still tried after any number of attempts')
    // The receiver answers again: the waiting message goes first, and the next one is written by the run after.
    receiver.fail = null
    await due()
    texts.length = 0
    const unblocked = await delivery().runOnce()
    assert.deepEqual([unblocked.status, unblocked.sent, unblocked.digested, texts.map(text => text.id)], ['OK', 1, 0, [stuck.id]])
    assert.deepEqual([(await stored(stuck.id)).delivery.status, (await stored(stuck.id)).delivery.errorCode], ['sent', null])
    const next = await delivery().runOnce()
    assert.deepEqual([next.sent, next.digested], [1, 1])
    assert.match(texts[1].text, /^repo\.ing · Market could not be verified\nlocal\/ledger-998202\nThe monitor's reads for this market keep failing \(STALE_PROGRESS\)\.\n/)
    assert.equal((await stored(behindIt)).delivery.digest, texts[1].id)
    assert.equal((await stored(held)).delivery.digest, stuck.id)
    const seventhAt = now

    // A message that cannot be sent for six hours expires, like any alert. What it covered is announced by its next repeat.
    now = seventhAt + 2 * HOUR
    await record(two.githubRepoId, difference(two))
    now += DIGEST_SETTLE_MS
    receiver.fail = 'TIMEOUT'
    assert.deepEqual((await delivery().runOnce()).results.map(result => [result.status, result.error]), [['retry', 'TIMEOUT']])
    const lost = (await messages()).at(-1).id
    now += 6 * HOUR + 1
    const gaveUp = await delivery().runOnce()
    assert.deepEqual([gaveUp.sent, gaveUp.expired, gaveUp.results], [0, 1, [{ id: lost, status: 'expired' }]])
    assert.deepEqual([(await stored(lost)).delivery.status, (await stored(lost)).delivery.error], ['expired', 'ALERT_TOO_OLD'])
    receiver.fail = null
    const eighthAt = now

    // A queued alert whose text cannot be made fails at once with its own code, uses no attempt at the receiver, and does
    // not hold up the alert behind it.
    const pending = { ...pendingDelivery(now), nextAttemptAt: '2020-01-01T00:00:00.000Z' }
    const broken = (await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values('broken-text',$1,'RESERVE_MOVED',$2) returning id`,
      [one.githubRepoId, JSON.stringify({ observedAt: iso(now), deltaLamports: 'not a number', delivery: pending })])).rows[0].id
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values('ops-wallet-low:ledger-test',null,'OPS_WALLET_LOW',$1)`,
      [JSON.stringify({ role: 'Builder payout signer', minimumLamports: '30000000', balanceLamports: '1000', observedAt: iso(now), delivery: pending })])
    texts.length = 0
    const rendered = await delivery({ reserveMoves: true }).runOnce()
    assert.deepEqual([rendered.status, rendered.sent, rendered.results.map(result => [result.status, result.error])], ['DELIVERY_REVIEW', 1, [['failed', 'RENDER_FAILED'], ['sent', undefined]]])
    assert.deepEqual([(await stored(broken)).delivery.status, (await stored(broken)).delivery.error, (await stored(broken)).delivery.attempts], ['failed', 'RENDER_FAILED', 0])
    assert.match(texts[0].text, /Low operating balance\nBuilder payout signer/)

    // Planning that fails writes nothing, is reported by code, and does not keep a queued alert from going out. The next run
    // plans the same rows.
    now = eighthAt + HOUR
    const waiting = await record(three.githubRepoId, marketPassAlertDetail({ market: three, code: 'RPC_UNAVAILABLE', transient: true, episode: episode('unchecked', true), now }))
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values('ops-wallet-low:ledger-test-2',null,'OPS_WALLET_LOW',$1)`,
      [JSON.stringify({ role: 'Fee collection signer', minimumLamports: '10000000', balanceLamports: '1000', observedAt: iso(now), delivery: { ...pendingDelivery(now), nextAttemptAt: '2020-01-01T00:00:00.000Z' } })])
    now += DIGEST_SETTLE_MS
    const count = async () => (await messages()).length, messagesBefore = await count()
    const faulty = db => ({ query: async (...args) => { if (String(args[0]).includes("'{delivery,digest}'")) throw Object.assign(Error('injected database failure'), { code: '40001' }); return db.query(...args) } })
    texts.length = 0
    const failed = await delivery({ digest: (db, options) => digestLedgerAlerts(createLedgerDigestStore(faulty(db)), options) }).runOnce()
    assert.deepEqual([failed.status, failed.sent, failed.digested, failed.digestError], ['DELIVERY_REVIEW', 1, 0, '40001'])
    assert.match(texts[0].text, /Low operating balance\nFee collection signer/)
    assert.equal(await count(), messagesBefore, 'the message was rolled back with the rest')
    assert.deepEqual((await stored(waiting)).delivery, { status: 'digest', queuedAt: iso(now - DIGEST_SETTLE_MS) })
    // When it keeps failing, the queue says so itself through the destination, after three runs and not on every run.
    const failingJob = delivery({ digest: async () => { throw Error('relation "graduation_alerts" does not exist') } })
    texts.length = 0
    const runs = []
    for (let run = 0; run < 5; run++) runs.push(await failingJob.runOnce())
    assert.deepEqual(runs.map(run => [run.status, run.digestError]), Array(5).fill(['DELIVERY_REVIEW', 'UNKNOWN']))
    assert.deepEqual(texts.map(text => text.id), [0], 'one notice')
    assert.match(texts[0].text, /^repo\.ing · Ledger messages cannot be written\nThe alert queue could not plan them 3 runs in a row \(UNKNOWN\)\.\n/)
    assert.doesNotMatch(texts[0].text, /relation|graduation_alerts/)
    texts.length = 0
    const retried = await delivery().runOnce()
    assert.deepEqual([retried.status, retried.sent, retried.digested], ['OK', 1, 1])
    assert.match(texts[0].text, /^repo\.ing · Market could not be verified\nlocal\/ledger-998203\n/)
    const ninthAt = now

    // With no destination the message is recorded unsent, and a destination set later is not handed it.
    now = ninthAt + DIGEST_SPACING_MS
    const unsent = await record(null, platformLedgerAlertDetail({ revenue: { status: 'MATCH', problems: [] }, liquidity: { status: 'MISMATCH', problems: ['x'] }, episode: episode('difference', false), now }))
    now += DIGEST_SETTLE_MS
    assert.deepEqual(await createReserveAlertDelivery({ pool, now: () => now }).runOnce(), { status: 'DESTINATION_REQUIRED', sent: 0, expired: 0, digested: 1 })
    const off = (await messages()).at(-1)
    assert.deepEqual(off.detail.delivery, { status: 'off', reason: 'DESTINATION_REQUIRED' })
    assert.equal((await stored(unsent)).delivery.digest, off.id)
    texts.length = 0
    assert.deepEqual(await delivery().runOnce(), quiet)
    assert.deepEqual(texts, [])
    const tenthAt = now

    // Rows left waiting while no job ran are expired, not sent, however many; the ones still news go out, 500 rows to a
    // message, and the rest of the same ledger follow as its reminder.
    now = tenthAt + DIGEST_SPACING_MS
    const lagging = feeLedgerAlertDetail({ market: three, reconciliation: { status: 'MISMATCH', difference: 5n }, episode: episode('behind', true), observedAt: iso(now), now })
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) select 'old:'||n,998203,'RECONCILIATION_MISMATCH',$1 from generate_series(1,30) n`,
      [JSON.stringify({ ...lagging, delivery: { status: 'digest', queuedAt: iso(now - 9 * HOUR) } })])
    await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) select 'new:'||n,998203,'RECONCILIATION_MISMATCH',$1 from generate_series(1,520) n`, [JSON.stringify(lagging)])
    now += DIGEST_SETTLE_MS
    texts.length = 0
    const backlog = await delivery().runOnce()
    assert.deepEqual([backlog.status, backlog.sent, backlog.expired, backlog.digested], ['OK', 1, 30, 470], 'the oldest 500 rows: 30 expired, 470 in the message')
    assert.match(texts[0].text, /^repo\.ing · Fee ledger behind the chain\nlocal\/ledger-998203\n/)
    assert.equal((await pool.query(`select count(*)::int n from graduation_alerts where event_key like 'old:%' and detail ~ '"status": ?"expired"' and detail ~ '"error": ?"ALERT_TOO_OLD"'`)).rows[0].n, 30)
    const left = async () => (await pool.query(`select count(*)::int n from graduation_alerts where event_key like 'new:%' and detail !~ '"digest": ?[0-9]'`)).rows[0].n
    assert.equal(await left(), 50, 'the rest wait')
    const backlogAt = now
    now = backlogAt + DIGEST_SPACING_MS
    assert.deepEqual(await delivery().runOnce(), quiet, 'as a reminder: not an hour later')
    now = backlogAt + DIGEST_REMINDER_MS
    assert.deepEqual([(await delivery().runOnce()).digested, (await delivery().runOnce()).digested, await left()], [50, 0, 0])
    assert.equal((await messages()).at(-1).detail.reminder, true)
    // What a message covered more than six hours ago is news again when it is recorded anew.
    now += DIGEST_REMINDER_MS + HOUR
    await record(three.githubRepoId, feeLedgerAlertDetail({ market: three, reconciliation: { status: 'MISMATCH', difference: 5n }, episode: episode('behind', true), observedAt: iso(now), now }))
    now += DIGEST_SETTLE_MS
    assert.deepEqual([(await delivery().runOnce()).sent, (await messages()).at(-1).detail.reminder], [1, false])

    // Untouched throughout: the rows that were never ledger alerts of this kind.
    assert.deepEqual(await stored(before), { status: 'MISMATCH' })
    assert.equal((await stored(stock)).delivery, undefined)
    assert.equal((await pool.query('select detail from graduation_alerts where id=$1', [poison])).rows[0].detail, refused)
    assert.equal((await pool.query(`select count(*)::int n from graduation_alerts where detail ~ '"status": ?"(pending|retry)"'`)).rows[0].n, 0)
    assert.equal(await lockFree(), true)
  } finally { await probe?.end().catch(() => {}); await pool?.end(); if (created) await admin.query('drop database repoing_reserve_alert_test'); await admin.end() }
})
