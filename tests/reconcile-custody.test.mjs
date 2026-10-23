import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { PublicKey } from '@solana/web3.js'
import { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CUSTODY_VAULT } from '../src/custody-settlement.mjs'

test('reconciliation retains both phases of custody but counts only DAMM source withdrawals',
  { skip: !process.env.RECONCILE_CUSTODY_TEST_DATABASE_URL }, async t => {
    const url = new URL(process.env.RECONCILE_CUSTODY_TEST_DATABASE_URL)
    assert.equal(url.hostname, '')
    assert.equal(url.pathname, '/repoing_reconcile_custody_test')
    assert.match(url.searchParams.get('host'), /\/\.amp\/in\/reconcile-pg-[^/]+\/socket$/)
    const pool = new pg.Pool({ connectionString: url.href })
    const key = byte => new PublicKey(Buffer.alloc(32, byte))
    const config = key(201), mint = key(202), creator = key(203), position = key(204)
    const curve = deriveDbcPoolAddress(NATIVE_MINT, mint, config)
    const token = Buffer.alloc(AccountLayout.span)
    AccountLayout.encode({ mint: NATIVE_MINT, owner: new PublicKey(CUSTODY_VAULT), amount: 614n,
      delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 1, isNative: 1488440n,
      delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, token)
    const connection = { rpcEndpoint: 'http://127.0.0.1:1',
      getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: token }) }
    // Isolate external chain reads; reconciliation, migrations, queries and custody balances are real.
    const prototype = Object.getPrototypeOf(new DynamicBondingCurveClient(connection, 'finalized').state)
    t.mock.method(prototype, 'getPool', async () => ({ poolState: {
      config, baseMint: mint, creator, creatorQuoteFee: 35n } }))
    let graduated = { available: 47n, claimed: 101n, partner: { earned: 96n, claimed: 43n } }
    t.mock.module('../src/graduated-fees.mjs', { namedExports: {
      createGraduatedFees: () => ({ read: async () => graduated }),
    } })
    const { createReconciler, GRADUATED_WITHDRAWAL_MISMATCH, PARTNER_CAPTURE_MISMATCH } = await import('../src/reconcile.mjs')
    try {
      assert.equal((await pool.query('select current_database() db')).rows[0].db, 'repoing_reconcile_custody_test')
      await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade')
      await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
        values(101,'fixture','reconcile','fixture/reconcile',0,0,false,now())`)
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,
        token_name,token_symbol,indexed_at,launch_finality,launch_signature,launch_slot,last_verified_at)
        values(101,'confirmed',$1,$2,$3,$3,'Fixture','F',now(),'finalized','synthetic-launch',1,now())`,
      [mint.toBase58(), curve.toBase58(), creator.toBase58()])
      await pool.query(`insert into fee_events(github_repo_id,signature,event_index,slot,amount_base_units,mint,pool,asset,kind)
        values(101,'synthetic-earned',0,1,394,$1,$2,$3,'dbc_creator_quote')`, [mint.toBase58(), curve.toBase58(), NATIVE_MINT.toBase58()])
      await pool.query(`insert into platform_fee_events(github_repo_id,pool,position,slot,amount_base_units,
        cumulative_earned,cumulative_claimed,evidence_hash,evidence) values(101,$1,$2,1,96,96,43,'fixture','{}')`,
      [curve.toBase58(), position.toBase58()])
      const db = await pool.connect()
      try {
        await db.query('begin')
        await db.query(`insert into custody_collection_batches(signature,item_count,amount,slot,receipt)
          values('dbc',2,518,1,'{}')`)
        await db.query(`insert into custody_fee_collections(signature,item_index,phase,batch_signature,github_repo_id,role,position,amount,slot,receipt)
          values('dbc',0,'DBC','dbc',101,'creator',null,211,1,'{}'),('dbc',1,'DBC','dbc',101,'partner',null,307,1,'{}'),
          ('damm-creator',-1,'DAMM',null,101,'creator',$1,101,1,'{}'),('damm-partner',-1,'DAMM',null,101,'partner',$1,43,1,'{}')`,
        [position.toBase58()])
        for (const [signature, collection, index, amount, phase] of [
          ['dbc-paid','dbc',0,37,'custody-dbc-receipt'], ['damm-paid','damm-creator',-1,11,'custody-receipt'],
        ]) {
          await db.query(`insert into custody_fee_payouts(signature,collection_signature,collection_item_index,beneficiary,amount,slot,receipt)
            values($1,$2,$3,$4,$5,2,'{}')`, [signature,collection,index,creator.toBase58(),amount])
          await db.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,
            status,damm_amount_base_units,evidence_source,custody_payout_signature,settled_at)
            values(101,$1,$2,$3,$4,'settled',$5,$6,$4,now())`,
          [creator.toBase58(),amount,NATIVE_MINT.toBase58(),signature,index < 0 ? amount : 0,phase])
        }
        await db.query('commit')
      } catch (e) { await db.query('rollback'); throw e } finally { db.release() }
      const reconciler = createReconciler({ pool, connection, config,
        custodyRecovery: { version: 1, poolCreators: [], positions: [] } })
      const result = await reconciler.reconcile('101')
      assert.equal(result.status, 'MATCH')
      assert.equal(result.recordedClaimed, 48n)
      assert.equal(result.expectedRemaining, 346n)
      assert.equal(result.onchainCreatorFee, 346n)
      assert.deepEqual(result.platform, { earned: 96n, claimed: 43n, onchainEarned: 96n, onchainClaimed: 43n })
      graduated = { ...graduated, claimed: 102n }
      assert.equal((await reconciler.reconcile('101')).reason, GRADUATED_WITHDRAWAL_MISMATCH)
      graduated = { ...graduated, claimed: 101n, partner: { earned: 96n, claimed: 44n } }
      assert.equal((await reconciler.reconcile('101')).reason, PARTNER_CAPTURE_MISMATCH)
      graduated = null
      const curveOnly = await reconciler.reconcile('101')
      assert.equal(curveOnly.onchainCreatorFee, 299n)
      assert.equal(curveOnly.difference, -47n)
      assert.equal(curveOnly.status, 'MISMATCH')
    } finally { await pool.end() }
  })
