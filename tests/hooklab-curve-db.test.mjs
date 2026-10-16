import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import pg from 'pg'
import { curveFixture, curveObservations, curveRpc } from './fixtures/hooklab-curve.mjs'
import { curveRecoveryJournal, deliverCurveAlert } from '../src/hooklab-curve-journal.mjs'
import { indexCurveReceipts } from '../src/hooklab-curve-receipts.mjs'
import { createTelegramSender } from '../src/launch-alerts-senders.mjs'
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
    const indexed = await indexCurveReceipts(journal, ['alpha', 'beta'].map(provider => ({ provider,
      connection: curveRpc(f), readHistory: async () => obs[0].history })))
    assert.deepEqual(indexed, [{ id, status: 'candidate-deltas-matched' }])
    const indexedEvents = (await journal.get(owner, id)).events
    assert.ok(indexedEvents.at(-1).evidence.observations.every(o => o.transactionResponse))
    assert.deepEqual(indexedEvents.at(-1).evidence.observations[0].receipt, obs[0].receipt)

    // Real HTTP request/response on loopback using the existing channel sender, never Telegram.
    const messages = []
    server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk
      messages.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result: { message_id: 42 } }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const sender = createTelegramSender({ token: 'synthetic-token', chatId: 'synthetic-private-destination',
      fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/alert`, options) })
    const sent = await deliverCurveAlert(pool, sender)
    assert.equal(sent.status, 'sent'); assert.equal(messages.length, 1)
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
    await pool.query(`update hook_lab_curve_journal set plan=jsonb_set(plan,'{canSubmit}','true') where id=$1`, [id])
    await assert.rejects(journal.get(owner, id), /plan changed/)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})
