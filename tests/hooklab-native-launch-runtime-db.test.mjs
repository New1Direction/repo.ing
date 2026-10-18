// End-to-end local PostgreSQL + actual runtime/compiler/custody; synthetic RPC only.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID,createHash,createPrivateKey,sign} from 'node:crypto'
import {Keypair,PublicKey,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {BorshCoder} from '@anchor-lang/core'
import pg from 'pg'
import {createNativeLaunchRuntime} from '../src/hooklab-native-launch-runtime.mjs'
import {deriveInclusiveMaxWalletPreparedAccounts} from '../src/hooklab-inclusive-max-wallet-preparation.mjs'
import {inclusiveMaxWalletLaunchFixture,inclusiveTokenElf} from './fixtures/hooklab-inclusive-max-wallet-launch.mjs'
import {deriveMaxWalletLaunchPostconditions} from '../src/hooklab-max-wallet-launch-settlement.mjs'
import {compileMaxWalletLaunchReview} from '../src/hooklab-max-wallet-launch.mjs'
import {maxWalletOperatorFixture} from './fixtures/hooklab-max-wallet-operator.mjs'
import {rebindMaxWalletLaunchFixture} from './fixtures/hooklab-max-wallet-launch-settlement.mjs'
import {dropTestDatabase} from './fixtures/drop-test-database.mjs'
import {ownerApprovalStore,remoteAdminSigner} from '../src/hooklab-owner-approval.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),pk=x=>new PublicKey(x),seed=label=>createHash('sha256').update(`LOCAL FULL RUNTIME TEST ONLY ${label}`).digest()
const wallet=Keypair.fromSeed(seed('wallet')),adminKey=Keypair.fromSeed(seed('admin'))
const signAdmin=message=>sign(null,message,createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed('admin')]),format:'der',type:'pkcs8'}))
function operator(mint,selectedConfig){return maxWalletOperatorFixture(input=>{
 rebindMaxWalletLaunchFixture(input,{creator:wallet.publicKey.toBase58(),reviewer:adminKey.publicKey.toBase58(),mint,selectedConfig})
 const initialPlan=compileMaxWalletLaunchReview(input),coder=new BorshCoder(JSON.parse(Buffer.from(input.profile.idls.launch,'base64')))
 for(const o of input.observations){const a=o.accounts.find(x=>x.address===initialPlan.addresses.authorization).account,raw=Buffer.from(a.dataBase64,'base64'),v=coder.accounts.decode('CreatorAuthorization',raw);v.max_launches=v.max_launches.addn(1);a.dataBase64=Buffer.concat([raw.subarray(0,8),coder.types.encode('CreatorAuthorization',v)]).toString('base64');input.reviewedStateHashes.authorization=sha(Buffer.from(a.dataBase64,'base64'))}
 const plan=compileMaxWalletLaunchReview(input),dynamic=new Set([selectedConfig,...['launch','pool','lpMint','launchReserve','launchQuote','poolRegistry','baseVault','quoteVault','launchLp','policy','registry','inclusiveFeePolicy'].map(k=>plan.addresses[k])])
 const old=Buffer.from(input.lookupTable.dataBase64,'base64'),keys=[];for(let i=56;i<old.length;i+=32){const k=pk(old.subarray(i,i+32)).toBase58();if(!dynamic.has(k))keys.push(k)}
 const bytes=Buffer.alloc(56+32*keys.length);old.subarray(0,56).copy(bytes);keys.forEach((k,i)=>pk(k).toBuffer().copy(bytes,56+32*i));input.lookupTable.dataBase64=bytes.toString('base64');input.lookupTable.sha256=sha(bytes)
 return input
},{baseFixture:inclusiveMaxWalletLaunchFixture,compile:compileMaxWalletLaunchReview,tokenElf:inclusiveTokenElf()})}
async function realRuntimeScenario({remoteAdmin=false,expireFirstAttempt=false}={}){
 const pgConfig={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},dbAdmin=new pg.Pool(pgConfig),database=`full_native_${randomUUID().replaceAll('-','')}`;let pool
 const oldFetch=globalThis.fetch
 try{
  await dbAdmin.query(`create database ${database}`);pool=new pg.Pool({...pgConfig,database})
  for(const file of [...(remoteAdmin?['hooklab-owner-approval-schema.sql']:[]),'hooklab-wallet-principal-schema.sql','hooklab-wallet-preparation-schema.sql','hooklab-native-signer-custody-schema.sql','hooklab-new-mint-preparation-schema.sql','hooklab-native-signing-schema.sql','hooklab-native-signing-attempt-schema.sql','hooklab-native-signing-context-schema.sql','hooklab-native-signing-refresh-schema.sql','hooklab-native-signing-wallet-request-schema.sql','hooklab-native-launch-context-schema.sql','hooklab-native-signing-expiry-schema.sql'])await pool.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'))
  let f=operator(Keypair.fromSeed(seed('initial-mint')).publicKey.toBase58(),Keypair.fromSeed(seed('initial-config')).publicKey.toBase58()),phase=0,hideTransaction=false,current=f.accounts
  const token=Buffer.alloc(32,53).toString('base64url'),owner=wallet.publicKey.toBase58(),profile=JSON.parse(f.profile.json),startSlot=f.f.observations[0].slot,receipts=new Map(),rentBySize={90:1517280,81:1454640,176:2115840}
  const initial=f,now=Date.now(),limits={...f.limits,maxAgeMs:60000,reviewExpiresAtMs:now+60000},prepLimits={nowMs:now,maxAgeMs:60000,maxSlotLag:5,validUntilSlot:startSlot+50,reviewExpiresAtMs:now+60000,maxRentLamports:String(Object.values(rentBySize).reduce((a,b)=>a+b,0)),maxNetworkFeeLamports:'15000',maxTotalDebitLamports:String(Object.values(rentBySize).reduce((a,b)=>a+b,0)+15000),computeUnitLimit:600000,computeUnitPriceMicroLamports:'0'}
  function setIdentity(mint,selectedConfig){
   if(f.request.mint===mint&&f.request.selectedConfig===selectedConfig)return
   f=operator(mint,selectedConfig);assert.equal(f.config.lookupTable.sha256,initial.config.lookupTable.sha256);current=new Map([...f.accounts,...current])
   const a=f.baseline.addresses;for(const address of [a.policy,a.registry,selectedConfig])current.set(address,null)
  }
  let blockhashEpoch=0 // a real chain moves to a new blockhash once the old one can no longer land
  const connections=f.connections.map(({provider,connection})=>({provider,connection:{rpcEndpoint:connection.rpcEndpoint,
   async getGenesisHash(){return profile.genesisHash},async getMinimumBalanceForRentExemption(size){assert.ok(rentBySize[size]);return rentBySize[size]},
   async getMultipleAccountsInfoAndContext(keys){if(keys.length===12)setIdentity(keys[7].toBase58(),keys[8].toBase58());return {context:{slot:startSlot+phase},value:keys.map(k=>{const a=current.get(k.toBase58());return a?{owner:pk(a.owner),executable:a.executable,lamports:Number(a.lamports??0),data:Buffer.from(a.dataBase64,'base64')}:null})}},
   async getLatestBlockhashAndContext(){return {context:{slot:startSlot+phase},value:{blockhash:blockhashEpoch?bs58.encode(createHash('sha256').update(`synthetic blockhash after expiry ${blockhashEpoch}`).digest()):initial.f.recentBlockhash.blockhash,lastValidBlockHeight:startSlot+150}}},
   async isBlockhashValid(){return {context:{slot:startSlot+phase},value:true}},async getBlockHeight(){return startSlot+phase},async getFeeForMessage(message){return {context:{slot:startSlot+phase},value:message.header.numRequiredSignatures*5000}},
   async simulateTransaction(){return {context:{slot:startSlot+phase},value:{err:null}}},async getTransaction(signature){return hideTransaction?null:receipts.get(signature)?.transaction??null},async getBlockSignatures(slot){return [...receipts.values()].find(r=>r.transaction.slot===slot)?.block??null},
  }}))
  for(const {connection}of connections)for(const [name,method]of Object.entries(connection)){if(typeof method==='function')connection[name]=async(...args)=>{try{return await method(...args)}catch(e){console.error('SYNTHETIC RPC FAILURE',name,e.message);throw e}}}
  const syntheticFetch=async(url,opts)=>{
   assert.equal(url,connections[0].connection.rpcEndpoint);const body=JSON.parse(opts.body);assert.equal(body.method,'sendTransaction');assert.equal(body.params[1].maxRetries,0)
   const wire=body.params[0],tx=VersionedTransaction.deserialize(Buffer.from(wire,'base64')),signature=bs58.encode(tx.signatures[0]),{rows:[row]}=await pool.query('select * from hook_lab_native_signing_operations where signature=$1',[signature]);assert.ok(row)
   const review=row.review,keys=review.accounts.map(a=>a.address),idx=k=>keys.indexOf(k),before=keys.map(k=>Number(current.get(k)?.lamports??0)),after=[...before],timestamp=1700000001+phase,slot=startSlot+phase+1
   let innerInstructions=[]
   if(row.stage==='preparation'){
    const input=row.settlement_context.preparationInput,derived=deriveInclusiveMaxWalletPreparedAccounts({profile:{json:input.profile.json,expectedSha256:input.profile.expectedSha256,idls:input.profile.idls},request:input.request,launchConfig:current.get(f.baseline.addresses.launchConfig),observedCreatedAtUnixSeconds:String(timestamp)})
    let rent=0;for(const a of Object.values(derived.accounts)){const lamports=rentBySize[a.size??Buffer.from(a.dataBase64,'base64').length];assert.ok(lamports);current.set(a.address,{...a,lamports:String(lamports)});after[idx(a.address)]=lamports;rent+=lamports-before[idx(a.address)]}
    after[idx(owner)]-=rent+15000
   }else{
    const expected=deriveMaxWalletLaunchPostconditions(row.settlement_context,{slot,timestamp});let rent=0
    for(const a of expected.accounts){const created=expected.created.includes(a.address),lamports=created?1000000:Number(current.get(a.address)?.lamports??0);current.set(a.address,{...a,lamports:String(lamports)});if(created){rent+=lamports-before[idx(a.address)];after[idx(a.address)]=lamports}}
    after[idx(owner)]-=rent+Number(expected.feesLamports)+15000;after[idx(expected.treasury)]+=Number(expected.feesLamports)
    innerInstructions=[{index:2,instructions:[{programIdIndex:idx(profile.programs.swap),accounts:[],data:bs58.encode(Buffer.from([1])),stackHeight:2},...expected.events.filter(e=>e.name==='PoolCreated').map(e=>({programIdIndex:idx(e.program),accounts:[idx(f.baseline.addresses.swapEventAuthority)],data:bs58.encode(Buffer.from(e.dataBase64,'base64')),stackHeight:3})),...expected.events.filter(e=>e.name==='LaunchCreated').map(e=>({programIdIndex:idx(e.program),accounts:[idx(f.baseline.addresses.eventAuthority)],data:bs58.encode(Buffer.from(e.dataBase64,'base64')),stackHeight:2}))]}]
   }
   for(let i=0;i<keys.length;i++){const a=current.get(keys[i]);if(a)current.set(keys[i],{...a,lamports:String(after[i])})}
   const loaded=review.accounts.slice(tx.message.staticAccountKeys.length),transaction={slot,blockTime:timestamp,transaction:{message:tx.message,signatures:tx.signatures.map(x=>bs58.encode(x))},meta:{err:null,fee:15000,preBalances:before,postBalances:after,innerInstructions,loadedAddresses:{writable:loaded.filter(x=>x.writable).map(x=>pk(x.address)),readonly:loaded.filter(x=>!x.writable).map(x=>pk(x.address))}}},block={parentSlot:slot-1,blockHeight:slot,blockTime:timestamp,blockhash:pk(Buffer.alloc(32,170+phase)).toBase58(),previousBlockhash:pk(Buffer.alloc(32,169+phase)).toBase58(),signatures:[signature]}
   receipts.set(signature,{transaction,block});phase++
   return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:signature}),{status:200})
  }
  globalThis.fetch=async(...args)=>{try{return await syntheticFetch(...args)}catch(e){console.error('SYNTHETIC SEND FAILURE',e.stack);throw e}}
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[sha(token),owner,profile.genesisHash])
  let ownerSignatures=0,ownerAway=false,chainPastDeadline=false;const ownerStore=remoteAdmin?ownerApprovalStore(pool,{adminAddress:adminKey.publicKey.toBase58()}):null
  const runtime=createNativeLaunchRuntime(pool,{enabled:true,origin:'https://repo.ing',ownerCustodyApproved:true,operatorDeploymentApproved:true,economicsApproved:true,config:initial.config,profile:initial.profile,dossierJson:initial.dossierJson,connections,keyRing:{test:Buffer.alloc(32,57)},activeKeyId:'test',adminSigner:remoteAdmin?remoteAdminSigner(pool,{address:adminKey.publicKey.toBase58(),observe:async()=>({slot:ownerAway?10**9:0,blockHeight:0,nowMs:Date.now()}),
   sleep:async()=>{ // owner-agent stand-in: sign each pending exact message with the admin key, once
    const {rows}=await pool.query("select id,message_base64 from hook_lab_owner_sign_requests where status='pending'")
    if(!ownerAway)for(const row of rows){ownerSignatures++;await ownerStore.submitSignature(row.id,signAdmin(Buffer.from(row.message_base64,'base64')).toString('base64'))}
   }}):{address:adminKey.publicKey.toBase58(),sign:signAdmin},expiryObserver:async()=>chainPastDeadline?{slot:10**9,blockHeight:10**9}:{slot:1,blockHeight:1},preparationLimits:prepLimits,launchLimits:limits})
  let lastLaunchId
  for(let launchNumber=0;launchNumber<2;launchNumber++){
  const operationId=randomUUID(),preparationId=randomUUID(),launchId=randomUUID();lastLaunchId=launchId
  const reserved=await runtime.reserve({sessionToken:token,owner,input:{operationId,capBps:initial.request.capBps,label:initial.request.label,name:initial.request.name,symbol:initial.request.symbol,uri:initial.request.uri,virtualQuote:initial.request.virtualQuote,creatorFeeBps:initial.request.creatorFeeBps}})
  for(const [id,stage]of [[preparationId,'preparation'],[launchId,'launch']]){
   if(expireFirstAttempt&&launchNumber===0&&stage==='launch'){ // owner away: the first attempt must expire without any send
    const abandoned=randomUUID(),sendsBefore=receipts.size
    await runtime.lifecycle.createReview(token,abandoned,{custodyOperationId:operationId,stage})
    const aw=await runtime.lifecycle.walletRequest(token,abandoned),atx=VersionedTransaction.deserialize(Buffer.from(aw.partialTransactionBase64,'base64'));atx.sign([wallet])
    await runtime.lifecycle.retainWalletSignature(token,abandoned,Buffer.from(atx.serialize()).toString('base64'))
    ownerAway=true
    for(const signer of aw.review.requiredSigners.filter(k=>k!==owner)){
     if(signer===adminKey.publicKey.toBase58())await assert.rejects(runtime.lifecycle.coSignNext(token,abandoned,signer))
     else await runtime.lifecycle.coSignNext(token,abandoned,signer)
    }
    ownerAway=false
    assert.equal((await pool.query("select status from hook_lab_owner_sign_requests order by created_at desc limit 1")).rows[0].status,'expired')
    await assert.rejects(runtime.lifecycle.expire(token,abandoned),undefined,'refused while the blockhash could still land')
    chainPastDeadline=true;const expired=await runtime.lifecycle.expire(token,abandoned);chainPastDeadline=false;blockhashEpoch++
    assert.equal(expired.status,'expired')
    await assert.rejects(runtime.lifecycle.submitOnce(token,abandoned),undefined,'expired operation can never be submitted')
    await assert.rejects(runtime.lifecycle.expire(token,abandoned),undefined,'expiry is final')
    assert.equal(receipts.size,sendsBefore,'nothing was sent for the abandoned attempt')
    assert.equal((await pool.query('select stage from hook_lab_native_signer_custody where operation_id=$1',[operationId])).rows[0].stage,'preparation-finalized')
   }
   const review=await runtime.lifecycle.createReview(token,id,{custodyOperationId:operationId,stage});assert.equal(review.status,'reviewed')
   const wr=await runtime.lifecycle.walletRequest(token,id),tx=VersionedTransaction.deserialize(Buffer.from(wr.partialTransactionBase64,'base64'));tx.sign([wallet]);await runtime.lifecycle.retainWalletSignature(token,id,Buffer.from(tx.serialize()).toString('base64'))
   for(const signer of wr.review.requiredSigners.filter(k=>k!==owner))await runtime.lifecycle.coSignNext(token,id,signer)
   assert.equal((await runtime.lifecycle.submitOnce(token,id)).status,'submitted')
   if(stage==='launch'){hideTransaction=true;assert.equal((await runtime.lifecycle.reconcile(token,id)).status,'outcome-unknown');await assert.rejects(runtime.lifecycle.submitOnce(token,id));hideTransaction=false}
   const settled=await runtime.lifecycle.reconcile(token,id).catch(async e=>{console.error('RECONCILE STAGE',stage,(await pool.query('select latest_evidence from hook_lab_wallet_preparations')).rows.map(x=>({status:x.latest_evidence?.status,reason:x.latest_evidence?.reasonCode})));throw e});assert.equal(settled.status,'finalized-success',`${stage} did not settle`)
   assert.equal((await runtime.lifecycle.reconcile(token,id)).status,'finalized-success')
   await assert.rejects(runtime.lifecycle.submitOnce(token,id))
  }
  if(remoteAdmin)assert.equal(ownerSignatures,launchNumber+1,'exactly one owner signature per launch, none for preparation');
  assert.equal(receipts.size,(launchNumber+1)*2);const {rows:[custody]}=await pool.query('select * from hook_lab_native_signer_custody where operation_id=$1',[operationId]);assert.equal(custody.stage,'launch-finalized');assert.equal(custody.mint,reserved.mint)
  }
  await pool.query('update hook_lab_wallet_sessions set revoked_at=clock_timestamp() where token_sha256=$1',[sha(token)]);await assert.rejects(runtime.lifecycle.get(token,lastLaunchId))
 }finally{globalThis.fetch=oldFetch;if(pool)await pool.end();await dropTestDatabase(dbAdmin,database);await dbAdmin.end()}
}
test('real runtime completes two launches with unchanged dossier, retained identities and unknown-outcome recovery',()=>realRuntimeScenario())
// Same scenario with the admin key OUT of the server: the remote signer queues each exact message and
// an owner-agent stand-in answers with the admin signature, exactly as the owner's Mac would.
test('real runtime completes the same launches through the owner-approval remote admin signer',()=>realRuntimeScenario({remoteAdmin:true}))
test('owner-away launch attempt expires on chain evidence, never sends, and a fresh review then completes',()=>realRuntimeScenario({remoteAdmin:true,expireFirstAttempt:true}))
