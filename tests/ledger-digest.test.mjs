import test from 'node:test'
import assert from 'node:assert/strict'
import { planLedgerDigest, ledgerKey, DIGEST_SETTLE_MS, DIGEST_MAX_WAIT_MS, DIGEST_SPACING_MS, DIGEST_REMINDER_MS, DIGEST_RENEW_MS, DIGEST_MEMORY_MS, DIGEST_ROW_MAX_AGE_MS, DIGEST_NAMED } from '../src/ledger-digest.mjs'
import { reconcileKind, reconcileLagging } from '../src/reconcile.mjs'
import { createReserveWebhookSender, digestLedgerAlerts, feeLedgerAlertDetail, ledgerChecksAlertDetail, marketPassAlertDetail, pendingDelivery, platformLedgerAlertDetail,
  reserveAlertText } from '../src/reserve-alerts.mjs'

const START = Date.parse('2026-10-05T08:00:00.000Z'), RUN_MS = 120_000, MINUTE = 60_000, HOUR = 3_600_000
const iso = at => new Date(at).toISOString()
const marketOf = (id, fullName = `local/market-${id}`) => ({ githubRepoId: String(id), mint: `mint${id}`, pool: `pool${id}`, fullName })
const unread = { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }, real = { status: 'MISMATCH', difference: -5n }, behind = { status: 'MISMATCH', difference: 5n }

// Rows as the monitor records them (src/ledger-alerts.mjs), in the order of their ids.
let lastId = 0
const fee = (repoId, at, reconciliation = unread, { since = at - 15 * MINUTE, fullName, repeat = false } = {}) => ({ id: ++lastId, repoId: String(repoId),
  detail: feeLedgerAlertDetail({ market: marketOf(repoId, fullName), reconciliation, observedAt: iso(at), now: at,
    episode: { lagging: reconcileLagging(reconciliation), kind: reconcileKind(reconciliation), repeat, since: iso(since) } }) })
const pass = (repoId, at, code = 'RPC_UNAVAILABLE', transient = true, since = at - 15 * MINUTE) => ({ id: ++lastId, repoId: String(repoId),
  detail: marketPassAlertDetail({ market: marketOf(repoId), code, transient, now: at, episode: { kind: 'unchecked', repeat: false, since: iso(since) } }) })
const platform = (at, since = at - 15 * MINUTE) => ({ id: ++lastId, repoId: null, detail: platformLedgerAlertDetail({ revenue: { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] },
  liquidity: { status: 'MATCH', problems: [] }, episode: { kind: 'difference', repeat: false, since: iso(since) }, now: at }) })
const checks = (at, since = at - 15 * MINUTE) => ({ id: ++lastId, repoId: null, detail: ledgerChecksAlertDetail({ code: 'RPC_UNAVAILABLE', episode: { kind: 'unchecked', repeat: false, since: iso(since) }, now: at }) })

// The delivery job with its store in memory (src/reserve-alerts.mjs digestLedgerAlerts): each run plans from the rows not yet
// in a message and from what the messages so far covered. receiver.down: a message written then is not delivered.
function job() {
  const waiting = [], covered = [], digests = [], expired = [], dropped = [], receiver = { down: false }
  const clear = (rows, at) => { for (const row of rows) row.detail.clearedAt = iso(at) }
  // What the messages written lately covered, as far back as the job asks its store.
  const recent = now => ({ lastAt: digests.at(-1)?.at ?? null, pending: digests.at(-1)?.pending ?? false,
    covered: covered.filter(({ at }) => at >= now - DIGEST_MEMORY_MS).map(({ row }) => ({ ledger: ledgerKey(row), kind: row.detail.kind, cleared: Boolean(row.detail.clearedAt) })) })
  return { waiting, covered, digests, expired, dropped, receiver, clear, add: (...rows) => { waiting.push(...rows) },
    run(now, options = {}) {
      const plan = planLedgerDigest({ rows: [...waiting], recent: recent(now), now, delivery: pendingDelivery(now), ...options })
      const gone = new Set([...plan.expire, ...plan.drop, ...(plan.digest?.covers ?? [])])
      for (let i = waiting.length - 1; i >= 0; i--) if (gone.has(waiting[i].id)) { if (plan.digest?.covers.includes(waiting[i].id)) covered.push({ row: waiting[i], at: now }); waiting.splice(i, 1) }
      expired.push(...plan.expire); dropped.push(...plan.drop)
      if (plan.digest) digests.push({ at: now, pending: receiver.down, ...plan.digest })
      return plan
    } }
}
const minutes = j => j.digests.map(digest => (digest.at - START) / MINUTE)
const nothing = { expire: [], drop: [], digest: null }

