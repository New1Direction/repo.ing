import test from 'node:test'
import {readFileSync} from 'node:fs'
import {deriveMaxWalletLaunchPostconditions} from '../src/hooklab-max-wallet-launch-settlement.mjs'
import assert from 'node:assert/strict'
import {compileMaxWalletLaunchReview,parseMaxWalletLaunchRequest} from '../src/hooklab-max-wallet-launch.mjs'
import {inclusiveMaxWalletLaunchFixture,inclusiveRustVector} from './fixtures/hooklab-inclusive-max-wallet-launch.mjs'
import {inclusiveGeneratedArtifact,missingInclusiveArtifacts} from './fixtures/hooklab-generated-artifact.mjs'
const inclusiveVector=missingInclusiveArtifacts(['inclusive-builder-vector.json'])
test('V3 launch compiler matches final actual SBF instruction bytes and ordered metas',{skip:inclusiveVector},()=>{
 const f=inclusiveMaxWalletLaunchFixture(),v=inclusiveRustVector(),p=compileMaxWalletLaunchReview(f)
 assert.equal(p.canonicalInstruction.dataHex,v.launch.instruction.dataHex)
 assert.deepEqual(p.canonicalInstruction.accounts.map(k=>({pubkey:k.address,isSigner:k.signer,isWritable:k.writable})),v.launch.instruction.keys)
 assert.equal(p.request.creatorFeeBps,100)
})
test('V3 launch cannot silently change chosen economics or select legacy family',{skip:inclusiveVector},()=>{
 for(const patch of [{creatorFeeBps:0},{creatorFeeBps:101},{feeModel:1},{protocolShareBps:2000},{policyVersion:1}]){
  const f=inclusiveMaxWalletLaunchFixture();Object.assign(f.request,patch);assert.throws(()=>compileMaxWalletLaunchReview(f))
 }
 const f=inclusiveMaxWalletLaunchFixture();delete f.request.creatorFeeBps;assert.throws(()=>parseMaxWalletLaunchRequest(f.request))
})

test('complete canonical initial poststate matches actual SBF after-create snapshot including mint tail',{skip:missingInclusiveArtifacts(['inclusive-builder-vector.json','inclusive-post-launch-snapshot.json'])},()=>{
 const f=inclusiveMaxWalletLaunchFixture(),v=JSON.parse(readFileSync(inclusiveGeneratedArtifact('inclusive-post-launch-snapshot.json'))),m=new Map(v.accounts.map(x=>[x.pubkey,x.account]))
 const expected=deriveMaxWalletLaunchPostconditions({schema:'repoing/max-wallet-launch-settlement-context/1',compilationInput:f},{slot:Number(v.slot),timestamp:Number(v.timestamp)})
 for(const a of expected.accounts){const actual=m.get(a.address);assert.ok(actual,a.address);assert.equal(actual.owner,a.owner);assert.equal(actual.dataBase64,a.dataBase64,a.address)}
})
