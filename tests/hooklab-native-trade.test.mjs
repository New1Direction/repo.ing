// Native-SOL trading end to end on the reviewed native ELFs (hook-lab e357fdf) in one isolated SBF bank: the server
// resolver reviews (two providers, exact simulation), the review and its settlement context go through a jsonb column,
// a restarted resolver revalidates, the bank executes the exact signed bytes, and settlement verifies the receipt.
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {ComputeBudgetProgram,Keypair,TransactionMessage,VersionedMessage} from '@solana/web3.js'
import {nativeTradeResolver} from '../src/hooklab-native-trade-resolver.mjs'
import {compileNativeSwapReview,nativeSwapInventory,nativeSwapV2Instruction} from '../src/hooklab-native-swap.mjs'
import {finalFillLamports} from '../src/hooklab-graduation.mjs'
import {sharedTradeAddresses} from '../src/hooklab-owner-launch-tables.mjs'
import {nativeErrorName} from '../src/hooklab-native-pins.mjs'
import {maxBuyLamports} from '../app/lib/hooklab-trade-math.mjs'
import {readHookCoinMarket} from '../src/hooklab-coin-market.mjs'
import {nativeWorld,NATIVE_SKIP} from './fixtures/hooklab-native-world.mjs'
import {jsonbRoundTrip} from './fixtures/jsonb-round-trip.mjs'
import {pk} from './fixtures/hooklab-canary.mjs'