test('the planner keeps the times the documentation gives', () => {
  // docs/RESERVE_ALERTS.md, "What is sent": 3 and 10 minutes to gather, an hour between messages with news, six hours
  // between reminders, an hour before trouble that came back is news again, eight hours before a waiting row expires.
  assert.deepEqual([DIGEST_SETTLE_MS, DIGEST_MAX_WAIT_MS, DIGEST_SPACING_MS, DIGEST_REMINDER_MS, DIGEST_RENEW_MS, DIGEST_ROW_MAX_AGE_MS].map(ms => ms / MINUTE), [3, 10, 60, 360, 60, 480])
})

test('ledger rows are recorded for a message of their own, not for delivery one by one', () => {
  for (const row of [fee(7, START), pass(7, START), platform(START), checks(START)]) assert.deepEqual(row.detail.delivery, { status: 'digest', queuedAt: iso(START) })
  assert.deepEqual([fee(7, START), pass(7, START), platform(START), checks(START)].map(ledgerKey), ['fees:7', 'market:7', 'platform', 'checks'])
})

test('one ledger that needs review is sent as itself, a few minutes after it was recorded', () => {
  const j = job(), row = fee(7, START, real)
  j.add(row)
  assert.deepEqual(j.run(START + DIGEST_SETTLE_MS - 1), nothing)
  const at = START + DIGEST_SETTLE_MS, { digest } = j.run(at)
  assert.deepEqual(digest.covers, [row.id])
  const { delivery: _delivery, ...own } = row.detail
  assert.deepEqual(digest.detail, { ledger: 'digest', count: 1, rows: 1, reminder: false, items: [{ ...own, alert: row.id }], since: own.since, observedAt: iso(at), delivery: pendingDelivery(at) })
  // What the operator reads is the ledger's own alert.
  assert.equal(reserveAlertText(31, digest.detail), reserveAlertText(31, row.detail))
  assert.match(reserveAlertText(31, digest.detail), /^repo\.ing · Fee ledger does not match the chain\nlocal\/market-7\nThe ledger shows more fees than the chain holds\.\nSince: .*\nChecked: .*\nhttps:\/\/repo\.ing\/token\/mint7\nAlert #31$/)
  assert.deepEqual(j.waiting, [])
  assert.deepEqual(j.run(at + RUN_MS), nothing, 'nothing is left to send')
})

test('an outage that touches every market is one message, whichever pass each market was recorded in', () => {
  const j = job()
  j.add(...Array.from({ length: 30 }, (_, i) => pass(100 + i, START)))
  assert.equal(j.run(START + MINUTE).digest, null)
  // The rest cross their hold on the next pass.
  const next = START + 80_000
  j.add(...Array.from({ length: 22 }, (_, i) => pass(130 + i, next)))
  assert.equal(j.run(START + DIGEST_SETTLE_MS).digest, null, 'the newest row is not settled yet')
  const { digest } = j.run(next + DIGEST_SETTLE_MS)
  assert.deepEqual([digest.covers.length, digest.detail.count, digest.detail.rows, digest.detail.items.length], [52, 52, 52, DIGEST_NAMED])
  const text = reserveAlertText(40, digest.detail).split('\n')
  assert.equal(text[0], 'repo.ing · 52 ledgers need review')
  assert.deepEqual(text.slice(1, 1 + DIGEST_NAMED), Array.from({ length: DIGEST_NAMED }, (_, i) => `local/market-${100 + i}: Market could not be verified`))
  assert.deepEqual(text.slice(1 + DIGEST_NAMED), ['and 42 more', `Since: ${iso(START - 15 * MINUTE)}`, 'https://repo.ing/operations/graduation', 'Alert #40'])
  assert.equal(j.digests.length, 1)
})

test('rows that keep arriving cannot postpone the message for ever', () => {
  const j = job()
  j.add(fee(1, START))
  for (let at = START + RUN_MS, repo = 2; !j.digests.length; at += RUN_MS, repo++) {
    assert.ok(at <= START + DIGEST_MAX_WAIT_MS, 'sent once the oldest row has waited the limit')
    // Another ledger, a second before every run.
    j.add(fee(repo, at - 1000))
    j.run(at)
  }
  assert.deepEqual(j.digests.map(digest => [digest.at, digest.detail.count]), [[START + DIGEST_MAX_WAIT_MS, 6]])
})

test('a new problem inside the hour waits for the hour, then is sent with everything recorded since', () => {
  const j = job()
  j.add(fee(7, START, behind))
  j.run(START + DIGEST_SETTLE_MS)
  const sent = START + DIGEST_SETTLE_MS
  const later = fee(8, sent + 20 * MINUTE, real), latest = platform(sent + 50 * MINUTE)
  j.add(later)
  assert.equal(j.run(sent + 30 * MINUTE).digest, null)
  j.add(latest)
  assert.equal(j.run(sent + DIGEST_SPACING_MS - 1).digest, null)
  const { digest } = j.run(sent + DIGEST_SPACING_MS)
  assert.deepEqual(digest.covers, [later.id, latest.id])
  assert.deepEqual(digest.detail.items.map(item => item.ledger), ['fees', 'platform'])
  assert.equal(digest.detail.reminder, false)
})

test('trouble that comes and goes all day is one message, then a reminder every six hours while it is still there', () => {
  // Every forty minutes all 52 markets are in trouble for twenty: each is recorded fifteen minutes in and matches again at
  // twenty. A provider that fails on and off, and the same for a real difference that comes and goes.
  for (const row of [(repo, at) => pass(repo, at), (repo, at) => fee(repo, at, real)]) {
    const j = job(), open = []
    for (let at = START + RUN_MS; at <= START + 24 * HOUR; at += RUN_MS) {
      const minute = ((at - START) / MINUTE) % 40
      if (minute === 16) { const rows = Array.from({ length: 52 }, (_, i) => row(100 + i, at - MINUTE)); open.push(...rows); j.add(...rows) }
      if (minute === 20) j.clear(open.splice(0), at)
      j.run(at)
    }
    assert.deepEqual(minutes(j), [18, 378, 738, 1098])
    assert.deepEqual(j.digests.map(digest => [digest.detail.count, digest.detail.reminder]), [[52, false], [52, true], [52, true], [52, true]])
    assert.equal(reserveAlertText(5, j.digests[1].detail).split('\n')[0], 'repo.ing · 52 ledgers still need review')
    // Every time in between it was recorded, cleared before its turn came, and never sent.
    assert.equal(j.dropped.length, (36 - 4) * 52)
    assert.deepEqual([j.expired.length, j.waiting.length], [0, 0])
  }
})

test('a lasting incident that spreads is announced as it spreads, then repeated every six hours, not every hour', () => {
  const j = job()
  // 52 ledgers stop matching seven minutes apart and stay that way. Each is recorded after its hold and again every six hours.
  const recordAt = Array.from({ length: 52 }, (_, i) => START + (i * 7 + 15) * MINUTE)
  for (let at = START + RUN_MS; at <= START + 24 * HOUR; at += RUN_MS) {
    recordAt.forEach((first, i) => {
      for (let period = 0; first + period * 6 * HOUR <= at; period++) {
        const due = first + period * 6 * HOUR
        if (due > at - RUN_MS) j.add(fee(100 + i, due, real, { since: first - 15 * MINUTE, repeat: period > 0 }))
      }
    })
    j.run(at)
  }
  assert.deepEqual(minutes(j), [18, 78, 138, 198, 258, 318, 378, 738, 1098])
  assert.deepEqual(j.digests.map(digest => digest.detail.reminder), [false, false, false, false, false, false, false, true, true])
  assert.equal(j.digests.at(-1).detail.count, 52, 'a reminder names every ledger still open')
  assert.equal(j.expired.length, 0)
})

test('a worker that restarts during a lasting problem does not announce it again each time', () => {
  const j = job()
  // One ledger that does not match. A deploy every ninety minutes starts a new episode, recorded fifteen minutes later.
  for (let at = START + RUN_MS; at <= START + 24 * HOUR; at += RUN_MS) {
    const minute = (at - START) / MINUTE
    if (minute % 90 === 16) j.add(fee(7, at - MINUTE, real, { since: at - 16 * MINUTE }))
    j.run(at)
  }
  assert.deepEqual(minutes(j), [18, 378, 738, 1098])
  assert.deepEqual(j.digests.map(digest => [digest.detail.count, digest.detail.reminder]), [[1, false], [1, true], [1, true], [1, true]])
})

test('trouble that came back after it cleared is announced again once it has lasted an hour, whatever its kind', () => {
  for (const state of [real, unread, behind]) {
    // Announced, cleared an hour in, back at 2 h and recorded at 2 h 15. lasts: for how long it stays that second time.
    const timeline = lasts => {
      const j = job(), first = fee(7, START + 15 * MINUTE, state)
      j.add(first)
      let second = null
      for (let at = START + RUN_MS; at <= START + 5 * HOUR; at += RUN_MS) {
        const minute = (at - START) / MINUTE
        if (minute === 60) j.clear([first], at)
        if (minute === 136) { second = fee(7, at - MINUTE, state, { since: START + 2 * HOUR }); j.add(second) }
        if (second && minute === 120 + lasts) j.clear([second], at)
        j.run(at)
      }
      return minutes(j)
    }
    const label = state.status + String(state.difference ?? '')
    assert.deepEqual(timeline(30), [18], `${label}: gone again inside the hour, never announced`)
    assert.deepEqual(timeline(58), [18], label)
    assert.deepEqual(timeline(400), [18, 120 + DIGEST_RENEW_MS / MINUTE], `${label}: announced when it has lasted the hour`)
  }
})

test('all checks stopping a second time is announced: an earlier, shorter outage does not silence a later, longer one', () => {
  const j = job()
  // The chain cannot be verified from 0:00 to 0:25 (announced), and again from 3:00 to 4:30.
  let first = null, second = null
  for (let at = START + RUN_MS; at <= START + 8 * HOUR; at += RUN_MS) {
    const minute = (at - START) / MINUTE
    if (minute === 16) { first = checks(at - MINUTE, START); j.add(first) }
    if (minute === 26) j.clear([first], at)
    if (minute === 196) { second = checks(at - MINUTE, START + 3 * HOUR); j.add(second) }
    if (minute === 270) j.clear([second], at)
    j.run(at)
  }
  assert.deepEqual(minutes(j), [18, 240], 'the second outage is told one hour in')
  assert.deepEqual(j.digests.map(digest => digest.detail.reminder), [false, false])
})

test('a problem that never cleared is the same problem after a worker restart, however long it has lasted', () => {
  const j = job()
  // Reads fail from 0:00 on and never recover. The worker restarts at 1:30 and records the market again fifteen minutes later.
  j.add(pass(7, START + 15 * MINUTE, 'RPC_UNAVAILABLE', true, START))
  for (let at = START + RUN_MS; at <= START + 7 * HOUR; at += RUN_MS) {
    if ((at - START) / MINUTE === 106) j.add(pass(7, at - MINUTE, 'RPC_UNAVAILABLE', true, START + 90 * MINUTE))
    j.run(at)
  }
  assert.deepEqual(minutes(j), [18, 378], 'not announced again an hour after the restart: its earlier row never cleared')
  assert.deepEqual(j.digests.map(digest => digest.detail.reminder), [false, true])
})

test('trouble whose start cannot be read is told, not held as young', () => {
  const j = job(), first = fee(7, START, unread)
  j.add(first)
  j.run(START + DIGEST_SETTLE_MS)
  j.clear([first], START + 10 * MINUTE)
  const again = fee(7, START + 70 * MINUTE, unread)
  again.detail.since = 'not a time'
  j.add(again)
  assert.deepEqual(j.run(START + 70 * MINUTE + DIGEST_SETTLE_MS).digest.covers, [again.id])
})

test('a reminder that just arrived does not hold back news that has settled', () => {
  const j = job(), news = fee(7, START, real), reminder = fee(8, START + 150_000, real, { repeat: true })
  j.add(news, reminder)
  const { digest } = j.run(START + DIGEST_SETTLE_MS)
  assert.deepEqual([digest.covers, digest.detail.reminder], [[news.id, reminder.id], false])
})

test('trouble that changes kind is news: reads that failed, then a real difference', () => {
  const j = job()
  j.add(fee(7, START, unread))
  j.run(START + DIGEST_SETTLE_MS)
  const found = fee(7, START + 40 * MINUTE, real)
  j.add(found)
  assert.equal(j.run(START + 50 * MINUTE).digest, null, 'inside the hour')
  const { digest } = j.run(START + DIGEST_SETTLE_MS + DIGEST_SPACING_MS)
  assert.deepEqual([digest.covers, digest.detail.reminder, digest.detail.items[0].kind], [[found.id], false, 'difference'])
  // A market's pass failing and its fee ledger not matching are two ledgers, each news once.
  const two = job(), ledger = fee(8, START, real), failing = pass(8, START)
  two.add(ledger, failing)
  assert.deepEqual(two.run(START + DIGEST_SETTLE_MS).digest.detail.items.map(item => item.ledger), ['fees', 'market'])
})

test('one message at a time: while the last one still waits to be sent, nothing new is written', () => {
  const j = job()
  j.receiver.down = true
  j.add(fee(7, START, real))
  j.run(START + DIGEST_SETTLE_MS)
  const later = fee(8, START + 30 * MINUTE, real)
  j.add(later)
  for (let at = START + HOUR; at <= START + 3 * HOUR; at += RUN_MS) j.run(at)
  assert.equal(j.digests.length, 1, 'no second message behind an undelivered one')
  // Delivered (or expired): the next run writes the next one.
  j.digests[0].pending = false
  const { digest } = j.run(START + 3 * HOUR + RUN_MS)
  assert.deepEqual(digest.covers, [later.id])
})

test('a ledger that matched again before its row went out is dropped, not sent', () => {
  const j = job(), cleared = fee(7, START, real), open = fee(8, START + MINUTE, real)
  j.add(cleared, open)
  j.clear([cleared], START + 2 * MINUTE)
  const plan = j.run(START + MINUTE + DIGEST_SETTLE_MS)
  assert.deepEqual([plan.drop, plan.digest.covers, plan.digest.detail.count], [[cleared.id], [open.id], 1])
  // Nothing but cleared rows: they are dropped at once, with no message and no wait.
  const only = job(), gone = fee(9, START, real)
  only.add(gone)
  only.clear([gone], START + MINUTE)
  assert.deepEqual(only.run(START + MINUTE), { expire: [], drop: [gone.id], digest: null })
})

test('a ledger recorded more than once counts once, by its most urgent row and of those the latest', () => {
  const j = job()
  const early = fee(7, START, unread), other = fee(8, START + 30_000, unread), found = fee(7, START + MINUTE, real), after = fee(7, START + 90_000, unread)
  j.add(early, other, found, after)
  const { digest } = j.run(START + 90_000 + DIGEST_SETTLE_MS)
  assert.deepEqual(digest.covers, [early.id, other.id, found.id, after.id])
  assert.deepEqual([digest.detail.count, digest.detail.rows], [2, 4])
  assert.deepEqual(digest.detail.items.map(item => [item.fullName, item.status, item.alert]), [['local/market-7', 'MISMATCH', found.id], ['local/market-8', 'UNAVAILABLE', other.id]])
  // Two rows of the same urgency: the one recorded last.
  const same = job(), first = fee(9, START, unread), second = fee(9, START + MINUTE, { status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' })
  same.add(first, second)
  assert.deepEqual(same.run(START + MINUTE + DIGEST_SETTLE_MS).digest.detail.items.map(item => item.alert), [second.id])
})

test('what needs the operator most is named first: real differences, then the checks, then what normally clears by itself', () => {
  const j = job()
  const rows = [fee(1, START, unread, { since: START - 40 * MINUTE }), fee(2, START, behind, { since: START - 90 * MINUTE }), checks(START, START - 20 * MINUTE),
    fee(3, START, real, { since: START - 16 * MINUTE }), platform(START, START - 30 * MINUTE), pass(4, START, 'CONFIG_OR_POOL_MISMATCH', false, START - 60 * MINUTE),
    fee(5, START, { status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' }, { since: START - 15 * MINUTE }), pass(6, START, 'RPC_RATE_LIMITED', true, START - 50 * MINUTE)]
  j.add(...rows)
  const { digest } = j.run(START + DIGEST_SETTLE_MS)
  assert.deepEqual(reserveAlertText(9, digest.detail).split('\n'), ['repo.ing · 8 ledgers need review',
    'local/market-4: Market verification failed', 'Platform ledger does not match', 'local/market-3: Fee ledger does not match the chain',
    'Ledger checks are not running', 'local/market-2: Fee ledger behind the chain', 'local/market-6: Market could not be verified',
    'local/market-1: Fee ledger could not be checked', 'local/market-5: Builder claim still unresolved',
    `Since: ${iso(START - 90 * MINUTE)}`, 'https://repo.ing/operations/graduation', 'Alert #9'])
  // With more ledgers than a message names, the ones left to the count are the ones that normally clear by themselves.
  const many = job()
  many.add(...Array.from({ length: 14 }, (_, i) => fee(200 + i, START, unread)), fee(300, START, real, { since: START }))
  assert.equal(many.run(START + DIGEST_SETTLE_MS).digest.detail.items[0].fullName, 'local/market-300')
})

test('rows too old to be news are expired, never sent; a row without a readable time never holds the others up', () => {
  const j = job()
  const old = fee(1, START - DIGEST_ROW_MAX_AGE_MS - 1), edge = fee(2, START - DIGEST_ROW_MAX_AGE_MS), unreadable = fee(3, START)
  unreadable.detail.delivery.queuedAt = 'not a time'
  const missing = fee(4, START)
  delete missing.detail.delivery.queuedAt
  j.add(old, edge, unreadable, missing)
  const plan = j.run(START)
  assert.deepEqual(plan.expire, [old.id, unreadable.id, missing.id])
  assert.deepEqual(plan.digest.covers, [edge.id])
  // Nothing but old rows: they expire and no message is written.
  const stale = job()
  stale.add(fee(5, START - 9 * HOUR), fee(6, START - 10 * HOUR))
  assert.deepEqual(stale.run(START), { expire: [lastId - 1, lastId], drop: [], digest: null })
  assert.deepEqual(planLedgerDigest({ rows: [], now: START }), nothing)
  // A reminder that waited its turn for the whole reminder period is still sent.
  assert.ok(DIGEST_ROW_MAX_AGE_MS >= DIGEST_REMINDER_MS + HOUR)
})

test('the message is stored with the delivery the job gives it: unsent when there is no destination', () => {
  const off = { status: 'off', reason: 'DESTINATION_REQUIRED' }
  const j = job(), row = fee(7, START, real)
  j.add(row)
  const { digest } = j.run(START + DIGEST_SETTLE_MS, { delivery: off })
  assert.deepEqual(digest.covers, [row.id])
  assert.deepEqual(digest.detail.delivery, off)
  // It still counts as the last message: the next one keeps its distance.
  j.add(fee(8, START + 10 * MINUTE, real))
  assert.equal(j.run(START + 30 * MINUTE).digest, null)
  assert.notEqual(j.run(START + DIGEST_SETTLE_MS + DIGEST_SPACING_MS).digest, null)
})

test('a message with the longest names still fits every receiver, and goes to a plain receiver as one event', async () => {
  const j = job(), long = `${'o'.repeat(39)}/${'r'.repeat(100)}`
  j.add(...Array.from({ length: 40 }, (_, i) => fee(500 + i, START, real, { fullName: `${long}${i}` })))
  const { digest } = j.run(START + DIGEST_SETTLE_MS), text = reserveAlertText(77, digest.detail)
  // Discord takes 2,000 characters and Telegram 4,096: nothing is cut off the end.
  assert.ok(text.length < 2000, String(text.length))
  assert.match(text, /\nand 30 more\nSince: .*\nhttps:\/\/repo\.ing\/operations\/graduation\nAlert #77$/)
  for (const line of text.split('\n').slice(1, 1 + DIGEST_NAMED)) assert.match(line, /^o{39}\/r+…: Fee ledger does not match the chain$/)
  const events = []
  const send = createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: 'https://example.com/hook' }, fetchImpl: async (_url, options) => { events.push(JSON.parse(options.body)); return { ok: true } } })
  await send({ id: 77, text, detail: digest.detail })
  assert.deepEqual([events[0].event, events[0].id, events[0].market.ledger, events[0].market.count, events[0].market.delivery], ['reconciliation_mismatch', 77, 'digest', 40, undefined])
})

// digestLedgerAlerts (src/reserve-alerts.mjs) with a store in memory: what it asks the store for and what it has it write.
// The store's own SQL runs against PostgreSQL in tests/reserve-alerts-integration.test.mjs.
function memoryStore(rows, recent = { lastAt: null, pending: false, covered: [] }) {
  const calls = []
  return { calls, waiting: async () => { calls.push(['waiting']); return rows }, recent: async since => { calls.push(['recent', since]); return recent },
    commit: async plan => { calls.push(['commit', plan]) } }
}

test('the delivery job plans from the stored rows and the last seven hours of messages, and writes the plan in one commit', async () => {
  const now = START + DIGEST_SETTLE_MS, row = fee(7, START, real), other = fee(6, START, real), old = fee(8, START - DIGEST_ROW_MAX_AGE_MS - MINUTE), gone = fee(9, START, real)
  gone.detail.clearedAt = iso(START + MINUTE)
  const store = memoryStore([row, other, old, gone])
  assert.deepEqual(await digestLedgerAlerts(store, { now, deliver: true }), { digested: 2, expired: 1, cleared: 1 })
  assert.deepEqual(store.calls.map(call => call[0]), ['waiting', 'recent', 'commit'])
  assert.equal(store.calls[1][1], now - DIGEST_MEMORY_MS)
  assert.equal(DIGEST_MEMORY_MS, DIGEST_REMINDER_MS + DIGEST_SPACING_MS)
  const plan = store.calls[2][1]
  assert.deepEqual([plan.expire, plan.drop, plan.digest.covers, plan.digest.detail.delivery], [[old.id], [gone.id], [row.id, other.id], pendingDelivery(now)])
  // Rows that only expired, or were only cleared, are written too, with no message.
  for (const [rows, counts] of [[[old], { digested: 0, expired: 1, cleared: 0 }], [[gone], { digested: 0, expired: 0, cleared: 1 }]]) {
    const tidy = memoryStore(rows)
    assert.deepEqual(await digestLedgerAlerts(tidy, { now, deliver: true }), counts)
    assert.deepEqual([tidy.calls.map(call => call[0]), tidy.calls[2][1].digest], [['waiting', 'recent', 'commit'], null])
  }
  // No destination: the message is written unsent.
  const unsent = memoryStore([fee(7, START, real)])
  await digestLedgerAlerts(unsent, { now, deliver: false })
  assert.deepEqual(unsent.calls[2][1].digest.detail.delivery, { status: 'off', reason: 'DESTINATION_REQUIRED' })
  // The last message is respected: inside the hour nothing is written, and the store is not asked to commit.
  const spaced = memoryStore([fee(7, START, real)], { lastAt: now - DIGEST_SPACING_MS + 1, pending: false, covered: [] })
  assert.deepEqual(await digestLedgerAlerts(spaced, { now, deliver: true }), { digested: 0, expired: 0, cleared: 0 })
  assert.deepEqual(spaced.calls.map(call => call[0]), ['waiting', 'recent'])
  // What a message covered lately makes the same trouble a reminder.
  const told = memoryStore([fee(7, START, unread)], { lastAt: now - 2 * HOUR, pending: false, covered: [{ ledger: 'fees:7', kind: 'unchecked', cleared: true }] })
  assert.equal((await digestLedgerAlerts(told, { now, deliver: true })).digested, 0)
  // Nothing recorded: one read, nothing else.
  const idle = memoryStore([])
  assert.deepEqual(await digestLedgerAlerts(idle, { now, deliver: true }), { digested: 0, expired: 0, cleared: 0 })
  assert.deepEqual(idle.calls, [['waiting']])
  // A store that fails is the caller's to report: nothing is swallowed here.
  await assert.rejects(digestLedgerAlerts({ waiting: async () => [fee(7, START, real)], recent: async () => ({}), commit: async () => { throw Error('LEDGER_DIGEST_CONFLICT') } }, { now, deliver: true }), /LEDGER_DIGEST_CONFLICT/)
})
