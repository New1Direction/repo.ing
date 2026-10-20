import test from 'node:test'
import assert from 'node:assert/strict'
import { selectedLaunchFixture,selectedLaunchCollectorFixture,selectedLaunchSettlementFixture } from './fixtures/selected-hook-launch.mjs'
import { compileSelectedHookLaunchReview,parseMaxWalletLaunchRequest,launchPreparationRequest } from '../src/hooklab-max-wallet-launch.mjs'
import { deriveOpenLaunchPostconditions,collectOpenLaunchSettlement } from '../src/hooklab-max-wallet-launch-settlement.mjs'
import { collectOpenLaunchReview } from '../src/hooklab-max-wallet-launch-collector.mjs'
test('selected launch uses the open lifecycle and exact nongate remaining accounts',()=>{
 const {input,addresses}=selectedLaunchFixture(),plan=compileSelectedHookLaunchReview(input)
 assert.deepEqual(parseMaxWalletLaunchRequest(input.request),input.request)
 assert.equal(launchPreparationRequest(input.request).schema,'repoing/selected-hook-preparation-request/1')
 assert.equal(plan.review.operation,'open-launch')
 assert.deepEqual(plan.review.requiredSigners,[input.request.creator,input.request.mint])
 assert.equal(plan.canonicalInstruction.accounts.length,38)
 assert.equal(plan.canonicalInstruction.accounts[34].address,input.hookPin.program)
 assert.equal(plan.canonicalInstruction.accounts[36].address,addresses.registry)
 assert.equal(plan.policy.capBps,0)
 const context={schema:'repoing/open-launch-settlement-context/1',compilationInput:input}
 const post=deriveOpenLaunchPostconditions(context,{slot:110,timestamp:1000})
 const mint=post.accounts.find(a=>a.address===input.request.mint)
 assert.ok(mint);assert.equal(post.events.length,4)
 assert.equal(plan.canSign,false)
})
test('selected launch refuses config, registry, hook bytes, disagreement and debit/deadline mutations',()=>{
 for(const [index,mutate] of [
  f=>{delete f.hookPin},
  f=>{f.hookPin.elfSha256='0'.repeat(64)},
  f=>{f.request.hookFlags=1},
  f=>{f.limits.maxInstructionDebitLamports='1999'},
  f=>{f.limits.maxTotalDebitLamports='11999'},
  f=>{f.limits.reviewExpiresAtMs=1000},
  f=>{f.observations[1].accounts.find(x=>x.address===f.request.creator).account=null},
  f=>{const address=f.request.selectedConfig;for(const o of f.observations){const a=o.accounts.find(x=>x.address===address).account;const b=Buffer.from(a.dataBase64,'base64');b[10]^=1;a.dataBase64=b.toString('base64')}},
  f=>{for(const o of f.observations){const a=o.accounts.find(x=>x.account?.owner===f.hookPin.program).account;a.dataBase64=Buffer.from('02daf6662c38c0cd010000000000','hex').toString('base64')}},
 ].entries()){const {input}=selectedLaunchFixture();mutate(input);assert.throws(()=>compileSelectedHookLaunchReview(input),`mutation ${index}`)}
})
test('finalized collector pins both readers and revalidates exact retained wire',async()=>{
 const f=selectedLaunchCollectorFixture(),first=await collectOpenLaunchReview(f)
 const again=await collectOpenLaunchReview({...f,expectedReview:first.plan.review})
 assert.deepEqual(again.plan.review,first.plan.review)
 assert.equal(first.collection.feeQuotedByBoth,true)
 assert.deepEqual(first.settlementContext.compilationInput.hookPin,f.config.selectedHookPin)
 for(const mutate of [
  f=>{delete f.config.selectedHookPin},
  f=>{f.connections[1].connection.getFeeForMessage=async()=>({context:{slot:100},value:9999})},
  f=>{f.preparation.preparedAccountHashes.registry='0'.repeat(64)},
  f=>{f.accounts.get(f.request.selectedConfig).dataBase64=Buffer.alloc(176).toString('base64')},
  f=>{f.accounts.get(f.addresses.registry).owner=f.p.programs.gate},
 ]){const f=selectedLaunchCollectorFixture();mutate(f);await assert.rejects(collectOpenLaunchReview(f))}
})
test('exact-wire settlement requires unchanged selected config/registry/program and bounded native debit',async()=>{
 const f=await selectedLaunchSettlementFixture()
 assert.equal((await collectOpenLaunchSettlement(f)).status,'finalized-success')
 assert.equal((await collectOpenLaunchSettlement(await selectedLaunchSettlementFixture({revalidate:true}))).status,'finalized-success')
 const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,v])=>[k,reorder(v)])):v
 assert.equal((await collectOpenLaunchSettlement({...f,settlementContext:reorder(f.settlementContext)})).status,'finalized-success')
 for(const mutate of [
  f=>{f.post.get(f.request.selectedConfig).dataBase64=Buffer.alloc(176).toString('base64')},
  f=>{f.post.get(f.addresses.registry).dataBase64=''},
  f=>{f.post.get(f.addresses.selectedProgramData).dataBase64=''},
  f=>{f.config.selectedHookPin={...f.config.selectedHookPin,elfSha256:'0'.repeat(64)}},
  f=>{f.transaction.meta.postBalances[0]--},
  f=>{f.review={...f.review,validUntilSlot:f.review.validUntilSlot+1}},
  f=>{const keys=f.review.accounts.map(a=>a.address);for(const a of f.expected.created)f.transaction.meta.postBalances[keys.indexOf(a)]=200;f.transaction.meta.postBalances[keys.indexOf(f.request.creator)]-=1100},
  f=>{f.transaction.transaction.signatures[0]=f.transaction.transaction.signatures[1]},
 ]){const f=await selectedLaunchSettlementFixture();mutate(f);assert.notEqual((await collectOpenLaunchSettlement(f)).status,'finalized-success')}
})
