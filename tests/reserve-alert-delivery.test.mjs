import test from 'node:test'
import assert from 'node:assert/strict'
import { createReserveAlertDelivery, pendingDelivery } from '../src/reserve-alerts.mjs'

// The delivery job's own logic, with the alert queue's table replaced by a stand-in that answers the job's statements by
// their tags (src/reserve-alerts.mjs). The statements themselves run against PostgreSQL in
// tests/reserve-alerts-integration.test.mjs, which is not part of the checks required before a merge; this file is.
const START = Date.parse('2026-10-05T08:00:00.000Z'), RUN_MS = 120_000, MINUTE = 60_000, HOUR = 3_600_000
const iso = at => new Date(at).toISOString()
const SENT_KINDS = ['RESERVE_MOVED', 'OPS_WALLET_LOW', 'RECONCILIATION_MISMATCH']

function queue() {
  const clock = { at: START }, rows = [], released = [], fault = { on: null }, lock = { holder: null }
  const waiting = row => SENT_KINDS.includes(row.kind) && ['pending', 'retry'].includes(row.detail.delivery?.status)
  const mark = (hit, change) => { for (const row of hit) Object.assign(row.detail.delivery, change); return { rows: hit.map(({ id }) => ({ id })) } }
  const connect = async () => {
    const client = {
      async query(sql, params = []) {
        const tag = /^\/\* alert-queue:(\w+) \*\//.exec(sql)?.[1]
        if (fault.on?.(tag)) throw Object.assign(Error('terminating connection due to administrator command'), { code: '57P01' })
        if (tag === 'lock') { if (lock.holder && lock.holder !== client) return { rows: [{ locked: false }] }; lock.holder = client; return { rows: [{ locked: true }] } }
        if (tag === 'unlock') { if (lock.holder === client) lock.holder = null; return { rows: [] } }
        if (tag === 'silence') return mark(rows.filter(row => row.kind === 'RESERVE_MOVED' && waiting(row)), { status: 'off', error: 'RESERVE_NOTIFICATIONS_OFF' })
        if (tag === 'expire') return mark(rows.filter(row => waiting(row) && Date.parse(row.detail.observedAt) < params[0].getTime()), { status: 'expired', error: 'ALERT_TOO_OLD' })
        // Due by this stand-in's clock, which is the job's.
        if (tag === 'due') return { rows: rows.filter(row => waiting(row) && Date.parse(row.detail.delivery.nextAttemptAt) <= clock.at).slice(0, 5).map(row => ({ id: row.id, detail: JSON.stringify(row.detail) })) }
        if (tag === 'save') { rows.find(row => row.id === params[0]).detail.delivery = JSON.parse(params[1]); return { rows: [] } }
        throw Error(`a statement this stand-in does not know: ${sql.slice(0, 50)}`)
      },
      release(broken) { released.push(Boolean(broken)) },
    }
    return client
  }
  const add = (kind, detail) => { rows.push({ id: rows.length + 1, kind, detail: structuredClone({ observedAt: iso(clock.at), delivery: pendingDelivery(clock.at), ...detail }) }); return rows.length }
  const wallet = role => add('OPS_WALLET_LOW', { role, minimumLamports: '30000000', balanceLamports: '1000' })
  return { clock, rows, released, fault, lock, add, wallet, pool: { connect }, delivery: id => rows.find(row => row.id === id).detail.delivery }
}
// A destination that answers, or refuses with the sender's code (src/reserve-alerts.mjs createReserveWebhookSender).
function receiver() {
  const got = [], state = { refuse: null }
  const send = async message => { if (state.refuse) throw state.refuse; got.push(message); return { accepted: true } }
  return { got, state, send }
}
const refusal = code => Object.assign(Error('NOTIFICATION_SEND_FAILED'), { code })
const nothingPlanned = async () => ({ digested: 0, expired: 0, cleared: 0 })

