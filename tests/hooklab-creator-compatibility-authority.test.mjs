import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import * as unit from '../src/hooklab-selected-hook-compatibility.mjs'
import { createHash } from 'node:crypto'
import { validateSelectedHookReleaseBindings, observeReleasedSelectedHookCompatibility } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { selectedLaunchCollectorFixture } from './fixtures/selected-hook-launch.mjs'
import { collectProductionOperatorBundle } from '../src/hooklab-production-operator-bundle.mjs'
import { sharedTradeAddresses } from '../src/hooklab-owner-launch-tables.mjs'
import { selectedHookSettings } from '../src/hooklab-production-bootstrap.mjs'
const key = n => new PublicKey(Buffer.alloc(32,n)).toBase58()
const loader='BPFLoaderUpgradeab1e11111111111111111111111'
const timelock='BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ'
const policy={schema:'repoing/selected-hook-compatibility/2',referenceCommit:'7fde54001d7f0c88b17c87babf73fb40be07b3cb',
 abi:{family:'bordrless-token-hook-v1',tokenFlagsMask:255,registryVersion:1,registryDiscriminator:'02daf6662c38c0cd',maxRegistryExtras:32,allowExtraSigners:false},
 authority:{immutable:true,timelock:{program:timelock,minDelaySeconds:259200,requireIdle:true},trustedUpgradeAuthorities:[]}}
