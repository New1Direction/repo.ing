import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { plainRecoveryJournal } from '../src/hooklab-plain-journal.mjs'
import { plainFixture, plainObservations } from './fixtures/hooklab-plain.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

test('plain durable journal: ownership, concurrent retention, atomic audit, reload and outage preserve exact finalized evidence', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `plain_recovery_test_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    let journal = plainRecoveryJournal(pool)
    const f = plainFixture(), owner = '101', id = randomUUID()
    const [first, replay] = await Promise.all([journal.prepare(owner, id, f.plan), journal.prepare(owner, id, f.plan)])
    assert.deepEqual(first, replay)
    assert.equal(await journal.get('202', id), null)
    await assert.rejects(journal.prepare('202', id, f.plan), { status: 409 })
    await assert.rejects(journal.prepare(owner, randomUUID(), f.plan), /unique/)
    await assert.rejects(journal.prepare(owner, id, { ...f.plan, canSign: true }), { status: 409 })
    await pool.query("alter table hook_lab_plain_events add constraint fixture_failure check (kind <> 'signed')")
    await assert.rejects(journal.recordSigned(owner, id, f.signed), /fixture_failure/)
    assert.equal((await journal.get(owner, id)).signature, null)
    await pool.query('alter table hook_lab_plain_events drop constraint fixture_failure')
    const [signed, again] = await Promise.all([journal.recordSigned(owner, id, f.signed), journal.recordSigned(owner, id, f.signed)])
    assert.deepEqual(signed, again)
    assert.equal((await journal.get(owner, id)).status, 'unresolved')
    assert.equal((await journal.health()).unresolved, '1')
    const observations = plainObservations(f)
    const observed = await journal.observe(owner, id, observations, ['alpha', 'beta'])
    assert.equal(observed.status, 'receipt-state-matched')
    assert.deepEqual(observed.retained_receipt.observations, observations)
    await journal.observe(owner, id, [], ['alpha', 'beta'])
    await pool.end(); pool = new pg.Pool({ ...config, database }); journal = plainRecoveryJournal(pool)
    const recovered = await journal.get(owner, id)
    assert.equal(recovered.signed_transaction, f.signed)
    assert.equal(recovered.status, 'unresolved')
    assert.deepEqual(recovered.retained_receipt, observed.retained_receipt)
    assert.equal(recovered.canRetry, false); assert.equal(recovered.canSubmit, false)
    assert.equal((await journal.health()).unresolved, '0')
    assert.equal((await journal.health()).latest_unavailable, '1')
    assert.equal((await journal.pending())[0].signature, signed.signature)
    assert.deepEqual((await pool.query('select kind from hook_lab_plain_events order by id')).rows.map(r => r.kind), ['prepared', 'signed', 'observed', 'observed'])
    const conflict = plainObservations(f); conflict.forEach(o => { o.receipt.error = { InstructionError: [2, 'Custom'] } })
    const conflicted = await journal.observe(owner, id, conflict, ['alpha', 'beta'])
    assert.equal(conflicted.status, 'review-required')
    assert.deepEqual(conflicted.retained_receipt, observed.retained_receipt)
    assert.equal((await journal.health()).review_required, '1')
    await pool.query(`update hook_lab_plain_recovery set plan=jsonb_set(plan,'{canSubmit}','true') where id=$1`, [id])
    await assert.rejects(journal.get(owner, id), { status: 409 })
  } finally {
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})