test('with no destination the ledger messages are still planned, nothing is sent, and the lock is given back', async () => {
  const q = queue(), asked = []
  q.wallet('Builder payout signer')
  const job = createReserveAlertDelivery({ pool: q.pool, now: () => q.clock.at, digest: async (db, options) => { asked.push(options); return { digested: 2, expired: 1, cleared: 0 } } })
  assert.deepEqual(await job.runOnce(), { status: 'DESTINATION_REQUIRED', sent: 0, expired: 1, digested: 2 })
  assert.deepEqual(asked, [{ now: START, deliver: false }])
  assert.deepEqual([q.delivery(1).status, q.lock.holder, q.released], ['pending', null, [false]], 'the queued alert waits for a destination')
  // With one, the same step is told to have its message sent, and what it expired is counted with the rest.
  const r = receiver()
  const run = await createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, digest: async (db, options) => { asked.push(options); return { digested: 4, expired: 3, cleared: 2 } } }).runOnce()
  assert.deepEqual(asked.at(-1), { now: START, deliver: true })
  assert.deepEqual(run, { status: 'OK', sent: 1, expired: 3, silenced: 0, digested: 4, results: [{ id: 1, status: 'sent' }] })
})

test('a job that finds the delivery lock taken does nothing, and leaves the lock with its holder', async () => {
  const q = queue(), r = receiver(), planned = []
  q.wallet('Builder payout signer')
  const holder = await q.pool.connect()
  await holder.query("/* alert-queue:lock */ select 1")
  const job = createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, digest: async () => { planned.push(1); return nothingPlanned() } })
  assert.deepEqual(await job.runOnce(), { status: 'BUSY', sent: 0 })
  assert.deepEqual([planned, r.got, q.lock.holder === holder, q.released], [[], [], true, [false]])
})

test('an alert the receiver refuses is tried again, with a growing pause, until it is six hours old; why is kept by code', async () => {
  const q = queue(), r = receiver()
  const id = q.wallet('Builder payout signer')
  const job = createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, digest: nothingPlanned })
  r.state.refuse = refusal('HTTP_503')
  const first = await job.runOnce()
  assert.deepEqual([first.status, first.sent, first.results], ['DELIVERY_REVIEW', 0, [{ id, status: 'retry', error: 'HTTP_503' }]])
  assert.deepEqual(q.delivery(id), { status: 'retry', attempts: 1, nextAttemptAt: iso(START + 30_000), error: 'NOTIFICATION_SEND_FAILED', errorCode: 'HTTP_503' })
  // A run every two minutes for six hours: never given up on, and the pause grows to fifteen minutes and no further.
  const pauses = []
  for (q.clock.at = START + RUN_MS; q.clock.at <= START + 6 * HOUR; q.clock.at += RUN_MS) {
    const before = q.delivery(id).attempts
    const run = await job.runOnce()
    if (q.delivery(id).attempts > before) { pauses.push(Date.parse(q.delivery(id).nextAttemptAt) - q.clock.at); assert.equal(run.status, 'DELIVERY_REVIEW') }
    else assert.deepEqual(run, { status: 'OK', sent: 0, expired: 0, silenced: 0, digested: 0, results: [] }, 'a run between two attempts has nothing to say')
  }
  assert.deepEqual(pauses.slice(0, 6), [60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
  assert.ok(q.delivery(id).attempts > 20 && q.delivery(id).status === 'retry', `${q.delivery(id).attempts} attempts, still trying`)
  // Six hours old: it expires, and the run that gives it up says so.
  q.clock.at = START + 6 * HOUR + 1
  const last = await job.runOnce()
  assert.deepEqual([last.status, last.sent, last.expired, last.results], ['DELIVERY_REVIEW', 0, 1, [{ id, status: 'expired' }]])
  assert.deepEqual([q.delivery(id).status, q.delivery(id).error, r.got.length], ['expired', 'ALERT_TOO_OLD', 0])
  // A failure with no code of the sender's is kept as UNKNOWN, never as its own words.
  for (const failure of [Error('getaddrinfo ENOTFOUND hooks.example/secret-token'), Object.assign(Error('x'), { code: 'not a code: https://hooks.example/secret' }), 'a string']) {
    const other = queue(), wallet = other.wallet('Fee collection signer')
    const run = await createReserveAlertDelivery({ pool: other.pool, send: async () => { throw failure }, now: () => other.clock.at, digest: nothingPlanned }).runOnce()
    assert.deepEqual([run.results, other.delivery(wallet).errorCode], [[{ id: wallet, status: 'retry', error: 'UNKNOWN' }], 'UNKNOWN'])
  }
})

