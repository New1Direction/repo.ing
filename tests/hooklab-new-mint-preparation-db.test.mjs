import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID,createHash } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { nativeSignerCustodyStore } from '../src/hooklab-native-signer-custody-store.mjs'
import { reviewNewMintPreparationCandidate } from '../src/hooklab-new-mint-preparation.mjs'
import { maxWalletPreparationReceiptFixture } from './fixtures/hooklab-max-wallet-preparation-receipts.mjs'
import { fakePlanningReaders } from './fixtures/hooklab-max-wallet-planning-readers.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
const token=Buffer.alloc(32,19).toString('base64url'),digest=createHash('sha256').update(token).digest('hex'),seedLabel='new-mint-candidate'
const testSigner=role=>Keypair.fromSeed(createHash('sha256').update(`max-wallet RECEIPT TEST FIXTURE ONLY: ${seedLabel}:${role}`).digest())
test('new mint reserves once durably, collects exact preparation, freezes intent, refreshes safely and survives failure without replacement',async()=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`new_mint_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  for(const file of ['hooklab-wallet-principal-schema.sql','hooklab-native-signer-custody-schema.sql','hooklab-new-mint-preparation-schema.sql'])await pool.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'))
  const f=maxWalletPreparationReceiptFixture({samePayer:true,seedLabel}).preparationInput
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[digest,f.request.creator,JSON.parse(f.profile.json).genesisHash])
  let generated=0
  const settings={enabled:true,origin:'https://repo.ing',keyRing:{test_only:Buffer.alloc(32,25)},activeKeyId:'test_only',signerFactory:()=>{generated++;return {mint:testSigner('mint'),selectedConfig:testSigner('selectedConfig')}}}
  const custody=nativeSignerCustodyStore(pool,settings),input={operationId:randomUUID(),capBps:f.request.capBps,label:f.request.label}
  const args={custody,sessionToken:token,input,profile:f.profile,connections:fakePlanningReaders(f),limits:f.limits,clock:()=>1000}
  const one=await reviewNewMintPreparationCandidate(args)
  assert.equal(generated,1);assert.deepEqual(one.request,f.request);assert.equal(one.custody.stage,'preparation-reviewed')
  assert.equal(one.productionUnsignedMessage,null);assert.equal(one.canSign,false)
  const two=await reviewNewMintPreparationCandidate({...args,custody:nativeSignerCustodyStore(pool,settings)})
  assert.equal(generated,1);assert.equal(two.custody.mint,one.custody.mint);assert.equal(Number(two.custody.revision),Number(one.custody.revision)+1)
  await assert.rejects(reviewNewMintPreparationCandidate({...args,input:{...input,capBps:input.capBps+1}}))
  assert.equal(generated,1)
  await assert.rejects(reviewNewMintPreparationCandidate({...args,connections:fakePlanningReaders(f,(kind,x)=>{if(kind==='valid')x.value=false})}))
  assert.deepEqual(await custody.get(token,input.operationId),two.custody)
  await assert.rejects(pool.query('update hook_lab_native_signer_custody set preparation_request=$2,revision=revision+1 where operation_id=$1',[input.operationId,{...f.request,label:'changed'}]))
  await custody.advanceCandidate(token,input.operationId,{expectedRevision:two.custody.revision,stage:'preparation-signed',evidenceSha256:'f'.repeat(64)})
  await assert.rejects(reviewNewMintPreparationCandidate(args));assert.equal(generated,1)
 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})