function fixture(program=key(11),mutable=false){
 const [pd]=PublicKey.findProgramAddressSync([new PublicKey(program).toBuffer()],new PublicKey(loader))
 const [tl,bump]=PublicKey.findProgramAddressSync([Buffer.from('timelock'),new PublicKey(program).toBuffer()],new PublicKey(timelock))
 const p=Buffer.alloc(36);p.writeUInt32LE(2);pd.toBuffer().copy(p,4)
 const d=Buffer.alloc(50);d.writeUInt32LE(3);Buffer.from([127,69,76,70,1]).copy(d,45)
 if(mutable){d[12]=1;tl.toBuffer().copy(d,13)}
 const t=Buffer.alloc(279);Buffer.from('bd214e4bcd1f04b1','hex').copy(t);t[8]=1;t[9]=bump;new PublicKey(program).toBuffer().copy(t,10);pd.toBuffer().copy(t,42);t.writeUInt32LE(259200,138)
 const accounts=[{address:program,owner:loader,executable:true,dataBase64:p.toString('base64')},{address:pd.toBase58(),owner:loader,executable:false,dataBase64:d.toString('base64')},...(mutable?[{address:tl.toBase58(),owner:timelock,executable:false,dataBase64:t.toString('base64')}]:[])]
 if(mutable){
  const [executorData]=PublicKey.findProgramAddressSync([new PublicKey(timelock).toBuffer()],new PublicKey(loader))
  const ep=Buffer.alloc(36);ep.writeUInt32LE(2);executorData.toBuffer().copy(ep,4)
  const ed=Buffer.alloc(50);ed.writeUInt32LE(3);Buffer.from([127,69,76,70,1]).copy(ed,45)
  accounts.push({address:timelock,owner:loader,executable:true,dataBase64:ep.toString('base64')},
   {address:executorData.toBase58(),owner:loader,executable:false,dataBase64:ed.toString('base64')})
 }
 const connections=[0,1].map(i=>({provider:`reader-${i}`,trustDomain:`independent-${i}`,connection:{rpcEndpoint:`https://reader-${i}.invalid`,getGenesisHash:async()=>key(8),getMultipleAccountsInfoAndContext:async keys=>({context:{slot:10},value:keys.map(k=>{const a=accounts.find(a=>a.address===k.toBase58());return a?{owner:new PublicKey(a.owner),executable:a.executable,data:Buffer.from(a.dataBase64,'base64')}:null})})}}))
 return {accounts,connections,program,policy,genesisHash:key(8),forbiddenPrograms:[key(9)],minContextSlot:1}
}
test('two creator programs share one compatibility policy, not a hook allowlist',async()=>{
 assert.equal(typeof unit.observeSelectedHookCompatibility,'function')
 for(const id of [key(11),key(12)]){const result=await unit.observeSelectedHookCompatibility(fixture(id));assert.equal(result.hookPin.program,id);assert.equal(result.authority.kind,'immutable')}
})
test('client forged executable pin is not accepted',async()=>{await assert.rejects(()=>unit.observeSelectedHookCompatibility({...fixture(),hookPin:{elfSha256:'f'.repeat(64)}}))})
test('provider disagreement and retained identity changes are rejected',async()=>{
 const f=fixture();const retained=await unit.observeSelectedHookCompatibility(f)
 const d=f.accounts[1];d.dataBase64=Buffer.concat([Buffer.from(d.dataBase64,'base64'),Buffer.from([1])]).toString('base64')
 await assert.rejects(()=>unit.observeSelectedHookCompatibility({...f,expectedEvidence:retained}))
 f.connections[1].connection.getMultipleAccountsInfoAndContext=async()=>({context:{slot:10},value:[null,null,null]})
 await assert.rejects(()=>unit.observeSelectedHookCompatibility(f))
})
test('idle timelock evidence accepted; malformed, pending, short and changed authority rejected',async()=>{
 const f=fixture(key(11),true),retained=await unit.observeSelectedHookCompatibility(f);assert.equal(retained.authority.kind,'timelocked')
 for(const [offset,value] of [[0,0],[8,2],[9,0],[138,0],[143,1],[175,1],[207,1],[211,1],[219,1],[142,1]]){
  const b=Buffer.from(f.accounts[2].dataBase64,'base64');b[offset]=value;const original=f.accounts[2].dataBase64;f.accounts[2].dataBase64=b.toString('base64')
  await assert.rejects(()=>unit.observeSelectedHookCompatibility(f));f.accounts[2].dataBase64=original
 }
 const b=Buffer.from(f.accounts[1].dataBase64,'base64');b[12]=0;f.accounts[1].dataBase64=b.toString('base64')
 await assert.rejects(()=>unit.observeSelectedHookCompatibility({...f,expectedEvidence:retained}))
})
test('protocol roles, system and kit are forbidden and policy semantics cannot drift',async()=>{
 const f=fixture();await assert.rejects(()=>unit.observeSelectedHookCompatibility({...f,forbiddenPrograms:[f.program]}))
 await assert.rejects(()=>unit.observeSelectedHookCompatibility({...f,program:'11111111111111111111111111111111'}))
 await assert.rejects(()=>unit.observeSelectedHookCompatibility({...f,policy:{...policy,referenceCommit:'0'.repeat(40)}}))
})
test('a mutable timelock executor cannot vouch for a delayed hook',async()=>{
 const f=fixture(key(11),true),b=Buffer.from(f.accounts[4].dataBase64,'base64')
 b[12]=1;new PublicKey(key(22)).toBuffer().copy(b,13);f.accounts[4].dataBase64=b.toString('base64')
 await assert.rejects(()=>unit.observeSelectedHookCompatibility(f),/executor/i)
})
test('v2 release binds semantic policy without a singleton; v1 cannot masquerade as policy',()=>{
 const f=selectedLaunchCollectorFixture(),d=JSON.parse(f.dossierJson)
 d.schema='repoing/production-observation/2'
 for(const a of d.accounts.filter(a=>['launch-config','swap-config'].includes(a.role)))Object.assign(a,{binding:'config-counters-v1',approvedDataBase64:f.accounts.get(a.address).dataBase64,idlSha256:f.p.idlSha256[a.role.split('-')[0]]})
 f.dossierJson=JSON.stringify(d);f.config.dossierSha256=createHash('sha256').update(f.dossierJson).digest('hex')
 delete f.config.selectedHookPin
 f.config.selectedHookRelease={schema:'repoing/selected-hook-release/2',approvalReference:f.config.approvalReference,sourceCommit:f.p.sourceCommit,
  profileSha256:f.config.profileSha256,dossierSha256:f.config.dossierSha256,compatibilityPolicy:policy,acceptanceSha256:'a'.repeat(64),releaseVerificationSha256:'b'.repeat(64)}
 assert.doesNotThrow(()=>validateSelectedHookReleaseBindings(f))
 assert.equal(typeof observeReleasedSelectedHookCompatibility,'function')
 f.config.selectedHookPin={program:key(11),elfSha256:'c'.repeat(64),elfLength:5}
 assert.throws(()=>validateSelectedHookReleaseBindings(f))
 delete f.config.selectedHookPin;f.config.selectedHookRelease.compatibilityPolicy={...policy,authority:{...policy.authority,trustedUpgradeAuthorities:[key(11)]}}
 assert.throws(()=>validateSelectedHookReleaseBindings(f))
})
test('operator bundle adopts a policy, not a per-program owner allowlist',async()=>{
 const f=selectedLaunchCollectorFixture(),lookupTable=key(23),table=Buffer.alloc(56)
 table.writeUInt32LE(1);table.writeBigUInt64LE(0xffffffffffffffffn,4)
 f.accounts.set(lookupTable,{address:lookupTable,owner:'AddressLookupTab1e1111111111111111111111111',executable:false,lamports:'10000',dataBase64:Buffer.concat([table,...sharedTradeAddresses(f.p).map(a=>new PublicKey(a).toBuffer())]).toString('base64')})
 for(const {connection} of f.connections)connection.getSlot=async()=>100
 const bundle=await collectProductionOperatorBundle({connections:f.connections,trustDomains:f.config.providerTrustDomains,lookupTable,launchTable:f.config.launchLookupTable.address,
  reviewer:f.config.reviewer,treasury:f.config.treasury,approvalReference:f.config.approvalReference,
  artifacts:{base:f.p,idls:Object.fromEntries(Object.entries(f.profile.idls).map(([r,b])=>[r,Buffer.from(b,'base64')])),elfLengths:f.profile.elfLengths,sdkSha256:'1'.repeat(64),open:true},
  selectedHookReleaseEvidence:{compatibilityPolicy:policy,acceptanceSha256:'a'.repeat(64),releaseVerificationSha256:'b'.repeat(64)}})
 assert.equal(bundle.config.selectedHookRelease.schema,'repoing/selected-hook-release/2')
 assert.equal(bundle.config.selectedHookPin,undefined)
 assert.doesNotThrow(()=>validateSelectedHookReleaseBindings({...bundle,connections:f.connections}))
 assert.throws(()=>selectedHookSettings({env:{HOOK_SELECTED_HOOKS_ENABLED:'true'},stack:bundle,connections:f.connections,open:true}),/authority-evidence integration/)
 const args={...bundle,connections:f.connections,program:f.config.selectedHookPin.program,stage:'initial'}
 const evidence=await observeReleasedSelectedHookCompatibility(args)
 assert.equal(evidence.hookPin.program,args.program)
 for(const stage of ['wallet-request','cosign','send','revalidation','recovery']){
  await assert.rejects(()=>observeReleasedSelectedHookCompatibility({...args,stage}))
  assert.deepEqual((await observeReleasedSelectedHookCompatibility({...args,stage,expectedEvidence:evidence})).hookPin,evidence.hookPin)
 }
 await assert.rejects(()=>observeReleasedSelectedHookCompatibility({...args,program:f.p.stack.kitProgram}))
})
test('future deployment, stale snapshot, shared trust and arbitrary mutable authority fail closed',async()=>{
 for(const mutation of [
  f=>{const b=Buffer.from(f.accounts[1].dataBase64,'base64');b.writeBigUInt64LE(11n,4);f.accounts[1].dataBase64=b.toString('base64')},
  f=>{f.minContextSlot=11},
  f=>{f.connections[1].trustDomain=f.connections[0].trustDomain},
  f=>{const b=Buffer.from(f.accounts[1].dataBase64,'base64');b[12]=1;new PublicKey(key(22)).toBuffer().copy(b,13);f.accounts[1].dataBase64=b.toString('base64')},
 ]){const f=fixture();mutation(f);await assert.rejects(()=>unit.observeSelectedHookCompatibility(f))}
})
test('explicit local acceptance observes one validator through two labelled proxies without independent trust claims',async()=>{
 const env={NODE_ENV:'development',HOOK_LOCAL_ACCEPTANCE:'true',HOOK_LOCAL_ACCEPTANCE_GENESIS:key(8),
  HOOK_WALLET_IDENTITY_ORIGIN:'https://localhost:8000',HOOK_WALLET_IDENTITY_DATABASE_URL:'postgres://localhost/hooks_local_compat',
  HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY:'https://localhost:8001',HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY:'https://localhost:8002'}
 const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]))
 try{
  Object.assign(process.env,env)
  const f=fixture()
  f.connections.forEach((c,i)=>{c.trustDomain='single-local-validator';c.connection.rpcEndpoint=env[i?'HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY':'HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY']})
  const evidence=await unit.observeSelectedHookCompatibility(f)
  assert.equal(evidence.topology,'single-local-validator-two-proxies')
  assert.deepEqual(unit.selectedHookAuthorityEvidenceSchema.parse(evidence),evidence)
  assert.deepEqual(await unit.observeSelectedHookCompatibility({...f,expectedEvidence:evidence}),evidence)
  for(const mutate of [
   ()=>{process.env.HOOK_LOCAL_ACCEPTANCE='false'},
   ()=>{process.env.NODE_ENV='production'},
   ()=>{process.env.HOOK_LOCAL_ACCEPTANCE_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'},
   ()=>{f.connections[1].connection.rpcEndpoint='https://remote.invalid'},
   ()=>{f.connections[1].connection.rpcEndpoint+='?override=1'},
   ()=>{f.connections[1].trustDomain='pretend-independent'},
  ]){
   const endpoint=f.connections[1].connection.rpcEndpoint
   mutate();await assert.rejects(()=>unit.observeSelectedHookCompatibility(f))
   Object.assign(process.env,env);f.connections[1].connection.rpcEndpoint=endpoint;f.connections[1].trustDomain='single-local-validator'
  }
  const b=Buffer.from(f.accounts[1].dataBase64,'base64');b[12]=1;new PublicKey(key(22)).toBuffer().copy(b,13);f.accounts[1].dataBase64=b.toString('base64')
  await assert.rejects(()=>unit.observeSelectedHookCompatibility(f),/Unbounded upgrade authority/)
 }finally{for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
})
