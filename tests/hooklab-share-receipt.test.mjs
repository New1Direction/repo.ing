import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyNativeTradeEvents} from '../src/hooklab-native-trade-settlement.mjs'
import {selectedNativeSettlementFixture} from './fixtures/selected-native-trade-settlement.mjs'
import {loadNativeArtifacts} from '../src/hooklab-native-pins.mjs'
import {loadArtifacts} from '../src/hooklab-owner-driver/artifacts.mjs'
import {shareNativeQuote} from '../src/hooklab-share-fee-quote.mjs'
import {pk,pda} from './fixtures/selected-hook-preparation.mjs'
import BN from 'bn.js'
import bs58 from 'bs58'
import {createHash} from 'node:crypto'

// Independent event encoding and synthetic execution; never an SBF acceptance claim.
function fixture(side,partial=false){
 const f=selectedNativeSettlementFixture(side),plan=structuredClone(f.plan),ci=structuredClone(f.input),a=plan.addresses,P=f.p.programs,buy=side==='buy',N=v=>new BN(String(v))
 plan.request={...plan.request,feeModel:1,amountIn:buy?'1000':'10000',maxInput:buy?'1000':'10000',minAmountOut:'1'}
 plan.economics={lpFeeBps:37,quoteCutBps:83}
 for(const obs of ci.observations){const row=obs.accounts.find(x=>x.address===a.pool),bytes=Buffer.from(row.account.dataBase64,'base64'),pool=f.coders.swap.accounts.decode('Pool',bytes);pool.fee_model=1;pool.lp_fee_bps=37;f.coders.swap.types.encode('Pool',pool).copy(bytes,8);row.account.dataBase64=bytes.toString('base64')}
 const pre={baseReserve:partial?500n:750000n,quoteReserve:partial?100n:100000n,virtualBase:partial?500n:0n,virtualQuote:0n,protocolFeesQuote:733n,protocolShareBps:2500n}
 const q=shareNativeQuote({side,amountIn:BigInt(plan.request.amountIn),minAmountOut:1n,creatorFeeBps:100n,lpFeeBps:37n,quoteCutBps:83n,tokenInputTax:buy?0n:701n,tokenOutputTax:buy?103n:0n,burnIn:buy?0n:29n,burnOut:buy?17n:0n,pool:pre,allowPartialFill:partial})
 const e=f.events,paid=[{holding:pk(a.launch),amount:N(q.fees.creatorQuote+q.fees.customQuote)}]
 Object.assign(e.Swapped,{amount_in:N(q.amountIn),amount_out:N(q.grossOutput),received_in:N(q.receivedIn),delivered_out:N(q.delivered),cuts_in:N(q.cutsIn),cuts_out:N(q.cutsOut),burn_in:N(q.burnIn),burn_out:N(q.burnOut),protocol_fee:N(q.fees.protocolQuote),lp_fee_bps:37,base_reserve:N(q.after.baseReserve),quote_reserve:N(q.after.quoteReserve),virtual_base:N(0),virtual_quote:N(0),deltas_in:buy?paid:[],deltas_out:buy?[]:paid})
 e.Swapped.virtual_base=N(pre.virtualBase)
 const keys=plan.review.accounts.map(x=>x.address),idx=k=>keys.indexOf(k),sourceBefore=buy?pre.baseReserve:100000n,destBefore=buy?0n:pre.baseReserve,burn=buy?q.burnOut:q.burnIn,debit=(buy?q.grossOutput:q.amountIn)-burn,tax=buy?103n:701n
 Object.assign(e.Transferred,{amount:N(debit),source_post:N(sourceBefore-burn-debit),destination_post:N(destBefore+debit-tax),deltas:[{holding:pk(f.taxHolding),amount:N(tax)}]})
 e.Burned={mint:pk(plan.request.mint),source:e.Transferred.source,source_owner:e.Transferred.source_owner,authority:e.Transferred.authority,amount:N(burn),source_post:N(sourceBefore-burn),supply_post:N(999000),slot:N(110),ts:N(1000)}
 const preBalances=f.receipt.meta.preBalances,postBalances=[...preBalances];postBalances[idx(a.pool)]+=Number(q.quoteVaultDelta)
 Object.assign(e.SwappedNative,{quote_lamports:N(buy?q.receivedIn:q.delivered),quote_deltas:paid,pool_lamports:N(postBalances[idx(a.pool)])})
 const swapAt=f.receipt.meta.innerInstructions[0].index,native=loadNativeArtifacts(),token=loadArtifacts()
 const encode=(name,h,data=e[name])=>{const role=['Transferred','Burned','Minted'].includes(name)?'token':['Graduated','QuoteCutTaken'].includes(name)?'launch':'swap',idl=role==='token'?token.idls.token:native.idls[role],coder=role==='token'?token.coders.token:native.coders[role];return {programIdIndex:idx(P[role]),accounts:[idx(pda(P[role],'__event_authority'))],stackHeight:h,data:bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),Buffer.from(idl.events.find(x=>x.name===name).discriminator),coder.types.encode(name,data)]))}}
 const tx={keys,slot:110,pre:preBalances,post:postBalances,instructions:f.receipt.transaction.message.compiledInstructions,innerInstructions:[]}
 const rebuild=()=>{tx.innerInstructions=[{index:swapAt,instructions:[...['Swapped','SwappedNative'].map(n=>encode(n,2)),...['Burned','Transferred'].flatMap(n=>[{programIdIndex:idx(P.token),accounts:[],stackHeight:2,data:''},encode(n,3)])]}]}
 rebuild();return {e,tx,plan,q,rebuild,encode,P,verify:()=>verifyNativeTradeEvents({ci,plan,tx,fee:5000n})}
}

