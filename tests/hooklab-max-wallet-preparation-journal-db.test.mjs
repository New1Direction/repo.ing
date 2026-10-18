// Isolated disposable PostgreSQL only. All signatures and observations are synthetic.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { customPreparationJournal, customPreparationSummary } from '../src/hooklab-custom-preparation-journal.mjs'
import { maxWalletPreparationReceiptFixture } from './fixtures/hooklab-max-wallet-preparation-receipts.mjs'
import { customPreparationReceiptFixture } from './fixtures/hooklab-custom-preparation-receipts.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const test = testRequiring(missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json']))
const trusted = f => ({ expectedProfileSha256: f.expectedProfileSha256, expectedProviders: f.expectedProviders, evidenceMode: f.evidenceMode })
const retained = (f, observations = f.observations) => ({ preparationInput: f.preparationInput, signedTransactionBase64: f.signedTransactionBase64, observations })
function disabled(value) {
  for (const field of ['canSign', 'canSubmit', 'canRetry', 'canLaunch', 'preparationReceiptAccepted', 'productionPreparationReceiptAccepted', 'productionAccepted', 'chainVerified', 'artifactAdopted', 'adoption', 'deploymentAdopted', 'policyApproved', 'executionAuthorized', 'publicExecutionEnabled']) assert.equal(value[field], false, field)
}
test('max-wallet signed preparation remains exact and non-executable through durable journal reads', async t => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `maxwallet_preparation_test_${randomUUID().replaceAll('-', '')}`
  let pool, readPool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await pool.query(await readFile(new URL('../src/hooklab-custom-preparation-schema.sql', import.meta.url), 'utf8'))
    const f = maxWalletPreparationReceiptFixture({ samePayer: false, lookupTable: true, capBps: 250, seedLabel: 'durable-max-wallet' }), id = randomUUID(), owner = '501'
    const journal = customPreparationJournal(pool, trusted(f))
    await t.test('selected policy, explicit cap, original signature and exact v0 message survive JSONB replay', async () => {
      const first = await journal.retain(owner, id, retained(f))
      assert.equal(first.status, 'candidate-preparation-matched')
      assert.equal(first.derived_record.policyKind, 'max-wallet')
      assert.equal(first.derived_record.policyVersion, 1)
      assert.equal(first.derived_record.plan.request.capBps, 250)
      assert.equal(first.latest_evidence.currentPrelaunchEligible, true)
      assert.equal(first.signed_transaction, f.signedTransactionBase64)
      disabled(first); disabled(customPreparationSummary(first))
      const replay = await customPreparationJournal(pool, trusted(f)).get(owner, id)
      assert.deepEqual(replay, first)
      assert.deepEqual(await journal.list(owner, { limit: 1 }), [customPreparationSummary(first)])
    })
    await t.test('existing owner isolation and strict profile discrimination hold for max-wallet', async () => {
      assert.equal(await journal.get('502', id), null)
      assert.deepEqual(await journal.list('502'), [])
      await assert.rejects(journal.retain('502', id, retained(f)), { status: 409 })
      const reference = customPreparationReceiptFixture({ seedLabel: 'reference-must-not-substitute' })
      await assert.rejects(journal.retain(owner, randomUUID(), retained(reference)), { status: 409 })
      const wrongProfile = customPreparationJournal(pool, trusted(reference))
      assert.equal(await wrongProfile.get(owner, id), null)
      assert.deepEqual(await wrongProfile.list(owner), [])
    })
    await t.test('later canonical Launch presence closes current eligibility without erasing or corrupting original evidence', async () => {
      const before = await journal.get(owner, id), observed = structuredClone(f.observations)
      for (const o of observed) o.absenceSnapshot.accounts[0].exists = true
      const later = await journal.observe(owner, id, observed)
      assert.equal(later.status, 'unresolved')
      assert.equal(later.latest_evidence.reasonCode, 'CURRENT_LAUNCH_PRESENT')
      assert.equal(later.latest_evidence.currentPrelaunchEligible, false)
      assert.equal(later.evidence_conflict, false)
      assert.deepEqual(later.retained_evidence, before.retained_evidence)
      const summary = (await journal.list(owner))[0]
      assert.equal(summary.retainedFinalizedEvidence, true)
      assert.equal(summary.evidenceConflict, false); disabled(summary)
      const restored = await journal.observe(owner, id, f.observations)
      assert.equal(restored.status, 'candidate-preparation-matched')
      assert.equal(restored.evidence_conflict, false)
    })
    await t.test('SELECT-only reads rebuild and refuse allowed-status tampering', async () => {
      readPool = new pg.Pool({ ...config, database, options: '-c default_transaction_read_only=on' })
      const reader = customPreparationJournal(readPool, trusted(f))
      assert.equal((await reader.get(owner, id)).status, 'candidate-preparation-matched')
      assert.equal((await reader.list(owner)).length, 1)
      const latest = (await pool.query('select latest_evidence from hook_lab_custom_preparation where id=$1', [id])).rows[0].latest_evidence
      await pool.query("update hook_lab_custom_preparation set latest_evidence=jsonb_set(latest_evidence,'{status}','\"unresolved\"') where id=$1", [id])
      await assert.rejects(reader.get(owner, id), { status: 409 })
      await assert.rejects(reader.list(owner), { status: 409 })
      await pool.query('update hook_lab_custom_preparation set latest_evidence=$2 where id=$1', [id, latest])
      assert.equal((await reader.list(owner))[0].status, 'candidate-preparation-matched')
    })
    await t.test('changed immutable cap evidence latches review-required without enabling retry', async () => {
      const changed = structuredClone(f.observations)
      for (const o of changed) {
        const policy = o.snapshot.accounts.find(a => a.role === 'policy'), bytes = Buffer.from(policy.dataBase64, 'base64')
        bytes.writeUInt16LE(251, 49); policy.dataBase64 = bytes.toString('base64')
      }
      const conflict = await journal.observe(owner, id, changed)
      assert.equal(conflict.status, 'review-required')
      assert.equal(conflict.evidence_conflict, true)
      disabled(conflict)
      const originalAgain = await journal.observe(owner, id, f.observations)
      assert.equal(originalAgain.status, 'review-required')
      assert.equal(originalAgain.retained_evidence.status, 'candidate-preparation-matched')
      disabled(customPreparationSummary(originalAgain))
    })
  } finally {
    await readPool?.end(); await pool?.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})
