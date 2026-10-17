import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { walletPreparationJournal } from '../src/hooklab-wallet-preparation.mjs'
import { maxWalletPreparationReceiptFixture, maxWalletPreparationRpcProviders } from './fixtures/hooklab-max-wallet-preparation-receipts.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
const disabled=value=>{for(const key of ['productionAccepted','preparationReceiptAccepted','collectionAuthenticated','eligibleForProductionLaunch','executionAuthorized','publicExecutionEnabled','canLaunch','canSign','canSubmit','canRetry'])assert.equal(value[key],false,key)}
test('wallet-owned evidence is collected through two configured readers, durable and never authorizes production',async t=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`wallet_preparation_${randomUUID().replaceAll('-','')}`
 let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  await pool.query(await readFile(new URL('../src/hooklab-wallet-preparation-schema.sql',import.meta.url),'utf8'))
  const f=maxWalletPreparationReceiptFixture({lookupTable:true,seedLabel:'wallet-owned-journal'}),rpc=maxWalletPreparationRpcProviders(f)
  let owner=f.preparationInput.request.creator,allowed=true
  const principalStore={resolve:async session=>{assert.equal(session,'synthetic-session');if(!allowed)throw Error('expired');return{kind:'wallet',wallet:owner,audience:'general-launcher',genesisHash:HOOK_MAINNET_GENESIS}}}
  const settings={enabled:true,principalStore,providers:rpc.providers,expectedProfileSha256:f.expectedProfileSha256}
  const journal=walletPreparationJournal(pool,settings),id=randomUUID(),input={preparationInput:f.preparationInput,signedTransactionBase64:f.signedTransactionBase64}
  await t.test('default off and foreign wallet fail before collection',async()=>{
   await assert.rejects(walletPreparationJournal(pool,{...settings,enabled:false}).collectAndRetain('synthetic-session',id,input))
   const previous=owner;owner=f.preparationInput.request.mint
   await assert.rejects(journal.collectAndRetain('synthetic-session',id,input));owner=previous;assert.equal(rpc.calls.length,0)
   await assert.rejects(journal.collectAndRetain('synthetic-session',id,{...input,observations:f.observations}));assert.equal(rpc.calls.length,0)
  })
  await t.test('exact two-provider read-only collection survives restart and exposes only safe summary',async()=>{
   const result=await journal.collectAndRetain('synthetic-session',id,input);disabled(result)
   assert.equal(result.status,'candidate-preparation-matched');assert.equal(rpc.calls.length,8);assert.equal(result.lastCollectionPrelaunchEligible,true)
   for(const key of ['preparation_input','signed_transaction','latest_evidence','observations'])assert.equal(Object.hasOwn(result,key),false)
   const second=await walletPreparationJournal(pool,settings).get('synthetic-session',id);assert.deepEqual(second,result)
  })
  await t.test('owner isolation and revoked session prevent reads and re-collection',async()=>{
   const previous=owner;owner=f.preparationInput.request.mint
   await assert.rejects(journal.get('synthetic-session',id));await assert.rejects(journal.reconcile('synthetic-session',id));owner=previous
   allowed=false;await assert.rejects(journal.get('synthetic-session',id));allowed=true
  })
  await t.test('collection failure retains original finalized evidence and closes last collection eligibility',async()=>{
   const original=rpc.providers[0].connection.getGenesisHash;rpc.providers[0].connection.getGenesisHash=async()=>{throw Error('private endpoint')}
   const result=await journal.reconcile('synthetic-session',id);disabled(result);assert.equal(result.status,'unresolved');assert.equal(result.retainedFinalizedEvidence,true);assert.equal(result.lastCollectionPrelaunchEligible,false)
   rpc.providers[0].connection.getGenesisHash=original
   assert.equal((await journal.reconcile('synthetic-session',id)).status,'candidate-preparation-matched')
  })
  await t.test('session revoked during provider reads cannot update durable evidence',async()=>{
   const before=await journal.get('synthetic-session',id),original=rpc.providers[0].connection.getGenesisHash
   rpc.providers[0].connection.getGenesisHash=async(...args)=>{allowed=false;return original(...args)}
   await assert.rejects(journal.reconcile('synthetic-session',id));allowed=true;rpc.providers[0].connection.getGenesisHash=original
   assert.deepEqual(await journal.get('synthetic-session',id),before)
  })
  await t.test('revocation while waiting for the collection write lock prevents commit',async()=>{
   const before=await journal.get('synthetic-session',id),lock=await pool.connect(),original=rpc.providers[0].connection.getGenesisHash
   let acquired;const ready=new Promise(resolve=>{acquired=resolve})
   rpc.providers[0].connection.getGenesisHash=async(...args)=>{
    await lock.query('begin');await lock.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`wallet-preparation:${id}`]);acquired();return original(...args)
   }
   try{
    const pending=journal.reconcile('synthetic-session',id),rejected=assert.rejects(pending)
    await ready
    let blocked=false
    for(let i=0;i<100;i++){
     const {rows:[row]}=await pool.query("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory') as blocked")
     if(row.blocked){blocked=true;break}await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(blocked,true);allowed=false;await lock.query('commit');await rejected
   }finally{allowed=true;rpc.providers[0].connection.getGenesisHash=original;await lock.query('rollback');lock.release()}
   assert.deepEqual(await journal.get('synthetic-session',id),before)
  })
  await t.test('duplicate operation and immutable identity cannot create a second retained mint',async()=>{
   await assert.rejects(journal.collectAndRetain('synthetic-session',randomUUID(),input))
   await assert.rejects(pool.query('update hook_lab_wallet_preparations set owner_wallet=$2 where id=$1',[id,f.preparationInput.request.mint]))
  })
  await t.test('provider disagreement preserves first conflict permanently even after later matching observations',async()=>{
   const original=f.observations[0].transaction.feeLamports
   f.observations[0].transaction.feeLamports=String(BigInt(original)+1n)
   const result=await journal.reconcile('synthetic-session',id);assert.equal(result.status,'review-required');disabled(result)
   const first=(await pool.query('select first_conflict from hook_lab_wallet_preparations where id=$1',[id])).rows[0].first_conflict
   assert.ok(first)
   f.observations[0].transaction.feeLamports=original
   const later=await journal.reconcile('synthetic-session',id);assert.equal(later.status,'review-required');assert.equal(later.lastCollectionPrelaunchEligible,false)
   assert.deepEqual((await pool.query('select first_conflict from hook_lab_wallet_preparations where id=$1',[id])).rows[0].first_conflict,first)
   await assert.rejects(pool.query('update hook_lab_wallet_preparations set evidence_conflict=false,first_conflict=null where id=$1',[id]))
  })
  await t.test('first-collection disagreement is sticky without earlier finalized evidence',async()=>{
   const fresh=maxWalletPreparationReceiptFixture({lookupTable:true,seedLabel:'first-disagreement'}),readers=maxWalletPreparationRpcProviders(fresh),freshId=randomUUID(),previousOwner=owner
   owner=fresh.preparationInput.request.creator
   const firstJournal=walletPreparationJournal(pool,{...settings,providers:readers.providers})
   const fee=fresh.observations[0].transaction.feeLamports;fresh.observations[0].transaction.feeLamports=String(BigInt(fee)+1n)
   const result=await firstJournal.collectAndRetain('synthetic-session',freshId,{preparationInput:fresh.preparationInput,signedTransactionBase64:fresh.signedTransactionBase64})
   assert.equal(result.status,'review-required');assert.equal(result.retainedFinalizedEvidence,false)
   fresh.observations[0].transaction.feeLamports=fee
   const later=await firstJournal.reconcile('synthetic-session',freshId);assert.equal(later.status,'review-required');assert.equal(later.lastCollectionPrelaunchEligible,false)
   owner=previousOwner
  })
 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})
