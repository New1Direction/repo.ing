// Synthetic keys and injected readers only. These are not production execution proofs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Keypair, PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { hookPublicationDigest, taxHookSetupManifest, materializeHookSetup } from '../src/hooklab-hook-catalog.mjs'
import { planSelectedHookSetup, collectSelectedHookSetup } from '../src/hooklab-selected-hook-setup.mjs'
import { resolveHookPublicationSelection, bindSelectedHookSetupIntent, selectedHookSetupResolver, collectSelectedHookSetupSettlement } from '../src/hooklab-selected-hook-setup-resolver.mjs'
import { nativeCustodySigningAdapter } from '../src/hooklab-native-custody-signing.mjs'
import { nextOpenLaunchAction, sameLaunchHook } from '../app/lib/hooklab-open-launch.mjs'
const key = n => Keypair.fromSeed(Buffer.alloc(32,n)).publicKey.toBase58()
const sha = b => createHash('sha256').update(b).digest('hex')
function fixture() {
 const signer=Keypair.fromSeed(Buffer.alloc(32,1)),creator=key(1),mint=key(2),selectedHook={program:key(3),flags:65},selectedConfig=key(12)
 const manifest=taxHookSetupManifest(selectedHook),configuration={feeBps:'100',maxWalletBps:'0',collector:key(4)}
 const programData=PublicKey.findProgramAddressSync([new PublicKey(selectedHook.program).toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58()
 const pb=Buffer.alloc(36);pb.writeUInt32LE(2);new PublicKey(programData).toBuffer().copy(pb,4)
 const db=Buffer.alloc(49);db.writeUInt32LE(3);Buffer.from([127,69,76,70]).copy(db,45)
 const hookPin={program:selectedHook.program,elfSha256:sha(db.subarray(45))}
 const publication={schema:'repoing/hook-publication/1',publisher:key(11),name:'Synthetic hook',version:'1',selectedHook,manifest,behavior:'Test',fees:'Test',risks:'Test',evidence:{hookPin,authority:{kind:'immutable'}}}
 const digest=hookPublicationDigest(publication),selection={digest,manifest,configuration}
 const request=materializeHookSetup(manifest,configuration,{creator,mint})
 const registry=request.instructions[0].accounts[4].address,registryData=Buffer.from('02daf6662c38c0cd0100000000','hex')
 const account=(address,owner,data,executable=false)=>({address,owner,dataBase64:data.toString('base64'),executable,lamports:'100000'})
 const snapshots=[...new Set([creator,selectedHook.program,programData,'ComputeBudget111111111111111111111111111111',...request.instructions[0].accounts.map(a=>a.address)])].map(address=>({address,account:address===creator?account(address,'11111111111111111111111111111111',Buffer.alloc(0)):address===selectedHook.program?account(address,'BPFLoaderUpgradeab1e11111111111111111111111',pb,true):address===programData?account(address,'BPFLoaderUpgradeab1e11111111111111111111111',db):null}))
 const input={request,programs:{token:key(5),swap:key(6),launch:key(7),gate:key(8)},hookPin,snapshots,context:{genesisHash:key(9),profileSha256:'a'.repeat(64),recentBlockhash:key(10),observedSlot:40,validUntilSlot:90,observedAtMs:1000,reviewExpiresAtMs:2000,lastValidBlockHeight:150,baseFeeLamports:'5000'},limits:{computeUnits:200000,maxRentLamports:'10000',maxNetworkFeeLamports:'5000',maxTotalDebitLamports:'15000'}}
 const plan=planSelectedHookSetup(input),tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64')));tx.sign([signer])
 const wire=Buffer.from(tx.serialize()).toString('base64'),signature=bs58.encode(tx.signatures[0])
 let finalized=false,missingRegistry=false,badFee=false,differentWire=false,liveSlot=42
 const connections=['one','two'].map(provider=>({provider,connection:{
  async getGenesisHash(){return input.context.genesisHash},async isBlockhashValid(){return {context:{slot:liveSlot},value:true}},async getBlockHeight(){return 100},async getFeeForMessage(){return {context:{slot:liveSlot},value:5000}},
  async getMultipleAccountsInfoAndContext(keys){return {context:{slot:finalized?50:liveSlot},value:keys.map(k=>{
   const address=k.toBase58(),a=snapshots.find(a=>a.address===address)?.account
   if(finalized&&address===registry&&!missingRegistry)return {owner:new PublicKey(selectedHook.program),executable:false,lamports:1000,data:registryData}
   return a?{owner:new PublicKey(a.owner),executable:a.executable,lamports:Number(a.lamports),data:Buffer.from(a.dataBase64,'base64')}:null
  })}},
  async simulateTransaction(_tx,opts){return {context:{slot:liveSlot},value:{err:null,unitsConsumed:10000,accounts:opts.accounts.addresses.map(address=>{
   const a=snapshots.find(a=>a.address===address)?.account
   if(address===registry)return {owner:selectedHook.program,executable:false,lamports:1000,data:[registryData.toString('base64'),'base64']}
   return a?{owner:a.owner,executable:a.executable,lamports:Number(a.lamports)-(address===creator?6000:0),data:[a.dataBase64,'base64']}:null
  })}}},
  async getTransaction(){if(!finalized)return null;const pre=plan.review.accounts.map(a=>Number(snapshots.find(s=>s.address===a.address).account?.lamports??0)),post=pre.map((v,i)=>v+(plan.review.accounts[i].address===registry?1000:plan.review.accounts[i].address===creator?-6000:0));return {slot:50,transaction:{message:tx.message,signatures:[differentWire?bs58.encode(Buffer.alloc(64,1)):signature]},meta:{err:null,fee:badFee?5001:5000,preBalances:pre,postBalances:post}}},
  async getBlockSignatures(){return {blockHeight:101,blockhash:key(15),signatures:[signature]}}
 }}))
 let row
 const pool={async query(sql,args){if(sql.includes('select publication'))return {rows:[{publication}]};if(sql.includes('from hook_lab_launch_requests'))return {rows:[{creator_wallet:creator,selected_hook:selectedHook,hook_publication:selection,status:'launching'}]};if(sql.startsWith('insert into hook_lab_selected_hook_setup_intents')){row??={custody_operation_id:args[0],owner_wallet:args[1],profile_sha256:args[2],mint:args[3],selected_config:args[4],hook_publication:args[5],setup_request:args[6]};return {rows:[]}};if(sql.includes('hook_lab_selected_hook_setup_intents'))return {rows:row?[row]:[]};throw Error(sql)}}
 const binding={custodyOperationId:randomUUID(),owner:creator,profileSha256:'a'.repeat(64),mint,selectedConfig,selectedHook,hookPublication:selection}
 const settings={enabled:true,releaseVerified:true,connections,collectPlan:async()=>structuredClone(input),observe:async()=>publication.evidence,authorize:async()=>({owner:creator,profileSha256:'a'.repeat(64),mint,selectedConfig}),clock:()=>1200}
 return {creator,mint,selection,selectedHook,publication,pool,binding,settings,plan,wire,signature,connections,input,advance:()=>{liveSlot++},finalize:()=>{finalized=true},mutate:kind=>{missingRegistry=kind==='registry';badFee=kind==='fee';differentWire=kind==='wire'}}
}
test('catalog-bound setup survives resolver restart, refresh and duplicate reserve without replacing configuration or mint',async()=>{
 const f=fixture(),bound=await bindSelectedHookSetupIntent(f.pool,f.binding)
 assert.deepEqual(await bindSelectedHookSetupIntent(f.pool,f.binding),bound)
 for(const patch of [{mint:key(21)},{hookPublication:{...f.selection,configuration:{...f.selection.configuration,feeBps:'101'}}}])await assert.rejects(bindSelectedHookSetupIntent(f.pool,{...f.binding,...patch}))
 await assert.rejects(resolveHookPublicationSelection({pool:f.pool,selection:{...f.selection,manifest:{...f.selection.manifest,selectedHook:{...f.selectedHook,flags:1}}},selectedHook:f.selectedHook,creator:f.creator}))
 const args={sessionToken:'synthetic',custodyOperationId:f.binding.custodyOperationId,owner:f.creator}
 const first=await selectedHookSetupResolver(f.pool,f.settings).resolve(args)
 f.advance()
 const resumed=await selectedHookSetupResolver(f.pool,f.settings).resolve({...args,expectedReview:first.review,expectedSimulation:first.settlementContext.simulation,settlementContext:JSON.parse(JSON.stringify(first.settlementContext))})
 assert.deepEqual(resumed.review,first.review)
 assert.deepEqual((await selectedHookSetupResolver(f.pool,f.settings).resolve({...args,intent:first.request})).request,first.request)
 await assert.rejects(selectedHookSetupResolver(f.pool,{...f.settings,releaseVerified:false}).resolve(args))
 await assert.rejects(selectedHookSetupResolver(f.pool,f.settings).resolve({...args,intent:{...first.request,mint:key(22)}}))
})
test('setup settles only exact wire on two finalized providers with fee/debit and registry postconditions',async()=>{
 const f=fixture(),expected=await collectSelectedHookSetup({plan:f.plan,connections:f.connections,clock:()=>1200})
 const args={plan:f.plan,expected,signedTransactionBase64:f.wire,signature:f.signature,connections:f.connections}
 assert.equal((await collectSelectedHookSetupSettlement(args)).status,'unresolved')
 f.finalize();assert.equal((await collectSelectedHookSetupSettlement(args)).status,'finalized-success')
 for(const kind of ['registry','fee','wire']){f.mutate(kind);await assert.rejects(collectSelectedHookSetupSettlement(args))}
})
test('custody hook-setup transitions never decrypt or reseal mint/config keys; intent tampering fails',async()=>{
 const f=fixture();await bindSelectedHookSetupIntent(f.pool,f.binding)
 const custody={operation_id:f.binding.custodyOperationId,owner_wallet:f.creator,profile_sha256:'a'.repeat(64),mint:f.mint,selected_config:f.binding.selectedConfig,stage:'reserved',sealed_signers:{invalid:'opening this must fail'}}
 const db={async query(sql,args){if(sql.includes('from hook_lab_native_signer_custody'))return {rows:[custody]};return f.pool.query(sql,args)}}
 const adapter=nativeCustodySigningAdapter({enabled:true,keyRing:{synthetic:Buffer.alloc(32,1)},activeKeyId:'synthetic',openLaunches:true})
 await adapter.lock(db,custody.operation_id)
 const args={db,owner:f.creator,custodyOperationId:custody.operation_id,stage:'hook-setup'}
 await adapter.beginStage({...args,review:f.plan.review,request:f.plan.request});await adapter.completeStage(args);await adapter.reopenStage(args);await adapter.settleStage({...args,status:'finalized-success'})
 assert.equal(custody.stage,'reserved')
 await assert.rejects(adapter.beginStage({...args,review:f.plan.review,request:{...f.plan.request,mint:key(23)}}))
 await assert.rejects(adapter.sign({...args,signerAddress:f.mint,review:f.plan.review}))
})
test('guided custom flow waits for setup finality, gate still has two stages, configuration cannot change during resume',()=>{
 const f=fixture(),op={stage:'hook-setup',status:'submitted',signature:f.signature,review:f.plan.review}
 assert.equal(nextOpenLaunchAction(op),'reconcile');assert.equal(nextOpenLaunchAction({...op,status:'finalized-failure'}),'stop')
 assert.equal(nextOpenLaunchAction({...op,status:'finalized-success'}),'preparation')
 assert.equal(nextOpenLaunchAction({...op,stage:'preparation',status:'finalized-success'}),'launch')
 const coin={capBps:0,selectedHook:f.selectedHook,hookPublication:f.selection}
 assert.equal(sameLaunchHook(coin,structuredClone(coin)),true)
 assert.equal(sameLaunchHook(coin,{...coin,hookPublication:{...f.selection,configuration:{...f.selection.configuration,feeBps:'102'}}}),false)
})
