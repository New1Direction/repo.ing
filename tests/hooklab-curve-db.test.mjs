import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import pg from 'pg'
import { curveFixture, curveObservations, curveRpc, curveArchive } from './fixtures/hooklab-curve.mjs'
import { curveRecoveryJournal, deliverCurveAlert, readCurveAlertEscalations, recordCurveAlertReview } from '../src/hooklab-curve-journal.mjs'
import { curveTrialBudgets } from '../src/hooklab-curve-budgets.mjs'
import { prepareCurveReview, CURVE_PROFILE } from '../src/hooklab-curve.mjs'
import { indexCurveReceipts, createCurveArchiveReader } from '../src/hooklab-curve-receipts.mjs'
import { createTelegramSender } from '../src/launch-alerts-senders.mjs'
import { createCurveEmailSender } from '../src/hooklab-curve-email.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

test('curve journal survives concurrent partials, atomic audit failure, restart and conflicting/outage history; durable alert HTTP delivery', async () => {
  // Deliberately not configurable to a shared database.
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `curve_test_${randomUUID().replaceAll('-', '')}`
  let pool, server
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await pool.query(readFileSync(new URL('../src/hooklab-curve-schema.sql', import.meta.url), 'utf8'))
    let journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    const f = curveFixture(), id = randomUUID(), owner = '101'
    const prepared = await Promise.all([journal.prepare(owner, id, f.intent, f.observed), journal.prepare(owner, id, f.intent, f.observed)])
    assert.deepEqual(prepared[0], prepared[1])
    await assert.rejects(journal.get('202', id), { status: 409 })
    await assert.rejects(journal.prepare(owner, id, { ...f.intent, minAmountOut: '661' }, f.observed), { status: 409 })
    await assert.rejects(journal.prepare(owner, randomUUID(), f.intent, f.observed), /unique/)
    await pool.query("alter table hook_lab_curve_events add constraint fixture_failure check(kind <> 'partial-signatures')")
    await assert.rejects(journal.retainPartial(owner, id, f.partial(f.trader)), /fixture_failure/)
    assert.equal((await journal.get(owner, id)).partial_transaction, null)
    await pool.query('alter table hook_lab_curve_events drop constraint fixture_failure')
    await journal.retainPartial(owner, id, f.partial(f.trader))
    await pool.end(); pool = new pg.Pool({ ...config, database }); journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    const recovered = await journal.get(owner, id)
    assert.equal(recovered.complete, false); assert.equal(recovered.partial_transaction, f.partial(f.trader))
    await Promise.all([journal.retainPartial(owner, id, f.partial(f.payer)), journal.retainPartial(owner, id, f.partial(f.trader))])
    assert.equal((await journal.get(owner, id)).partial_transaction, f.signed)
    const noHistory = await journal.observe(owner, id, [])
    assert.equal(noHistory.status, 'unresolved')
    assert.equal((await pool.query('select count(*) from hook_lab_curve_alerts')).rows[0].count, '1')
    const obs = curveObservations(f)
    assert.equal((await journal.observe(owner, id, obs)).status, 'candidate-deltas-matched')
    await journal.observe(owner, id, [])
    await pool.end(); pool = new pg.Pool({ ...config, database }); journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    const retained = await journal.get(owner, id)
    assert.deepEqual(retained.first_finalized.observations, obs)
    assert.equal(retained.latest_status, 'unresolved'); assert.equal(retained.canRetry, false)
    assert.equal(retained.partial_transaction, f.signed)
    assert.deepEqual(retained.events.map(e => Number(e.sequence)), [1, 2, 3, 4, 5, 6])
    assert.deepEqual(retained.events[4].evidence.observations, obs)
    const conflicting = structuredClone(obs); conflicting.forEach(o => { o.receipt.error = { InstructionError: [2, 'Custom'] } })
    assert.equal((await journal.observe(owner, id, conflicting)).status, 'review-required')
    assert.deepEqual((await journal.get(owner, id)).first_finalized, retained.first_finalized)
    assert.deepEqual((await journal.pending()).map(r => r.id), [id])
    const archive = curveArchive(f)
    const indexed = await indexCurveReceipts(journal, ['alpha', 'beta'].map(provider => ({ provider,
      connection: curveRpc(f), readHistory: createCurveArchiveReader({ ...archive.pins, readArchive: async () => archive.envelope }) })))
    assert.deepEqual(indexed, [{ id, status: 'review-required' }])
    // A later matching read must not erase an earlier finalized contradiction, even after restart.
    await pool.end(); pool = new pg.Pool({ ...config, database }); journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    assert.equal((await journal.observe(owner, id, obs)).status, 'review-required')
    assert.equal((await journal.get(owner, id)).evidence_conflict, true)
    const indexedEvents = (await journal.get(owner, id)).events
    assert.ok(indexedEvents.at(-2).evidence.observations.every(o => o.transactionResponse))
    assert.deepEqual(indexedEvents.at(-2).evidence.observations[0].receipt, obs[0].receipt)
    assert.equal(indexedEvents.at(-2).evidence.observations[0].historyArchive.payloadBase64, archive.envelope.payloadBase64)
    assert.equal(indexedEvents.at(-2).evidence.observations[1].historyArchive.signatureBase64, archive.envelope.signatureBase64)

    // Real HTTP on loopback only, never the email provider or Telegram.
    const messages = [], keys = [], emailId = randomUUID()
    server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk
      messages.push(JSON.parse(body))
      keys.push(request.headers['idempotency-key'])
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: emailId, ok: true, result: { message_id: 42 } }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const sender = createTelegramSender({ token: 'synthetic-token', chatId: 'synthetic-private-destination',
      fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/alert`, options) })
    const email = createCurveEmailSender({ HOOKLAB_CURVE_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'synthetic-key',
      HOOKLAB_CURVE_ALERT_FROM: 'alerts@example.com', HOOKLAB_CURVE_ALERT_TO: 'owner@example.com' },
    (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/alert`, options))
    const sent = await deliverCurveAlert(pool, email)
    assert.equal(sent.status, 'sent'); assert.equal(messages.length, 1)
    assert.equal(keys[0], `hooklab-curve-alert/${sent.journalId}/${sent.sequence}`)
    assert.equal((await pool.query('select message_id from hook_lab_curve_alerts where journal_id=$1 and sequence=$2',
      [sent.journalId, sent.sequence])).rows[0].message_id, emailId)
    assert.match(messages[0].text, /execution remains disabled/)
    assert.equal(messages[0].text.includes(f.signed), false)
    const unknown = await deliverCurveAlert(pool, async () => { throw new Error('response lost') })
    assert.equal(unknown.status, 'unknown')
    const failed = await deliverCurveAlert(pool, async () => ({ status: 'failed', retryAfterMs: 60000 }))
    assert.equal(failed.status, 'failed')
    assert.equal((await deliverCurveAlert(pool, sender)).status, 'idle')
    await pool.query("update hook_lab_curve_alerts set retry_at=now() where status='failed'")
    const retry = await Promise.all([deliverCurveAlert(pool, sender), deliverCurveAlert(pool, sender)])
    assert.deepEqual(retry.map(r => r.status).sort(), ['idle', 'sent'])
    assert.equal(messages.length, 2)
    const statuses = (await pool.query('select status,attempts from hook_lab_curve_alerts order by sequence')).rows
    assert.deepEqual(statuses, [{ status: 'sent', attempts: 1 }, { status: 'unknown', attempts: 1 }, { status: 'sent', attempts: 2 }])
    // Simulate crash after claiming a post; restart quarantines it rather than sending twice.
    await pool.query("update hook_lab_curve_alerts set status='sending',attempted_at=now()-interval '3 minutes' where status='unknown'")
    assert.equal((await deliverCurveAlert(pool, sender)).status, 'idle')
    assert.equal(messages.length, 2)
    assert.equal((await pool.query("select count(*) from hook_lab_curve_alerts where status='unknown'")).rows[0].count, '1')
    const drill = curveFixture(), drillId = randomUUID()
    await journal.prepare(owner, drillId, drill.intent, drill.observed)
    await journal.retainPartial(owner, drillId, drill.signed)
    await journal.observe(owner, drillId, [])
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal((await deliverCurveAlert(pool, async () => ({ status: 'failed', retryAfterMs: 1 }))).status, 'failed')
      await pool.query("update hook_lab_curve_alerts set retry_at=now() where status='failed'")
    }
    await pool.end(); pool = new pg.Pool({ ...config, database })
    assert.equal((await deliverCurveAlert(pool, sender)).status, 'idle')
    assert.equal(messages.length, 2)
    const exhausted = (await pool.query('select status,attempts from hook_lab_curve_alerts where journal_id=$1', [drillId])).rows[0]
    assert.deepEqual(exhausted, { status: 'failed', attempts: 3 })
    const queue = await readCurveAlertEscalations(pool)
    assert.deepEqual(queue.map(r => r.reason).sort(), ['ambiguous-delivery', 'attempts-exhausted'])
    const target = queue.find(r => r.journal_id === drillId)
    const review = { journalId: target.journal_id, sequence: target.sequence, kind: 'escalated', evidenceSha256: 'a'.repeat(64) }
    await recordCurveAlertReview(pool, '303', review)
    await assert.rejects(recordCurveAlertReview(pool, '404', { ...review, evidenceSha256: 'b'.repeat(64) }), /duplicate/)
    assert.equal((await readCurveAlertEscalations(pool)).find(r => r.journal_id === drillId).escalation_recorded, true)
    await recordCurveAlertReview(pool, '303', { ...review, kind: 'acknowledged', evidenceSha256: 'c'.repeat(64) })
    // A separately retained operator acknowledgement neither resets attempts nor resends anything.
    await pool.end(); pool = new pg.Pool({ ...config, database })
    assert.equal((await readCurveAlertEscalations(pool)).some(r => r.journal_id === drillId), false)
    assert.equal((await deliverCurveAlert(pool, sender)).status, 'idle'); assert.equal(messages.length, 2)
    assert.deepEqual((await pool.query('select status,attempts from hook_lab_curve_alerts where journal_id=$1', [drillId])).rows[0], exhausted)
    await pool.query("update hook_lab_curve_events set created_at=now()-interval '6 minutes'")
    assert.deepEqual((await readCurveAlertEscalations(pool)).map(r => r.reason).sort(),
      ['acknowledgement-overdue', 'acknowledgement-overdue', 'ambiguous-delivery'])
    journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    await pool.query(`update hook_lab_curve_journal set plan=jsonb_set(plan,'{canSubmit}','true') where id=$1`, [id])
    await assert.rejects(journal.get(owner, id), /plan changed/)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})