test('model1 final fill matches pinned consumed input and floor-prorates original minimum',()=>{
 const f=fixture('buy',true)
 assert.ok(f.q.amountIn<1000n)
 // Largest original minimum whose prorated floor equals the measured delivery.
 f.plan.request.minAmountOut=String(((f.q.delivered+1n)*1000n-1n)/f.q.amountIn)
 const v=f.verify()
 assert.equal(v.quote.amountIn,String(f.q.amountIn))
 assert.equal(v.quote.unspentInput,String(1000n-f.q.amountIn))
 assert.equal(v.quote.minAmountOut,String(f.q.delivered))
 f.plan.request.minAmountOut=String(BigInt(f.plan.request.minAmountOut)+1n)
 assert.throws(f.verify)
})

test('model1 cannot claim an arbitrary partial debit on a non-final fill',()=>{
 const f=fixture('buy');f.plan.request.amountIn='2000';f.plan.request.maxInput='2000'
 assert.throws(f.verify)
})

function quoteCutFixture(){
 const f=fixture('buy'),idx=k=>f.tx.keys.indexOf(k),authority=pda(f.P.launch,'__event_authority')
 if(idx(authority)<0)f.tx.keys.push(authority)
 // Encode the source callback ABI independently (the older pinned IDL lacks it).
 const tail=Buffer.alloc(13);tail[0]=1;tail.writeUInt16LE(100,1);tail.writeUInt16LE(83,3);tail.writeBigUInt64LE(f.q.fees.customQuote,5)
 const bytes=Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),createHash('sha256').update('event:QuoteCutTaken').digest().subarray(0,8),pk(f.plan.addresses.launch).toBuffer(),pk(f.plan.request.trader).toBuffer(),tail])
 const event={programIdIndex:idx(f.P.launch),accounts:[idx(authority)],stackHeight:3,data:bs58.encode(bytes)}
 f.tx.innerInstructions[0].instructions.push({programIdIndex:idx(f.P.launch),accounts:[],stackHeight:2,data:''},event)
 return {...f,event,bytes}
}
test('QuoteCutTaken accepts only exact launch self-CPI bytes and authenticated payout deltas',()=>{
 const f=quoteCutFixture();assert.equal(f.verify().quote.customQuoteCut,String(f.q.fees.customQuote))
 f.e.SwappedNative.quote_deltas[0].amount.iaddn(1)
 const callback=f.tx.innerInstructions[0].instructions.slice(-2)
 f.rebuild();f.tx.innerInstructions[0].instructions.push(...callback)
 assert.throws(f.verify)
})
for(const change of ['authority','ancestry','amount','direction','trailing bytes','duplicate'])test(`QuoteCutTaken rejects ${change}`,()=>{
 const f=quoteCutFixture()
 if(change==='authority')f.event.accounts=[0]
 if(change==='ancestry')f.event.stackHeight=2
 if(change==='amount')f.bytes[f.bytes.length-1]^=1
 if(change==='direction')f.bytes[80]=0
 if(change==='trailing bytes')f.bytes=Buffer.concat([f.bytes,Buffer.from([0])])
 f.event.data=bs58.encode(f.bytes)
 if(change==='duplicate')f.tx.innerInstructions[0].instructions.push(f.event)
 assert.throws(f.verify)
})

