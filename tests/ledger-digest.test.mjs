import test from 'node:test'
import assert from 'node:assert/strict'
import { planLedgerDigest, DIGEST_SETTLE_MS, DIGEST_MAX_WAIT_MS, DIGEST_SPACING_MS, DIGEST_NAMED } from '../src/ledger-digest.mjs'
import { reconcileLagging } from '../src/reconcile.mjs'
import { createReserveWebhookSender, feeLedgerAlertDetail, ledgerChecksAlertDetail, pendingDelivery, platformLedgerAlertDetail, reserveAlertText } from '../src/reserve-alerts.mjs'

const START = Date.parse('2026-10-05T08:00:00.000Z'), MAX_AGE_MS = 6 * 3_600_000, RUN_MS = 120_000, MINUTE = 60_000
const iso = at => new Date(at).toISOString()
const marketOf = (id, fullName = `local/market-${id}`) => ({ githubRepoId: String(id), mint: `mint${id}`, pool: `pool${id}`, fullName })
const unread = { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }, real = { status: 'MISMATCH', difference: -5n }, behind = { status: 'MISMATCH', difference: 5n }

// Rows as the monitor records them (src/ledger-alerts.mjs), in the order of their ids.
let lastId = 0
const fee = (repoId, at, reconciliation = unread, { since = at - 15 * MINUTE, fullName } = {}) => ({ id: ++lastId, repoId: String(repoId),
  detail: feeLedgerAlertDetail({ market: marketOf(repoId, fullName), reconciliation, episode: { lagging: reconcileLagging(reconciliation), since: iso(since) }, observedAt: iso(at), now: at }) })
const platform = (at, since = at - 15 * MINUTE) => ({ id: ++lastId, repoId: null, detail: platformLedgerAlertDetail({ revenue: { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] },
  liquidity: { status: 'MATCH', problems: [] }, episode: { since: iso(since) }, now: at }) })
const checks = (at, since = at - 15 * MINUTE) => ({ id: ++lastId, repoId: null, detail: ledgerChecksAlertDetail({ code: 'RPC_UNAVAILABLE', episode: { since: iso(since) }, now: at }) })

// The delivery job (src/reserve-alerts.mjs): each run plans from the rows not yet in a message and the time of the last message.
function job(options = {}) {
  const waiting = [], digests = [], expired = []
  return { waiting, digests, expired, add: (...rows) => { waiting.push(...rows) },
    run(now) {
      const plan = planLedgerDigest({ rows: [...waiting], lastDigestAt: digests.at(-1)?.at ?? null, now, maxAgeMs: MAX_AGE_MS, delivery: pendingDelivery(now), ...options })
      const gone = new Set([...plan.expire, ...(plan.digest?.covers ?? [])])
      for (let i = waiting.length - 1; i >= 0; i--) if (gone.has(waiting[i].id)) waiting.splice(i, 1)
      expired.push(...plan.expire)
      if (plan.digest) digests.push({ at: now, ...plan.digest })
      return plan
    } }
}

test('ledger rows are recorded for a message of their own, not for delivery one by one', () => {
  for (const row of [fee(7, START), platform(START), checks(START)]) assert.deepEqual(row.detail.delivery, { status: 'digest', queuedAt: iso(START) })
})

