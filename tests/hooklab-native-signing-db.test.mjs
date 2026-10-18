// Only deterministic synthetic signers and injected transports; no RPC or live keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID,createHash,createPrivateKey,sign } from 'node:crypto'
import { Keypair,VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { planMaxWalletPreparation } from '../src/hooklab-max-wallet-preparation.mjs'
import { maxWalletPreparationReceiptFixture } from './fixtures/hooklab-max-wallet-preparation-receipts.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
const token=Buffer.alloc(32,29).toString('base64url'),digest=createHash('sha256').update(token).digest('hex'),seedLabel='native-signing'
const seed=role=>createHash('sha256').update(`max-wallet RECEIPT TEST FIXTURE ONLY: ${seedLabel}:${role}`).digest()
const testSigner=role=>Keypair.fromSeed(seed(role))
function currentFixture(){const f=maxWalletPreparationReceiptFixture({samePayer:true,seedLabel}),now=Date.now();f.preparationInput.observations.forEach(x=>{x.observedAtMs=now});f.preparationInput.recentBlockhash.observedAtMs=now;Object.assign(f.preparationInput.limits,{nowMs:now,maxAgeMs:60000,reviewExpiresAtMs:now+60000});return f}
const signFor=(role,message)=>sign(null,message,createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed(role)]),format:'der',type:'pkcs8'}))
test('durable exact-message signing retains partials, refuses mutation and sends at most once with sticky recovery',async()=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`native_signing_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  for(const file of ['hooklab-wallet-principal-schema.sql','hooklab-native-signing-schema.sql','hooklab-native-signing-attempt-schema.sql','hooklab-native-signing-context-schema.sql','hooklab-native-signing-refresh-schema.sql','hooklab-native-signing-wallet-request-schema.sql'])await pool.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'))
  const f=currentFixture(),review=planMaxWalletPreparation(f.preparationInput).review,owner=review.wallet
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[digest,owner,review.genesisHash])
  let fresh=true,sends=0,signs=0,outcome='unresolved'
  const result={status:'operator-pins-and-state-verified',configurationSha256:'a'.repeat(64),settlementContext:{schema:'synthetic-test-only'},owner,stage:'preparation',profileSha256:review.profileSha256,messageSha256:review.messageSha256,review}
  const resolver={prepare:async()=>structuredClone(result),revalidate:async()=>{if(!fresh)throw Error('changed');return structuredClone(result)},reconcile:async({signature})=>({status:outcome,signature,messageSha256:review.messageSha256,profileSha256:review.profileSha256,immutableReceipt:'synthetic-only',executionStatus:'finalized-executed',policyReviewRequired:true,reviewBoundsSatisfied:false,quote:{delivered:'9',priceImpactBps:'501',rawSecret:'NEVER-BROWSER'},rawEvidence:'NEVER-BROWSER'})}
  const serverSigner={sign:async({signerAddress,message})=>{signs++;const role=['mint','selectedConfig'].find(r=>testSigner(r).publicKey.toBase58()===signerAddress);assert.ok(role);return signFor(role,message)}}
  const sender={send:async()=>{sends++;throw Error('lost synthetic response')}}
  const settings={enabled:true,origin:'https://repo.ing',resolver,serverSigner,sender},store=nativeSigningLifecycle(pool,settings),id=randomUUID(),custodyOperationId=randomUUID()
  await assert.rejects(nativeSigningLifecycle(pool,{...settings,enabled:false}).createReview(token,id,{custodyOperationId,stage:'preparation'}))
  await assert.rejects(nativeSigningLifecycle(pool,{...settings,resolver:null}).createReview(token,id,{custodyOperationId,stage:'preparation'}))
  let current=await store.createReview(token,id,{custodyOperationId,stage:'preparation'});assert.equal(current.status,'reviewed')
  await assert.rejects(pool.query("update hook_lab_native_signing_operations set settlement_context='{}',revision=revision+1 where id=$1",[id]))
  result.configurationSha256='b'.repeat(64);await assert.rejects(store.walletRequest(token,id));result.configurationSha256='a'.repeat(64)
  result.settlementContext={schema:'fresh-context-must-not-replace-original'}
  await store.walletRequest(token,id)
  assert.equal((await pool.query('select settlement_context from hook_lab_native_signing_operations where id=$1',[id])).rows[0].settlement_context.schema,'synthetic-test-only')
  const refreshId=randomUUID();await store.createReview(token,refreshId,{custodyOperationId:randomUUID(),stage:'preparation'})
  const freshFixture=currentFixture();freshFixture.preparationInput.recentBlockhash.blockhash=testSigner('selectedConfig').publicKey.toBase58()
  result.review=planMaxWalletPreparation(freshFixture.preparationInput).review;result.messageSha256=result.review.messageSha256
  const refreshed=await store.refreshReview(token,refreshId);assert.notEqual(refreshed.messageSha256,review.messageSha256)
  assert.equal((await pool.query('select count(*) from hook_lab_native_signing_review_history where operation_id=$1',[refreshId])).rows[0].count,'1')
  result.review=review;result.messageSha256=review.messageSha256

  await assert.rejects(store.coSignNext(token,id,f.preparationInput.request.mint));assert.equal(signs,0)
  const issuedOnly=id;await store.walletRequest(token,issuedOnly)
  assert.equal((await store.get(token,issuedOnly)).walletRequestIssued,true);await assert.rejects(store.refreshReview(token,issuedOnly))
  await store.walletRequest(token,issuedOnly) // same-message recovery remains available
  const request=await store.walletRequest(token,id),tx=VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64,'base64'))
  tx.signatures[review.requiredSigners.indexOf(owner)]=signFor('creator',tx.message.serialize())
  const walletWire=Buffer.from(tx.serialize()).toString('base64')
  fresh=false;current=await store.retainWalletSignature(token,id,walletWire);assert.equal(current.status,'partial')
  await assert.rejects(store.retainWalletSignature(token,refreshId,walletWire))
  await assert.rejects(store.refreshReview(token,id))
  await assert.rejects(store.coSignNext(token,id,f.preparationInput.request.mint));assert.equal(signs,0)
  fresh=true
  const wrong=VersionedTransaction.deserialize(Buffer.from(walletWire,'base64'));wrong.message.recentBlockhash=testSigner('mint').publicKey.toBase58()
  await assert.rejects(store.retainWalletSignature(token,id,Buffer.from(wrong.serialize()).toString('base64')))
  current=await nativeSigningLifecycle(pool,settings).coSignNext(token,id,f.preparationInput.request.mint);assert.equal(current.status,'partial')
  current=await store.coSignNext(token,id,f.preparationInput.request.selectedConfig);assert.equal(current.status,'signed');assert.equal(signs,2)
  await store.coSignNext(token,id,f.preparationInput.request.mint);assert.equal(signs,2)
  const attempts=await Promise.allSettled([store.submitOnce(token,id),store.submitOnce(token,id)])
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(sends,1)
  current=await store.get(token,id);assert.equal(current.status,'outcome-unknown');assert.ok(current.signature)
  await assert.rejects(store.submitOnce(token,id));assert.equal(sends,1)
  current=await store.reconcile(token,id);assert.equal(current.status,'outcome-unknown')
  outcome='finalized-success';current=await store.reconcile(token,id);assert.equal(current.status,'review-required')
  assert.equal(current.settlement.evidenceConflict,false);assert.ok(!JSON.stringify(current).includes('NEVER-BROWSER'))
  outcome='finalized-failure';current=await store.reconcile(token,id);assert.equal(current.status,'review-required')
  outcome='finalized-success';current=await store.reconcile(token,id);assert.equal(current.status,'review-required')
  const saved=(await pool.query('select * from hook_lab_native_signing_operations where id=$1',[id])).rows[0]
  assert.equal(saved.first_finalized.status,'finalized-success');assert.equal(saved.first_conflict.status,'finalized-failure')
  assert.ok(saved.partial_transaction);await assert.rejects(store.submitOnce(token,id));assert.equal(sends,1)
  let failedCalls=0
  const failing=nativeSigningLifecycle(pool,{...settings,serverSigner:{sign:async()=>{failedCalls++;throw Error('lost callback result')}}}),other=randomUUID()
  await failing.createReview(token,other,{custodyOperationId:randomUUID(),stage:'preparation'})
  await failing.retainWalletSignature(token,other,walletWire)
  await assert.rejects(failing.coSignNext(token,other,f.preparationInput.request.mint))
  assert.equal((await failing.get(token,other)).status,'signing-unknown')
  await assert.rejects(failing.coSignNext(token,other,f.preparationInput.request.mint));assert.equal(failedCalls,1)
  await assert.rejects(failing.retainRecoveredServerSignature(token,other,Buffer.alloc(64).toString('base64')))
  const recovered=await failing.retainRecoveredServerSignature(token,other,signFor('mint',tx.message.serialize()).toString('base64'))
  assert.equal(recovered.status,'partial');assert.ok(recovered.signedBy.includes(f.preparationInput.request.mint))
  let slowCalls=0
  const slow=nativeSigningLifecycle(pool,{...settings,serverSigner:{sign:async({message})=>{slowCalls++;await new Promise(resolve=>setTimeout(resolve,550));return signFor('mint',message)}}}),slowId=randomUUID()
  await slow.createReview(token,slowId,{custodyOperationId:randomUUID(),stage:'preparation'});await slow.retainWalletSignature(token,slowId,walletWire)
  await pool.query("update hook_lab_wallet_sessions set expires_at=clock_timestamp()+interval '400 milliseconds' where token_sha256=$1",[digest])
  const afterExpiry=await slow.coSignNext(token,slowId,f.preparationInput.request.mint)
  assert.equal(afterExpiry.status,'partial');assert.ok(afterExpiry.signedBy.includes(f.preparationInput.request.mint));assert.equal(slowCalls,1)
  await assert.rejects(slow.get(token,slowId))
  await pool.query("update hook_lab_wallet_sessions set expires_at=clock_timestamp()+interval '30 minutes' where token_sha256=$1",[digest])
  await slow.coSignNext(token,slowId,f.preparationInput.request.mint);assert.equal(slowCalls,1)


 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})

test('same-transaction encrypted custody signs only retained roles and atomically advances custody stage',async()=>{
 const { nativeSignerCustodyStore }=await import('../src/hooklab-native-signer-custody-store.mjs')
 const { nativeCustodySigningAdapter }=await import('../src/hooklab-native-custody-signing.mjs')
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`native_cosign_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  for(const file of ['hooklab-wallet-principal-schema.sql','hooklab-native-signer-custody-schema.sql','hooklab-new-mint-preparation-schema.sql','hooklab-native-signing-schema.sql','hooklab-native-signing-attempt-schema.sql','hooklab-native-signing-context-schema.sql','hooklab-native-signing-refresh-schema.sql','hooklab-native-signing-wallet-request-schema.sql'])await pool.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'))
  const f=currentFixture(),review=planMaxWalletPreparation(f.preparationInput).review,owner=review.wallet
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[digest,owner,review.genesisHash])
  const custodyOperationId=randomUUID(),keyRing={test_only:Buffer.alloc(32,31)},activeKeyId='test_only',custody=nativeSignerCustodyStore(pool,{enabled:true,origin:'https://repo.ing',keyRing,activeKeyId})
  await custody.retainServerSigners(token,custodyOperationId,review.profileSha256,{mint:testSigner('mint'),selectedConfig:testSigner('selectedConfig')})
  await custody.retainPreparationReview(token,custodyOperationId,{expectedRevision:'0',request:f.preparationInput.request,evidenceSha256:'a'.repeat(64)})
  const binding={status:'operator-pins-and-state-verified',configurationSha256:'a'.repeat(64),settlementContext:{schema:'synthetic-test-only'},owner,stage:'preparation',profileSha256:review.profileSha256,messageSha256:review.messageSha256,review}
  let transportFailure=false,outcome='finalized-success'
  const resolver={prepare:async({sessionToken})=>{assert.equal(sessionToken,token);return binding},revalidate:async({sessionToken})=>{
   assert.equal(sessionToken,token)
   // If revalidation held the custody row lock, this independent query would fail.
   await pool.query('select * from hook_lab_native_signer_custody where operation_id=$1 for update nowait',[custodyOperationId]);return binding
  },reconcile:async({signature})=>{if(transportFailure)throw Error('PRIVATE-TRANSPORT-SENTINEL');return {status:outcome,signature,messageSha256:review.messageSha256,profileSha256:review.profileSha256}}}
  const adapter=nativeCustodySigningAdapter({enabled:true,keyRing,activeKeyId}),store=nativeSigningLifecycle(pool,{enabled:true,origin:'https://repo.ing',resolver,custodyAdapter:adapter,sender:{send:async({signature})=>signature}}),id=randomUUID()
  await store.createReview(token,id,{custodyOperationId,stage:'preparation'})
  const issuedOnly=id;await store.walletRequest(token,issuedOnly)
  assert.equal((await store.get(token,issuedOnly)).walletRequestIssued,true);await assert.rejects(store.refreshReview(token,issuedOnly))
  await store.walletRequest(token,issuedOnly) // same-message recovery remains available
  const request=await store.walletRequest(token,id),tx=VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64,'base64'))
  tx.signatures[review.requiredSigners.indexOf(owner)]=signFor('creator',tx.message.serialize());await store.retainWalletSignature(token,id,Buffer.from(tx.serialize()).toString('base64'))
  await assert.rejects(store.coSignNext(token,id,testSigner('creator').publicKey.toBase58()))
  await store.coSignNext(token,id,f.preparationInput.request.mint)
  assert.equal((await custody.get(token,custodyOperationId)).stage,'preparation-reviewed')
  await store.coSignNext(token,id,f.preparationInput.request.selectedConfig)
  assert.equal((await custody.get(token,custodyOperationId)).stage,'preparation-signed')
  assert.equal((await store.submitOnce(token,id)).status,'submitted')
  transportFailure=true;await assert.rejects(store.reconcile(token,id),error=>!error.message.includes('PRIVATE-TRANSPORT-SENTINEL')&&error.code==='NATIVE_SIGNING_UNAVAILABLE')
  transportFailure=false;await store.reconcile(token,id)
  assert.equal((await custody.get(token,custodyOperationId)).stage,'preparation-finalized')
  outcome='finalized-failure';await store.reconcile(token,id)
  assert.equal((await custody.get(token,custodyOperationId)).stage,'reconcile-required')
 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})
