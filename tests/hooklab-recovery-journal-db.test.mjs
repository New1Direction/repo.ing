import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { hookLabRecoveryJournal } from '../src/hooklab-recovery-journal.mjs'
import { HARDENED_MANIFEST_SHA256 } from '../src/hooklab-hardened.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Ephemeral offline signatures only; no RPC, funds, retained acceptance keys or app DATABASE_URL.
test('registered migration: durable journal ownership, byte binding, concurrency, audit rollback and reload', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `hooklab_recovery_test_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    const journal = hookLabRecoveryJournal(pool), owner = '101', id = randomUUID()
    const payer = Keypair.generate(), recipientKey = Keypair.generate(), recipient = recipientKey.publicKey
    const make = (lamports = 1) => new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.createAccount({ fromPubkey: payer.publicKey,
        newAccountPubkey: recipient, lamports, space: 0, programId: SystemProgram.programId })],
    }).compileToV0Message())
    const tx = make()
    const terms = { schema: 'repoing/hardened-recovery/1', network: 'devnet',
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', manifestSha256: HARDENED_MANIFEST_SHA256,
      operation: 'launch', wallet: payer.publicKey.toBase58(), mint: recipient.toBase58(), pool: recipient.toBase58(),
      observedSlot: '100', lastValidBlockHeight: '300', accountsSha256: 'a'.repeat(64), policySha256: 'b'.repeat(64),
      maxInput: '1', minimumOutput: '0', maxNativeDebitLamports: '10000', messageBase64: Buffer.from(tx.message.serialize()).toString('base64') }
    // This journal verifies storage identity/signatures, NOT the meaning of the dummy instruction.
    const [first, replay] = await Promise.all([journal.prepare(owner, id, terms), journal.prepare(owner, id, terms)])
    assert.deepEqual(first, replay)
    assert.equal((await journal.get(owner, id)).events.length, 1)
    assert.equal(await journal.get('202', id), null)
    await assert.rejects(journal.prepare('202', id, terms), { status: 404 })
    await assert.rejects(journal.prepare(owner, id, { ...terms, maxInput: '2' }), /changed/)
    await assert.rejects(journal.prepare(owner, randomUUID(), terms), /unique/)
    const second = make(2)
    await assert.rejects(journal.prepare(owner, randomUUID(), { ...terms, messageBase64: Buffer.from(second.message.serialize()).toString('base64') }), /unique/)
    await assert.rejects(journal.recordSigned(owner, id, Buffer.from(tx.serialize()).toString('base64')), /signature/)
    second.sign([payer, recipientKey])
    await assert.rejects(journal.recordSigned(owner, id, Buffer.from(second.serialize()).toString('base64')), /differs/)
    tx.sign([payer])
    await assert.rejects(journal.recordSigned(owner, id, Buffer.from(tx.serialize()).toString('base64')), /signature/)
    tx.sign([recipientKey])
    const signed = Buffer.from(tx.serialize()).toString('base64')
    await assert.rejects(journal.recordSigned(owner, id, Buffer.concat([Buffer.from(tx.serialize()), Buffer.from([0])]).toString('base64')), /Noncanonical/)
    // Storage/audit failure must not turn a prepared row into a possibly submitted one.
    await pool.query("alter table hook_lab_recovery_events add constraint fixture_failure check (kind <> 'signed')")
    await assert.rejects(journal.recordSigned(owner, id, signed), /fixture_failure/)
    assert.equal((await journal.get(owner, id)).status, 'prepared')
    await pool.query('alter table hook_lab_recovery_events drop constraint fixture_failure')
    const [recorded, retried] = await Promise.all([journal.recordSigned(owner, id, signed), journal.recordSigned(owner, id, signed)])
    assert.deepEqual(recorded, retried)
    assert.equal(recorded.status, 'unresolved')
    await assert.rejects(journal.recordSigned('202', id, signed), { status: 404 })
    await pool.query("update hook_lab_recovery_journal set created_at=now()-interval '400 days',updated_at=now()-interval '400 days'")
    await pool.end()
    pool = new pg.Pool({ ...config, database })
    const restored = await hookLabRecoveryJournal(pool).get(owner, id)
    assert.equal(restored.signature, recorded.signature)
    assert.equal(restored.signed_transaction, signed)
    assert.equal(restored.terms.messageBase64, terms.messageBase64)
    assert.deepEqual(restored.events.map(e => e.kind), ['prepared', 'signed'])
    assert.equal(restored.canRetry, false); assert.equal(restored.canSubmit, false); assert.equal(restored.chainVerified, false)
    assert.equal(await hookLabRecoveryJournal(pool).unresolvedCount(), '1')
    await pool.query(`update hook_lab_recovery_journal set terms=jsonb_set(terms,'{schema}','"future"') where id=$1`, [id])
    await assert.rejects(hookLabRecoveryJournal(pool).get(owner, id))
    await assert.rejects(hookLabRecoveryJournal(pool).recordSigned(owner, id, signed))
    assert.equal((await pool.query('select terms from hook_lab_recovery_journal where id=$1', [id])).rows[0].terms.schema, 'future')
  } finally {
    if (pool) await pool.end()
    await dropTestDatabase(admin, database)
    await admin.end()
  }
})
