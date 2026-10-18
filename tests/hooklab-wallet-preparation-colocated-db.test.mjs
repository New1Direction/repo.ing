import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID,createHash } from 'node:crypto'
import pg from 'pg'
import { coLocatedWalletPreparationJournal } from '../src/hooklab-wallet-preparation.mjs'
import { assessWalletLaunchPreparation } from '../src/hooklab-wallet-launch-assessment.mjs'
import { walletPrincipalStore } from '../src/hooklab-wallet-principal.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { maxWalletPreparationReceiptFixture,maxWalletPreparationRpcProviders } from './fixtures/hooklab-max-wallet-preparation-receipts.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const test = testRequiring(missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json']))
const token=Buffer.alloc(32,11).toString('base64url'),digest=createHash('sha256').update(token).digest('hex')
test('co-located evidence writes serialize real session revocation in the same database transaction',async t=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`wallet_colocated_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  for(const file of ['hooklab-wallet-principal-schema.sql','hooklab-wallet-preparation-schema.sql'])await pool.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'))
  const f=maxWalletPreparationReceiptFixture({lookupTable:true,seedLabel:'colocated-journal'}),rpc=maxWalletPreparationRpcProviders(f)
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[digest,f.preparationInput.request.creator,HOOK_MAINNET_GENESIS])
  const settings={enabled:true,origin:'https://repo.ing',providers:rpc.providers,expectedProfileSha256:f.expectedProfileSha256}
  const id=randomUUID(),journal=coLocatedWalletPreparationJournal(pool,settings)
  const first=await journal.collectAndRetain(token,id,{preparationInput:f.preparationInput,signedTransactionBase64:f.signedTransactionBase64})
  assert.equal(first.status,'candidate-preparation-matched');assert.equal(first.sessionAuthorization,'co-located-transaction-lock');assert.equal(first.eligibleForProductionLaunch,false)
  const principalStore=walletPrincipalStore(pool,{enabled:true,origin:settings.origin,audience:'general-launcher',genesisHash:HOOK_MAINNET_GENESIS})
  await t.test('actual durable preparation and two-reader refresh reach explicit adoption gate without launch bytes',async()=>{
   const assessment=await assessWalletLaunchPreparation({journal,sessionToken:token,input:{preparationId:id,request:f.preparationInput.request}})
   assert.equal(assessment.status,'blocked');assert.equal(assessment.unsignedLaunchMessage,null);assert.equal(assessment.canLaunch,false)
   assert.equal(assessment.preparation.preparationIntentSha256,first.preparationIntentSha256)
   assert.deepEqual(assessment.blockers.map(b=>b.code),['OPERATOR_DEPLOYMENT_APPROVAL_REQUIRED','PRODUCTION_LAUNCH_REVALIDATION_REQUIRED'])
  })
  await t.test('arbitrary principal-store override is rejected',async()=>{
   assert.throws(()=>coLocatedWalletPreparationJournal(pool,{...settings,principalStore:{resolve:async()=>({wallet:f.preparationInput.request.creator})}}))
  })
  await t.test('revoke waits for evidence transaction that already acquired session share lock',async()=>{
   let reached,release;const atWrite=new Promise(r=>{reached=r}),resume=new Promise(r=>{release=r})
   const wrapped={query:pool.query.bind(pool),connect:async()=>{const db=await pool.connect();return{release:()=>db.release(),query:async(sql,args)=>{const result=await db.query(sql,args);if(sql.startsWith('update hook_lab_wallet_preparations set')){reached();await resume}return result}}}}
   const pending=coLocatedWalletPreparationJournal(wrapped,settings).reconcile(token,id)
   await atWrite;let revoked=false;const revoke=principalStore.revoke(token).then(()=>{revoked=true})
   await new Promise(r=>setTimeout(r,50));assert.equal(revoked,false);release()
   assert.equal((await pending).status,'candidate-preparation-matched');await revoke;assert.equal(revoked,true)
   await assert.rejects(journal.get(token,id))
  })
  await t.test('revocation committed before session row lock prevents evidence eligibility read',async()=>{
   await pool.query('update hook_lab_wallet_sessions set revoked_at=null where token_sha256=$1',[digest])
   const blocker=await pool.connect()
   try{
    await blocker.query('begin');await blocker.query('update hook_lab_wallet_sessions set revoked_at=clock_timestamp() where token_sha256=$1',[digest])
    const pending=journal.get(token,id),rejected=assert.rejects(pending)
    await new Promise(r=>setTimeout(r,100));await blocker.query('commit');await rejected
   }finally{await blocker.query('rollback');blocker.release()}
  })
 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})