test('an alert that goes out keeps its receipt and drops the code of its earlier failure', async () => {
  const q = queue(), r = receiver()
  const id = q.wallet('Builder payout signer')
  const job = createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, digest: nothingPlanned })
  r.state.refuse = refusal('TIMEOUT')
  await job.runOnce()
  r.state.refuse = null
  q.clock.at += RUN_MS
  assert.deepEqual(await job.runOnce(), { status: 'OK', sent: 1, expired: 0, silenced: 0, digested: 0, results: [{ id, status: 'sent' }] })
  assert.deepEqual(q.delivery(id), { status: 'sent', attempts: 2, nextAttemptAt: iso(START + 30_000), error: null, errorCode: null, sentAt: iso(START + RUN_MS), receipt: { accepted: true } })
  assert.match(r.got[0].text, /^repo\.ing · Low operating balance\nBuilder payout signer\n/)
  assert.deepEqual([r.got[0].id, r.got[0].detail.role], [id, 'Builder payout signer'])
})

test('an alert whose text cannot be made fails at once, with no attempt at the receiver, and the alert behind it goes out', async () => {
  const q = queue(), r = receiver()
  const broken = q.add('RESERVE_MOVED', { deltaLamports: 'not a number' }), behind = q.wallet('Fee collection signer')
  const run = await createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, reserveMoves: true, digest: nothingPlanned }).runOnce()
  assert.deepEqual([run.status, run.sent, run.results], ['DELIVERY_REVIEW', 1, [{ id: broken, status: 'failed', error: 'RENDER_FAILED' }, { id: behind, status: 'sent' }]])
  assert.deepEqual([q.delivery(broken).status, q.delivery(broken).error, q.delivery(broken).attempts, r.got.map(message => message.id)], ['failed', 'RENDER_FAILED', 0, [behind]])
  // It is not picked up again.
  q.clock.at += RUN_MS
  assert.deepEqual((await createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, reserveMoves: true, digest: nothingPlanned }).runOnce()).results, [])
})

test('reserve moves that are still queued are marked off, not sent, unless their notifications are on', async () => {
  const move = { fullName: 'local/reserve', phase: 'CURVE', previousReserveLamports: '100000000', reserveLamports: '150000000', deltaLamports: '50000000', thresholdLamports: '85000000000',
    progressPercent: 0.17, previousObservedAt: iso(START - MINUTE), url: 'https://repo.ing/token/mint' }
  const q = queue(), r = receiver()
  const moved = q.add('RESERVE_MOVED', move), low = q.wallet('Builder payout signer')
  const run = await createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, digest: nothingPlanned }).runOnce()
  assert.deepEqual([run.status, run.sent, run.silenced, r.got.map(message => message.id)], ['OK', 1, 1, [low]])
  assert.deepEqual([q.delivery(moved).status, q.delivery(moved).error], ['off', 'RESERVE_NOTIFICATIONS_OFF'])
  const on = queue(), sent = receiver()
  const kept = on.add('RESERVE_MOVED', move)
  const second = await createReserveAlertDelivery({ pool: on.pool, send: sent.send, now: () => on.clock.at, reserveMoves: true, digest: nothingPlanned }).runOnce()
  assert.deepEqual([second.sent, second.silenced, on.delivery(kept).status], [1, 0, 'sent'])
  assert.match(sent.got[0].text, /^repo\.ing · Curve reserve up\nlocal\/reserve\n/)
})

