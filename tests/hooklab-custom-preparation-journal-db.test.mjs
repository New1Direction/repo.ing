// Disposable local PostgreSQL only. All signatures, receipts and account bytes
// come from explicitly synthetic fixtures. No network RPC or production proof.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { customPreparationJournal, customPreparationSummary } from '../src/hooklab-custom-preparation-journal.mjs'
import { customPreparationReceiptFixture } from './fixtures/hooklab-custom-preparation-receipts.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

const owner = '101', otherOwner = '202'
const trusted = f => ({ expectedProfileSha256: f.expectedProfileSha256,
  expectedProviders: f.expectedProviders, evidenceMode: f.evidenceMode })
const input = (f, observations = f.observations) => ({ preparationInput: f.preparationInput,
  signedTransactionBase64: f.signedTransactionBase64, observations })
const assertDisabled = value => {
  for (const field of ['canSign', 'canSubmit', 'canRetry', 'canLaunch', 'preparationReceiptAccepted',
    'productionPreparationReceiptAccepted', 'productionAccepted', 'chainVerified', 'artifactAdopted', 'adoption',
    'deploymentAdopted', 'policyApproved', 'executionAuthorized', 'publicExecutionEnabled']) assert.equal(value[field], false, field)
}
const unavailable = f => f.observations.map(o => ({ ...structuredClone(o), transaction: null, block: null,
  snapshot: null, programSnapshot: null, errorCode: 'READ_UNAVAILABLE' }))
const failure = f => {
  const observations = structuredClone(f.observations)
  for (const o of observations) {
    o.transaction.err = { InstructionError: [2, { Custom: 1 }] }
    o.transaction.postBalances = o.transaction.preBalances.map(String)
    o.transaction.postBalances[0] = String(BigInt(o.transaction.preBalances[0]) - BigInt(o.transaction.feeLamports))
    o.snapshot = null; o.programSnapshot = null
  }
  return observations
}

