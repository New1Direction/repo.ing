import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { verifyHistoricalCollection, importHistoricalCollection } from '../src/historical-collection.mjs'

const transaction = JSON.parse(readFileSync(new URL('./fixtures/recovery/historical-damm-payout.json', import.meta.url))).result
const signature = '4WWqcKpFA6xqohrr5krgX6febhoBzLEJMvWB7Q2o6qCQN9H9N5t5rgQ1mqLonEgn3un1p7bSih1y5RWDx1nqvkcY'
export const historicalReview = {
  signature, transactionHash: '36377d2d1131fe7883d18b0b3075720d4e15961b8761232d7c1f1d2897a0902e',
  repoId: '1391948723', mint: 'HbtGZge2NcfrrmBGx2Pqf9qgrNvMa63hQHVqcWSPuNub',
  curve: '4b1hdxNQaqaktZX462dofh8WtZy2uUKivMid92Nv58it',
  pool: 'q15tXnaoDGRKph9LYMuFzDeyveGseTgoa1TKgoS8TfT',
  position: 'D582TTbzngqBmHXix8bJasBe9ttyVxZhDEdyBWePvnCF',
  source: 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1',
  receiver: '4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce',
  amount: '1558033552', dammClaimed: '76142012',
}
export const historicalEvidence = () => ({ transaction: structuredClone(transaction), review: { ...historicalReview },
  finality: { signature, slot: 459083368, confirmationStatus: 'finalized', err: null } })

test('historical payout proves money received separately from fees claimed, without an intent', () => {
  const receipt = verifyHistoricalCollection(historicalEvidence())
  assert.equal(receipt.amount, '1558033552')
  assert.equal(receipt.dammClaimed, '76142012')
  assert.equal(receipt.evidenceSource, 'historical-receipt')
  assert.equal(receipt.originalIntentAvailable, false)
  assert.equal(receipt.signature, signature)
  assert.equal(receipt.signedTransaction, undefined)
})

for (const field of ['receiver', 'source', 'position', 'pool']) test(`historical receipt rejects wrong ${field}`, () => {
  const input = historicalEvidence()
  input.review[field] = '11111111111111111111111111111111'
  assert.throws(() => verifyHistoricalCollection(input), /Historical/)
})
test('finality and full receipt hash are mandatory', () => {
  for (const change of [f => { f.finality.confirmationStatus = 'confirmed' },
    f => { f.transaction.meta.fee++ }, f => { f.review.amount = '76142012' },
    f => { f.review.dammClaimed = '1558033552' }]) {
    const f = historicalEvidence(); change(f)
    assert.throws(() => verifyHistoricalCollection(f), /Historical/)
  }
})
test('a re-reviewed transaction without the explicit beneficiary transfer is rejected', () => {
  const f = historicalEvidence()
  f.transaction.transaction.message.instructions.splice(4, 1)
  f.review.transactionHash = createHash('sha256').update(JSON.stringify(f.transaction)).digest('hex')
  assert.throws(() => verifyHistoricalCollection(f), /Historical/)
})

// Real PostgreSQL contract coverage is opt-in, and refuses non-disposable databases.
test('receipt-only import is idempotent, cannot manufacture a pending intent, and preserves existing evidence',
  { skip: !process.env.RECOVERY_TEST_DATABASE_URL }, async () => {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: process.env.RECOVERY_TEST_DATABASE_URL })
    const client = await pool.connect()
    try {
      assert.equal((await client.query('select current_database() as db')).rows[0].db, 'recovery_reconcile')
      await client.query('begin')
      const first = await importHistoricalCollection(client, historicalEvidence())
      assert.equal(first.inserted, true)
      assert.equal((await importHistoricalCollection(client, historicalEvidence())).inserted, false)
      const { rows: [row] } = await client.query('select * from builder_fee_collections where signature=$1', [signature])
      assert.equal(row.evidence_source, 'historical-receipt')
      assert.equal(row.signed_transaction, null)
      assert.equal(row.last_valid_block_height, null)
      assert.equal(row.expires_at, null)
      assert.equal(row.amount, '1558033552')
      await client.query('savepoint pending')
      await assert.rejects(client.query("update builder_fee_collections set status='pending',settled_at=null where signature=$1", [signature]))
      await client.query('rollback to pending')
      await client.query('savepoint conflict')
      await client.query("update builder_fee_collections set amount=1 where signature=$1", [signature])
      await assert.rejects(importHistoricalCollection(client, historicalEvidence()), /conflict/)
      await client.query('rollback to conflict')
    } finally { await client.query('rollback'); client.release(); await pool.end() }
  })
