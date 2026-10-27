import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { PublicKey } from '@solana/web3.js'
import { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { custodyBalance, recordCustodyCollection, recordCustodyPayout, recordDbcCustodyBatchCollection, verifyCustodySolvency } from '../src/custody-ledger.mjs'
import { CUSTODY_VAULT } from '../src/custody-settlement.mjs'
import * as settlement from '../src/custody-settlement.mjs'
import { dbcBatchFixture, dbcPayoutFixture } from './custody-evidence-fixture.mjs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { custodyCollectionBatches, custodyFeeCollections, custodyFeePayouts } from '../src/db/schema.mjs'

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

// Dedicated disposable Unix-socket cluster ONLY. No inherited DATABASE_URL or live RPC.
test('PostgreSQL DBC batch: atomic item accounting, replay, rollback, concurrent payouts and DAMM compatibility',
  { skip: !process.env.CUSTODY_BATCH_TEST_DATABASE_URL }, async () => {
    const url = new URL(process.env.CUSTODY_BATCH_TEST_DATABASE_URL)
    assert.equal(url.hostname, '')
    assert.equal(url.pathname, '/repoing_custody_batch_test')
    assert.match(url.searchParams.get('host'), /\/\.amp\/in\/dbc-batch-pg-[^/]+\/socket$/)
    const pool = new pg.Pool({ connectionString: url.href, max: 4 })
    const transaction = async fn => {
      const db = await pool.connect()
      try { await db.query('begin'); const value = await fn(db); await db.query('commit'); return value }
      catch (e) { await db.query('rollback'); throw e }
      finally { db.release() }
    }
    try {
      assert.equal((await pool.query('select current_database() db')).rows[0].db, 'repoing_custody_batch_test')
      assert.equal(typeof settlement.recordValidatedDbcCustodyBatchCollection, 'function')
      await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade')
      // Start at the deployed predecessor, then exercise the real journal upgrade.
      const predecessor = await mkdtemp(join(tmpdir(), 'repoing-custody-migrations-'))
      try {
        await cp(new URL('../drizzle/', import.meta.url), predecessor, { recursive: true })
        const journalPath = join(predecessor, 'meta/_journal.json')
        const journal = JSON.parse(await readFile(journalPath, 'utf8'))
        journal.entries = journal.entries.filter(entry => entry.idx <= 84)
        await writeFile(journalPath, JSON.stringify(journal))
        await migrate(drizzle(pool), { migrationsFolder: predecessor })
      } finally { await rm(predecessor, { recursive: true, force: true }) }
      const f = await dbcBatchFixture(), recipient = new PublicKey(Buffer.alloc(32, 210)).toBase58()
      for (const c of f.plan.claims) {
        const a = c.attribution
        await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
          values($1,'fixture','repo',$2,0,0,false,now())`, [a.repoId, `fixture/${a.repoId}`])
        await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol)
          values($1,'failed',$2,$3,$4,$4,'fixture','F')`, [a.repoId, a.mint, a.curve, a.previousOwner])
        await pool.query(`insert into repo_beneficiaries(github_repo_id,github_user_id,wallet,bound_at)
          values($1,1,$2,'2026-10-01T00:00:00Z')`, [a.repoId, recipient])
        await pool.query(`insert into fee_events(github_repo_id,signature,event_index,slot,amount_base_units,mint,pool,asset,kind)
          values($1,$2,0,1,1000,$3,$4,$5,'dbc_creator_quote')`, [a.repoId, `earned-${a.repoId}`, a.mint, a.curve, NATIVE_MINT.toBase58()])
      }
      // Seed an actual old-shape DAMM row before migrating, proving data and old API survive.
      const a = f.plan.claims[0].attribution, position = new PublicKey(Buffer.alloc(32, 220)).toBase58()
      await pool.query(`insert into graduated_migration_proofs(github_repo_id,curve,config,mint,pool,signature,slot,
        creator_position,creator_nft_account,creator_nft_mint,partner_position,partner_nft_account,partner_nft_mint)
        values(101,$1,$2,$3,$1,'synthetic-migration',1,$4,$4,$4,$4,$4,$4)`, [a.curve,a.config,a.mint,position])
      const old = { kind: 'vault-wsol-fee-collection', signature: 'legacy-damm', slot: 10, amount: 13n,
        owner: CUSTODY_VAULT, attribution: { repoId: '101', role: 'creator', mint: a.mint, curve: a.curve, position },
        beneficiaryPaid: false, vaultControlVerified: true }
      await transaction(db => recordCustodyCollection(db, old))
      const oldRow = (await pool.query('select * from custody_fee_collections')).rows[0]
      await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
      const journalBeforeRetry = (await pool.query('select * from drizzle.__drizzle_migrations order by id')).rows
      await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
      assert.deepEqual((await pool.query('select * from drizzle.__drizzle_migrations order by id')).rows, journalBeforeRetry)
      assert.deepEqual((await pool.query('select receipt from custody_fee_collections')).rows[0].receipt, oldRow.receipt)
      assert.equal((await transaction(db => recordCustodyCollection(db, old))).inserted, false)
      for (const table of [custodyCollectionBatches, custodyFeeCollections, custodyFeePayouts]) {
        const config = getTableConfig(table)
        const { rows } = await pool.query(`select column_name,is_nullable from information_schema.columns
          where table_schema='public' and table_name=$1 order by column_name`, [config.name])
        assert.deepEqual(rows, config.columns.map(c => ({ column_name: c.name, is_nullable: c.notNull ? 'NO' : 'YES' }))
          .sort((a, b) => a.column_name.localeCompare(b.column_name)))
        for (const key of config.primaryKeys) assert.equal((await pool.query(`select count(*)::int n from pg_constraint
          where conrelid=$1::regclass and contype='p' and conname=$2`, [config.name, key.getName()])).rows[0].n, 1)
      }

      const results = await Promise.all([settlement.recordValidatedDbcCustodyBatchCollection(pool, f), settlement.recordValidatedDbcCustodyBatchCollection(pool, f)])
      assert.deepEqual(results.map(r => r.inserted).sort(), [false, true])
      assert.equal((await pool.query('select count(*)::int n from custody_collection_batches')).rows[0].n, 1)
      assert.deepEqual((await pool.query("select item_index,amount::text from custody_fee_collections where phase='DBC' order by item_index")).rows,
        [{ item_index: 0, amount: '101' }, { item_index: 1, amount: '307' }])
      assert.equal((await pool.query('select count(*)::int n from repo_claims')).rows[0].n, 0, 'collection does not pay liabilities')
      await assert.rejects(custodyBalance(pool, '102'), /phase selection/)
      assert.deepEqual((await custodyBalance(pool, '102', { phase: 'all' })).creator, { collected: 307n, paid: 0n, held: 307n })
      assert.deepEqual((await custodyBalance(pool, '101', { phase: 'DAMM' })).creator, { collected: 13n, paid: 0n, held: 13n })

      const conflict = await dbcBatchFixture(); conflict.plan.claims[1].attribution.previousOwner = recipient
      await assert.rejects(settlement.recordValidatedDbcCustodyBatchCollection(pool, conflict), /conflict/)
      // A second valid receipt fails on its second INSERT: no header or first item may survive.
      const atomic = await dbcBatchFixture(); atomic.finality.signature = atomic.tx.transaction.signatures[0] = 'atomic-rollback'
      await pool.query(`create function reject_second_item() returns trigger language plpgsql as $$begin
        if new.signature='atomic-rollback' and new.item_index=1 then raise exception 'injected second item failure'; end if;
        return new; end$$; create trigger reject_second before insert on custody_fee_collections for each row execute function reject_second_item()`)
      await assert.rejects(settlement.recordValidatedDbcCustodyBatchCollection(pool, atomic), /second item failure/)
      assert.equal((await pool.query("select count(*)::int n from custody_collection_batches where signature='atomic-rollback'")).rows[0].n, 0)
      assert.equal((await pool.query("select count(*)::int n from custody_fee_collections where signature='atomic-rollback'")).rows[0].n, 0)
      await pool.query('drop trigger reject_second on custody_fee_collections; drop function reject_second_item()')

      const payout = (item, signature, amount) => ({ kind: 'vault-wsol-beneficiary-payment', signature, slot: 51,
        amount, collectionSignature: f.finality.signature, collectionItemIndex: item, attribution: f.plan.claims[item].attribution,
        beneficiary: recipient, beneficiaryBoundAt: '2026-10-01T00:00:00.000Z', beneficiaryPaid: true, vaultControlVerified: true })
      await assert.rejects(transaction(db => recordCustodyPayout(db, { ...payout(0, 'wrong-item', 1n), collectionItemIndex: 1 })), /attribution/)
      await assert.rejects(transaction(db => recordCustodyPayout(db, { ...payout(0, 'missing-item', 1n), collectionItemIndex: undefined })), /item/)
      await assert.rejects(transaction(db => recordCustodyPayout(db, { ...payout(0, 'wrong-beneficiary', 1n), beneficiary: CUSTODY_VAULT })), /beneficiary/)
      const concurrent = await Promise.allSettled([transaction(db => recordCustodyPayout(db, payout(0, 'payout-a', 70n))),
        transaction(db => recordCustodyPayout(db, payout(0, 'payout-b', 70n)))])
      assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1)
      assert.match(concurrent.find(r => r.status === 'rejected').reason.message, /balance/)
      const winning = (await pool.query("select signature from custody_fee_payouts where signature in ('payout-a','payout-b')")).rows[0].signature
      assert.equal((await transaction(db => recordCustodyPayout(db, payout(0, winning, 70n)))).inserted, false)
      await transaction(db => recordCustodyPayout(db, payout(1, 'payout-other', 307n)))
      assert.deepEqual((await custodyBalance(pool, '101', { phase: 'all' })).creator, { collected: 114n, paid: 70n, held: 44n })
      assert.deepEqual((await custodyBalance(pool, '101', { phase: 'DBC' })).creator, { collected: 101n, paid: 70n, held: 31n })
      assert.deepEqual((await custodyBalance(pool, '102', { phase: 'all' })).creator, { collected: 307n, paid: 307n, held: 0n })
      const paid = (await pool.query('select damm_amount_base_units::text as damm,evidence_source from repo_claims order by id')).rows
      assert.deepEqual(paid, [{ damm: '0', evidence_source: 'custody-dbc-receipt' }, { damm: '0', evidence_source: 'custody-dbc-receipt' }])
      const oldPayout = { ...payout(0, 'legacy-paid', 13n), collectionSignature: old.signature, collectionItemIndex: undefined, attribution: old.attribution }
      await transaction(db => recordCustodyPayout(db, oldPayout))
      assert.equal((await pool.query("select damm_amount_base_units::text as amount from repo_claims where claim_signature='legacy-paid'")).rows[0].amount, '13')

      // Real receipt -> owned SQL transaction -> beneficiary debit, not just a bare ledger fixture.
      const finalPayout = dbcPayoutFixture(f)
      const paidResults = await Promise.all([settlement.recordValidatedCustodyPayout(pool, finalPayout),
        settlement.recordValidatedCustodyPayout(pool, finalPayout)])
      assert.deepEqual(paidResults.map(r => r.inserted).sort(), [false, true])
      assert.equal(paidResults[0].receipt.collectionItemIndex, 0)
      assert.equal((await custodyBalance(pool, '101', { phase: 'all' })).creator.held, 0n)
      await assert.rejects(settlement.recordValidatedCustodyPayout(pool, dbcPayoutFixture(f, { amount: 1n, signature: 'drained' })), /balance/)
      await assert.rejects(transaction(db => recordCustodyPayout(db, { ...payout(0, winning, 71n) })), /conflict/)

      const partner = await dbcBatchFixture('partner')
      const partnerReceipt = (await settlement.recordValidatedDbcCustodyBatchCollection(pool, partner)).receipt
      assert.equal(partnerReceipt.authorityRisk, 'exposed-partner-authority')
      const partnerPayout = dbcPayoutFixture(partner, { amount: 43n, signature: 'partner-paid' })
      const partnerPaidReceipt = settlement.validateCustodyPayoutReceipt(partnerPayout)
      await assert.rejects(transaction(db => recordCustodyPayout(db, partnerPaidReceipt)), /partner beneficiary policy/)
      await settlement.recordValidatedCustodyPayout(pool, partnerPayout)
      assert.deepEqual((await custodyBalance(pool, '101', { phase: 'DBC' })).partner, { collected: 101n, paid: 43n, held: 58n })
      assert.equal((await pool.query("select count(*)::int n from repo_claims where claim_signature='partner-paid'")).rows[0].n, 0)
      const token = Buffer.alloc(AccountLayout.span)
      AccountLayout.encode({ mint: NATIVE_MINT, owner: new PublicKey(CUSTODY_VAULT), amount: 365n,
        delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 1, isNative: 1488440n,
        delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, token)
      assert.equal(await verifyCustodySolvency(pool, { getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: token }) }), 365n)

      const receipt = results[0].receipt
      await assert.rejects(transaction(db => recordCustodyCollection(db, receipt.items[0])), /atomic batch/)
      await assert.rejects(transaction(db => recordDbcCustodyBatchCollection(db, { ...receipt, items: [receipt.items[0], receipt.items[0]] })), /batch items/)
      await assert.rejects(transaction(db => recordDbcCustodyBatchCollection(db, { ...receipt, beneficiaryPaid: true })), /batch/)
      const wrongRepo = await dbcBatchFixture(); wrongRepo.plan.claims[1].attribution.repoId = '101'
      await assert.rejects(settlement.recordValidatedDbcCustodyBatchCollection(pool, wrongRepo), /market attribution/)
      const crossLedger = await dbcBatchFixture(); crossLedger.finality.signature = crossLedger.tx.transaction.signatures[0] = winning
      await assert.rejects(settlement.recordValidatedDbcCustodyBatchCollection(pool, crossLedger), /another ledger/)
      const malformed = await dbcBatchFixture(); malformed.tx.meta.postTokenBalances.at(-1).uiTokenAmount.amount = '426'
      await assert.rejects(settlement.recordValidatedDbcCustodyBatchCollection(pool, malformed), /DBC custody/)

      // SQL itself refuses a committed header with missing items, not just wrapper rollback.
      await assert.rejects(transaction(db => db.query(`insert into custody_collection_batches(signature,item_count,amount,slot,receipt)
        values('partial',2,408,50,'{}')`)), /Incomplete DBC/)
      assert.equal((await pool.query("select count(*)::int n from custody_collection_batches where signature='partial'")).rows[0].n, 0)
      await assert.rejects(transaction(db => db.query("update custody_collection_batches set receipt='{}' where signature=$1", [receipt.signature])), /immutable/)
      await assert.rejects(transaction(db => db.query("update custody_fee_collections set receipt='{}' where signature=$1", [receipt.signature])), /immutable/)
      await assert.rejects(transaction(db => db.query("delete from custody_fee_collections where signature=$1 and item_index=1", [partnerReceipt.signature])), /immutable/)
      await assert.rejects(transaction(db => db.query("delete from custody_fee_payouts where signature='partner-paid'")), /immutable/)
      await assert.rejects(transaction(db => db.query("update custody_fee_payouts set amount=1 where signature='partner-paid'")), /immutable/)
      await assert.rejects(transaction(db => db.query("update repo_claims set damm_amount_base_units=amount_base_units where claim_signature='synthetic-dbc-payout'")), /repo_claims_custody_evidence/)
      await assert.rejects(transaction(db => db.query(`insert into custody_fee_payouts(signature,collection_signature,beneficiary,amount,slot,receipt)
        values('not-addressable',$1,$2,1,51,'{}')`, [receipt.signature, recipient])), /custody_payout_collection_item_fk/)
    } finally { await pool.end() }
  })

// 2026-10-27: the vault's WSOL moved to the team wallet (owner decision, STATUS 2026-10-26), so the vault check failed and every
// market's builder fees read "verifying", including markets with nothing in custody. Only a market holding custody funds depends on it.
test('only a market with funds still held in custody depends on the vault holding them', async () => {
  const { holdsCustodyFunds } = await import('../src/custody-ledger.mjs')
  const role = held => ({ collected: held, paid: 0n, held })
  assert.equal(holdsCustodyFunds(null), false)
  assert.equal(holdsCustodyFunds({ creator: role(0n), partner: role(0n) }), false)
  assert.equal(holdsCustodyFunds({ creator: { collected: 50n, paid: 50n, held: 0n }, partner: role(0n) }), false, 'fully paid out')
  assert.equal(holdsCustodyFunds({ creator: role(1n), partner: role(0n) }), true)
  assert.equal(holdsCustodyFunds({ creator: role(0n), partner: role(7n) }), true)
})
