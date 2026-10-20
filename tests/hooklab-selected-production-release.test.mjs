import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import * as collector from '../src/hooklab-max-wallet-launch-collector.mjs'
import * as bootstrap from '../src/hooklab-production-bootstrap.mjs'
import {nativeTradeResolver} from '../src/hooklab-native-trade-resolver.mjs'
import {createNativeLaunchRuntime} from '../src/hooklab-native-launch-runtime.mjs'
import {selectedLaunchCollectorFixture} from './fixtures/selected-hook-launch.mjs'
import {collectProductionOperatorBundle} from '../src/hooklab-production-operator-bundle.mjs'
import {sharedTradeAddresses} from '../src/hooklab-owner-launch-tables.mjs'
import {PublicKey} from '@solana/web3.js'
const sha=x=>createHash('sha256').update(x).digest('hex')

function approved(){
 const f=selectedLaunchCollectorFixture(),d=JSON.parse(f.dossierJson)
 d.schema='repoing/production-observation/2'
 for(const a of d.accounts.filter(a=>['launch-config','swap-config'].includes(a.role))){
  const role=a.role.split('-')[0]
  Object.assign(a,{binding:'config-counters-v1',approvedDataBase64:f.accounts.get(a.address).dataBase64,idlSha256:f.p.idlSha256[role]})
 }
 f.dossierJson=JSON.stringify(d);f.config.dossierSha256=sha(f.dossierJson)
 f.config.selectedHookRelease={schema:'repoing/selected-hook-release/1',approvalReference:f.config.approvalReference,
  sourceCommit:f.p.sourceCommit,profileSha256:f.config.profileSha256,dossierSha256:f.config.dossierSha256,
  hookPin:f.config.selectedHookPin,acceptanceSha256:'a'.repeat(64),releaseVerificationSha256:'b'.repeat(64)}
 return f
}

test('production selected signing requires one adopted release binding, not the local switch or a hook pin alone',()=>{
 const f=approved()
 assert.equal(typeof collector.validateSelectedHookReleaseBindings,'function')
 const bound=collector.validateSelectedHookReleaseBindings(f)
 assert.equal(bound.profile.sourceCommit,f.p.sourceCommit)
 const settings=bootstrap.selectedHookSettings({env:{HOOK_SELECTED_HOOKS_ENABLED:'true'},stack:f,open:true})
 assert.deepEqual(settings,{selectedHooksEnabled:true,selectedHookPin:f.config.selectedHookPin})
 assert.deepEqual(bootstrap.selectedHookSettings({env:{},stack:f,open:true}),{selectedHooksEnabled:false,selectedHookPin:null})
 for(const mutate of [
  x=>delete x.config.selectedHookRelease,
  x=>x.config.selectedHookRelease.sourceCommit='0'.repeat(40),
  x=>x.config.selectedHookRelease.profileSha256='0'.repeat(64),
  x=>x.config.selectedHookRelease.dossierSha256='0'.repeat(64),
  x=>x.config.selectedHookRelease.hookPin={...x.config.selectedHookPin,elfSha256:'0'.repeat(64)},
  x=>x.config.selectedHookRelease.approvalReference='another approval',
  x=>delete x.config.selectedHookRelease.releaseVerificationSha256,
  x=>x.config.selectedHookPin.program=x.p.programs.gate,
 ]){const x=approved();mutate(x);assert.throws(()=>bootstrap.selectedHookSettings({env:{HOOK_SELECTED_HOOKS_ENABLED:'true'},stack:x,open:true}))}
 assert.throws(()=>bootstrap.selectedHookSettings({env:{HOOK_SELECTED_HOOKS_ENABLED:'true',HOOK_LOCAL_SELECTED_HOOKS_ENABLED:'true'},stack:f,open:true}))
 assert.throws(()=>bootstrap.selectedHookSettings({env:{HOOK_SELECTED_HOOKS_ENABLED:'true'},stack:f,open:false}))
 for(const program of [f.p.programs.gate,'FbAuVaTqVPzs43KdsQE8ByfbMJdRFABanya3fuEVjdRM']){
  const x=approved();x.config.selectedHookPin.program=program;x.config.selectedHookRelease.hookPin.program=program
  assert.throws(()=>collector.validateSelectedHookReleaseBindings(x),/stack role or acceptance fixture/)
 }
 for(const mutate of [
  x=>{const d=JSON.parse(x.dossierJson);d.schema='repoing/production-observation/1';for(const a of d.accounts){delete a.binding;delete a.approvedDataBase64;delete a.idlSha256}x.dossierJson=JSON.stringify(d)},
  x=>{const d=JSON.parse(x.dossierJson),a=d.accounts.find(a=>a.role==='swap-config');delete a.binding;delete a.approvedDataBase64;delete a.idlSha256;x.dossierJson=JSON.stringify(d)},
  x=>{const p=JSON.parse(x.profile.json);p.stack.open=false;x.profile.json=JSON.stringify(p);x.profile.expectedSha256=x.config.profileSha256=sha(x.profile.json);const d=JSON.parse(x.dossierJson);d.artifacts.profileSha256=x.config.profileSha256;x.dossierJson=JSON.stringify(d)},
  x=>x.connections[1].connection=x.connections[0].connection,
 ]){
  const x=approved();mutate(x);x.config.dossierSha256=sha(x.dossierJson)
  Object.assign(x.config.selectedHookRelease,{profileSha256:x.config.profileSha256,dossierSha256:x.config.dossierSha256})
  assert.throws(()=>collector.validateSelectedHookReleaseBindings(x),'internally matching hashes cannot bypass deployment/topology prerequisites')
 }
})

