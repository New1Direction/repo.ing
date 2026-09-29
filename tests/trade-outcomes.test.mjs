import test from 'node:test'
import assert from 'node:assert/strict'
import { TRADE_LANDING_DEGRADED, checkTradeLandingAlert, landingAlertDecision, outcomeRow, recordTradeOutcome, scrubError,
  tradeOutcomeSummary } from '../src/trade-outcomes.mjs'
import { statusOutcome, submitOutcome, trackTradeOutcome } from '../app/lib/trade-tracking.mjs'

const prepared = { githubRepoId: 1250482335n, mint: 'RCATmint111111111111111111111111111111111', direction: 'buy', amountIn: 10_000_000n,
  priorityFee: { computeUnitLimit: 120_000, microLamports: 300_000, lamports: '36000' } }

// Records every query; answers from `rows` (a function of the SQL) and reports one inserted row.
function fakeDb(rows = () => [], { rowCount = 1, fail = null } = {}) {
  const queries = []
  return { queries, query: async (sql, params = []) => {
    queries.push({ sql, params })
    if (fail) throw fail
    return { rows: rows(sql, params), rowCount: /^\s*insert/i.test(sql) ? rowCount : 0 }
  } }
}

test('an outcome row keeps market, phase, direction, amount, priority fee and timings, and never a wallet', () => {
  const row = outcomeRow({ attemptKey: 'a1', outcome: 'submitted', prepared: { ...prepared, wallet: 'SECRETWALLET' }, signature: 's',
    prepareToSignMs: 1234, signToConfirmMs: -1 })
  assert.deepEqual(row, { attemptKey: 'a1', outcome: 'submitted', githubRepoId: '1250482335', mint: prepared.mint, phase: 'curve',
    direction: 'buy', amountIn: '10000000', priorityFeeLamports: '36000', cuPrice: '300000', cuLimit: 120_000, signature: 's', error: null,
    prepareToSignMs: 1234, signToConfirmMs: null })
  assert.ok(!JSON.stringify(row).includes('SECRETWALLET'))
  assert.equal(outcomeRow({ attemptKey: 'sig:x', outcome: 'expired' }).phase, null)
  assert.equal(outcomeRow({ attemptKey: 'a', outcome: 'confirmed', prepared: { ...prepared, phase: 'graduated' } }).phase, 'graduated')
  assert.throws(() => outcomeRow({ attemptKey: 'a', outcome: 'lost' }), /Unknown trade outcome/)
  assert.throws(() => outcomeRow({ attemptKey: '', outcome: 'failed' }), /attempt key/)
})

test('stored error text never carries an RPC URL or API key', () => {
  assert.equal(scrubError(Error('failed to get info: request to https://mainnet.helius-rpc.com/?api-key=abc123 failed')),
    'failed to get info: request to <url> failed')
  assert.equal(scrubError('bad api_key=zzz here'), 'bad api-key=<redacted> here')
  assert.equal(scrubError(null), null)
  assert.equal(scrubError('x'.repeat(900)).length, 500)
})

test('recording inserts once per attempt and outcome', async () => {
  const db = fakeDb()
  assert.equal(await recordTradeOutcome(db, { attemptKey: 'a1', outcome: 'expired', prepared, signature: 's', error: Error('Trade failed: x') }), true)
  assert.match(db.queries[0].sql, /on conflict\(attempt_key,outcome\) do nothing/)
  assert.deepEqual(db.queries[0].params.slice(0, 3), ['a1', 'expired', '1250482335'])
  assert.equal(db.queries[0].params[11], 'Trade failed: x')
  assert.equal(await recordTradeOutcome(fakeDb(() => [], { rowCount: 0 }), { attemptKey: 'a1', outcome: 'expired' }), false)
})

test('alert thresholds: 3+ lost in the hour, or under 90% success over 5+ settled attempts', () => {
  assert.equal(landingAlertDecision({ confirmed: 20, expired: 2 }).degraded, false)
  assert.equal(landingAlertDecision({ confirmed: 50, expired: 2, failed: 1 }).degraded, true)
  assert.equal(landingAlertDecision({ confirmed: 4, verificationFailed: 1 }).degraded, true)
  assert.equal(landingAlertDecision({ confirmed: 3, verificationFailed: 1 }).degraded, false)
  assert.equal(landingAlertDecision({ confirmed: 9, expired: 1 }).degraded, false)
  assert.equal(landingAlertDecision({ confirmed: 8, expired: 1, verificationFailed: 1 }).degraded, true)
  assert.deepEqual(landingAlertDecision({}), { degraded: false, attempts: 0, lost: 0, successRate: null })
})

