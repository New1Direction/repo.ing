// Native-SOL trading over HTTP: off by default (HOOK_NATIVE_TRADING_ENABLED and a runtime built with it), behind the
// same tester gate, with an exact intent and the native stages; bridged quotes, funding and withdrawals are unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {Keypair} from '@solana/web3.js'
import {createInclusiveTradeHandler,nativeTradingOn} from '../app/lib/hooklab-inclusive-trade.mjs'
import {createInclusiveTradeRuntime,stackProfileFor} from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
import {createMarketHandler} from '../app/lib/hooklab-market.mjs'
import {NATIVE_ELF} from '../src/hooklab-native-pins.mjs'
import {compileNativeSwapReview,pinsNativeBuilds} from '../src/hooklab-native-swap.mjs'
import {NATIVE_ELF_PIN,nativePinned} from './fixtures/hooklab-native-bundle.mjs'

const id='11111111-1111-4111-8111-111111111111',token=Buffer.alloc(32,9).toString('base64url'),owner='11111111111111111111111111111111'
const env={HOOK_INCLUSIVE_TRADING_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_TRADING_PUBLIC:'true',HOOK_NATIVE_TRADING_ENABLED:'true'}
const options={configuration:()=>({origin:'https://repo.ing'}),database:()=>({end:async()=>{}}),quota:async()=>true,principalStore:()=>({resolve:async()=>({wallet:owner})})}
const request=body=>new Request('https://repo.ing/api/hook-lab/inclusive-trade',{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${token}`},body:JSON.stringify(body)})
const intent={mint:owner,selectedConfig:owner,capBps:200,creatorFeeBps:100,side:'buy',amountIn:'100000',minAmountOut:'1',maxInput:'100000',maxPriceImpactBps:1000,graduate:false}
function handler({env:e=env,nativeTrading=true}={}){
 const seen=[],lifecycle={createReview:async(t,i,value)=>{seen.push(value);return {id,owner,stage:value.stage,status:'reviewed',review:{messageBase64:'NEVER',messageSha256:'a'.repeat(64)}}}}
 return {seen,handle:createInclusiveTradeHandler({...options,env:e,runtime:()=>({origin:'https://repo.ing',lifecycle,walletFunding:true,walletWithdraw:true,nativeTrading})})}
}
const json=async response=>({status:response.status,body:await response.json()})

test('native trading is off by default: a native quote is blocked and nothing is reviewed',async()=>{
 for(const [e,nativeTrading] of [[{...env,HOOK_NATIVE_TRADING_ENABLED:undefined},true],[env,false],[{...env,HOOK_NATIVE_TRADING_ENABLED:'1'},true]]){
  const h=handler({env:e,nativeTrading}),r=await json(await h.handle(request({action:'native-quote',signingId:id,request:intent})))
  assert.equal(r.body.blockers[0].code,'NATIVE_TRADING_DISABLED');assert.match(r.body.blockers[0].message,/opens soon/);assert.equal(h.seen.length,0)
 }
 assert.equal(nativeTradingOn({},{nativeTrading:true}),false);assert.equal(nativeTradingOn(env,{}),false);assert.equal(nativeTradingOn(env,{nativeTrading:true}),true)
 // Bridged quotes still go to the inclusive stages, switch or not.
 const {graduate,...bridged}=intent,h=handler({env:{...env,HOOK_NATIVE_TRADING_ENABLED:undefined},nativeTrading:false})
 assert.equal((await json(await h.handle(request({action:'quote',signingId:id,request:bridged})))).body.operation.stage,'inclusive-buy')
})

test('with the switch on, a native quote reviews native-buy or native-sell with the exact intent, graduate included',async()=>{
 const h=handler()
 for(const value of [intent,{...intent,graduate:true},{...intent,side:'sell'}]){
  const r=await json(await h.handle(request({action:'native-quote',signingId:id,request:value})))
  assert.equal(r.status,200);assert.ok(!JSON.stringify(r.body).includes('NEVER'),'no signable bytes before the wallet request')
 }
 assert.deepEqual(h.seen,[{custodyOperationId:id,stage:'native-buy',intent},{custodyOperationId:id,stage:'native-buy',intent:{...intent,graduate:true}},{custodyOperationId:id,stage:'native-sell',intent:{...intent,side:'sell'}}])
})

test('native quotes keep the tester gate; withdrawing legacy bridged SOL is never gated',async()=>{
 const closed={...env,HOOK_TRADING_PUBLIC:undefined},h=handler({env:closed})
 assert.equal((await json(await h.handle(request({action:'native-quote',signingId:id,request:intent})))).body.blockers[0].code,'TRADING_NOT_OPEN')
 const tester=handler({env:{...closed,HOOK_TRADING_TESTER_WALLETS:owner}})
 assert.equal((await json(await tester.handle(request({action:'native-quote',signingId:id,request:intent})))).body.operation.stage,'native-buy')
 assert.equal((await json(await h.handle(request({action:'withdraw',signingId:id,request:{lamports:'5'}})))).body.operation.stage,'wallet-withdraw')
})

test('HTTP cannot choose the trader, inject state or drop the graduate flag of a native quote',async()=>{
 const h=handler(),{graduate,...missing}=intent
 for(const value of [missing,{...intent,trader:owner},{...intent,feePayer:owner},{...intent,graduate:'yes'},{...intent,observations:[]},{...intent,maxPriceImpactBps:5000}])
  assert.equal((await h.handle(request({action:'native-quote',signingId:id,request:value}))).status,400,JSON.stringify(value))
 assert.equal(h.seen.length,0)
})

test('the trade runtime takes new native work only when built with the switch and a bundle pinning the native builds',async()=>{
 const today=JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle-2.json',import.meta.url),'utf8')),origins=today.config.providerTrustDomains.map(t=>t.origin)
 const settings=bundle=>({origin:'https://repo.ing',ownerTradingApproved:true,operatorDeploymentApproved:true,economicsApproved:true,config:bundle.config,profile:bundle.profile,dossierJson:bundle.dossierJson,
  connections:bundle.profile.providers.map((provider,i)=>({provider,connection:{rpcEndpoint:origins[i]+'rpc'}})),
  limits:{nowMs:1,maxAgeMs:60000,maxSlotLag:16,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:'15000',maxTotalDebitLamports:'15000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}})
 const upgraded=nativePinned(today)
 const reaches=async runtime=>{let connects=0;await assert.rejects(runtime(()=>{connects++;throw Error('no database here')}).lifecycle.createReview(token,id,{custodyOperationId:id,stage:'native-buy',intent}));return connects}
 const build=(nativeTradingEnabled,bundle=upgraded)=>connect=>createInclusiveTradeRuntime({connect:async()=>connect(),query:async()=>{throw Error('no database here')}},{...settings(bundle),nativeTradingEnabled})
 assert.equal(build(false)(()=>{}).nativeTrading,false);assert.equal(build(true)(()=>{}).nativeTrading,true)
 assert.equal(build(true,today)(()=>{}).nativeTrading,false,'switch on before the upgrade: native stays off, nothing throws')
 assert.equal(await reaches(build(false)),0,'off: the stage is refused before any database work');assert.equal(await reaches(build(true)),1,'on: the lifecycle takes it')
 assert.equal(await reaches(build(true,today)),0)
 const bridged=async(nativeTradingEnabled,bundle)=>{let connects=0;await assert.rejects(build(nativeTradingEnabled,bundle)(()=>{connects++;throw Error('no database')}).lifecycle.createReview(token,id,{custodyOperationId:id,stage:'inclusive-buy',intent}));return connects}
 assert.equal(await bridged(false,today),1);assert.equal(await bridged(true,today),1);assert.equal(await bridged(true,upgraded),1,'bridged stages are there either way')
})

// Production bundle 3 pins the trimmed native ELFs (the bytes a deployed ProgramData holds); the raw build output pins too.
test('native trading opens for a bundle pinning the native ELFs raw or trimmed, and for no other pin or IDL',async()=>{
 const today=JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle-2.json',import.meta.url),'utf8')),origins=today.config.providerTrustDomains.map(t=>t.origin)
 const runtime=bundle=>createInclusiveTradeRuntime({connect:async()=>{throw Error('no database here')},query:async()=>{throw Error('no database here')}},{origin:'https://repo.ing',
  ownerTradingApproved:true,operatorDeploymentApproved:true,economicsApproved:true,config:bundle.config,profile:bundle.profile,dossierJson:bundle.dossierJson,nativeTradingEnabled:true,
  connections:bundle.profile.providers.map((provider,i)=>({provider,connection:{rpcEndpoint:origins[i]+'rpc'}})),
  limits:{nowMs:1,maxAgeMs:60000,maxSlotLag:16,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:'15000',maxTotalDebitLamports:'15000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}})
 // The compiler's own gate, before it reads any state (the input is well formed; its state is not a coin's).
 const compiles=bundle=>{
  const providers=bundle.profile.providers,genesisHash=JSON.parse(bundle.profile.json).genesisHash,accounts=Array.from({length:20},()=>({address:Keypair.generate().publicKey.toBase58(),account:null}))
  try{compileNativeSwapReview({profile:bundle.profile,request:{schema:'repoing/native-swap-request/1',policyKind:'max-wallet',policyVersion:2,feeModel:2,protocolShareBps:2500,trader:owner,...intent},
   provenance:'server-collected-finalized-state-not-execution-authorization',observations:providers.map(provider=>({provider,genesisHash,commitment:'finalized',slot:1,observedAtMs:1,accounts})),
   recentBlockhash:{blockhash:owner,genesisHash,providers,observedAtMs:1,currentBlockHeight:1,blockhashValid:true,lastValidBlockHeight:2,observedSlot:1,networkFeeLamports:'5000',lamportsPerSignature:'5000'},
   lookupTable:null,limits:{nowMs:1,maxAgeMs:5000,maxSlotLag:5,validUntilSlot:2,reviewExpiresAtMs:2,maxNetworkFeeLamports:'5000',maxTotalDebitLamports:'5000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}})
   return 'compiled'}
  catch(error){return /does not pin the reviewed native builds/.test(error.message)?'refused':'past the pin check'}}
 const cases=[
  ['the raw build output',nativePinned(today,{elf:'raw'}),true],
  ['the trimmed ProgramData bytes, as bundle 3',nativePinned(today,{elf:'trimmed'}),true],
  ['another hash',nativePinned(today,{elf:role=>({sha256:'ab'.repeat(32),length:NATIVE_ELF[role].trimmedLength})}),false],
  ['the raw hash with the trimmed length',nativePinned(today,{elf:role=>({sha256:NATIVE_ELF[role].sha256,length:NATIVE_ELF[role].trimmedLength})}),false],
  ['the trimmed hash with the raw length',nativePinned(today,{elf:role=>({sha256:NATIVE_ELF[role].trimmedSha256,length:NATIVE_ELF[role].length})}),false],
  ['the native swap beside today’s launch',nativePinned(today,{elf:role=>role==='swap'?NATIVE_ELF_PIN.trimmed(role):null}),false],
  ['the native ELFs beside bundle 2’s IDLs',nativePinned(today,{elf:'trimmed',idl:'bundle'}),false],
  ['bundle 2 itself',today,false]]
 for(const [label,bundle,open] of cases){
  assert.equal(pinsNativeBuilds(bundle.profile),open,label)
  assert.equal(runtime(bundle).nativeTrading,open,`${label}: the runtime`)
  assert.equal(compiles(bundle),open?'past the pin check':'refused',`${label}: the compiler`)
 }
})

test('the market API says whether native coins trade here yet',async()=>{
 const mint=Keypair.generate().publicKey.toBase58()
 const service=nativeTrading=>({nativeTrading,market:async()=>({market:{mint,native:true},wallet:null}),coinProfile:async()=>({id:'r1'})})
 const read=async(e,nativeTrading)=>(await (await createMarketHandler({env:e,runtime:()=>service(nativeTrading),allowed:()=>true})(new Request(`https://repo.ing/api/hook-lab/market/${mint}`),{mint})).json())
 assert.equal((await read(env,true)).nativeTrading,true)
 assert.equal((await read({},true)).nativeTrading,false);assert.equal((await read(env,false)).nativeTrading,false)
 assert.equal((await read(env,true)).market.native,true)
})