const LIMITS={maxAgeMs:5000,maxSlotLag:5,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:'10000',maxTotalDebitLamports:'10000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}
const BOOT=1800000000000,RESTARTED=BOOT+3600000,CAP_BPS=5000,SUPPLY=1000000000000000n,CAP=SUPPLY*BigInt(CAP_BPS)/10000n
const sha=x=>createHash('sha256').update(x).digest('hex')
// An active lookup table holding exactly these addresses (as the owner's shared trade table is), at a fresh address.
function table(addresses,authority){
 const data=Buffer.alloc(56+32*addresses.length);data.writeUInt32LE(1);data.writeBigUInt64LE(0xffffffffffffffffn,4);data.writeBigUInt64LE(50n,12);data[21]=1;pk(authority).toBuffer().copy(data,22)
 addresses.forEach((address,i)=>pk(address).toBuffer().copy(data,56+i*32))
 return {address:Keypair.generate().publicKey.toBase58(),owner:'AddressLookupTab1e1111111111111111111111111',dataBase64:data.toString('base64'),sha256:sha(data)}
}
// The same compilation for another wallet: an unfunded-holding newcomer, with the given lookup table.
function variant(input,{trader,lookupTable}){
 const request={...input.request,trader},inventory=nativeSwapInventory(JSON.parse(input.profile.json),request),old=new Map(input.observations[0].accounts.map(x=>[x.address,x.account]))
 const wallet={...old.get(input.request.trader),address:trader},row=address=>({address,account:address===trader?wallet:old.has(address)?old.get(address):null})
 return {...input,request,lookupTable,observations:input.observations.map(o=>({...o,accounts:inventory.map(row)}))}
}

test('native-SOL trades: one approval per trade, exact lamports, the final fill graduates the coin, then open trading',{skip:NATIVE_SKIP,timeout:600000},async t=>{
 const w=await nativeWorld({capBps:CAP_BPS});t.after(w.close)
 const {roles,addresses:a}=w,profile=JSON.parse(w.state.profile.json),report=[]
 const resolverAt=(nowMs,alter)=>nativeTradeResolver({...w.bindings,connections:w.connections(alter),limits:{...LIMITS,nowMs},clock:()=>1000})
 const intent=(side,amountIn,extra={})=>({side,creatorFeeBps:100,capBps:CAP_BPS,mint:roles.mint,selectedConfig:roles.config,amountIn:String(amountIn),minAmountOut:'1',maxInput:String(amountIn),maxPriceImpactBps:1000,graduate:false,...extra})
 const coins=async owner=>{const h=w.holdingOf(roles.mint,owner);await w.sync([h]);const v=w.state.accounts.get(h);return v?Buffer.from(v.dataBase64,'base64').readBigUInt64LE(74):0n}
 const market=async()=>{await w.sync([a.pool,a.launch]);const p=w.decoded('swap','Pool',a.pool),l=w.decoded('launch','Launch',a.launch)
  return {graduated:l.status===1,graduationQuote:l.graduation_quote.toString(),creatorFeeBps:100,capBps:CAP_BPS,initialSupply:String(SUPPLY),
   pool:{baseReserve:p.base_reserve.toString(),quoteReserve:p.quote_reserve.toString(),virtualBase:p.virtual_base.toString(),virtualQuote:p.virtual_quote.toString(),protocolFeesQuote:p.protocol_fees_quote.toString()}}}
 // A realistic minimum received (the panel's estimate less 3%), as the server refuses one that allows more than 5% (I1).
 const prepare=async(owner,side,amount,extra={})=>resolverAt(BOOT).prepare({owner,stage:`native-${side}`,intent:intent(side,amount,{minAmountOut:await w.minimumOut(side,amount,owner),...extra})})
 const store=prepared=>jsonbRoundTrip({review:prepared.review,configurationSha256:prepared.configurationSha256,settlementContext:prepared.settlementContext})
 // The whole server path: review, store as jsonb, revalidate after a restart, execute the exact bytes, settle twice.
 async function trade(owner,side,amount,extra){
  const prepared=await prepare(owner,side,amount,extra),stored=store(prepared)
  assert.notEqual(JSON.stringify(stored.settlementContext),JSON.stringify(prepared.settlementContext),'jsonb reorders keys')
  assert.equal((await resolverAt(RESTARTED).revalidate({owner,stage:`native-${side}`,...stored})).messageSha256,prepared.messageSha256)
  const watched=Object.keys(compileNativeSwapReview(stored.settlementContext.compilationInput).lamportDeltas)
  const before=await w.lamports(watched),sent=await w.send(prepared.review.messageBase64)
  assert.equal(sent.error,null,JSON.stringify(sent.logs?.slice(-6)));assert.ok(sent.wireBytes<=1232)
  const after=await w.lamports(watched)
  const settle=nowMs=>resolverAt(nowMs).reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
  const settled=await settle(BOOT);assert.equal(settled.status,'finalized-success','read back from jsonb')
  assert.deepEqual(await settle(RESTARTED),settled,'and after a restart')
  for(const k of watched)assert.equal(String(after[k]-before[k]),settled.lamportDeltas[k],`lamports of ${k}`)
  report.push({side,amount:String(amount),graduate:!!extra?.graduate,units:sent.units,wireBytes:sent.wireBytes,gross:settled.quote.grossCreatorFee,platform:settled.quote.protocolFee,creator:settled.quote.netCreatorFee})
  return {prepared,stored,sent,settled}
 }

 await t.test('the coin page reads the coin as native from the bytes the programs wrote, with no bridged SOL for the wallet',async()=>{
  const view=await readHookCoinMarket({connection:w.connections()[0].connection,mint:roles.mint,wallet:roles.creator})
  assert.equal(view.market.native,true);assert.equal(view.market.quoteFormMismatch,false);assert.equal(view.market.graduated,false)
  assert.deepEqual(Object.keys(view.wallet).sort(),['address','coin','lamports'])
 })
 await t.test('a first buy creates the coin holding in the same approval; the canonical receipt to the lamport',async()=>{
  const {prepared,settled}=await trade(roles.creator,'buy',1000003)
  const rent=BigInt(prepared.request.quote.holdingRentLamports)
  assert.ok(rent>0n);assert.deepEqual(prepared.review.requiredSigners,[roles.creator]);assert.equal(prepared.review.instructionDebitLamports,String(1000003n+rent))
  assert.equal(prepared.review.maxNativeDebitLamports,String(5000n+1000003n+rent))
  assert.deepEqual([settled.quote.grossCreatorFee,settled.quote.protocolFee,settled.quote.netCreatorFee],['10001','2500','7501'])
  assert.deepEqual(settled.lamportDeltas,{[roles.creator]:String(-(5000n+1000003n+rent)),[a.launch]:'7501',[a.pool]:String(1000003n-7501n),[w.holdingOf(roles.mint,roles.creator)]:String(rent)})
  assert.equal(settled.tokenBalances[0].before,'0');assert.equal(settled.tokenBalances[0].after,settled.quote.delivered)
 })
 await t.test('a sale pays SOL straight to the wallet: pool to launch N, pool to wallet out − G, the platform share stays',async()=>{
  const {settled}=await trade(roles.creator,'sell',(await coins(roles.creator))/3n)
  assert.deepEqual([settled.quote.grossCreatorFee,settled.quote.protocolFee,settled.quote.netCreatorFee],['3303','825','2478'])
  const delivered=BigInt(settled.quote.delivered),out=delivered+3303n
  assert.deepEqual(settled.lamportDeltas,{[roles.creator]:String(delivered-5000n),[a.launch]:'2478',[a.pool]:String(-(out-825n))})
 })
 await t.test('stale or changed state is refused before anything is signed',async()=>{
  const stored=store(await prepare(roles.creator,'buy',50000000))
  await trade(roles.buyer,'buy',20000000)
  await assert.rejects(resolverAt(RESTARTED).revalidate({owner:roles.creator,stage:'native-buy',...stored}),/changed|Price moved/,'another trade moved the pool')
  await assert.rejects(resolverAt(BOOT).revalidate({owner:roles.creator,stage:'native-sell',...stored}),/changed/,'another stage')
  await assert.rejects(prepare(roles.outsider,'sell',1),{code:'HOOKLAB_USER_REFUSAL',message:/holds none of this coin/})
  await assert.rejects(prepare(roles.creator,'sell',1000,{graduate:true}),/Only a buy graduates/)
  await assert.rejects(prepare(roles.creator,'buy',finalFillLamports(await market()),{graduate:true}),{code:'HOOKLAB_USER_REFUSAL',message:/max per wallet|moves the price/})
  // A simulation that moves any watched account differently (here the launch PDA by one lamport) is refused too.
  await assert.rejects(nativeTradeResolver({...w.bindings,limits:{...LIMITS,nowMs:BOOT},clock:()=>1000,connections:w.connections().map(c=>({...c,connection:{...c.connection,
   simulateTransaction:async(tx,config)=>{const r=await c.connection.simulateTransaction(tx,config);r.value.accounts[1]={...r.value.accounts[1],lamports:r.value.accounts[1].lamports+1};return r}}}))})
   .prepare({owner:roles.creator,stage:'native-buy',intent:intent('buy',3000000,{minAmountOut:await w.minimumOut('buy',3000000,roles.creator)})}),/changed/)
 })
 await t.test('only a coin whose pool and launch are both native trades here; a bridged or half-flagged one is refused',async()=>{
  const input=(await prepare(roles.creator,'buy',3000000)).settlementContext.compilationInput
  const flip=changes=>({...input,observations:input.observations.map(o=>({...o,accounts:o.accounts.map(x=>{
   const at=changes[x.address];if(at===undefined)return x;const b=Buffer.from(x.account.dataBase64,'base64');b[at]=0;return {...x,account:{...x.account,dataBase64:b.toString('base64')}}})}))})
  assert.ok(compileNativeSwapReview(input))
  for(const changes of [{[a.pool]:351},{[a.launch]:560},{[a.pool]:351,[a.launch]:560}])assert.throws(()=>compileNativeSwapReview(flip(changes)),/not a native-SOL coin/)
 })
 await t.test('a signed trade that lands after the pool moved settles from its own events, still exact to the lamport',async()=>{
  for(const [side,amount,other] of [['buy',30000000n,15000000],['sell',(await coins(roles.creator))/5n,15000001]]){
   const prepared=await prepare(roles.creator,side,amount,{minAmountOut:await w.minimumOut(side,amount,roles.creator,500)}),stored=store(prepared)
   await trade(roles.buyer,'buy',other)
   const watched=Object.keys(compileNativeSwapReview(stored.settlementContext.compilationInput).lamportDeltas)
   const before=await w.lamports(watched),sent=await w.send(prepared.review.messageBase64),after=await w.lamports(watched)
   assert.equal(sent.error,null)
   const settled=await resolverAt(RESTARTED).reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
   assert.equal(settled.status,'finalized-success');assert.notEqual(settled.quote.delivered,prepared.request.quote.delivered,'the pool it met differs from the review')
   for(const k of watched)assert.equal(String(after[k]-before[k]),settled.lamportDeltas[k],`${side}: lamports of ${k}`)
  }
 })
 await t.test('a buy over the max per wallet is refused by the review and, built by hand, by the chain',async()=>{
  const over=1500000000n
  await assert.rejects(prepare(roles.creator,'buy',over),{code:'HOOKLAB_USER_REFUSAL',message:/max per wallet/})
  const ix=nativeSwapV2Instruction(profile,{side:'buy',trader:roles.creator,mint:roles.mint,amountIn:over,minAmountOut:1})
  const protectedState=async()=>(await w.svm.call('get',{addresses:[a.pool,a.launch,a.baseVault,w.holdingOf(roles.mint,roles.creator)]})).accounts
  const before=await protectedState(),result=await w.send(await w.compile(roles.creator,[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ix]))
  assert.match(result.error,/InstructionErrorCustom\(6001\)/,'the gate’s CapExceeded');assert.deepEqual(await protectedState(),before,'nothing moved')
 })
 let fill,last
 await t.test('capped buys up to the curve’s end, each settled exactly',async()=>{
  for(let trader=roles.creator,i=0;i<40;i++){
   const m=await market(),max=maxBuyLamports(m,await coins(trader));fill=finalFillLamports(m)
   if(max===null){assert.equal(trader,roles.creator);trader=roles.buyer;continue}
   if(max===fill){last=trader;break}
   await trade(trader,'buy',max*98n/100n)
  }
  assert.ok(fill&&last===roles.buyer,'the second wallet can finish the curve')
 })
 await t.test('a graduation review is exact or refused: one lamport short, or the fill without graduate',async()=>{
  await assert.rejects(prepare(last,'buy',fill-1n,{graduate:true}),{code:'HOOKLAB_USER_REFUSAL',message:/curve changed/})
  await assert.rejects(prepare(last,'buy',fill),{code:'HOOKLAB_USER_REFUSAL',message:/curve changed/})
 })
 await t.test('the graduation transaction fits in one packet for a wallet without a holding, with the shared trade table or none',async()=>{
  const input=(await prepare(last,'buy',fill,{graduate:true})).settlementContext.compilationInput,shared=sharedTradeAddresses(profile)
  const newcomer=Keypair.generate().publicKey.toBase58(),sizes=[]
  for(const lookupTable of [table(shared,roles.admin),null]){
   const plan=compileNativeSwapReview(variant(input,{trader:newcomer,lookupTable}))
   assert.equal(plan.createsHolding,true);assert.equal(plan.graduates,true);assert.equal(plan.instructions.length,5,'budget, budget, create holding, swap_v2, graduate')
   const size=Buffer.from(plan.review.messageBase64,'base64').length+65;assert.ok(size<=1232,`${size} bytes`);sizes.push(size)
  }
  t.diagnostic(`worst-case graduation transaction: ${sizes[0]} bytes with the shared trade table, ${sizes[1]} without a table (limit 1232)`)
 })
 await t.test('if another buy lands first, the signed final fill fails closed and only its fee is charged',async()=>{
  const stored=store(await prepare(last,'buy',fill,{graduate:true}))
  await trade(roles.outsider,'buy',2000000)
  const sent=await w.send(stored.review.messageBase64),[,index,code]=/\(\((\d+), (?:Tagged\()?InstructionErrorCustom\((\d+)\)/.exec(sent.error)??[]
  const program=[profile.programs.swap,profile.programs.launch][Number(index)-2]
  assert.ok(['InsufficientLiquidity','NotReady'].includes(nativeErrorName(program,Number(code),profile.programs)),sent.error)
  const failed=await resolverAt(RESTARTED).reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
  assert.equal(failed.status,'finalized-failure');assert.equal(failed.feeLamports,'5000')
  assert.equal(failed.errorName,nativeErrorName(program,Number(code),profile.programs),'named by the program that raised it, for the customer’s message')
  assert.equal((await market()).graduated,false)
 })
 await t.test('a full curve waiting for graduate still takes sales, never buys',async()=>{
  fill=finalFillLamports(await market())
  const ix=nativeSwapV2Instruction(profile,{side:'buy',trader:last,mint:roles.mint,amountIn:fill,minAmountOut:1})
  assert.equal((await w.send(await w.compile(last,[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ix]))).error,null,'the fill without graduate, by another client')
  await assert.rejects(prepare(roles.outsider,'buy',1000000),{code:'HOOKLAB_USER_REFUSAL',message:/finished its bonding curve/})
  const {settled}=await trade(roles.outsider,'sell',await coins(roles.outsider))
  assert.ok(BigInt(settled.quote.delivered)>0n);assert.equal((await market()).graduated,false)
 })
 let late
 await t.test('the exact final fill and graduate go out as ONE transaction, and settle only with the launch graduated',async()=>{
  late=store(await prepare(roles.creator,'sell',(await coins(roles.creator))/500n))
  fill=finalFillLamports(await market())
  const {prepared,stored,sent,settled}=await trade(last,'buy',fill,{graduate:true})
  assert.equal(prepared.request.quote.graduates,true);assert.equal(settled.graduated,true)
  // Both providers must read the launch graduated: one that still shows the curve keeps it unresolved.
  const lagging=w.connections().map((c,i)=>i===0?c:{...c,connection:{...c.connection,getMultipleAccountsInfoAndContext:async(keys,config)=>{
   const r=await c.connection.getMultipleAccountsInfoAndContext(keys,config)
   return {...r,value:r.value.map((v,j)=>{if(!v||keys[j].toBase58()!==a.launch)return v;const data=Buffer.from(v.data);data[138]=0;return {...v,data}})}}}})
  const settleWith=connections=>nativeTradeResolver({...w.bindings,connections,limits:{...LIMITS,nowMs:BOOT},clock:()=>1000})
   .reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
  assert.equal((await settleWith(lagging)).status,'unresolved');assert.equal((await settleWith(w.connections())).status,'finalized-success')
  const ixs=TransactionMessage.decompile(VersionedMessage.deserialize(Buffer.from(prepared.review.messageBase64,'base64')),{addressLookupTableAccounts:[w.lookup]}).instructions
  assert.deepEqual(ixs.map(ix=>ix.programId.toBase58()).slice(2),[profile.programs.swap,profile.programs.launch],'[swap_v2 buy of the exact fill, graduate]')
  const after=await market();assert.equal(after.graduated,true);assert.equal(after.pool.virtualBase,'0')
 })
 await t.test('a sale reviewed on the curve that lands after graduation still settles exactly, flagged for a person to check',async()=>{
  const before=await w.lamports([roles.creator]),sent=await w.send(late.review.messageBase64)
  assert.equal(sent.error,null)
  const settled=await resolverAt(RESTARTED).reconcile({...late,signedTransactionBase64:sent.wireBase64,signature:sent.signature})
  assert.equal(settled.status,'finalized-success');assert.equal(settled.policyReviewRequired,true);assert.equal(settled.reviewBoundsSatisfied,false)
  assert.equal(String((await w.lamports([roles.creator]))[roles.creator]-before[roles.creator]),settled.lamportDeltas[roles.creator])
 })
 await t.test('after graduation: no cap, constant product on the real reserves, the same inclusive fee',async()=>{
  const held=await coins(roles.creator);assert.ok(held>CAP-CAP/100n&&held<=CAP,'the creator sat at the old cap')
  await assert.rejects(prepare(roles.creator,'buy',100000000,{graduate:true}),{code:'HOOKLAB_USER_REFUSAL',message:/curve changed/})
  const {settled}=await trade(roles.creator,'buy',100000000)
  assert.ok(await coins(roles.creator)>CAP,'over the old max per wallet');assert.equal(settled.quote.grossCreatorFee,'1000000')
  const sold=await trade(roles.buyer,'sell',(await coins(roles.buyer))/20n)
  assert.ok(BigInt(sold.settled.quote.delivered)>0n)
 })
 await t.test('receipts that do not match the execution never settle',async()=>{
  const {stored,sent}=await trade(roles.buyer,'buy',10000000)
  const settleWith=async alter=>(await resolverAt(BOOT,alter).reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})).status
  const index=address=>sent.keys.indexOf(address)
  assert.equal(await settleWith(()=>{}),'finalized-success')
  assert.equal(await settleWith(tx=>{tx.meta.postBalances[index(a.launch)]+=1;tx.meta.postBalances[index(a.pool)]-=1}),'unresolved','a lamport from the pool to the launch')
  assert.equal(await settleWith(tx=>{tx.meta.postBalances[0]-=1;tx.meta.postBalances[index(a.baseVault)]+=1}),'unresolved','a lamport from the wallet elsewhere')
  assert.equal(await settleWith(tx=>{for(const g of tx.meta.innerInstructions)g.instructions=g.instructions.slice(0,-1)}),'unresolved','a missing event')
  assert.equal(await settleWith(tx=>{tx.meta.fee+=1}),'unresolved')
  assert.equal(await settleWith(tx=>{tx.slot+=1}),'unresolved')
  // An operator settings change after the trade landed does not strand it: its stored context still settles, as long as
  // it binds its own hash and today's profile.
  const changed=nativeTradeResolver({...w.bindings,connections:w.connections(),limits:{...LIMITS,nowMs:BOOT,maxNetworkFeeLamports:'20000'},clock:()=>1000})
  assert.notEqual(changed.configurationSha256,stored.configurationSha256)
  assert.equal((await changed.reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})).status,'finalized-success')
  const otherProfile=jsonbRoundTrip(stored.settlementContext);otherProfile.compilationInput.profile.providers=[...otherProfile.compilationInput.profile.providers].reverse()
  await assert.rejects(changed.reconcile({...stored,settlementContext:otherProfile,signedTransactionBase64:sent.wireBase64,signature:sent.signature}))
  await assert.rejects(changed.reconcile({...stored,settlementContext:{...stored.settlementContext,configurationSha256:changed.configurationSha256},signedTransactionBase64:sent.wireBase64,signature:sent.signature}),
   'a context bound to another hash')
  // Providers a few trades apart see different pools; that is not receipt evidence, so the trade still settles.
  const apart=w.connections().map((c,i)=>i===0?c:{...c,connection:{...c.connection,getMultipleAccountsInfoAndContext:async(keys,config)=>{
   const r=await c.connection.getMultipleAccountsInfoAndContext(keys,config)
   return {...r,value:r.value.map((v,j)=>{if(!v||keys[j].toBase58()!==a.pool)return v;const data=Buffer.from(v.data);data[200]^=1;return {...v,data}})}}}})
  assert.equal((await nativeTradeResolver({...w.bindings,connections:apart,limits:{...LIMITS,nowMs:BOOT},clock:()=>1000})
   .reconcile({...stored,signedTransactionBase64:sent.wireBase64,signature:sent.signature})).status,'finalized-success')
 })
 const bytes=report.map(x=>x.wireBytes),units=report.map(x=>x.units)
 t.diagnostic(`native trades settled: ${report.length}; wire bytes ${Math.min(...bytes)}-${Math.max(...bytes)}; units ${Math.min(...units)}-${Math.max(...units)}; graduation ${JSON.stringify(report.find(x=>x.graduate))}`)
})