test('a degraded hour writes one deduplicated graduation alert keyed by the UTC hour', async () => {
  const now = () => Date.parse('2026-09-29T14:37:00Z')
  const db = fakeDb(sql => /select terminal/.test(sql) ? [{ terminal: 'confirmed', count: 7 }, { terminal: 'expired', count: 3 }] : [])
  const result = await checkTradeLandingAlert(db, { now })
  assert.equal(result.alerted, true); assert.equal(result.attempts, 10)
  assert.deepEqual(db.queries[0].params, [new Date('2026-09-29T13:37:00Z')])
  const insert = db.queries[1]
  assert.match(insert.sql, /insert into graduation_alerts.*on conflict\(event_key\) do nothing/s)
  assert.deepEqual(insert.params.slice(0, 2), ['trade-landing:2026-09-29T14', TRADE_LANDING_DEGRADED])
  assert.equal(JSON.parse(insert.params[2]).expired, 3)
  const healthy = fakeDb(() => [{ terminal: 'confirmed', count: 12 }])
  assert.equal((await checkTradeLandingAlert(healthy, { now })).alerted, false)
  assert.equal(healthy.queries.length, 1)
})

test('route glue records each outcome once per session, checks alerts only for lost outcomes, and never throws', async () => {
  const db = fakeDb(() => [{ terminal: 'expired', count: 3 }]), session = {}
  assert.equal(await trackTradeOutcome(db, { attemptKey: 'a', outcome: 'submitted', prepared }, { session }), true)
  assert.equal(db.queries.length, 1)
  assert.equal(await trackTradeOutcome(db, { attemptKey: 'a', outcome: 'submitted', prepared }, { session }), false)
  assert.equal(db.queries.length, 1)
  await trackTradeOutcome(db, { attemptKey: 'a', outcome: 'expired', prepared }, { session })
  assert.ok(db.queries.some(q => /graduation_alerts/.test(q.sql)))
  const logs = []
  const broken = fakeDb(() => [], { fail: Object.assign(Error('connect ECONNREFUSED postgres://user:pw@db/x'), { code: 'ECONNREFUSED' }) })
  assert.equal(await trackTradeOutcome(broken, { attemptKey: 'b', outcome: 'failed' }, { log: (...args) => logs.push(args) }), false)
  assert.deepEqual(logs, [['trade outcome recording failed', 'ECONNREFUSED']])
  assert.equal(await trackTradeOutcome(null, { attemptKey: 'c', outcome: 'failed' }), false)
})

test('status and submit results map to outcomes; transient chainConfirmed is not a verification failure while polling', () => {
  assert.equal(statusOutcome('confirmed', { hasSession: true }), 'confirmed')
  assert.equal(statusOutcome('chainConfirmed', { hasSession: true }), null)
  assert.equal(statusOutcome('chainConfirmed', { hasSession: false }), 'confirmed')
  assert.equal(statusOutcome('expired', { hasSession: false }), 'expired')
  assert.equal(statusOutcome('pending', { hasSession: true }), null)
  assert.equal(submitOutcome('chainConfirmed'), 'verification_failed')
  assert.equal(submitOutcome('failed'), 'failed')
  assert.equal(submitOutcome('pending'), null)
})

test('the 24h summary counts outcomes, best outcome per attempt, confirm-time percentiles and recent failures', async () => {
  const db = fakeDb(sql => {
    if (/group by outcome/.test(sql)) return [{ outcome: 'prepared', count: 12 }, { outcome: 'submitted', count: 10 }, { outcome: 'confirmed', count: 8 }, { outcome: 'expired', count: 2 }]
    if (/select terminal/.test(sql)) return [{ terminal: 'confirmed', count: 8 }, { terminal: 'expired', count: 2 }]
    if (/sign_to_confirm_ms as ms/.test(sql)) return [1000, 2000, 3000, 4000, 5000, 6000, 7000, 30000].map(ms => ({ ms }))
    return [{ outcome: 'expired', mint: prepared.mint, phase: 'curve', direction: 'buy', signature: 's', error: 'expired', priorityFeeLamports: '36000', createdAt: new Date('2026-09-29T00:00:00Z') }]
  })
  const summary = await tradeOutcomeSummary(db)
  assert.deepEqual(summary.counts, { prepared: 12, submitted: 10, confirmed: 8, expired: 2, failed: 0, verification_failed: 0 })
  assert.equal(summary.attempts, 10); assert.equal(summary.successRate, 0.8)
  assert.equal(summary.confirmP50Ms, 4000); assert.equal(summary.confirmP95Ms, 30000)
  assert.equal(summary.failures[0].createdAt, '2026-09-29T00:00:00.000Z')
  assert.ok(!db.queries.some(q => /wallet/.test(q.sql)))
})
