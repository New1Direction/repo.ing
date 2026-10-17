import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inclusiveMaxWalletProfileSchema, inclusiveMaxWalletPreparationRequestSchema, planInclusiveMaxWalletPreparation } from '../src/hooklab-inclusive-max-wallet-preparation.mjs'
import { maxWalletProfileSchema } from '../src/hooklab-max-wallet-preparation.mjs'
import { inclusiveMaxWalletPreparationInventory } from '../src/hooklab-inclusive-max-wallet-preparation-collector.mjs'
import { inclusiveMaxWalletPolicyAddress } from '../src/hooklab-inclusive-fee-abi.mjs'
// Schema-only input, never represented as an executed V3 fixture or adopted profile.
const legacy = JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/max-wallet-candidate/offline-builder-profile.json', import.meta.url)))
const candidate = () => ({...structuredClone(legacy), schema:'hook-lab/offline-inclusive-max-wallet-builder-profile/1',buildFeature:'inclusive-fees-candidate',
 capability:{...legacy.capability,policyVersion:2,creatorFeeBps:100,feeModel:2,protocolShareBps:2500,eligibleFeeClass:'creator-quote',rounding:'floor-platform-per-swap-residual-creator'}})
const request = p => ({schema:'repoing/inclusive-max-wallet-preparation-request/1',policyKind:'max-wallet',policyVersion:2,
 creator:p.programs.launch,feePayer:p.programs.launch,mint:p.programs.gate,selectedConfig:p.programs.swap,capBps:100,label:'schema-only',
 creatorFeeBps:100,feeModel:2,protocolShareBps:2500,rules:'none',hookFlags:1})
test('inclusive schema is explicit and cannot reinterpret legacy profile or authority',()=>{
 const p=candidate();assert.equal(inclusiveMaxWalletProfileSchema.parse(p).capability.creatorFeeBps,100)
 assert.throws(()=>inclusiveMaxWalletProfileSchema.parse(legacy));assert.throws(()=>maxWalletProfileSchema.parse(p))
 for(const field of ['artifactAdopted','ownerApprovalVerified','executionAuthorized','publicExecutionEnabled','canSign','canSubmit']){
  assert.throws(()=>inclusiveMaxWalletProfileSchema.parse({...p,[field]:true}))
 }
 for(const mutation of [{feeModel:1},{protocolShareBps:3333},{eligibleFeeClass:'all-fees'},{rounding:'ceil'},{creatorFeeBps:10000}]){
  assert.throws(()=>inclusiveMaxWalletProfileSchema.parse({...p,capability:{...p.capability,...mutation}}))
 }
})
test('inclusive preparation requires explicit fee selection and exact mode',()=>{
 const r=request(candidate());assert.equal(inclusiveMaxWalletPreparationRequestSchema.parse(r).policyVersion,2)
 for(const field of ['creatorFeeBps','feeModel','protocolShareBps']){const bad={...r};delete bad[field];assert.throws(()=>inclusiveMaxWalletPreparationRequestSchema.parse(bad))}
 for(const mutation of [{policyVersion:1},{feeModel:1},{creatorFeeBps:-1},{creatorFeeBps:1.2},{protocolShareBps:3333},{holderFeeBps:100}]){
  assert.throws(()=>inclusiveMaxWalletPreparationRequestSchema.parse({...r,...mutation}))
 }
 assert.equal(inclusiveMaxWalletPreparationRequestSchema.parse({...r,creatorFeeBps:0}).creatorFeeBps,0)
})
test('inclusive inventory derives policy-v2; a request alone never generates preparation bytes',()=>{
 const p=candidate(),r=request(p),inventory=inclusiveMaxWalletPreparationInventory(p,r)
 assert.equal(inventory[5],inclusiveMaxWalletPolicyAddress(p.programs.gate,r.mint));assert.equal(inventory.length,12)
 assert.throws(()=>planInclusiveMaxWalletPreparation({request:r,profile:p}))
})

import { BorshCoder } from '@anchor-lang/core'
import { inclusiveMaxWalletPreparationFixture, sha } from './fixtures/hooklab-inclusive-max-wallet-preparation.mjs'
import { inclusiveRustVector } from './fixtures/hooklab-inclusive-max-wallet-launch.mjs'
import { deriveInclusiveMaxWalletPreparedAccounts } from '../src/hooklab-inclusive-max-wallet-preparation.mjs'
import { deriveCustomPreparationRecord } from '../src/hooklab-custom-preparation-receipts.mjs'
test('V3 preparation instructions exactly match executed SBF bytes and prepared accounts',()=>{
 const f=inclusiveMaxWalletPreparationFixture(),v=inclusiveRustVector(),plan=planInclusiveMaxWalletPreparation(f)
 const instruction=i=>({program:i.programId,dataHex:i.dataHex,accounts:i.keys.map(k=>({address:k.pubkey,signer:k.isSigner,writable:k.isWritable}))})
 assert.deepEqual(plan.instructions.slice(2),v.preparation.instructions.map(instruction))
 const c=new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.launch,'base64'))),post=new Map(v.launch.accountsBefore.map(x=>[x.pubkey,x.account]))
 const selected=c.accounts.decode('LaunchConfig',Buffer.from(post.get(f.request.selectedConfig).dataBase64,'base64'))
 const expected=deriveInclusiveMaxWalletPreparedAccounts({profile:{json:f.profile.json,expectedSha256:f.profile.expectedSha256,idls:f.profile.idls},request:f.request,
 launchConfig:f.observations[0].accounts[4].account,observedCreatedAtUnixSeconds:selected.created_at.toString()})
 for(const a of Object.values(expected.accounts))assert.equal(a.dataBase64,post.get(a.address).dataBase64)
 const record=deriveCustomPreparationRecord(f,f.profile.expectedSha256)
 assert.equal(record.policyVersion,2);assert.equal(record.expectedAccounts.policy.size,90)
 assert.equal(record.expectedAccounts.policy.sha256,expected.accounts.policy.sha256)
 assert.equal(plan.policy.creatorFeeBps,100);assert.equal(plan.canSign,false);assert.equal(plan.canSubmit,false)
})
test('V3 preparation rejects unreviewed fee and retained configured ceilings',()=>{
 const f=inclusiveMaxWalletPreparationFixture();f.request.creatorFeeBps++
 assert.throws(()=>planInclusiveMaxWalletPreparation(f),/economics/)
 for(const ceiling of ['max_creator_fee_bps','max_rules_fee_bps']){
  const x=inclusiveMaxWalletPreparationFixture(),coder=new BorshCoder(JSON.parse(Buffer.from(x.profile.idls.launch,'base64')))
  for(const observation of x.observations){const a=observation.accounts[4].account,bytes=Buffer.from(a.dataBase64,'base64'),c=coder.accounts.decode('Config',bytes)
   if(ceiling==='max_creator_fee_bps')c.max_creator_fee_bps=99;else c.rule_bounds.max_rules_fee_bps=99
   const out=Buffer.alloc(bytes.length);bytes.subarray(0,8).copy(out);coder.types.encode('Config',c).copy(out,8);a.dataBase64=out.toString('base64')}
  assert.throws(()=>planInclusiveMaxWalletPreparation(x),/economics/)
 }
})