test('dedicated custom preparation journal preserves exact identity/evidence atomically; synthetic and permanently non-executable', async t => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `custom_preparation_test_${randomUUID().replaceAll('-', '')}`
  let pool, readonly
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await pool.query(await readFile(new URL('../src/hooklab-custom-preparation-schema.sql', import.meta.url), 'utf8'))
    const f = customPreparationReceiptFixture(), id = randomUUID(), pinned = structuredClone(trusted(f))
    let journal = customPreparationJournal(pool, pinned)

    await t.test('trusted constructor config is required, strict and immutable', async () => {
      for (const bad of [undefined, {}, { ...trusted(f), evidenceMode: 'production' },
        { ...trusted(f), expectedProviders: ['same', 'same'] }, { ...trusted(f), canSubmit: true }]) {
        assert.throws(() => customPreparationJournal(pool, bad))
      }
      pinned.expectedProviders[0] = 'untrusted-a'; pinned.expectedProviders[1] = 'untrusted-b'
      pinned.expectedProfileSha256 = 'f'.repeat(64)
      const [first, replay] = await Promise.all([journal.retain(owner, id, input(f)), journal.retain(owner, id.toUpperCase(), input(f))])
      assert.deepEqual(first, replay)
      assertDisabled(customPreparationSummary(first))
    })

    await t.test('concurrent identical retention is idempotent, owner scoped and bounded', async () => {
      const [a, b] = await Promise.all([journal.retain(owner, id, input(f)), journal.retain(owner, id.toUpperCase(), input(f))])
      assert.deepEqual(a, b)
      assert.equal(a.status, 'candidate-preparation-matched')
      assert.equal(a.evidence_mode, 'synthetic-fixture')
      assertDisabled(a)
      assert.equal((await pool.query('select count(*)::int as n from hook_lab_custom_preparation_events where journal_id=$1', [id])).rows[0].n, 1)
      assert.equal(await journal.get(otherOwner, id), null)
      assert.deepEqual(await journal.list(otherOwner), [])
      await assert.rejects(journal.retain(otherOwner, id, input(f)), { status: 409 })
      await assert.rejects(journal.observe(otherOwner, id, []), { status: 409 })
      await assert.rejects(journal.retain(owner, randomUUID(), input(f)), { status: 409 })
      await assert.rejects(journal.retain(otherOwner, randomUUID(), input(f)), { status: 409 })
      for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '1' }, { cursor: 'arbitrary' }]) {
        await assert.rejects(journal.list(owner, bad)); await assert.rejects(journal.pending(bad))
      }
      for (const bad of ['0', '-1', '01', 'github-login', '1'.repeat(19)]) await assert.rejects(journal.get(bad, id))
      await assert.rejects(journal.get(owner, 'not-a-uuid'))
      const [summary] = await journal.list(owner, { limit: 1 })
      assertDisabled(summary)
      assert.deepEqual(summary, customPreparationSummary(await journal.get(owner, id)))
      assert.ok(!JSON.stringify(summary).includes(f.signedTransactionBase64))
      for (const secret of ['signed_transaction', 'preparation_input', 'observations', 'derived_record', 'retained_evidence']) assert.ok(!(secret in summary))
      assert.equal(summary.retainedFinalizedEvidence, true)
    })

    await t.test('profile/provider/mode mismatches cannot read, rewrite or duplicate a mint', async () => {
      for (const patch of [{ expectedProfileSha256: 'd'.repeat(64) }, { expectedProviders: ['other-a', 'other-b'] },
        { evidenceMode: 'configured-readonly-rpc' }]) {
        const other = customPreparationJournal(pool, { ...trusted(f), ...patch })
        assert.equal(await other.get(owner, id), null)
        assert.deepEqual(await other.list(owner), [])
        await assert.rejects(other.retain(owner, id, input(f)), { status: 409 })
        await assert.rejects(other.retain(owner, randomUUID(), input(f)), { status: 409 })
      }
    })

    await t.test('rebuild and wire verification reject caller authority, altered input and replacement signatures', async () => {
      await assert.rejects(journal.retain(owner, id, { ...input(f), accepted: true }))
      const changed = structuredClone(input(f)); changed.preparationInput.request.label = 'Changed intent'
      await assert.rejects(journal.retain(owner, id, changed), { status: 409 })
      const injected = structuredClone(input(f)); injected.preparationInput.plan = { canSubmit: true }
      await assert.rejects(journal.retain(owner, randomUUID(), injected), { status: 409 })
      const wire = Buffer.from(f.signedTransactionBase64, 'base64'); wire[1] ^= 1
      await assert.rejects(journal.retain(owner, id, { ...input(f), signedTransactionBase64: wire.toString('base64') }), { status: 409 })
      const different = customPreparationReceiptFixture({ seedLabel: 'different-wire' })
      await assert.rejects(journal.retain(owner, id, input(different)), { status: 409 })
      const unknownFlag = structuredClone(f.observations); unknownFlag[0].canSubmit = true
      await assert.rejects(journal.observe(owner, id, unknownFlag), { status: 409 })
      await assert.rejects(journal.observe(owner, id, ['x'.repeat(4194305)]), { status: 409 })
      assert.equal((await journal.get(owner, id)).signed_transaction, f.signedTransactionBase64)
    })

    await t.test('different UUIDs racing for one mint cannot create two identities', async () => {
      const distinct = customPreparationReceiptFixture({ seedLabel: 'race' }), ids = [randomUUID(), randomUUID()]
      const attempts = await Promise.allSettled(ids.map(next => journal.retain(owner, next, input(distinct))))
      assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(attempts.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1)
    })

    await t.test('provider outage, pending and missing provider never become final acceptance', async () => {
      const unresolved = customPreparationReceiptFixture({ seedLabel: 'pending' }), unresolvedId = randomUUID()
      assert.equal((await journal.retain(owner, unresolvedId, input(unresolved, unavailable(unresolved)))).status, 'unresolved')
      await assert.rejects(journal.observe(owner, unresolvedId, unresolved.observations.slice(0, 1)), { status: 409 })
      const missing = structuredClone(unresolved.observations); Object.assign(missing[1], { transaction: null, block: null, snapshot: null })
      assert.equal((await journal.observe(owner, unresolvedId, missing)).status, 'unresolved')
      const pending = structuredClone(unresolved.observations)
      pending.forEach(o => { o.transactionCommitment = 'confirmed'; o.blockCommitment = 'confirmed' })
      assert.equal((await journal.observe(owner, unresolvedId, pending)).status, 'pending-finality')
      const waiting = await journal.get(owner, unresolvedId)
      assert.equal(waiting.retained_evidence, null); assertDisabled(waiting)
      assert.equal((await journal.pending({ limit: 1 }))[0].id, unresolvedId)
      assert.equal((await journal.observe(owner, unresolvedId, unresolved.observations)).status, 'candidate-preparation-matched')
      assert.equal((await journal.pending()).length, 0)
    })

    await t.test('failed finalized execution stays failed; later success cannot upgrade original evidence', async () => {
      const failed = customPreparationReceiptFixture({ seedLabel: 'failed' }), failedId = randomUUID()
      const original = await journal.retain(owner, failedId, input(failed, failure(failed)))
      assert.equal(original.status, 'finalized-failure'); assertDisabled(original)
      const later = await journal.observe(owner, failedId, failed.observations)
      assert.equal(later.status, 'review-required'); assert.equal(later.evidence_conflict, true)
      assert.deepEqual(later.retained_evidence, original.retained_evidence)
      assert.equal(later.signed_transaction, original.signed_transaction)
      const outage = await journal.observe(owner, failedId, unavailable(failed))
      assert.equal(outage.status, 'review-required')
      assert.deepEqual(outage.retained_evidence, original.retained_evidence)
      assert.deepEqual(outage.first_conflict, later.first_conflict)
      await assert.rejects(pool.query('update hook_lab_custom_preparation set evidence_conflict=false,first_conflict=null where id=$1', [failedId]), /conflict requires/)
    })

    await t.test('concurrent conflicting evidence and outage retain one identity and a sticky conflict', async () => {
      const concurrent = customPreparationReceiptFixture({ seedLabel: 'conflict-race' }), concurrentId = randomUUID()
      const original = await journal.retain(owner, concurrentId, input(concurrent))
      await Promise.all([journal.observe(owner, concurrentId, failure(concurrent)),
        journal.observe(owner, concurrentId, unavailable(concurrent))])
      const result = await journal.get(owner, concurrentId)
      assert.equal(result.status, 'review-required')
      assert.deepEqual(result.retained_evidence, original.retained_evidence)
      assert.equal(result.signed_transaction, original.signed_transaction)
      assert.equal(result.first_conflict.status, 'finalized-failure')
      assertDisabled(result)
    })

    await t.test('changed finalized program source cannot replace retained immutable preparation evidence', async () => {
      const source = customPreparationReceiptFixture({ seedLabel: 'source-conflict' }), sourceId = randomUUID()
      const original = await journal.retain(owner, sourceId, input(source))
      const changed = structuredClone(source.observations)
      for (const o of changed) {
        const account = o.programSnapshot.accounts.find(a => a.role === 'launchProgramData')
        const bytes = Buffer.from(account.dataBase64, 'base64'); bytes[bytes.length - 1] ^= 1
        account.dataBase64 = bytes.toString('base64')
      }
      const result = await journal.observe(owner, sourceId, changed)
      assert.equal(result.status, 'review-required')
      assert.equal(result.latest_evidence.reasonCode, 'SOURCE_MISMATCH')
      assert.deepEqual(result.retained_evidence, original.retained_evidence)
      assert.equal(result.first_conflict.reasonCode, 'SOURCE_MISMATCH')
      assertDisabled(result)
    })

    await t.test('insert and observation audit failure roll back every state mutation', async () => {
      const atomic = customPreparationReceiptFixture({ seedLabel: 'audit-rollback' }), atomicId = randomUUID()
      await pool.query("alter table hook_lab_custom_preparation_events add constraint fixture_audit_failure check (kind <> 'retained') not valid")
      await assert.rejects(journal.retain(owner, atomicId, input(atomic)), /fixture_audit_failure/)
      assert.equal(await journal.get(owner, atomicId), null)
      await pool.query('alter table hook_lab_custom_preparation_events drop constraint fixture_audit_failure')
      const before = await journal.get(owner, id)
      await pool.query("alter table hook_lab_custom_preparation_events add constraint fixture_audit_failure check (kind <> 'observed') not valid")
      await assert.rejects(journal.observe(owner, id, unavailable(f)), /fixture_audit_failure/)
      assert.deepEqual(await journal.get(owner, id), before)
      await pool.query('alter table hook_lab_custom_preparation_events drop constraint fixture_audit_failure')
      await pool.query("alter table hook_lab_custom_preparation_events add constraint fixture_audit_failure check (kind <> 'conflict') not valid")
      await assert.rejects(journal.observe(owner, id, failure(f)), /fixture_audit_failure/)
      assert.deepEqual(await journal.get(owner, id), before)
      await pool.query('alter table hook_lab_custom_preparation_events drop constraint fixture_audit_failure')
    })

    await t.test('outage/restart preserve signed wire and original finalized evidence; reads need no writes', async () => {
      const before = await journal.get(owner, id)
      const outage = await journal.observe(owner, id, unavailable(f))
      assert.equal(outage.status, 'unresolved')
      assert.deepEqual(outage.retained_evidence, before.retained_evidence)
      await pool.end(); pool = new pg.Pool({ ...config, database }); journal = customPreparationJournal(pool, trusted(f))
      const restarted = await journal.get(owner, id)
      assert.deepEqual(restarted, outage)
      readonly = new pg.Pool({ ...config, database, options: '-c default_transaction_read_only=on' })
      const readJournal = customPreparationJournal(readonly, trusted(f))
      assert.deepEqual(await readJournal.get(owner, id), restarted)
      assert.ok((await readJournal.list(owner)).some(row => row.id === id))
      const later = structuredClone(f.observations)
      later.forEach((o, i) => {
        o.snapshot.slot += 100 + i; o.programSnapshot.slot = o.snapshot.slot
        for (const a of [...o.snapshot.accounts, ...o.programSnapshot.accounts]) a.lamports = String(BigInt(a.lamports) + 100n)
        o.rawResponseSha256 = 'a'.repeat(64)
      })
      const restored = await journal.observe(owner, id, later)
      assert.equal(restored.status, 'candidate-preparation-matched')
      assert.equal(restored.evidence_conflict, false)
      assert.deepEqual(restored.retained_evidence, before.retained_evidence)
      await assert.rejects(pool.query("update hook_lab_custom_preparation set signed_transaction='replacement' where id=$1", [id]), /identity is immutable/)
      await assert.rejects(pool.query('update hook_lab_custom_preparation set retained_evidence=null where id=$1', [id]), /finalized preparation evidence is immutable/)
    })

    await t.test('list replay rejects a forged allowed status instead of displaying a false match', async () => {
      const original = await journal.observe(owner, id, unavailable(f))
      assert.equal(original.latest_evidence.status, 'unresolved')
      await pool.query("update hook_lab_custom_preparation set latest_evidence=jsonb_set(latest_evidence,'{status}','\"candidate-preparation-matched\"') where id=$1", [id])
      await assert.rejects(journal.get(owner, id), { status: 409 })
      await assert.rejects(journal.list(owner), { status: 409 })
      await pool.query('update hook_lab_custom_preparation set latest_evidence=$2 where id=$1', [id, original.latest_evidence])
      assert.equal((await journal.list(owner)).find(row => row.id === id).status, 'unresolved')
    })

    await t.test('oversized list pages fail before any full payload transfer and never skip records', async () => {
      const original = await journal.get(owner, id), queries = []
      const measured = customPreparationJournal({ async connect() {
        const db = await pool.connect()
        return { query(sql, values) { queries.push(sql); return db.query(sql, values) }, release() { db.release() } }
      } }, trusted(f))
      await pool.query(`update hook_lab_custom_preparation set latest_evidence=jsonb_set(latest_evidence,
        '{oversizedFixture}',to_jsonb(repeat('x',33554433))) where id=$1`, [id])
      try {
        await assert.rejects(measured.list(owner, { limit: 50 }), { status: 503 })
        assert.equal(queries[0], 'begin isolation level repeatable read read only')
        assert.ok(queries.some(sql => sql.includes('octet_length(preparation_input::text)')))
        assert.ok(!queries.some(sql => /select \* from hook_lab_custom_preparation/.test(sql)))
        assert.equal(queries.at(-1), 'rollback')
      } finally {
        await pool.query('update hook_lab_custom_preparation set latest_evidence=$2 where id=$1', [id, original.latest_evidence])
      }
      assert.ok((await journal.list(owner)).some(row => row.id === id))
    })

    await t.test('summary rejects forged stored flags/status/signature; retained row re-verification fails closed', async () => {
      const row = await journal.get(owner, id)
      for (const patch of [{ latest_evidence: { ...row.latest_evidence, status: 'accepted' } },
        { latest_evidence: { ...row.latest_evidence, canSign: true } }, { signature: 'bad' },
        { retained_evidence: {} }, { canSubmit: true }, { created_at: 'yesterday' }, { mint: 'not-an-address' }]) {
        assert.throws(() => customPreparationSummary({ ...row, ...patch }))
      }
      await pool.query("update hook_lab_custom_preparation set latest_evidence=jsonb_set(latest_evidence,'{canSubmit}','true') where id=$1", [id])
      await assert.rejects(journal.get(owner, id), { status: 409 })
      await assert.rejects(journal.list(owner), { status: 409 })
    })
  } finally {
    if (readonly) await readonly.end()
    if (pool) await pool.end()
    await dropTestDatabase(admin, database)
    await admin.end()
  }
})