test('direct launch and trading runtime composition enforce the same production release record',()=>{
 const f=approved()
 // No database call or RPC happens during construction; execution still revalidates actual chain bytes.
 const trade=nativeTradeResolver({...f,selectedNativeTradingEnabled:true})
 assert.equal(typeof trade.prepare,'function')
 const launch=createNativeLaunchRuntime({}, {...f,enabled:true,origin:'https://app.example.org',ownerCustodyApproved:true,
  operatorDeploymentApproved:true,economicsApproved:true,nativeLaunches:true,openLaunches:true,selectedHooksEnabled:true,
  keyRing:{test:Buffer.alloc(32,7)},activeKeyId:'test',preparationLimits:f.limits,launchLimits:f.limits})
 assert.equal(launch.selectedHooksEnabled,true)
 delete f.config.selectedHookRelease
 assert.throws(()=>nativeTradeResolver({...f,selectedNativeTradingEnabled:true}))
 assert.throws(()=>createNativeLaunchRuntime({}, {...f,enabled:true,ownerCustodyApproved:true,
  operatorDeploymentApproved:true,economicsApproved:true,openLaunches:true,selectedHooksEnabled:true}))
})

test('production collection binds selected release evidence to its own fresh dossier and immutable executable',async()=>{
 const f=approved(),lookupTable=PublicKey.unique().toBase58(),table=Buffer.alloc(56)
 table.writeUInt32LE(1);table.writeBigUInt64LE(0xffffffffffffffffn,4)
 f.accounts.set(lookupTable,{address:lookupTable,owner:'AddressLookupTab1e1111111111111111111111111',executable:false,lamports:'10000',
  dataBase64:Buffer.concat([table,...sharedTradeAddresses(f.p).map(a=>new PublicKey(a).toBuffer())]).toString('base64')})
 for(const {connection} of f.connections)connection.getSlot=async()=>100
 const evidence={hookPin:f.config.selectedHookPin,acceptanceSha256:'c'.repeat(64),releaseVerificationSha256:'d'.repeat(64)}
 const input={connections:f.connections,trustDomains:f.config.providerTrustDomains,lookupTable,launchTable:f.config.launchLookupTable.address,
  reviewer:f.config.reviewer,treasury:f.config.treasury,approvalReference:f.config.approvalReference,
  artifacts:{base:f.p,idls:Object.fromEntries(Object.entries(f.profile.idls).map(([r,b])=>[r,Buffer.from(b,'base64')])),elfLengths:f.profile.elfLengths,sdkSha256:'1'.repeat(64),open:true},
  selectedHookReleaseEvidence:evidence}
 const bundle=await collectProductionOperatorBundle(input)
 assert.deepEqual(bundle.config.selectedHookPin,evidence.hookPin)
 assert.deepEqual(bundle.config.selectedHookRelease,{schema:'repoing/selected-hook-release/1',approvalReference:input.approvalReference,
  sourceCommit:f.p.sourceCommit,profileSha256:bundle.config.profileSha256,dossierSha256:sha(bundle.dossierJson),...evidence})
 assert.doesNotThrow(()=>collector.validateSelectedHookReleaseBindings({...bundle,connections:f.connections}))
 const pd=PublicKey.findProgramAddressSync([new PublicKey(evidence.hookPin.program).toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58()
 const original=f.accounts.get(pd),data=Buffer.from(original.dataBase64,'base64');data[12]=1
 f.accounts.set(pd,{...original,dataBase64:data.toString('base64')})
 await assert.rejects(collectProductionOperatorBundle(input),/selected hook/)
 f.accounts.set(pd,original)
 await assert.rejects(collectProductionOperatorBundle({...input,selectedHookReleaseEvidence:{...evidence,hookPin:{...evidence.hookPin,elfSha256:'0'.repeat(64)}}}),/selected hook/)
 await assert.rejects(collectProductionOperatorBundle({...input,selectedHookReleaseEvidence:{...evidence,canSign:true}}))
})