test('curve-specific wallet proof binds exact owner/session/origin/plan and atomically consumes once under a durable quota', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', database: 'postgres' }
  const admin = new pg.Pool(config), database = `curve_auth_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await pool.query(readFileSync(new URL('../src/hooklab-curve-schema.sql', import.meta.url), 'utf8'))
    let journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    const f = curveFixture(), id = randomUUID(), owner = '101'
    const context = { sessionId: 'a'.repeat(48), origin: 'https://repo.ing' }
    const signature = message => sign(null, Buffer.from(message), createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), f.trader.secretKey.subarray(0, 32)]),
      format: 'der', type: 'pkcs8' })).toString('base64')
    for (const origin of ['http://repo.ing', 'https://repo.ing/', 'https://user@repo.ing']) {
      await assert.rejects(journal.challenge(owner, id, f.plan, { ...context, origin }))
    }
    const c = await journal.challenge(owner, id, f.plan, context)
    assert.match(c.message, /^repo.ing curve review retention v1\n/)
    assert.ok(c.message.includes(f.intent.trader) && c.message.includes(f.plan.review.messageSha256))
    assert.ok(!c.message.includes(context.sessionId)); assert.equal(c.canSign, false)
    const proof = { nonce: c.nonce, signature: signature(c.message) }
    for (const [who, operation, plan, ctx, p] of [
      ['202', id, f.plan, context, proof], [owner, randomUUID(), f.plan, context, proof],
      [owner, id, f.plan, { ...context, sessionId: 'b'.repeat(48) }, proof],
      [owner, id, f.plan, { ...context, origin: 'https://other.example' }, proof],
      [owner, id, prepareCurveReview({ ...f.intent, minAmountOut: '661' }, f.observed), context, proof],
      [owner, id, f.plan, context, { ...proof, signature: signature(c.message.replace('curve review retention', 'plain review retention')) }],
    ]) await assert.rejects(journal.prepareAuthenticated(who, operation, plan, ctx, p))
    await pool.query("alter table hook_lab_curve_events add constraint fixture_proof_failure check(kind <> 'wallet-proof')")
    await assert.rejects(journal.prepareAuthenticated(owner, id, f.plan, context, proof), /fixture_proof_failure/)
    assert.equal(await journal.get(owner, id), null)
    await pool.query('alter table hook_lab_curve_events drop constraint fixture_proof_failure')
    const results = await Promise.allSettled([1, 2].map(() => journal.prepareAuthenticated(owner, id, f.plan, context, proof)))
    assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'])
    await pool.end(); pool = new pg.Pool({ ...config, database }); journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    await pool.query("update hook_lab_curve_challenges set expires_at=now()-interval '1 second'")
    const saved = await journal.get(owner, id)
    assert.deepEqual(saved.events.map(e => e.kind), ['prepared', 'wallet-proof'])
    assert.equal(saved.canSubmit, false); assert.equal(saved.events[1].evidence.spendingConsent, false)
    await assert.rejects(journal.prepareAuthenticated(owner, id, f.plan, context, proof))
    const expiredId = randomUUID(), expired = await journal.challenge(owner, expiredId, f.plan, context)
    await pool.query("update hook_lab_curve_challenges set expires_at=now() where nonce=$1", [expired.nonce])
    await assert.rejects(journal.prepareAuthenticated(owner, expiredId, f.plan, context,
      { nonce: expired.nonce, signature: signature(expired.message) }))
    const quota = await Promise.allSettled(Array.from({ length: 12 }, () => journal.challenge('303', randomUUID(), f.plan, context)))
    assert.equal(quota.filter(r => r.status === 'fulfilled').length, 10)
    assert.deepEqual(quota.filter(r => r.status === 'rejected').map(r => r.reason.status), [429, 429])
    await pool.end(); pool = new pg.Pool({ ...config, database }); journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    await assert.rejects(journal.challenge('303', randomUUID(), f.plan, context), { status: 429 })
  } finally {
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})

test('trial reservations serialize, survive expiry/stop/unknown outcomes, and require exact finalized buy history before sell', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', database: 'postgres' }
  const admin = new pg.Pool(config), database = `curve_budget_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await pool.query(readFileSync(new URL('../src/hooklab-curve-schema.sql', import.meta.url), 'utf8'))
    const owner = '101', journal = curveRecoveryJournal(pool, ['alpha', 'beta'])
    let time = 2500, budgets = curveTrialBudgets(pool, ['alpha', 'beta'], () => time)
    const f = curveFixture({ recipientSame: true }), obs = curveObservations(f)
    const sell = prepareCurveReview({ ...f.intent, side: 'sell', amountIn: '137', minAmountOut: '19' },
      { ...f.observed, slot: 104, nowMs: 2000, accounts: obs[0].history.after })
    const proposal = { schema: 'repoing/curve-trial-proposal/1', profileSha256: CURVE_PROFILE,
      ...Object.fromEntries(['policySha256', 'deploymentEvidenceSha256', 'provenanceEvidenceSha256', 'custodyEvidenceSha256',
        'alertDrillSha256', 'ownerApprovalSha256'].map(k => [k, 'a'.repeat(64)])),
      buyMessageSha256: f.plan.review.messageSha256, sellMessageSha256: sell.review.messageSha256,
      startsAtMs: 1000, expiresAtMs: 20000, maxQuoteInput: '101', maxBaseInput: '137', maxNetworkFeesLamports: '20000',
      maxQuoteLoss: '82', maxBuys: 1, maxSells: 1, globalUnpauseAcknowledged: true,
      rePauseNeedsSeparateApproval: true, historicalReceiptsRequired: true }
    const trial = randomUUID(), buyId = randomUUID(), sellId = randomUUID()
    await budgets.create(owner, trial, proposal, f.plan, sell)
    await journal.prepare(owner, buyId, f.intent, f.observed)
    await journal.prepare(owner, sellId, sell.intent, sell.observed)
    await assert.rejects(budgets.reserve('202', trial, buyId), /unavailable/)
    await assert.rejects(budgets.reserve(owner, trial, sellId), /Buy unresolved/)
    time = 16000
    await assert.rejects(budgets.reserve(owner, trial, buyId), /review expired/)
    time = 2500
    const reserved = await Promise.all([budgets.reserve(owner, trial, buyId), budgets.reserve(owner, trial, buyId)])
    assert.deepEqual(reserved[0], reserved[1]); assert.equal(reserved[0].canSubmit, false)
    assert.equal((await budgets.get(owner, trial)).reservations.length, 1)
    const alternate = randomUUID()
    await budgets.create(owner, alternate, proposal, f.plan, sell)
    await assert.rejects(budgets.reserve(owner, alternate, buyId), /unique/)
    const drift = prepareCurveReview({ ...sell.intent, minAmountOut: '18' }, sell.observed), driftId = randomUUID()
    await journal.prepare(owner, driftId, drift.intent, drift.observed)
    await assert.rejects(budgets.reserve(owner, trial, driftId), /Exact trial message/)
    await journal.retainPartial(owner, buyId, f.signed)
    await journal.observe(owner, buyId, [])
    await assert.rejects(budgets.reserve(owner, trial, sellId), /Buy unresolved/)
    await journal.observe(owner, buyId, obs)
    assert.equal((await budgets.reserve(owner, trial, sellId)).side, 'sell')
    await assert.rejects(budgets.reserve(owner, alternate, buyId), /before any signature/)
    await budgets.stop(owner, alternate)
    await assert.rejects(budgets.reserve(owner, alternate, sellId), /Trial stopped/)
    // An otherwise valid pre-buy snapshot must not be accepted as the sell's historical prestate.
    const g = curveFixture({ recipientSame: true }), gObs = curveObservations(g)
    const oldSell = prepareCurveReview({ ...g.intent, side: 'sell', amountIn: '137', minAmountOut: '19' },
      { ...g.observed, slot: 104, nowMs: 2000 })
    const oldTrial = randomUUID(), gBuy = randomUUID(), gSell = randomUUID()
    await budgets.create(owner, oldTrial, { ...proposal, buyMessageSha256: g.plan.review.messageSha256,
      sellMessageSha256: oldSell.review.messageSha256 }, g.plan, oldSell)
    await journal.prepare(owner, gBuy, g.intent, g.observed)
    await journal.prepare(owner, gSell, oldSell.intent, oldSell.observed)
    await budgets.reserve(owner, oldTrial, gBuy)
    await journal.retainPartial(owner, gBuy, g.signed)
    assert.equal((await journal.observe(owner, gBuy, gObs)).status, 'candidate-deltas-matched')
    await assert.rejects(budgets.reserve(owner, oldTrial, gSell), /not bound to finalized buy history/)
    const failed = structuredClone(gObs); failed.forEach(o => { o.receipt.error = { InstructionError: [2, 'Slippage'] } })
    assert.equal((await journal.observe(owner, gBuy, failed)).status, 'review-required')
    await assert.rejects(budgets.reserve(owner, oldTrial, gSell), /Buy unresolved/)
    // A later matching success cannot clear a retained conflict or free its budget.
    assert.equal((await journal.observe(owner, gBuy, gObs)).status, 'review-required')
    await assert.rejects(budgets.reserve(owner, oldTrial, gSell), /Buy unresolved/)
    const held = (await budgets.get(owner, trial)).reservations
    assert.deepEqual(held.map(r => r.input_amount), ['101', '137'])
    assert.deepEqual(held.map(r => r.network_fee_cap), ['10000', '10000'])
    await budgets.stop(owner, trial); time = 20000
    await pool.end(); pool = new pg.Pool({ ...config, database }); budgets = curveTrialBudgets(pool, ['alpha', 'beta'], () => time)
    assert.deepEqual((await budgets.get(owner, trial)).reservations, held)
    assert.equal((await budgets.reserve(owner, trial, buyId)).journal_id, buyId)
    assert.equal((await budgets.get(owner, trial)).releasable, false)
    await assert.rejects(budgets.reserve(owner, oldTrial, gSell), /expired/)
  } finally {
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})
