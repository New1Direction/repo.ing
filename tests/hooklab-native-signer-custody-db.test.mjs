import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash,randomUUID } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { nativeSignerCustodyStore } from '../src/hooklab-native-signer-custody-store.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
const key=n=>Keypair.fromSeed(Buffer.alloc(32,n)),owner=key(1).publicKey.toBase58(),token=Buffer.alloc(32,12).toString('base64url'),digest=createHash('sha256').update(token).digest('hex')
const ring={test_v1:Buffer.alloc(32,7),test_v2:Buffer.alloc(32,8)},profile='a'.repeat(64),signers=()=>({mint:key(2),selectedConfig:key(3)})
test('encrypted server signers survive multi-stage preparation, restart, rotation and uncertain outcomes without timeout erasure',async t=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`native_custody_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  for(const file of ['hooklab-wallet-principal-schema.sql','hooklab-native-signer-custody-schema.sql'])await pool.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'))
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[digest,owner,HOOK_MAINNET_GENESIS])
  const options={enabled:true,origin:'https://repo.ing',keyRing:ring,activeKeyId:'test_v1'},store=nativeSignerCustodyStore(pool,options),id=randomUUID()
  await assert.rejects(nativeSignerCustodyStore(pool,{...options,enabled:false}).retainServerSigners(token,id,profile,signers()))
  let current=await store.retainServerSigners(token,id,profile,signers());assert.equal(current.stage,'reserved');assert.equal(current.canSign,false)
  const saved=(await pool.query('select * from hook_lab_native_signer_custody where operation_id=$1',[id])).rows[0]
  for(const signer of Object.values(signers()))assert.ok(!JSON.stringify(saved).includes(Buffer.from(signer.secretKey).toString('base64')))
  assert.equal(Object.hasOwn(current,'sealed_signers'),false);assert.equal(Object.hasOwn(current,'secretKey'),false)
  assert.deepEqual(await nativeSignerCustodyStore(pool,options).get(token,id),current)
  for(const stage of ['preparation-reviewed','preparation-signed','preparation-finalized','launch-reviewed']){
   current=await store.advanceCandidate(token,id,{expectedRevision:current.revision,stage,evidenceSha256:'b'.repeat(64)})
   assert.equal(current.stage,stage);assert.equal(current.encryptedSignersRetained,true);assert.equal(current.ownerCustodyApprovalVerified,false)
  }
  await assert.rejects(store.advanceCandidate(token,id,{expectedRevision:'0',stage:'launch-signed',evidenceSha256:'b'.repeat(64)}))
  const rotatedStore=nativeSignerCustodyStore(pool,{...options,activeKeyId:'test_v2'})
  current=await rotatedStore.rotateKey(token,id,current.revision);assert.equal(current.keyId,'test_v2')
  await assert.rejects(nativeSignerCustodyStore(pool,{...options,keyRing:{test_v1:ring.test_v1}}).get(token,id))
  current=await rotatedStore.advanceCandidate(token,id,{expectedRevision:current.revision,stage:'launch-signed',evidenceSha256:'c'.repeat(64)})
  current=await rotatedStore.advanceCandidate(token,id,{expectedRevision:current.revision,stage:'reconcile-required',evidenceSha256:'d'.repeat(64)})
  await pool.query("update hook_lab_wallet_sessions set expires_at=clock_timestamp()-interval '1 second' where token_sha256=$1",[digest])
  await assert.rejects(rotatedStore.get(token,id))
  assert.equal((await pool.query('select sealed_signers is not null as retained from hook_lab_native_signer_custody where operation_id=$1',[id])).rows[0].retained,true)
  await pool.query("update hook_lab_wallet_sessions set expires_at=clock_timestamp()+interval '30 minutes' where token_sha256=$1",[digest])
  assert.deepEqual(await rotatedStore.get(token,id),current)
  await assert.rejects(rotatedStore.advanceCandidate(token,id,{expectedRevision:current.revision,stage:'reserved',evidenceSha256:'e'.repeat(64)}))
  const history=(await pool.query('select revision,stage from hook_lab_native_signer_custody_history where operation_id=$1 order by revision',[id])).rows
  assert.equal(history.length,Number(current.revision)+1)
  assert.equal(history[0].stage,'reserved');assert.equal(history.at(-1).stage,'reconcile-required')
  const second=randomUUID(),secondSigners={mint:key(5),selectedConfig:key(6)}
  const reserved=await rotatedStore.retainServerSigners(token,second,profile,secondSigners)
  const attempts=await Promise.allSettled([1,2].map(()=>rotatedStore.advanceCandidate(token,second,{expectedRevision:reserved.revision,stage:'preparation-reviewed',evidenceSha256:'f'.repeat(64)})))
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1)
  assert.equal(attempts.filter(result=>result.status==='rejected').length,1)
  await assert.rejects(pool.query('update hook_lab_native_signer_custody set mint=$2,revision=revision+1 where operation_id=$1',[id,key(4).publicKey.toBase58()]))
 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})
