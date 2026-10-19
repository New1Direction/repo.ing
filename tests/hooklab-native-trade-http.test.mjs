// Native-SOL trading over HTTP: off by default (HOOK_NATIVE_TRADING_ENABLED and a runtime built with it), behind the
// same tester gate, with an exact intent and the native stages; bridged quotes, funding and withdrawals are unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {Keypair} from '@solana/web3.js'
import {NATIVE_ELF,NATIVE_IDL_SHA256} from '../src/hooklab-native-pins.mjs'
import {createInclusiveTradeHandler,nativeTradingOn} from '../app/lib/hooklab-inclusive-trade.mjs'
import {createInclusiveTradeRuntime} from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
import {createMarketHandler} from '../app/lib/hooklab-market.mjs'

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

// Today's production bundle, re-pinned to the reviewed native builds as the post-upgrade bundle will be (profile IDLs,
// ELF hashes and lengths, and the dossier and operator config that bind them).
const sha=x=>createHash('sha256').update(x).digest('hex')
function nativePinned(bundle){
 const p=JSON.parse(bundle.profile.json),idl=role=>readFileSync(new URL(`../vendor/hooklab-native-candidate/bordrless_${role}.json`,import.meta.url))
 const json=JSON.stringify({...p,idlSha256:{...p.idlSha256,...NATIVE_IDL_SHA256},elfSha256:{...p.elfSha256,swap:NATIVE_ELF.swap.sha256,launch:NATIVE_ELF.launch.sha256}})
 const profile={...bundle.profile,json,expectedSha256:sha(json),idls:{...bundle.profile.idls,swap:idl('swap').toString('base64'),launch:idl('launch').toString('base64')},
  elfLengths:{...bundle.profile.elfLengths,swap:NATIVE_ELF.swap.length,launch:NATIVE_ELF.launch.length}}
 const dossier=JSON.parse(bundle.dossierJson);dossier.artifacts.profileSha256=profile.expectedSha256
 for(const pin of dossier.programs)if(['swap','launch'].includes(pin.role))Object.assign(pin,{elfSha256:NATIVE_ELF[pin.role].sha256,elfLength:NATIVE_ELF[pin.role].length})
 const dossierJson=JSON.stringify(dossier)
 return {config:{...bundle.config,profileSha256:profile.expectedSha256,dossierSha256:sha(dossierJson)},profile,dossierJson}
}

test('the trade runtime registers the native stages only when built with the switch and a bundle pinning the native builds',async()=>{
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

test('the market API says whether native coins trade here yet',async()=>{
 const mint=Keypair.generate().publicKey.toBase58()
 const service=nativeTrading=>({nativeTrading,market:async()=>({market:{mint,native:true},wallet:null}),coinProfile:async()=>({id:'r1'})})
 const read=async(e,nativeTrading)=>(await (await createMarketHandler({env:e,runtime:()=>service(nativeTrading),allowed:()=>true})(new Request(`https://repo.ing/api/hook-lab/market/${mint}`),{mint})).json())
 assert.equal((await read(env,true)).nativeTrading,true)
 assert.equal((await read({},true)).nativeTrading,false);assert.equal((await read(env,false)).nativeTrading,false)
 assert.equal((await read(env,true)).market.native,true)
})