test('one ledger that needs review is sent as itself, a few minutes after it was recorded', () => {
  const j = job(), row = fee(7, START, real)
  j.add(row)
  assert.deepEqual(j.run(START + DIGEST_SETTLE_MS - 1), { expire: [], digest: null })
  const at = START + DIGEST_SETTLE_MS, { digest } = j.run(at)
  assert.deepEqual(digest.covers, [row.id])
  const { delivery: _delivery, ...own } = row.detail
  assert.deepEqual(digest.detail, { ledger: 'digest', count: 1, rows: 1, items: [{ ...own, alert: row.id }], since: own.since, observedAt: iso(at), delivery: pendingDelivery(at) })
  // What the operator reads is the ledger's own alert.
  assert.equal(reserveAlertText(31, digest.detail), reserveAlertText(31, row.detail))
  assert.match(reserveAlertText(31, digest.detail), /^repo\.ing · Fee ledger does not match the chain\nlocal\/market-7\nThe ledger shows more fees than the chain holds\.\nSince: .*\nChecked: .*\nhttps:\/\/repo\.ing\/token\/mint7\nAlert #31$/)
  assert.deepEqual(j.waiting, [])
  assert.deepEqual(j.run(at + RUN_MS), { expire: [], digest: null }, 'nothing is left to send')
})

test('an outage that touches every market is one message, whichever pass each market was recorded in', () => {
  const j = job()
  j.add(...Array.from({ length: 30 }, (_, i) => fee(100 + i, START)))
  assert.equal(j.run(START + MINUTE).digest, null)
  // The rest cross their hold on the next pass.
  const next = START + 80_000
  j.add(...Array.from({ length: 22 }, (_, i) => fee(130 + i, next)))
  assert.equal(j.run(START + DIGEST_SETTLE_MS).digest, null, 'the newest row is not settled yet')
  const { digest } = j.run(next + DIGEST_SETTLE_MS)
  assert.deepEqual([digest.covers.length, digest.detail.count, digest.detail.rows, digest.detail.items.length], [52, 52, 52, DIGEST_NAMED])
  const text = reserveAlertText(40, digest.detail).split('\n')
  assert.equal(text[0], 'repo.ing · 52 ledgers need review')
  assert.deepEqual(text.slice(1, 1 + DIGEST_NAMED), Array.from({ length: DIGEST_NAMED }, (_, i) => `local/market-${100 + i}: Fee ledger could not be checked`))
  assert.deepEqual(text.slice(1 + DIGEST_NAMED), ['and 42 more', `Since: ${iso(START - 15 * MINUTE)}`, `Checked: ${iso(next + DIGEST_SETTLE_MS)}`, 'https://repo.ing/operations/graduation', 'Alert #40'])
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

test('at most one ledger message an hour, however the ledgers flap', () => {
  const j = job(), until = START + 3 * 3_600_000
  // A flaky provider for three hours: every ledger fails long enough to be recorded, matches once, and is recorded again
  // sixteen minutes later.
  for (let at = START + RUN_MS, batch = START; at <= until; at += RUN_MS) {
    for (; batch <= at; batch += 16 * MINUTE) j.add(...Array.from({ length: 52 }, (_, i) => fee(100 + i, batch)))
    j.run(at)
  }
  assert.deepEqual(j.digests.map(digest => (digest.at - START) / MINUTE), [4, 64, 124])
  for (let i = 1; i < j.digests.length; i++) assert.ok(j.digests[i].at - j.digests[i - 1].at >= DIGEST_SPACING_MS)
  // Each says how many ledgers, not how many times they were recorded.
  assert.deepEqual(j.digests.map(digest => [digest.detail.count, digest.detail.rows]), [[52, 52], [52, 208], [52, 156]])
  assert.deepEqual(j.expired, [])
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
})

test('a ledger recorded more than once counts once, with its latest state', () => {
  const j = job()
  const early = fee(7, START, unread), other = fee(8, START + 30_000, unread), late = fee(7, START + MINUTE, real)
  j.add(early, other, late)
  const { digest } = j.run(START + MINUTE + DIGEST_SETTLE_MS)
  assert.deepEqual(digest.covers, [early.id, other.id, late.id])
  assert.deepEqual([digest.detail.count, digest.detail.rows], [2, 3])
  assert.deepEqual(digest.detail.items.map(item => [item.fullName, item.status, item.alert]), [['local/market-7', 'MISMATCH', late.id], ['local/market-8', 'UNAVAILABLE', other.id]])
})

test('what needs the operator most is named first: real differences, then the checks, then what normally clears by itself', () => {
  const j = job()
  const rows = [fee(1, START, unread, { since: START - 40 * MINUTE }), fee(2, START, behind, { since: START - 90 * MINUTE }), checks(START, START - 20 * MINUTE),
    fee(3, START, real, { since: START - 16 * MINUTE }), platform(START, START - 30 * MINUTE), fee(4, START, { status: 'ERROR', reason: 'CONFIG_OR_POOL_MISMATCH' }, { since: START - 60 * MINUTE }),
    fee(5, START, { status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' }, { since: START - 15 * MINUTE })]
  j.add(...rows)
  const { digest } = j.run(START + DIGEST_SETTLE_MS)
  assert.deepEqual(reserveAlertText(9, digest.detail).split('\n'), ['repo.ing · 7 ledgers need review',
    'local/market-4: Fee ledger could not be reconciled', 'Platform ledger does not match', 'local/market-3: Fee ledger does not match the chain',
    'Ledger checks are not running', 'local/market-2: Fee ledger behind the chain', 'local/market-1: Fee ledger could not be checked', 'local/market-5: Builder claim still unresolved',
    `Since: ${iso(START - 90 * MINUTE)}`, `Checked: ${iso(START + DIGEST_SETTLE_MS)}`, 'https://repo.ing/operations/graduation', 'Alert #9'])
  // With more ledgers than a message names, the ones left to the count are the ones that normally clear by themselves.
  const many = job()
  many.add(...Array.from({ length: 14 }, (_, i) => fee(200 + i, START, unread)), fee(300, START, real, { since: START }))
  assert.equal(many.run(START + DIGEST_SETTLE_MS).digest.detail.items[0].fullName, 'local/market-300')
})

test('rows too old to be news are expired, never sent; a row without a readable time never holds the others up', () => {
  const j = job()
  const old = fee(1, START - MAX_AGE_MS - 1), edge = fee(2, START - MAX_AGE_MS), unreadable = fee(3, START)
  unreadable.detail.delivery.queuedAt = 'not a time'
  const missing = fee(4, START)
  delete missing.detail.delivery.queuedAt
  j.add(old, edge, unreadable, missing)
  const plan = j.run(START)
  assert.deepEqual(plan.expire, [old.id, unreadable.id, missing.id])
  assert.deepEqual(plan.digest.covers, [edge.id])
  // Nothing but old rows: they expire and no message is written.
  const stale = job()
  stale.add(fee(5, START - 7 * 3_600_000), fee(6, START - 8 * 3_600_000))
  assert.deepEqual(stale.run(START), { expire: [lastId - 1, lastId], digest: null })
  assert.deepEqual(planLedgerDigest({ rows: [], lastDigestAt: null, now: START, maxAgeMs: MAX_AGE_MS }), { expire: [], digest: null })
})

test('the message is stored with the delivery the job gives it: unsent when there is no destination', () => {
  const off = { status: 'off', reason: 'DESTINATION_REQUIRED' }
  const j = job({ delivery: off }), row = fee(7, START, real)
  j.add(row)
  const { digest } = j.run(START + DIGEST_SETTLE_MS)
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
  assert.match(text, /\nand 30 more\nSince: .*\nChecked: .*\nhttps:\/\/repo\.ing\/operations\/graduation\nAlert #77$/)
  for (const line of text.split('\n').slice(1, 1 + DIGEST_NAMED)) assert.match(line, /^o{39}\/r+…: Fee ledger does not match the chain$/)
  const events = []
  const send = createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: 'https://example.com/hook' }, fetchImpl: async (_url, options) => { events.push(JSON.parse(options.body)); return { ok: true } } })
  await send({ id: 77, text, detail: digest.detail })
  assert.deepEqual([events[0].event, events[0].id, events[0].market.ledger, events[0].market.count, events[0].market.delivery], ['reconciliation_mismatch', 77, 'digest', 40, undefined])
})
