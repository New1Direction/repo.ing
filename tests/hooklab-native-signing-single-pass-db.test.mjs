// Single-pass launch signing (2026-10-27): after the wallet's signature is retained, one server call adds the custody
// co-signatures and submits, revalidating the chain evidence once instead of once per step, so a launch fits its review
// lease. Synthetic signers and injected transports only; no RPC or live keys.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID,createHash,createPrivateKey,sign } from 'node:crypto'
import { Keypair,VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { planMaxWalletPreparation } from '../src/hooklab-max-wallet-preparation.mjs'
import { maxWalletPreparationReceiptFixture } from './fixtures/hooklab-max-wallet-preparation-receipts.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
const test = testRequiring(missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json']))
const token=Buffer.alloc(32,29).toString('base64url'),digest=createHash('sha256').update(token).digest('hex'),seedLabel='native-signing'
const seed=role=>createHash('sha256').update(`max-wallet RECEIPT TEST FIXTURE ONLY: ${seedLabel}:${role}`).digest()
const testSigner=role=>Keypair.fromSeed(seed(role))
const signFor=(role,message)=>sign(null,message,createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed(role)]),format:'der',type:'pkcs8'}))
function currentFixture(){const f=maxWalletPreparationReceiptFixture({samePayer:true,seedLabel}),now=Date.now();f.preparationInput.observations.forEach(x=>{x.observedAtMs=now});f.preparationInput.recentBlockhash.observedAtMs=now;Object.assign(f.preparationInput.limits,{nowMs:now,maxAgeMs:60000,reviewExpiresAtMs:now+60000});return f}

async function world(t,work){
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`native_single_pass_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  for(const file of ['hooklab-wallet-principal-schema.sql','hooklab-native-signing-schema.sql','hooklab-native-signing-attempt-schema.sql','hooklab-native-signing-context-schema.sql','hooklab-native-signing-refresh-schema.sql','hooklab-native-signing-wallet-request-schema.sql'])await pool.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'))
  const f=currentFixture(),review=planMaxWalletPreparation(f.preparationInput).review,owner=review.wallet
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[digest,owner,review.genesisHash])
  const counts={revalidate:0,signs:0,sends:0},state={leaseOk:true,signerFails:false},logs=[]
  const result={status:'operator-pins-and-state-verified',configurationSha256:'a'.repeat(64),settlementContext:{schema:'synthetic-test-only'},owner,stage:'preparation',profileSha256:review.profileSha256,messageSha256:review.messageSha256,review}
  const resolver={prepare:async()=>structuredClone(result),revalidate:async()=>{counts.revalidate++;if(!state.leaseOk)throw Object.assign(Error('Review lifetime differs'),{code:'MAX_WALLET_PREPARATION_UNAVAILABLE'});return structuredClone(result)}}
  const serverSigner={sign:async({signerAddress,message})=>{counts.signs++;if(state.signerFails)throw Error('lost callback');const role=['mint','selectedConfig'].find(r=>testSigner(r).publicKey.toBase58()===signerAddress);assert.ok(role);return signFor(role,message)}}
  const sender={send:async({signature})=>{counts.sends++;return signature}}
  const store=nativeSigningLifecycle(pool,{enabled:true,origin:'https://repo.ing',resolver,serverSigner,sender,log:line=>logs.push(line),logError:line=>logs.push(line)})
  const signed=async()=>{
   const id=randomUUID();await store.createReview(token,id,{custodyOperationId:randomUUID(),stage:'preparation'})
   const request=await store.walletRequest(token,id),tx=VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64,'base64'))
   tx.signatures[review.requiredSigners.indexOf(owner)]=signFor('creator',tx.message.serialize())
   await store.retainWalletSignature(token,id,Buffer.from(tx.serialize()).toString('base64'));return id
  }
  await work({store,counts,state,logs,signed,f,pool})
 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
}

test('per-step signing revalidates four times; the single pass revalidates twice and lands the same transaction',async t=>{
 await world(t,async({store,counts,signed,f})=>{
  // Before: wallet request, two co-signatures and the submit each revalidate.
  counts.revalidate=0;const stepwise=await signed()
  await store.coSignNext(token,stepwise,f.preparationInput.request.mint);await store.coSignNext(token,stepwise,f.preparationInput.request.selectedConfig)
  const viaSteps=await store.submitOnce(token,stepwise)
  assert.equal(counts.revalidate,4);assert.equal(viaSteps.status,'submitted')
  // After: the wallet request, then one pass for both co-signatures and the submit.
  counts.revalidate=0;counts.sends=0;counts.signs=0;const single=await signed()
  const done=await store.completeSigning(token,single)
  assert.equal(counts.revalidate,2,'one revalidation for the wallet request, one for the whole pass')
  assert.equal(done.status,'submitted');assert.ok(done.signature);assert.equal(counts.signs,2);assert.equal(counts.sends,1)
  assert.deepEqual([...done.signedBy].sort(),[...viaSteps.signedBy].sort())
  // Nothing is sent twice: the pass on a sent operation is refused.
  await assert.rejects(store.completeSigning(token,single));assert.equal(counts.sends,1)
 })
})

test('a lease refusal in the single pass signs and sends nothing and leaves the operation closable',async t=>{
 await world(t,async({store,counts,state,signed,logs})=>{
  const id=await signed();counts.signs=0;counts.sends=0;state.leaseOk=false
  await assert.rejects(store.completeSigning(token,id))
  assert.equal(counts.signs,0);assert.equal(counts.sends,0)
  const after=await store.get(token,id);assert.equal(after.status,'partial');assert.equal(after.signature,null)
  assert.ok(logs.some(line=>/refused native signing: MAX_WALLET_PREPARATION_UNAVAILABLE/.test(line)),'the real reason is logged')
 })
})

test('a lost custody signature stops the pass before any send, exactly like the per-step co-signature',async t=>{
 await world(t,async({store,counts,state,signed})=>{
  const id=await signed();counts.sends=0;state.signerFails=true
  await assert.rejects(store.completeSigning(token,id))
  assert.equal(counts.sends,0);assert.equal((await store.get(token,id)).status,'signing-unknown')
 })
})

test('each signing call logs one timing line split into chain, database, signing and send',async t=>{
 await world(t,async({store,logs,signed})=>{
  const id=await signed();logs.length=0;await store.completeSigning(token,id)
  const line=logs.find(x=>x.startsWith('Hook Lab timing native signing complete:'))
  assert.match(line,/revalidate \d+ms db \d+ms sign \d+ms send \d+ms total \d+ms/)
  assert.ok(!/postgres:|api-key/.test(logs.join('\n')))
 })
})
