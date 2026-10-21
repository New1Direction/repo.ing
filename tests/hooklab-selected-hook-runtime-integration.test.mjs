// Run with: node --experimental-test-module-mocks --test tests/hooklab-selected-hook-runtime-integration.test.mjs
// Runtime wiring test: synthetic providers/custody/preparation collector, real catalog,
// setup compiler/collector/resolver and durable launch context. No keys or RPC endpoints.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { fixture, key, pk, pda } from './fixtures/selected-hook-preparation.mjs'
import { selectedLaunchFixture } from './fixtures/selected-hook-launch.mjs'
import { AddressLookupTableProgram, AddressLookupTableInstruction, TransactionInstruction } from '@solana/web3.js'
import { taxHookSetupManifest, hookPublicationDigest } from '../src/hooklab-hook-catalog.mjs'
import { executionGenesis } from '../src/hooklab-local-acceptance.mjs'

test('runtime reserves setup before preparation, preserves identity on restart and waits for finality', {skip:process.execArgv.includes('--experimental-test-module-mocks')?false:'Requires --experimental-test-module-mocks'}, async t => {
 const launchFixture=selectedLaunchFixture(),f={...fixture(),profile:launchFixture.input.profile},owner=f.request.creator,id=randomUUID(),token=Buffer.alloc(32,7).toString('base64url')
 const selectedHook={program:f.request.selectedHook.program,flags:65},manifest=taxHookSetupManifest(selectedHook)
 const pd=pda('BPFLoaderUpgradeab1e11111111111111111111111',pk(selectedHook.program).toBuffer())
 const strip=a=>{const {lamports,...rest}=a;return rest}
 const source=new Map(f.observations[0].accounts.map(a=>[a.address,a.account]))
 const sha=b=>createHash('sha256').update(b).digest('hex')
 const evidence={schema:'repoing/selected-hook-authority-evidence/2',genesisHash:JSON.parse(f.profile.json).genesisHash,policySha256:sha('synthetic-policy'),
  hookPin:{program:selectedHook.program,elfSha256:f.hookPin.elfSha256,elfLength:f.hookPin.elfLength},
  programAccount:strip(source.get(selectedHook.program)),programData:strip(source.get(pd)),authority:{kind:'immutable',upgradeAuthority:null},observedSlot:100,
  programSha256:sha(Buffer.from(source.get(selectedHook.program).dataBase64,'base64')),programDataSha256:sha(Buffer.from(source.get(pd).dataBase64,'base64')),
  executableSha256:f.hookPin.elfSha256,providers:['one','two']}
 const publication={schema:'repoing/hook-publication/1',publisher:owner,name:'Synthetic',version:'1',selectedHook,manifest,behavior:'Test',fees:'Test',risks:'Test',evidence}
 const selection={digest:hookPublicationDigest(publication),manifest,configuration:{feeBps:'100',maxWalletBps:'0',collector:key(90)}}
 const economics={quoteCut:{maxBuyBps:80,maxSellBps:40},authorShareBps:1000,rules:{burnBuyBps:20,burnSellBps:30}}
 const input={operationId:id,selectedHook,hookPublication:selection,capBps:0,creatorFeeBps:137,label:'Synthetic',name:'Synthetic',symbol:'SYN',uri:'https://repo.ing/synthetic',virtualQuote:'1000000000',...economics}
 const coin={creator_wallet:owner,status:'launching',selected_hook:selectedHook,hook_publication:selection,selected_economics:economics,name:input.name,symbol:input.symbol,uri:input.uri,creator_fee_bps:137,cap_bps:0}
 let custody,setup,context,finality,allocations=0,preparations=0,setupReads=0,changed=false
 const summary=()=>custody&&({operationId:id,custodySessionId:custody.custody_session_id,owner,profileSha256:f.profile.expectedSha256,mint:custody.mint,selectedConfig:custody.selected_config,stage:custody.stage,revision:String(custody.revision),preparedRequest:custody.preparation_request,selectedAuthorityEvidence:custody.selected_authority_evidence})
 const store={async reserveNewCandidate(){allocations++;assert.equal(allocations,1);custody={operation_id:id,custody_session_id:randomUUID(),owner_wallet:owner,profile_sha256:f.profile.expectedSha256,mint:f.request.mint,selected_config:f.request.selectedConfig,stage:'reserved',revision:0,preparation_request:null,selected_authority_evidence:null};return summary()},
  async get(){throw Error('Setup must not open custody')},
  async retainPreparationIntent(_token,_id,{request,selectedAuthorityEvidence}){if(custody.preparation_request){assert.deepEqual(custody.preparation_request,request);assert.deepEqual(custody.selected_authority_evidence,selectedAuthorityEvidence)}else{custody.preparation_request=structuredClone(request);custody.selected_authority_evidence=structuredClone(selectedAuthorityEvidence);custody.revision++}return summary()},
  async retainPreparationReview(_token,_id,{request}){assert.deepEqual(request,custody.preparation_request);custody.stage='preparation-reviewed';custody.revision++;return summary()}}
 const pool={async connect(){return {...this,release(){}}},async query(sql,args){
  if(['begin','commit','rollback'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return {rows:[]}
  if(sql.includes('hook_lab_wallet_sessions'))return {rows:[{wallet:owner,origin:'https://repo.ing',audience:'general-launcher',genesis_hash:executionGenesis(),expires_at:new Date(Date.now()+60000),revoked_at:null}]}
  if(sql.includes('clock_timestamp() as now'))return {rows:[{now:new Date()}]}
  if(sql.includes('from hook_lab_native_signer_custody'))return {rows:custody?[structuredClone(custody)]:[]}
  if(sql.includes('select publication'))return {rows:[{publication}]}
  if(sql.includes('from hook_lab_launch_requests'))return {rows:[coin]}
  if(sql.startsWith('insert into hook_lab_selected_hook_setup_intents')){setup??={custody_operation_id:args[0],owner_wallet:args[1],profile_sha256:args[2],mint:args[3],selected_config:args[4],hook_publication:args[5],setup_request:args[6]};return {rows:[]}}
  if(sql.includes('from hook_lab_selected_hook_setup_intents'))return {rows:setup?[structuredClone(setup)]:[]}
  if(sql.startsWith('insert into hook_lab_native_launch_context')){context={custody_operation_id:args[0],owner_wallet:args[1],launch_request:args[2],preparation_limits:args[3],launch_limits:args[4],setup_limits:args[5]};return {rows:[]}}
  if(sql.includes('from hook_lab_native_launch_context'))return {rows:context?[structuredClone(context)]:[]}
  if(sql.includes('from hook_lab_native_signing_operations'))return {rows:finality?[finality]:[]}
  throw Error(sql)
 }}
 const setupLimits={computeUnits:200000,maxRentLamports:'10000',maxNetworkFeeLamports:'5000',maxTotalDebitLamports:'15000',validUntilSlot:150,reviewExpiresAtMs:2000}
 const accounts=new Map([...launchFixture.accounts,[owner,{address:owner,owner:'11111111111111111111111111111111',executable:false,lamports:'10000000',dataBase64:''}],
  [selectedHook.program,{...evidence.programAccount,lamports:'100000'}],[pd,{...evidence.programData,lamports:'100000'}]])
 const registry=pda(selectedHook.program,'bordrless-hook-accounts',pk(f.request.mint).toBuffer()),registryData=Buffer.from('02daf6662c38c0cd0100000000','hex').toString('base64')
 accounts.delete(registry)
 const tableRent=2000
 let tableSimulations=0,rentReads=0
 const connections=['one','two'].map(provider=>({provider,connection:{
  async getGenesisHash(){return JSON.parse(f.profile.json).genesisHash},
  async getMultipleAccountsInfoAndContext(keys){setupReads++;return {context:{slot:100},value:keys.map(k=>{const a=accounts.get(k.toBase58());return a?{owner:pk(a.owner),executable:a.executable,lamports:Number(a.lamports),data:Buffer.from(a.dataBase64,'base64')}:null})}},
  async getLatestBlockhashAndContext(){return {context:{slot:100},value:{blockhash:key(88),lastValidBlockHeight:200}}},
  async getBlock(){return {blockhash:key(88),blockHeight:50}},
  async getBlocks(start,end,commitment){assert.equal(end,99);assert.ok(start<=95);assert.equal(commitment,'finalized');return [95,97]},
  async getMinimumBalanceForRentExemption(size,commitment){rentReads++;assert.ok(size>56);assert.equal(commitment,'finalized');return tableRent},
  async isBlockhashValid(){return {context:{slot:100},value:true}},async getBlockHeight(){return 100},async getFeeForMessage(){return {context:{slot:100},value:5000}},
  async simulateTransaction(tx,opts){
   const instructions=tx.message.compiledInstructions.filter(i=>tx.message.staticAccountKeys[i.programIdIndex].equals(AddressLookupTableProgram.programId)).map(i=>new TransactionInstruction({programId:AddressLookupTableProgram.programId,data:Buffer.from(i.data),keys:i.accountKeyIndexes.map(index=>({pubkey:tx.message.staticAccountKeys[index],isSigner:tx.message.isAccountSigner(index),isWritable:tx.message.isAccountWritable(index)}))}))
   let table
   if(instructions.length){
    assert.deepEqual(instructions.map(i=>AddressLookupTableInstruction.decodeInstructionType(i)),['CreateLookupTable','ExtendLookupTable','FreezeLookupTable'])
    const create={...AddressLookupTableInstruction.decodeCreateLookupTable(instructions[0]),lookupTable:instructions[0].keys[0].pubkey},extend=AddressLookupTableInstruction.decodeExtendLookupTable(instructions[1]),freeze=AddressLookupTableInstruction.decodeFreezeLookupTable(instructions[2])
    assert.equal(create.recentSlot,97,'ALT seed is an actual finalized ancestor, not current bank or skipped slot');assert.equal(create.authority.toBase58(),owner);assert.equal(create.payer.toBase58(),owner)
    assert.ok(extend.lookupTable.equals(create.lookupTable));assert.ok(freeze.lookupTable.equals(create.lookupTable));assert.ok(extend.authority.equals(create.authority));assert.ok(freeze.authority.equals(create.authority));assert.equal(extend.payer.toBase58(),owner)
    const data=Buffer.alloc(56+32*extend.addresses.length);data.writeUInt32LE(1);data.writeBigUInt64LE(0xffffffffffffffffn,4);data.writeBigUInt64LE(100n,12)
    extend.addresses.forEach((a,i)=>a.toBuffer().copy(data,56+32*i))
    table={address:create.lookupTable.toBase58(),data};tableSimulations++
   }
   return {context:{slot:100},value:{err:null,unitsConsumed:1000,accounts:opts.accounts.addresses.map(address=>{
   if(address===registry)return {owner:selectedHook.program,executable:false,lamports:1000,data:[registryData,'base64']}
   if(address===table?.address)return {owner:AddressLookupTableProgram.programId.toBase58(),executable:false,lamports:tableRent,data:[table.data.toString('base64'),'base64']}
   const a=accounts.get(address);return a?{owner:a.owner,executable:a.executable,lamports:Number(a.lamports)-(address===owner?6000+(table?tableRent:0):0),data:[a.dataBase64,'base64']}:null
  })}}}
 }}))
 const mocked=(path,namedExports)=>t.mock.module(new URL(path,import.meta.url).href,{namedExports})
 mocked('../src/hooklab-native-signer-custody-store.mjs',{nativeSignerCustodyStore:()=>store})
 mocked('../src/hooklab-native-signing.mjs',{nativeSigningLifecycle:(_pool,{resolver,stageOperations})=>({...resolver,stageOperations})})
 mocked('../src/hooklab-native-custody-signing.mjs',{nativeCustodySigningAdapter:()=>({})})
 mocked('../src/hooklab-native-transaction-sender.mjs',{nativeTransactionSender:()=>({})})
 mocked('../src/hooklab-open-creation.mjs',{readOpenCreation:async()=>({native:true,open:true,paused:false,creatorFeeBps:[100],maxCreatorFeeBps:200,capBps:[100]})})
 mocked('../src/hooklab-max-wallet-launch-collector.mjs',{validateSelectedHookReleaseBindings:()=>{},observeReleasedSelectedHookCompatibility:async({program,stage,expectedEvidence})=>{
  assert.equal(program,selectedHook.program);if(changed)throw Error('Code changed');if(stage!=='initial')assert.deepEqual(expectedEvidence,evidence);return structuredClone(evidence)
 }})
 mocked('../src/hooklab-selected-hook-preparation-collector.mjs',{collectSelectedHookPreparationReview:async({request,selectedAuthorityEvidence,limits})=>{
  preparations++;assert.equal(finality?.status,'finalized-success');assert.deepEqual(selectedAuthorityEvidence,evidence);assert.equal(request.mint,custody.mint)
  for(const key of Object.keys(economics))assert.deepEqual(request[key],economics[key],'post-setup preparation retains economics')
  assert.equal(limits.maxTotalDebitLamports,f.limits.maxTotalDebitLamports)
  return {plan:{review:{synthetic:true}},collection:{synthetic:true}}
 }})
 mocked('../src/hooklab-max-wallet-preparation-resolver.mjs',{coLocatedMaxWalletPreparationResolver:()=>({resolve:async()=>({owner,stage:'preparation'})})})
 mocked('../src/hooklab-max-wallet-launch-resolver.mjs',{coLocatedMaxWalletLaunchResolver:()=>({})})
 const {createNativeLaunchRuntime}=await import('../src/hooklab-native-launch-runtime.mjs')
 const profile=f.profile
 const dossierJson=JSON.stringify({schema:'repoing/production-observation/2',accounts:['launch-config','swap-config'].map(role=>({role,binding:'config-counters-v1'}))})
 const settings={enabled:true,origin:'https://repo.ing',ownerCustodyApproved:true,operatorDeploymentApproved:true,economicsApproved:true,config:{launchLookupTable:{},selectedHookRelease:{schema:'repoing/selected-hook-release/2'}},profile,dossierJson,connections,preparationLimits:f.limits,launchLimits:f.limits,setupLimits,nativeLaunches:true,openLaunches:true,selectedHooksEnabled:true,clock:()=>1000,
  reviewTiming:async()=>({nowMs:1000,validUntilSlot:150,reviewExpiresAtMs:2000,maxTotalDebitLamports:'999999999'})}
 let runtime=createNativeLaunchRuntime(pool,settings)
 const args={sessionToken:token,owner,input},first=await runtime.reserve(args)
 assert.equal(first.mint,f.request.mint);assert.equal(first.hookSetupRequest.mint,first.mint);assert.equal(custody.stage,'reserved');assert.equal(preparations,0);assert.equal(setupReads,0)
 assert.deepEqual(first.request.postMintSetup,selection)
 for(const key of Object.keys(economics)){
  assert.deepEqual(first.request[key],economics[key]);assert.deepEqual(custody.preparation_request[key],economics[key]);assert.deepEqual(context.launch_request[key],economics[key])
 }
 assert.equal(first.request.configAuthor,undefined,'self-serve creator is the config author; no third-party scope')
 assert.deepEqual(context.launch_request.postMintSetup,selection,'launch retains the same publication/configuration as setup, before any mint exists')
 assert.deepEqual(custody.selected_authority_evidence,evidence);assert.deepEqual(context.setup_limits,setupLimits)
 runtime=createNativeLaunchRuntime(pool,settings)
 assert.deepEqual(await runtime.reserve(args),first);assert.equal(allocations,1)
 const stage={sessionToken:token,custodyOperationId:id,owner}
 for(const status of [undefined,'submitted','finalized-failure','conflict']){finality=status?{status,first_finalized:{status},first_conflict:null}:undefined;await assert.rejects(runtime.lifecycle.prepare({...stage,stage:'preparation'}))}
 assert.equal(preparations,0)
 assert.equal(runtime.lifecycle.stageOperations['hook-setup'],'selected-hook-setup')
 const reviewed=await runtime.lifecycle.prepare({...stage,stage:'hook-setup',limits:{maxTotalDebitLamports:'999999999'}})
 assert.deepEqual(reviewed.review.requiredSigners,[owner]);assert.equal(reviewed.review.maxNativeDebitLamports,'15000');assert.equal(preparations,0)
 const setupPlan=JSON.parse(reviewed.settlementContext.planJson)
 assert.ok(setupPlan.supplementalTable.addresses.length>0)
 assert.deepEqual(reviewed.review.supplementalTableCost,{address:setupPlan.supplementalTable.address,rentLamports:String(tableRent),permanentFreeze:true})
 assert.equal(rentReads,2);assert.equal(tableSimulations,4)
 const resumed=await runtime.lifecycle.revalidate({...stage,stage:'hook-setup',review:reviewed.review,settlementContext:reviewed.settlementContext})
 assert.deepEqual(resumed.review,reviewed.review)
 // Finality record is synthetic here; exact-chain settlement is covered by setup-stage tests.
 finality={status:'finalized-success',first_finalized:{status:'finalized-success'},first_conflict:null}
 await runtime.lifecycle.prepare({...stage,stage:'preparation'});assert.equal(preparations,1)
 runtime=createNativeLaunchRuntime(pool,settings)
 await runtime.lifecycle.prepare({...stage,stage:'preparation'});assert.equal(preparations,1)
 assert.deepEqual(await runtime.reserve(args),first);assert.equal(allocations,1)
 custody.stage='preparation-signed'
 assert.deepEqual(await runtime.reserve(args),first);assert.equal(allocations,1);assert.equal(preparations,1)
 for(const patch of [{name:'Changed'},{selectedHook:{...selectedHook,flags:1}},{hookPublication:{...selection,configuration:{...selection.configuration,feeBps:'101'}}},{quoteCut:undefined},{authorShareBps:0},{rules:'none'}])await assert.rejects(runtime.reserve({...args,input:{...input,...patch}}))
 changed=true;await assert.rejects(runtime.reserve(args));assert.equal(allocations,1)
 assert.throws(()=>createNativeLaunchRuntime(pool,{...settings,selectedHooksEnabled:false}).observeSelectedHookCompatibility({program:selectedHook.program}))
})
