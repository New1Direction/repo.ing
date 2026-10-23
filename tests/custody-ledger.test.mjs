import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { PublicKey } from '@solana/web3.js'
import { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { custodyBalance, recordCustodyCollection, recordCustodyPayout, verifyCustodySolvency } from '../src/custody-ledger.mjs'
import { CUSTODY_VAULT } from '../src/custody-settlement.mjs'

test('vault custody retains entitlement until verified beneficiary payment, with replay and overspend protection',
  { skip: !process.env.RECOVERY_TEST_DATABASE_URL }, async () => {
    const pool = new pg.Pool({ connectionString: process.env.RECOVERY_TEST_DATABASE_URL })
    const db = await pool.connect()
    try {
      assert.equal((await db.query('select current_database() as db')).rows[0].db, 'recovery_reconcile')
      await db.query('begin')
      const attribution = { repoId: '1391948723', role: 'creator', mint: 'HbtGZge2NcfrrmBGx2Pqf9qgrNvMa63hQHVqcWSPuNub',
        curve: '4b1hdxNQaqaktZX462dofh8WtZy2uUKivMid92Nv58it', position: 'D582TTbzngqBmHXix8bJasBe9ttyVxZhDEdyBWePvnCF' }
      // Validator contract fixtures, not evidence of a live executed transaction.
      const collection = { kind: 'vault-wsol-fee-collection', signature: 'local-collection', slot: 100,
        amount: 101n, owner: CUSTODY_VAULT, attribution, beneficiaryPaid: false, vaultControlVerified: true }
      assert.equal((await recordCustodyCollection(db, collection)).inserted, true)
      assert.equal((await recordCustodyCollection(db, collection)).inserted, false)
      assert.equal((await custodyBalance(db, attribution.repoId)).creator.held, 101n)
      const token = amount => {
        const data=Buffer.alloc(AccountLayout.span)
        AccountLayout.encode({mint:NATIVE_MINT,owner:new PublicKey(CUSTODY_VAULT),amount,delegateOption:0,
          delegate:PublicKey.default,state:1,isNativeOption:1,isNative:1488440n,delegatedAmount:0n,
          closeAuthorityOption:0,closeAuthority:PublicKey.default},data)
        return {owner:TOKEN_PROGRAM_ID,data}
      }
      await assert.rejects(verifyCustodySolvency(db,{getAccountInfo:async()=>token(100n)}),/balance/)
      assert.equal(await verifyCustodySolvency(db,{getAccountInfo:async()=>token(101n)}),101n)
      await assert.rejects(recordCustodyCollection(db, { ...collection, amount: 102n }), /conflict/)
      await assert.rejects(recordCustodyCollection(db, { ...collection, signature: 'unverified', vaultControlVerified: false }), /Custody/)
      const beneficiary = '4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce'
      await db.query(`insert into repo_beneficiaries(github_repo_id,github_user_id,wallet,bound_at)
        values($1,17,$2,'2026-10-01T00:00:00Z')`, [attribution.repoId, beneficiary])
      const payout = { kind: 'vault-wsol-beneficiary-payment', signature: 'local-payout', slot: 101,
        collectionSignature: collection.signature, attribution, amount: 37n, beneficiary,
        beneficiaryBoundAt: '2026-10-01T00:00:00.000Z', beneficiaryPaid: true, vaultControlVerified: true }
      assert.equal((await recordCustodyPayout(db, payout)).inserted, true)
      assert.equal((await recordCustodyPayout(db, payout)).inserted, false)
      assert.deepEqual((await custodyBalance(db, attribution.repoId)).creator, { collected: 101n, paid: 37n, held: 64n })
      const { rows: [row] } = await db.query("select amount_base_units::text as amount,damm_amount_base_units::text as damm,signed_transaction,evidence_source from repo_claims where claim_signature='local-payout'")
      assert.equal(row.amount, '37'); assert.equal(row.damm, '37'); assert.equal(row.signed_transaction, null)
      assert.equal(row.evidence_source, 'custody-receipt')
      await assert.rejects(recordCustodyPayout(db, { ...payout, signature: 'overspend', amount: 65n }), /balance/)
      await assert.rejects(recordCustodyPayout(db, { ...payout, signature: 'wrong-beneficiary', beneficiary: CUSTODY_VAULT }), /beneficiary/)
      await assert.rejects(recordCustodyPayout(db, { ...payout, signature: 'stale-binding', beneficiaryBoundAt: '2026-10-02T00:00:00.000Z' }), /beneficiary/)
      await assert.rejects(recordCustodyPayout(db, { ...payout, signature: 'wrong-role', attribution: { ...attribution, role: 'partner' } }), /attribution/)
      await assert.rejects(recordCustodyCollection(db, { ...collection, signature: 'wrong-position',
        attribution: { ...attribution, position: CUSTODY_VAULT } }), /attribution/)
      const partner = { ...collection, signature: 'partner-collection', attribution: { ...attribution, role: 'partner',
        position: '2LHAJURZAZfLuL1MY7qNrkgRk4EgijkuzKKNU9CNu8tk' }, amount: 43n }
      await recordCustodyCollection(db, partner)
      assert.deepEqual((await custodyBalance(db, attribution.repoId)).partner, { collected: 43n, paid: 0n, held: 43n })
      assert.equal((await custodyBalance(db, attribution.repoId)).creator.held, 64n)
    } finally { await db.query('rollback'); db.release(); await pool.end() }
  })