// Regression (self-serve e2e, 2026-10-19): the listed coin record (coinByMint, launchedCoins) carries its stack, not the
// launch request's source, so every own-stack coin read as legacy: its page 404'd and the market said "not listed".
test('a listed coin record is read and traded under its own stack\'s profile',()=>{
 const profiles={legacy:{id:'legacy'},own:{id:'own'}}
 assert.equal(stackProfileFor(profiles,{id:'a',stack:'own'}),profiles.own,'a listed coin of our own stack')
 assert.equal(stackProfileFor(profiles,{id:'a',stack:'legacy'}),profiles.legacy,'a listed coin of the legacy stack')
 assert.equal(stackProfileFor(profiles,{source:'open'}),profiles.own,'a launch request row');assert.equal(stackProfileFor(profiles,{source:'owner-invite'}),profiles.legacy)
 assert.equal(stackProfileFor(profiles,null),profiles.legacy,'a coin the site did not launch reads under the legacy stack')
 assert.equal(stackProfileFor({...profiles,own:null},{stack:'own'}),null,'no bundle for its stack: not listed here')
})

// Regression (self-serve e2e, 2026-10-19): native-quote and get returned review.accounts, which names our stack's quote
// marker, to the browser. The trade API keeps the transaction's account list and lookup tables on the server (as the
// launch API does); the wallet still shows the transaction itself, and the browser keeps every field its checks use.
test('trade responses carry what the browser checks, never the transaction\'s account list or lookup tables',async()=>{
 const MARKER='2JTTrekMSkwF3B83LVroiKPVxauUwAJR1xtQs4CJoGVc',genesisHash='G'.repeat(44)
 const review={wallet:owner,payer:owner,genesisHash,messageSha256:'a'.repeat(64),messageBase64:'AQID',reviewExpiresAtMs:5,requiredSigners:[owner],
  accounts:[{address:owner,signer:true,writable:true},{address:MARKER,signer:false,writable:false}],lookupTables:[MARKER]}
 const op=stage=>({id,owner,custodyOperationId:id,stage,status:'reviewed',review,settlement:{executionStatus:'finalized-executed',quote:{delivered:'7'}}})
 const lifecycle={createReview:async(t,i,value)=>op(value.stage),get:async()=>op('native-sell'),walletRequest:async()=>({review,partialTransactionBase64:'AQID',canSubmit:false})}
 const handle=createInclusiveTradeHandler({...options,env,runtime:()=>({origin:'https://repo.ing',lifecycle,walletFunding:true,walletWithdraw:true,nativeTrading:true})})
 for(const body of [{action:'native-quote',signingId:id,request:intent},{action:'get',signingId:id},{action:'wallet-request',signingId:id},{action:'quote',signingId:id,request:(({graduate,...r})=>r)(intent)}]){
  const r=await json(await handle(request(body))),raw=JSON.stringify(r.body),shown=r.body.operation?.review??r.body.review
  assert.equal(r.status,200,body.action);assert.doesNotMatch(raw,new RegExp(MARKER),body.action);assert.doesNotMatch(raw,/"accounts"|"lookupTables"/,body.action)
  for(const field of ['wallet','payer','genesisHash','messageSha256','reviewExpiresAtMs','requiredSigners'])assert.deepEqual(shown[field],review[field],`${body.action} ${field}`)
  if(body.action==='wallet-request')assert.deepEqual([shown.messageBase64,r.body.partialTransactionBase64],['AQID','AQID'])
  else assert.deepEqual(r.body.operation.settlement,{executionStatus:'finalized-executed',quote:{delivered:'7'}},body.action)
 }
})