function graduating(){
 const f=fixture('buy',true),{plan,tx,P,q}=f,a=plan.addresses,N=v=>new BN(String(v)),idx=k=>tx.keys.indexOf(k)
 plan.graduates=true;plan.request.graduate=true
 // Standalone verifier fixture: the compiler's graduation account inventory is represented
 // explicitly; the independently encoded events below carry the actual balances.
 for(const address of [a.launchReserve,a.launchLp,a.lpMint,pda(P.launch,'__event_authority')])if(idx(address)<0){tx.keys.push(address);tx.pre.push(0);tx.post.push(0);plan.review.accounts.push({address,writable:true,signer:false})}
 tx.instructions=[...tx.instructions,{programIdIndex:idx(P.launch)}]
 const common={slot:N(110),ts:N(1000)},topup=300n,burned=700n,base=topup,quote=q.after.quoteReserve,lp=5000n
 const t={...common,mint:pk(plan.request.mint),source:pk(a.launchReserve),source_owner:pk(a.launch),authority:pk(a.launch),destination:pk(a.baseVault),destination_owner:pk(a.pool),amount:N(topup),source_post:N(burned),destination_post:N(base),deltas:[]}
 const m={...common,mint:pk(a.lpMint),destination:pk(a.launchLp),destination_owner:pk(a.launch),authority:pk(a.pool),amount:N(lp),destination_post:N(lp),supply_post:N(lp)}
 const final={...common,pool:pk(a.pool),base_reserve:N(base),quote_reserve:N(quote),lp_supply:N(lp+1000n),lp_minted:N(lp),lp_recipient:pk(a.launchLp)}
 const b={...common,mint:pk(plan.request.mint),source:pk(a.launchReserve),source_owner:pk(a.launch),authority:pk(a.launch),amount:N(burned),source_post:N(0),supply_post:N(900000)}
 const g={...common,launch:pk(a.launch),mint:pk(plan.request.mint),pool:pk(a.pool),cranker:pk(plan.request.trader),topup:N(topup),burned:N(burned),base_reserve:N(base),quote_reserve:N(quote),lp_minted:N(lp),supply:N(900000)}
 const call=(program,h)=>({programIdIndex:idx(program),accounts:[],data:'',stackHeight:h})
 const rebuild=()=>{f.rebuild();tx.innerInstructions.push({index:tx.instructions.length-1,instructions:[call(P.token,2),f.encode('Transferred',3,t),call(P.swap,2),call(P.token,3),f.encode('Minted',4,m),f.encode('CurveFinalized',3,final),call(P.token,2),f.encode('Burned',3,b),f.encode('Graduated',2,g)]})}
 rebuild();return {...f,t,m,final,b,g,rebuild}
}
test('model1 graduation authenticates reserve top-up, LP mint, burn and final books',()=>{
 const f=graduating(),v=f.verify()
 assert.equal(v.quote.after.baseReserve,'300')
 assert.equal(v.tokenBalances.find(x=>x.address===f.plan.addresses.launchReserve).after,'0')
})
for(const change of ['missing transfer','duplicate burn','ancestry','authority','topup','burn','mint','final reserve','trailing bytes'])test(`model1 graduation rejects ${change}`,()=>{
 const f=graduating()
 if(change==='topup')f.t.amount.iaddn(1)
 if(change==='burn')f.b.source_post.iaddn(1)
 if(change==='mint')f.m.supply_post.iaddn(1)
 if(change==='authority')f.t.authority=pk(f.plan.request.trader)
 if(change==='final reserve')f.final.base_reserve.iaddn(1)
 f.rebuild();const xs=f.tx.innerInstructions.at(-1).instructions
 if(change==='missing transfer')xs.splice(0,2)
 if(change==='duplicate burn')xs.splice(-1,0,...xs.slice(-3,-1))
 if(change==='ancestry')xs[4].stackHeight=3
 if(change==='trailing bytes')xs.at(-1).data=bs58.encode(Buffer.concat([bs58.decode(xs.at(-1).data),Buffer.from([0])]))
 assert.throws(f.verify)
})
for(const side of ['buy','sell']){
 test(`model1 ${side}: authenticated asymmetric tax, burn, custom quote and LP share`,()=>{
  const f=fixture(side),v=f.verify()
  assert.equal(v.quote.protocolFee,String(f.q.fees.protocolQuote))
  assert.equal(v.quote.netCreatorFee,String(f.q.fees.creatorQuote))
  assert.equal(v.quote.customQuoteCut,String(f.q.fees.customQuote))
  assert.equal(v.quote.burnedToken,String(f.q.burnIn+f.q.burnOut))
  assert.equal(v.quote.feeBreakdown.outputShareQuote,String(f.q.fees.outputShareQuote))
  assert.equal(v.quote.after.protocolFeesQuote,null,'ABI does not attest absolute counter')
  assert.equal(v.quote.delivered,String(f.q.delivered))
 })
 for(const change of ['ancestry','duplicate payout','burn amount','tax amount','protocol','reserve','inclusive event'])test(`model1 ${side} rejects ${change}`,()=>{
  const f=fixture(side)
  if(change==='burn amount')f.e.Burned.amount.iaddn(1)
  if(change==='tax amount')f.e.Transferred.deltas[0].amount.iaddn(1)
  if(change==='protocol')f.e.Swapped.protocol_fee.iaddn(1)
  if(change==='reserve')f.e.Swapped.quote_reserve.iaddn(100000)
  f.rebuild()
  const xs=f.tx.innerInstructions[0].instructions
  if(change==='ancestry')xs.at(-1).stackHeight=2
  if(change==='duplicate payout')xs.push(...xs.slice(-2))
  if(change==='inclusive event')xs.unshift(f.encode('InclusiveCreatorFeeAccrued',2))
  assert.throws(f.verify)
 })
}
