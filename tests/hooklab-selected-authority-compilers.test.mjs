import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { fixture, sha, pk, pda, connections } from './fixtures/selected-hook-preparation.mjs'
import { deriveCustomPreparationRecord, verifyCustomPreparationEvidence, collectCustomPreparationEvidence } from '../src/hooklab-custom-preparation-receipts.mjs'
import { selectedHookPreparationReceiptFixture, selectedHookPreparationRpcProviders } from './fixtures/selected-hook-preparation-receipts.mjs'
import { selectedLaunchFixture, selectedLaunchCollectorFixture } from './fixtures/selected-hook-launch.mjs'
import { planSelectedHookPreparation } from '../src/hooklab-selected-hook-preparation.mjs'
import { collectSelectedHookPreparationReview } from '../src/hooklab-selected-hook-preparation-collector.mjs'
import { compileSelectedHookLaunchReview, selectedHookLaunchInventory } from '../src/hooklab-max-wallet-launch.mjs'
import { collectOpenLaunchReview } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { deriveOpenLaunchPostconditions } from '../src/hooklab-max-wallet-launch-settlement.mjs'

const loader='BPFLoaderUpgradeab1e11111111111111111111111',executor='BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ'
function evidence(f, delayed=false) {
 const accounts=f.accounts??new Map(f.observations[0].accounts.map(a=>[a.address,a.account])),pin=f.input?.hookPin??f.hookPin
 const identity=a=>{const {lamports,...rest}=a;return rest}
 const programAccount=identity(accounts.get(pin.program)),programData=identity(accounts.get(pda(loader,pk(pin.program).toBuffer())))
 let authority={kind:'immutable',upgradeAuthority:null}
 if(delayed){
  const [tl,bump]=PublicKey.findProgramAddressSync([Buffer.from('timelock'),pk(pin.program).toBuffer()],pk(executor)),epd=pda(loader,pk(executor).toBuffer())
  const pb=Buffer.alloc(36),db=Buffer.alloc(49),tb=Buffer.alloc(279)
  pb.writeUInt32LE(2);pk(epd).toBuffer().copy(pb,4);db.writeUInt32LE(3);Buffer.from([127,69,76,70]).copy(db,45)
  Buffer.from('bd214e4bcd1f04b1','hex').copy(tb);tb[8]=1;tb[9]=bump;pk(pin.program).toBuffer().copy(tb,10);pk(programData.address).toBuffer().copy(tb,42);tb.writeUInt32LE(259200,138)
  const hp=Buffer.from(programData.dataBase64,'base64');hp[12]=1;tl.toBuffer().copy(hp,13);programData.dataBase64=hp.toString('base64')
  const account=(address,owner,data,executable=false)=>({address,owner,executable,dataBase64:data.toString('base64')})
  authority={kind:'timelocked',upgradeAuthority:tl.toBase58(),delaySeconds:259200,timelock:account(tl.toBase58(),executor,tb),executor:account(executor,loader,pb,true),executorProgramData:account(epd,loader,db)}
 }
 const e={schema:'repoing/selected-hook-authority-evidence/2',genesisHash:JSON.parse((f.input??f).profile.json).genesisHash,policySha256:'a'.repeat(64),hookPin:pin,programAccount,programData,authority,
  programSha256:sha(Buffer.from(programAccount.dataBase64,'base64')),programDataSha256:sha(Buffer.from(programData.dataBase64,'base64')),executableSha256:pin.elfSha256,observedSlot:100,providers:(f.input??f).profile.providers}
 for(const a of [programAccount,programData,...(delayed?[authority.timelock,authority.executor,authority.executorProgramData]:[])])accounts.set(a.address,{...a,lamports:'10000'})
 return {e,accounts}
}
function prepare(delayed){
 const f=fixture(),{e,accounts}=evidence(f,delayed);f.selectedAuthorityEvidence=e
 for(const o of f.observations){for(const a of o.accounts)if(a.account)a.account=accounts.get(a.address);if(delayed)o.accounts.push(...[e.authority.timelock,e.authority.executor,e.authority.executorProgramData].map(a=>({address:a.address,account:accounts.get(a.address)})))}
 f.observations=f.observations.map(o=>structuredClone(o))
 return f
}
function launch(e,delayed){
 const f=selectedLaunchFixture(),input=f.input
 input.selectedAuthorityEvidence=e
 for(const a of [e.programAccount,e.programData,...(delayed?[e.authority.timelock,e.authority.executor,e.authority.executorProgramData]:[])])f.accounts.set(a.address,{...a,lamports:'10000'})
 if(delayed){const a=f.accounts.get(input.request.selectedConfig),b=Buffer.from(a.dataBase64,'base64'),v=f.coders.launch.accounts.decode('LaunchConfig',b);v.reserved[0]=1;f.coders.launch.types.encode('LaunchConfig',v).copy(b,8);a.dataBase64=b.toString('base64');input.preparationEvidence.preparedAccountHashes.selectedConfig=sha(b)}
 const {inventory}=selectedHookLaunchInventory(input.profile,input.request,f.configBytes,{accounts:f.accounts,hookPin:input.hookPin,selectedAuthorityEvidence:e})
 for(const o of input.observations)o.accounts=inventory.map(address=>({address,account:f.accounts.get(address)??null}))
 input.observations=input.observations.map(o=>structuredClone(o))
 return f
}
for(const delayed of [false,true])test(`original ${delayed?'delayed':'immutable'} evidence survives preparation to launch and settlement`,()=>{
 const f=prepare(delayed),prep=planSelectedHookPreparation(f),l=launch(f.selectedAuthorityEvidence,delayed),plan=compileSelectedHookLaunchReview(l.input)
 assert.deepEqual(prep.selectedAuthorityEvidence,f.selectedAuthorityEvidence)
 assert.deepEqual(plan.selectedAuthorityEvidence,f.selectedAuthorityEvidence)
 if(delayed){const a=f.selectedAuthorityEvidence.authority;assert.deepEqual(prep.instructions[2].accounts.slice(-4).map(a=>a.address),[f.selectedAuthorityEvidence.programData.address,a.timelock.address,a.executor.address,a.executorProgramData.address]);assert.deepEqual(plan.canonicalInstruction.accounts.slice(32,36).map(a=>a.address),[l.addresses.launchGovernance,f.selectedAuthorityEvidence.programData.address,a.executor.address,a.executorProgramData.address]);assert.equal(plan.canonicalInstruction.accounts.at(-2).address,a.timelock.address)}
 const context={schema:'repoing/open-launch-settlement-context/1',compilationInput:l.input,selectedAuthorityEvidence:f.selectedAuthorityEvidence}
 assert.doesNotThrow(()=>deriveOpenLaunchPostconditions(context,{slot:110,timestamp:1000}))
 assert.throws(()=>deriveOpenLaunchPostconditions({...context,selectedAuthorityEvidence:undefined},{slot:110,timestamp:1000}))
})
test('both compilers refuse changed retained hook bytes and mutable executor',()=>{
 for(const target of ['hook','executor']){
  const f=prepare(true),l=launch(f.selectedAuthorityEvidence,true),e=f.selectedAuthorityEvidence
  const address=target==='hook'?e.programData.address:e.authority.executorProgramData.address
  const mutate=a=>{const b=Buffer.from(a.dataBase64,'base64');b[12]=1;b[b.length-1]^=1;a.dataBase64=b.toString('base64')}
  for(const o of f.observations)mutate(o.accounts.find(a=>a.address===address).account)
  for(const o of l.input.observations)mutate(o.accounts.find(a=>a.address===address).account)
  assert.throws(()=>planSelectedHookPreparation(f));assert.throws(()=>compileSelectedHookLaunchReview(l.input))
 }
 const f=prepare(true);const a=f.selectedAuthorityEvidence.authority.executorProgramData,b=Buffer.from(a.dataBase64,'base64');b[12]=1;a.dataBase64=b.toString('base64')
 for(const o of f.observations)o.accounts.find(v=>v.address===a.address).account.dataBase64=a.dataBase64
 assert.throws(()=>planSelectedHookPreparation(f),/executor must be immutable/)
})
test('launch collection retains original evidence in compiler and top-level settlement context',async()=>{
 const f=selectedLaunchCollectorFixture(),{e}=evidence(f)
 const result=await collectOpenLaunchReview({...f,selectedAuthorityEvidence:e})
 assert.deepEqual(result.settlementContext.selectedAuthorityEvidence,e)
 assert.deepEqual(result.settlementContext.compilationInput.selectedAuthorityEvidence,e)
})
test('delayed preparation collector preserves original evidence and config template binds the Rust timelock bit',async()=>{
 const f=prepare(true),result=await collectSelectedHookPreparationReview({...f,connections:connections(f),clock:()=>1000})
 assert.deepEqual(result.preparationInput.selectedAuthorityEvidence,f.selectedAuthorityEvidence)
 const record=deriveCustomPreparationRecord(result.preparationInput,f.profile.expectedSha256)
 const coder=launch(f.selectedAuthorityEvidence,true).coders.launch
 const v=coder.accounts.decode('LaunchConfig',Buffer.from(record.expectedAccounts.selectedConfig.canonicalTemplateBase64,'base64'))
 assert.deepEqual(v.reserved,[1,...Array(29).fill(0)])
})
test('release 2 launch collector uses retained per-operation pin without a singleton',async()=>{
 const f=selectedLaunchCollectorFixture(),{e}=evidence(f),d=JSON.parse(f.dossierJson)
 d.schema='repoing/production-observation/2'
 for(const a of d.accounts.filter(a=>['launch-config','swap-config'].includes(a.role)))Object.assign(a,{binding:'config-counters-v1',approvedDataBase64:f.accounts.get(a.address).dataBase64,idlSha256:f.p.idlSha256[a.role.split('-')[0]]})
 f.dossierJson=JSON.stringify(d);f.config.dossierSha256=sha(f.dossierJson);delete f.config.selectedHookPin
 f.config.selectedHookRelease={schema:'repoing/selected-hook-release/2',approvalReference:f.config.approvalReference,sourceCommit:f.p.sourceCommit,profileSha256:f.config.profileSha256,dossierSha256:f.config.dossierSha256,
  compatibilityPolicy:{schema:'repoing/selected-hook-compatibility/2',referenceCommit:'7fde54001d7f0c88b17c87babf73fb40be07b3cb',abi:{family:'bordrless-token-hook-v1',tokenFlagsMask:255,registryVersion:1,registryDiscriminator:'02daf6662c38c0cd',maxRegistryExtras:32,allowExtraSigners:false},authority:{immutable:true,timelock:{program:executor,minDelaySeconds:259200,requireIdle:true},trustedUpgradeAuthorities:[]}},acceptanceSha256:'a'.repeat(64),releaseVerificationSha256:'b'.repeat(64)}
 const result=await collectOpenLaunchReview({...f,selectedAuthorityEvidence:e})
 assert.deepEqual(result.settlementContext.compilationInput.hookPin,e.hookPin)
 assert.deepEqual(result.settlementContext.selectedAuthorityEvidence,e)
 await assert.rejects(collectOpenLaunchReview(f))
})
test('preparation accepts more than four registry extras without changing privileges',()=>{
 const f=prepare(false),count=Buffer.alloc(4);count.writeUInt32LE(5)
 const bytes=Buffer.concat([Buffer.from('02daf6662c38c0cd01','hex'),count,...Array.from({length:5},(_,i)=>Buffer.concat([Buffer.from([0,0]),Buffer.alloc(32,110+i)]))])
 for(const o of f.observations)o.accounts[5].account.dataBase64=bytes.toString('base64')
 const plan=planSelectedHookPreparation(f)
 assert.equal(plan.selectedHook.extras.length,5)
 assert.ok(plan.selectedHook.extras.every(a=>!a.signer&&!a.writable))
})
test('delayed preparation settles exact authority snapshots and refuses changed executor after inclusion',async()=>{
 const f=selectedHookPreparationReceiptFixture(prepare(true))
 assert.equal(verifyCustomPreparationEvidence(f).status,'candidate-preparation-matched')
 const {providers}=selectedHookPreparationRpcProviders(f)
 const collected=await collectCustomPreparationEvidence({...f,providers})
 assert.equal(collected.result.status,'candidate-preparation-matched')
 for(const o of f.observations){const a=o.programSnapshot.accounts.find(a=>a.role==='executorProgramData'),b=Buffer.from(a.dataBase64,'base64');b[12]=1;a.dataBase64=b.toString('base64')}
 assert.equal(verifyCustomPreparationEvidence(f).status,'unresolved')
})
