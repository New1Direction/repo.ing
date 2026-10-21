import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { coLocatedWalletPreparationJournal } from '../src/hooklab-wallet-preparation.mjs'
import { deriveCustomPreparationRecord } from '../src/hooklab-custom-preparation-receipts.mjs'
import { verifyHookLabSignedMessage } from '../src/hooklab-message-boundary.mjs'
import { selectedHookPreparationReceiptFixture, selectedHookPreparationRpcProviders } from './fixtures/selected-hook-preparation-receipts.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

const disabled = value => {
  for (const key of ['productionAccepted', 'preparationReceiptAccepted', 'collectionAuthenticated', 'eligibleForProductionLaunch',
    'executionAuthorized', 'publicExecutionEnabled', 'canLaunch', 'canSign', 'canSubmit', 'canRetry']) assert.equal(value[key], false, key)
}
// Dedicated disposable local PostgreSQL only; never consume application DATABASE_URL.
test('selected-hook wallet journal retains config-only settlement and exact wire without execution authority', async t => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `selected_wallet_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    for (const file of ['hooklab-wallet-principal-schema.sql', 'hooklab-wallet-preparation-schema.sql'])
      await pool.query(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
    const f = selectedHookPreparationReceiptFixture(), input = { preparationInput: f.preparationInput, signedTransactionBase64: f.signedTransactionBase64 }
    const record = deriveCustomPreparationRecord(f.preparationInput, f.expectedProfileSha256)
    const signed = verifyHookLabSignedMessage(record.plan.review, f.signedTransactionBase64)
    const token = Buffer.alloc(32, 61).toString('base64url'), foreignToken = Buffer.alloc(32, 62).toString('base64url')
    const digest = v => createHash('sha256').update(v).digest('hex'), id = randomUUID()
    for (const [session, wallet] of [[token, input.preparationInput.request.creator], [foreignToken, input.preparationInput.request.mint]])
      await pool.query(`insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at)
        values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')`,
      [digest(session), wallet, record.plan.review.genesisHash])
    let unavailable = true, persistedBeforeRead = 0
    const row = async () => (await pool.query('select * from hook_lab_wallet_preparations where id=$1', [id])).rows[0]
    const rpc = selectedHookPreparationRpcProviders(f, { beforeRead: async () => {
      if (unavailable) {
        const stored = await row()
        assert.equal(stored.signed_transaction, f.signedTransactionBase64)
        assert.equal(stored.signed_transaction_sha256, signed.signedTransactionSha256)
        persistedBeforeRead++
        throw Error('Synthetic read unavailable')
      }
    } })
    const settings = { enabled: true, origin: 'https://repo.ing', providers: rpc.providers, expectedProfileSha256: f.expectedProfileSha256 }
    let journal = coLocatedWalletPreparationJournal(pool, settings)
    await t.test('wire is committed before unavailable reads; identity survives a new pool and journal', async () => {
      const result = await journal.collectAndRetain(token, id, input)
      disabled(result); assert.equal(result.status, 'unresolved'); assert.ok(persistedBeforeRead >= 2)
      const stored = await row()
      assert.equal(stored.profile_sha256, f.expectedProfileSha256)
      assert.deepEqual(stored.providers, f.expectedProviders)
      assert.equal(stored.message_sha256, record.plan.review.messageSha256)
      assert.equal(stored.intent_sha256, record.plan.review.intentSha256)
      assert.equal(stored.preparation_input_sha256, record.preparationInputSha256)
      assert.equal(stored.signature, signed.signature)
      assert.deepEqual(stored.preparation_input, f.preparationInput)
      await pool.end(); pool = new pg.Pool({ ...config, database })
      journal = coLocatedWalletPreparationJournal(pool, settings)
      assert.deepEqual(await journal.get(token, id), result)
      await assert.rejects(journal.resolveForLaunch(token, id))
    })
    await t.test('foreign, revoked, and changed identities fail without RPC or replacement wire', async () => {
      const count = rpc.calls.length
      for (const method of ['get', 'reconcile', 'resolveForLaunch']) await assert.rejects(journal[method](foreignToken, id))
      await assert.rejects(journal.collectAndRetain(foreignToken, id, input))
      await pool.query('update hook_lab_wallet_sessions set revoked_at=clock_timestamp() where token_sha256=$1', [digest(token)])
      await assert.rejects(journal.get(token, id))
      await pool.query('update hook_lab_wallet_sessions set revoked_at=null where token_sha256=$1', [digest(token)])
      const changed = structuredClone(input); changed.preparationInput.request.label = 'Changed'
      await assert.rejects(journal.collectAndRetain(token, id, changed))
      const extra = structuredClone(input); extra.preparationInput.request.extra = true
      await assert.rejects(journal.collectAndRetain(token, id, extra))
      const wire = Buffer.from(f.signedTransactionBase64, 'base64'); wire[5] ^= 1
      await assert.rejects(journal.collectAndRetain(token, id, { ...input, signedTransactionBase64: wire.toString('base64') }))
      await assert.rejects(coLocatedWalletPreparationJournal(pool, { ...settings, expectedProfileSha256: '0'.repeat(64) }).get(token, id))
      await assert.rejects(coLocatedWalletPreparationJournal(pool, { ...settings, providers: [...rpc.providers].reverse() }).get(token, id))
      assert.equal(rpc.calls.length, count)
      assert.equal((await row()).signed_transaction, f.signedTransactionBase64)
    })
    await t.test('restart reconciliation settles only config rent 2000 plus fee 10000 and resolves exact handoff', async () => {
      unavailable = false
      const result = await journal.reconcile(token, id)
      disabled(result); assert.equal(result.status, 'candidate-preparation-matched')
      assert.equal(result.sessionAuthorization, 'co-located-transaction-lock')
      assert.deepEqual(result.preparedRequest, input.preparationInput.request)
      const stored = await row(), evidence = stored.retained_evidence
      assert.equal(evidence.rentLamports, '2000'); assert.equal(evidence.totalDebitLamports, '12000')
      assert.equal(evidence.observations[0].transaction.feeLamports, '10000')
      assert.deepEqual(Object.keys(record.expectedAccounts), ['selectedConfig'])
      const resolved = await journal.resolveForLaunch(token, id)
      assert.deepEqual(resolved, { id, wallet: result.wallet, signature: signed.signature, profileSha256: f.expectedProfileSha256,
        preparationIntentSha256: record.plan.review.intentSha256, preparedRequest: input.preparationInput.request,
        executionSlot: evidence.finalizedSlot, preparedAccountHashes: evidence.matchedAccountHashes })
      for (const key of ['signedTransactionBase64', 'unsignedLaunchMessage', 'canSign', 'canSubmit', 'executionAuthorized']) assert.equal(Object.hasOwn(resolved, key), false)
      assert.deepEqual(Object.keys(journal).sort(), ['collectAndRetain', 'get', 'reconcile', 'resolveForLaunch'])
      await assert.rejects(journal.collectAndRetain(token, randomUUID(), input))
      await assert.rejects(pool.query('update hook_lab_wallet_preparations set signed_transaction=$2 where id=$1', [id, 'changed']))
    })
    await t.test('changed signed inclusion, config or registry is sticky, retains original settlement, and blocks handoff', async () => {
      const retained = (await row()).retained_evidence
      for (const kind of ['transaction', 'config', 'registry']) {
        const original = structuredClone(f.observations)
        for (const o of f.observations) {
          if (kind === 'transaction') {
            const wire = Buffer.from(o.transaction.signedTransactionBase64, 'base64')
            wire[5] ^= 1; o.transaction.signedTransactionBase64 = wire.toString('base64')
          }
          else {
            const a = o.snapshot.accounts[kind === 'config' ? 0 : 1], b = Buffer.from(a.dataBase64, 'base64')
            b[b.length - 1] ^= 1; a.dataBase64 = b.toString('base64')
          }
        }
        const result = await journal.reconcile(token, id)
        disabled(result); assert.equal(result.status, 'review-required'); assert.equal(result.lastCollectionPrelaunchEligible, false)
        assert.equal((await row()).latest_evidence.reasonCode, kind === 'transaction' ? 'IDENTITY_MISMATCH' : 'STATE_MISMATCH')
        f.observations = original
      }
      const first = (await row()).first_conflict
      assert.equal((await journal.reconcile(token, id)).status, 'review-required')
      await assert.rejects(journal.resolveForLaunch(token, id))
      assert.deepEqual((await row()).first_conflict, first)
      assert.deepEqual((await row()).retained_evidence, retained)
      await assert.rejects(pool.query('update hook_lab_wallet_preparations set evidence_conflict=false,first_conflict=null where id=$1', [id]))
      assert.deepEqual([...new Set(rpc.calls.map(c => c.method))].sort(),
        ['getBlockSignatures', 'getGenesisHash', 'getMultipleAccountsInfoAndContext', 'getTransaction'])
    })
  } finally {
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})
