// Regressions for the independent security review of the native-SOL trade path (PR #323), on the reviewed native ELFs.
// F1: a first buy whose coin holding appears (or whose rent rate changes) before it lands must still settle, exactly.
// F3: lamports sent to a wallet's future holding address must not lock that wallet out of buying.
// F4: one provider's lastValidBlockHeight must not decide a review's lifetime; the second provider proves it.
// I1: the server refuses a native review whose minimum received allows more than the panel's largest slippage.
import test from 'node:test'
import assert from 'node:assert/strict'
import {ComputeBudgetProgram,PublicKey,SystemProgram} from '@solana/web3.js'
import {nativeTradeResolver} from '../src/hooklab-native-trade-resolver.mjs'
import {nativeSwapV2Instruction} from '../src/hooklab-native-swap.mjs'
import {createHolding} from '../src/hooklab-owner-driver/instructions.mjs'
import {nativeWorld,NATIVE_SKIP} from './fixtures/hooklab-native-world.mjs'
import {jsonbRoundTrip} from './fixtures/jsonb-round-trip.mjs'

const LIMITS={maxAgeMs:5000,maxSlotLag:5,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:'10000',maxTotalDebitLamports:'10000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}
const BOOT=1800000000000
const store=p=>jsonbRoundTrip({review:p.review,configurationSha256:p.configurationSha256,settlementContext:p.settlementContext})
const buy=(roles,amountIn='1000003',extra={})=>({side:'buy',creatorFeeBps:100,capBps:5000,mint:roles.mint,selectedConfig:roles.config,amountIn,minAmountOut:'1',maxInput:amountIn,maxPriceImpactBps:1000,graduate:false,...extra})

test('F1: a first buy whose coin holding appears before it lands executes on chain, so it must settle',{skip:NATIVE_SKIP,timeout:600000},async t=>{
 const w=await nativeWorld({capBps:5000});t.after(w.close)
 const {roles}=w,profile=JSON.parse(w.state.profile.json)
 const resolver=nativeTradeResolver({...w.bindings,connections:w.connections(),limits:{...LIMITS,nowMs:BOOT},clock:()=>1000})
 // The buyer has no coin holding yet, so the review includes create_holding and charges its rent.
 const prepared=await resolver.prepare({owner:roles.buyer,stage:'native-buy',intent:buy(roles)})
 assert.equal(prepared.request.quote.holdingRentLamports!=='0',true,'the review creates the holding')
 const stored=store(prepared)
 // Anyone (here another wallet; equally the buyer's own second tab or a bridged fund step) creates the buyer's holding
 // after the review's finalized observation. create_holding is idempotent ("or does nothing if it exists").
 const other=await w.send(await w.compile(roles.outsider,[createHolding(profile.programs,{payer:roles.outsider,mint:roles.mint,owner:roles.buyer})]))
 assert.equal(other.error,null)
 // Revalidation before the wallet request accepts the outcome where the holding already exists.
 assert.equal((await resolver.revalidate({owner:roles.buyer,stage:'native-buy',...stored})).messageSha256,prepared.messageSha256,'revalidation accepts an existing holding')
 // The buyer's signed, reviewed transaction still executes: tokens are delivered, SOL is debited.
 const holding=w.holdingOf(roles.mint,roles.buyer),before=await w.lamports([roles.buyer,holding])
 const sent=await w.send(stored.review.messageBase64)
 assert.equal(sent.error,null,'the reviewed trade executed on chain')
 await w.sync([holding]);const coins=Buffer.from(w.state.accounts.get(holding).dataBase64,'base64').readBigUInt64LE(74)
 assert.ok(coins>0n,'the buyer received the coin')
 const after=await w.lamports([roles.buyer,holding]),spent=before[roles.buyer]-after[roles.buyer]
 t.diagnostic(`executed: buyer paid ${spent} lamports (review said at most ${stored.review.maxNativeDebitLamports}), received ${coins} raw coin`)
 const settled=await resolver.reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
 assert.equal(settled.status,'finalized-success',`an executed trade must settle (got ${settled.status})`)
 assert.equal(settled.lamportDeltas[roles.buyer],String(-spent),'the buyer paid the fee and the amount, no rent');assert.equal(spent,5000n+1000003n)
 assert.equal(after[holding]-before[holding],0n);assert.ok(spent<=BigInt(stored.review.maxNativeDebitLamports))
})

test('F1: a rent-rate change between review and landing settles when the holding cost no more than reviewed, and fails closed when it cost more',{skip:NATIVE_SKIP,timeout:600000},async t=>{
 const w=await nativeWorld({capBps:5000});t.after(w.close)
 const {roles,addresses:a}=w
 const resolver=nativeTradeResolver({...w.bindings,connections:w.connections(),limits:{...LIMITS,nowMs:BOOT},clock:()=>1000})
 // Reviewed at the bank's default 6,960 lamports per byte; lands at mainnet's 5,080 (SIMD-0437): the holding costs less.
 const cheaper=store(await resolver.prepare({owner:roles.buyer,stage:'native-buy',intent:buy(roles)}))
 assert.equal(cheaper.settlementContext.compilationInput.request.trader,roles.buyer)
 await w.svm.call('rent',{lamportsPerByte:5080})
 const holding=w.holdingOf(roles.mint,roles.buyer),before=await w.lamports([roles.buyer,holding])
 const sent=await w.send(cheaper.review.messageBase64);assert.equal(sent.error,null)
 const after=await w.lamports([roles.buyer,holding])
 assert.equal(after[holding]-before[holding],(128n+204n)*5080n,'the holding took today’s rent')
 const settled=await resolver.reconcile({...cheaper,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
 assert.equal(settled.status,'finalized-success');assert.equal(settled.lamportDeltas[holding],String((128n+204n)*5080n))
 assert.equal(settled.lamportDeltas[roles.buyer],String(-(5000n+1000003n+(128n+204n)*5080n)))
 // Reviewed at 5,080; the rate rises to 8,000 before it lands. The pool and launch get donations so the swap itself
 // still clears its own rent checks; the new holding then costs more than the review stated.
 const dearer=store(await resolver.prepare({owner:roles.outsider,stage:'native-buy',intent:buy(roles,'1000007')}))
 await w.svm.call('rent',{lamportsPerByte:8000})
 await assert.rejects(resolver.revalidate({owner:roles.outsider,stage:'native-buy',...dearer}),'revalidation refuses a holding that now costs more')
 for(const address of [a.pool,a.launch])assert.equal((await w.send(await w.compile(roles.creator,[SystemProgram.transfer({fromPubkey:new PublicKey(roles.creator),toPubkey:new PublicKey(address),lamports:5000000})]))).error,null)
 const landed=await w.send(dearer.review.messageBase64);assert.equal(landed.error,null,JSON.stringify(landed.logs?.slice(-4)))
 const refused=await resolver.reconcile({...dearer,signedTransactionBase64:landed.wireBase64,signature:landed.signature})
 assert.equal(refused.status,'unresolved','more than the review stated never settles as success')
})

test('F4: one provider\'s low lastValidBlockHeight is refused at review, so an executed trade always settles',{skip:NATIVE_SKIP,timeout:600000},async t=>{
 const w=await nativeWorld({capBps:5000});t.after(w.close)
 const {roles}=w
 // The harness's finalized height is 100. Provider 0 (the only one asked for the blockhash) answers lastValidBlockHeight
 // 110 instead of 250: still >= the current height and within 150, so before the fix the review and revalidation passed.
 const lying=w.connections().map((c,i)=>i===0?{...c,connection:{...c.connection,getLatestBlockhashAndContext:async()=>{const r=await c.connection.getLatestBlockhashAndContext();return {...r,value:{...r.value,lastValidBlockHeight:110}}}}}:c)
 await assert.rejects(nativeTradeResolver({...w.bindings,connections:lying,limits:{...LIMITS,nowMs:BOOT},clock:()=>1000}).prepare({owner:roles.creator,stage:'native-buy',intent:buy(roles)}),
  'the second provider’s block for that blockhash proves height 100 + 150, not 110')
 // Nor may the second provider vouch for another block.
 const otherBlock=w.connections().map((c,i)=>i===1?{...c,connection:{...c.connection,getBlock:async(...args)=>({...await c.connection.getBlock(...args),blockhash:roles.table})}}:c)
 await assert.rejects(nativeTradeResolver({...w.bindings,connections:otherBlock,limits:{...LIMITS,nowMs:BOOT},clock:()=>1000}).prepare({owner:roles.creator,stage:'native-buy',intent:buy(roles)}))
 // An honest review lands at height 130 (tip height, inside the blockhash's real 150-block life) and settles.
 const honest=nativeTradeResolver({...w.bindings,connections:w.connections(),limits:{...LIMITS,nowMs:BOOT},clock:()=>1000})
 const control=store(await honest.prepare({owner:roles.creator,stage:'native-buy',intent:buy(roles)}))
 assert.equal(control.review.lastValidBlockHeight,250)
 const sent=await w.send(control.review.messageBase64);assert.equal(sent.error,null)
 const landed=w.connections().map(c=>({...c,connection:{...c.connection,getBlockSignatures:async(...args)=>({...await c.connection.getBlockSignatures(...args),blockHeight:130})}}))
 const settled=await nativeTradeResolver({...w.bindings,connections:landed,limits:{...LIMITS,nowMs:BOOT},clock:()=>1000}).reconcile({...control,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
 assert.equal(settled.status,'finalized-success',`got ${settled.status}`)
})

test('F3: lamports sent to a wallet\'s future holding address do not lock that wallet out of buying the coin here',{skip:NATIVE_SKIP,timeout:600000},async t=>{
 const w=await nativeWorld({capBps:5000});t.after(w.close)
 const {roles}=w,profile=JSON.parse(w.state.profile.json)
 const resolver=nativeTradeResolver({...w.bindings,connections:w.connections(),limits:{...LIMITS,nowMs:BOOT},clock:()=>1000})
 // Anyone pays the empty-account minimum to the buyer's holding PDA (a plain system transfer; no signature from the buyer).
 const holding=w.holdingOf(roles.mint,roles.buyer)
 const dust=await w.send(await w.compile(roles.outsider,[SystemProgram.transfer({fromPubkey:new PublicKey(roles.outsider),toPubkey:new PublicKey(holding),lamports:890880})]))
 assert.equal(dust.error,null)
 // The chain still accepts the buyer's first buy ([create_holding, swap_v2]; Anchor init tops up a pre-funded PDA) ...
 const byHand=await w.send(await w.compile(roles.buyer,[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),
  createHolding(profile.programs,{payer:roles.buyer,mint:roles.mint,owner:roles.buyer}),
  nativeSwapV2Instruction(profile,{side:'buy',trader:roles.buyer,mint:roles.mint,amountIn:1000003n,minAmountOut:1})]))
 t.diagnostic(`hand-built first buy on the pre-funded PDA: ${byHand.error??'executed'}`)
 assert.equal(byHand.error,null)
 // ... and so does repo.ing's review. Another wallet (the outsider), its holding PDA pre-funded the same way.
 const victim=roles.outsider,victimHolding=w.holdingOf(roles.mint,victim)
 assert.equal((await w.send(await w.compile(roles.creator,[SystemProgram.transfer({fromPubkey:new PublicKey(roles.creator),toPubkey:new PublicKey(victimHolding),lamports:890880})]))).error,null)
 const result=await resolver.prepare({owner:victim,stage:'native-buy',intent:buy(roles)}).then(()=>'reviewed',e=>`refused: ${e.code??''} ${e.message}`)
 t.diagnostic(`review of the victim's first buy: ${result}`)
 assert.equal(result,'reviewed')
 // It pays only the rest of the holding's rent, and settles from the receipt's HoldingCreated.
 const prepared=await resolver.prepare({owner:victim,stage:'native-buy',intent:buy(roles,'1000005')}),stored=store(prepared)
 assert.equal(prepared.request.quote.holdingRentLamports,String((128n+204n)*6960n-890880n))
 const before=await w.lamports([victim,victimHolding]),sent=await w.send(stored.review.messageBase64);assert.equal(sent.error,null)
 const after=await w.lamports([victim,victimHolding])
 const settled=await resolver.reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
 assert.equal(settled.status,'finalized-success')
 assert.equal(String(after[victimHolding]-before[victimHolding]),prepared.request.quote.holdingRentLamports)
 assert.equal(settled.lamportDeltas[victim],String(after[victim]-before[victim]))
})

test('I1: the server refuses a native review whose minimum received allows more than 5% slippage',{skip:NATIVE_SKIP,timeout:600000},async t=>{
 const w=await nativeWorld({capBps:5000});t.after(w.close)
 const {roles}=w
 const resolver=nativeTradeResolver({...w.bindings,connections:w.connections(),limits:{...LIMITS,nowMs:BOOT},clock:()=>1000})
 const delivered=BigInt((await resolver.prepare({owner:roles.creator,stage:'native-buy',intent:buy(roles,'1000003')})).request.quote.delivered)
 const floor=(delivered*9500n+9999n)/10000n
 await assert.rejects(resolver.prepare({owner:roles.creator,stage:'native-buy',intent:buy(roles,'1000003',{minAmountOut:String(floor-1n)})}),{code:'HOOKLAB_USER_REFUSAL',message:/slippage/})
 assert.equal((await resolver.prepare({owner:roles.creator,stage:'native-buy',intent:buy(roles,'1000003',{minAmountOut:String(floor)})})).request.quote.minAmountOut,String(floor))
})