test('planning that fails is reported by code and never stops the queue; when it keeps failing the queue says so itself, once per six hours', async () => {
  const q = queue(), r = receiver()
  const plan = { fail: Object.assign(Error('relation "graduation_alerts" does not exist'), { code: '42P01' }) }
  const job = createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, digest: async () => { if (plan.fail) throw plan.fail; return nothingPlanned() } })
  // The alert queued beside the failing plan still goes out, on the first failed run.
  const low = q.wallet('Builder payout signer')
  const first = await job.runOnce()
  assert.deepEqual([first.status, first.sent, first.digested, first.digestError, r.got.map(message => message.id)], ['DELIVERY_REVIEW', 1, 0, '42P01', [low]])
  // Two failed runs are not yet worth a message; the third is. Then one every six hours for as long as it fails.
  const notices = () => r.got.filter(message => message.detail.ledger === 'queue')
  q.clock.at += RUN_MS
  await job.runOnce()
  assert.deepEqual(notices(), [])
  for (q.clock.at += RUN_MS; q.clock.at <= START + 13 * HOUR; q.clock.at += RUN_MS) assert.deepEqual((await job.runOnce()).digestError, '42P01')
  assert.deepEqual(notices().map(notice => (Date.parse(notice.detail.observedAt) - START) / MINUTE), [4, 364, 724])
  assert.equal(notices()[0].text, `repo.ing · Ledger messages cannot be written\nThe alert queue could not plan them 3 runs in a row (42P01).\nLedgers that need review are still listed on the operations page, and are not sent while this lasts.\nChecked: ${iso(START + 4 * MINUTE)}\nhttps://repo.ing/operations/graduation`)
  assert.equal(new Set(notices().map(notice => notice.id)).size, 3, 'each notice is its own message to a receiver that drops repeats')
  assert.doesNotMatch(JSON.stringify(notices()), /relation|does not exist/)
  // A run that plans again starts the count over: two more failures say nothing, the third does (the last notice is old enough).
  plan.fail = null
  q.clock.at = START + 20 * HOUR
  assert.deepEqual(await job.runOnce(), { status: 'OK', sent: 0, expired: 0, silenced: 0, digested: 0, results: [] })
  plan.fail = Error('no code at all')
  for (let run = 1; run <= 3; run++) { q.clock.at += RUN_MS; assert.equal((await job.runOnce()).digestError, 'UNKNOWN'); assert.equal(notices().length, run < 3 ? 3 : 4) }
  // A notice the receiver refuses is tried again by the next failed run, not dropped.
  const deaf = queue(), mute = receiver()
  mute.state.refuse = refusal('HTTP_500')
  const failing = createReserveAlertDelivery({ pool: deaf.pool, send: mute.send, now: () => deaf.clock.at, digest: async () => { throw plan.fail } })
  for (let run = 0; run < 4; run++) { await failing.runOnce(); deaf.clock.at += RUN_MS }
  mute.state.refuse = null
  await failing.runOnce()
  assert.equal(mute.got.length, 1)
  // With no destination there is nowhere to say it: the run's result still does.
  const silent = queue()
  const unsent = createReserveAlertDelivery({ pool: silent.pool, now: () => silent.clock.at, digest: async () => { throw plan.fail } })
  for (let run = 0; run < 4; run++) assert.deepEqual(await unsent.runOnce(), { status: 'DESTINATION_REQUIRED', sent: 0, expired: 0, digested: 0, digestError: 'UNKNOWN' })
})

test('the delivery lock is given back when a run fails, and a lock that cannot be given back costs the connection', async () => {
  const q = queue(), r = receiver()
  q.wallet('Builder payout signer')
  const job = createReserveAlertDelivery({ pool: q.pool, send: r.send, now: () => q.clock.at, digest: nothingPlanned })
  q.fault.on = tag => tag === 'due'
  await assert.rejects(job.runOnce(), { code: '57P01' })
  assert.deepEqual([q.lock.holder, q.released], [null, [false]])
  q.released.length = 0
  q.fault.on = tag => tag === 'unlock'
  await assert.rejects(job.runOnce(), { code: '57P01' })
  assert.deepEqual(q.released, [true], 'released as broken, so it cannot go back to the pool still holding the lock')
  // The lock itself failing: nothing was locked, so nothing is unlocked.
  q.released.length = 0
  const asked = []
  q.fault.on = tag => { asked.push(tag); return tag === 'lock' }
  await assert.rejects(job.runOnce(), { code: '57P01' })
  assert.deepEqual([asked, q.released], [['lock'], [false]])
})
