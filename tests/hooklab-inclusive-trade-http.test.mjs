import test from 'node:test'
import assert from 'node:assert/strict'
import {createInclusiveTradeHandler,tradingOpenFor} from '../app/lib/hooklab-inclusive-trade.mjs'
import {inclusiveTradeRuntime,createInclusiveTradeRuntime} from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
const id='11111111-1111-4111-8111-111111111111',token=Buffer.alloc(32,9).toString('base64url'),owner='11111111111111111111111111111111'
const options={env:{HOOK_INCLUSIVE_TRADING_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_TRADING_PUBLIC:'true'},configuration:()=>({origin:'https://repo.ing'}),database:()=>({end:async()=>{}}),quota:async()=>true,principalStore:()=>({resolve:async()=>({wallet:owner})})}
const request=(body,headers={},url='https://repo.ing/api/hook-lab/inclusive-trade')=>new Request(url,{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${token}`,...headers},body:JSON.stringify(body)})
const intent={mint:owner,selectedConfig:owner,capBps:100,creatorFeeBps:100,side:'buy',amountIn:'100',minAmountOut:'1',maxInput:'100',maxPriceImpactBps:100}
test('inclusive trading defaults off and runtime requires explicit approvals',async()=>{
 assert.equal(inclusiveTradeRuntime(),null);assert.throws(()=>createInclusiveTradeRuntime({},{}))
 assert.equal((await (await createInclusiveTradeHandler()(request({action:'get',signingId:id}))).json()).status,'blocked')
 assert.equal((await (await createInclusiveTradeHandler({...options,runtime:()=>null})(request({action:'get',signingId:id}))).json()).blockers[0].code,'INCLUSIVE_TRADE_RUNTIME_UNCONFIGURED')
})
test('HTTP cannot inject owners, RPC observations, messages, proofs or legacy mode',async()=>{
 let calls=0;const handler=createInclusiveTradeHandler({...options,runtime:()=>{calls++;return null}})
 for(const [req,status] of [[request({action:'get',signingId:id},{origin:'https://wrong.invalid'}),403],[request({action:'get',signingId:id},{cookie:''}),401],
  [request({action:'quote',signingId:id,request:{...intent,owner}}),400],[request({action:'quote',signingId:id,request:{...intent,feeModel:1}}),400],
  [request({action:'quote',signingId:id,request:intent,observations:[]}),400],[request({action:'cosign',signingId:id}),400]])assert.equal((await handler(req)).status,status)
 assert.equal(calls,0)
})
test('quote binds same authenticated lifecycle, and repeated id returns retained original intent',async()=>{
 let calls=0;const original={id,owner,stage:'inclusive-buy',request:{...intent,amountIn:'99'},status:'reviewed',review:{messageBase64:'NEVER-UNMARKED',messageSha256:'a'.repeat(64)}}
 const lifecycle={createReview:async(t,i,value)=>{calls++;assert.equal(t,token);assert.equal(i,id);assert.deepEqual(value,{custodyOperationId:id,stage:'inclusive-buy',intent});return original}}
 const handler=createInclusiveTradeHandler({...options,runtime:()=>({origin:'https://repo.ing',lifecycle})})
 const result=await (await handler(request({action:'quote',signingId:id,request:intent}))).json()
 assert.deepEqual(result.operation,{...original,review:{messageSha256:'a'.repeat(64)}});assert.ok(!JSON.stringify(result).includes('NEVER-UNMARKED'));assert.equal(calls,1)
})
test('HTTP only routes requested submit once; uncertain result is retained and errors never expose details',async()=>{
 let calls=0;const lifecycle={submitOnce:async()=>{calls++;return {id,owner,stage:'inclusive-buy',status:'outcome-unknown',review:{}}},get:async()=>{throw Error('SECRET')}}
 const handler=createInclusiveTradeHandler({...options,runtime:()=>({origin:'https://repo.ing',lifecycle})})
 const result=await (await handler(request({action:'submit',signingId:id}))).json();assert.equal(result.operation.status,'outcome-unknown');assert.equal(calls,1)
 const failed=await handler(request({action:'get',signingId:id}));assert.equal(failed.status,409);assert.ok(!(await failed.text()).includes('SECRET'))
})

test('until trading is public only listed testers may start trades or funding; existing operations stay readable',async()=>{
 assert.equal(tradingOpenFor({HOOK_TRADING_PUBLIC:'true'},owner),true)
 assert.equal(tradingOpenFor({},owner),false)
 assert.equal(tradingOpenFor({HOOK_TRADING_TESTER_WALLETS:` other , ${owner} `},owner),true)
 let creates=0,gets=0;const lifecycle={createReview:async(t,i,value)=>{creates++;return {id,owner,stage:value.stage,status:'reviewed',review:{}}},get:async()=>{gets++;return {id,owner,stage:'wallet-fund',status:'reviewed',review:{}}}}
 const closed=createInclusiveTradeHandler({...options,env:{...options.env,HOOK_TRADING_PUBLIC:undefined},runtime:()=>({origin:'https://repo.ing',lifecycle,walletFunding:true,walletWithdraw:true})})
 for(const body of [{action:'quote',signingId:id,request:intent},{action:'fund',signingId:id,request:{mint:null,lamports:'1000'}}])
  assert.equal((await (await closed(request(body))).json()).blockers[0].code,'TRADING_NOT_OPEN')
 assert.equal((await (await closed(request({action:'get',signingId:id}))).json()).operation.stage,'wallet-fund','recovery stays open')
 assert.equal(creates,0);assert.equal(gets,1)
 assert.equal((await (await closed(request({action:'withdraw',signingId:id,request:{lamports:'1000'}}))).json()).status,'available','withdrawing is never gated')
 assert.equal(creates,1)
})

test('fund and withdraw create wallet-funding reviews only when funding is switched on',async()=>{
 const seen=[];const lifecycle={createReview:async(t,i,value)=>{seen.push(value);return {id,owner,stage:value.stage,status:'reviewed',review:{}}}}
 const off=createInclusiveTradeHandler({...options,runtime:()=>({origin:'https://repo.ing',lifecycle,walletFunding:false,walletWithdraw:true})})
 assert.equal((await (await off(request({action:'fund',signingId:id,request:{mint:null,lamports:'1000'}}))).json()).blockers[0].code,'WALLET_FUNDING_DISABLED')
 assert.equal((await (await off(request({action:'withdraw',signingId:id,request:{lamports:'7'}}))).json()).operation.stage,'wallet-withdraw','deposits off, withdrawals on')
 seen.length=0
 const on=createInclusiveTradeHandler({...options,runtime:()=>({origin:'https://repo.ing',lifecycle,walletFunding:true,walletWithdraw:true})})
 const mint='2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn'
 assert.equal((await (await on(request({action:'fund',signingId:id,request:{mint,lamports:'1000000'}}))).json()).operation.stage,'wallet-fund')
 assert.equal((await (await on(request({action:'withdraw',signingId:id,request:{lamports:'5'}}))).json()).operation.stage,'wallet-withdraw')
 assert.deepEqual(seen,[{custodyOperationId:id,stage:'wallet-fund',intent:{action:'fund',mint,lamports:'1000000'}},{custodyOperationId:id,stage:'wallet-withdraw',intent:{action:'withdraw',mint:null,lamports:'5'}}])
 for(const bad of [{action:'fund',signingId:id,request:{mint:null,lamports:'-1'}},{action:'withdraw',signingId:id,request:{lamports:'0'}},{action:'fund',signingId:id,request:{mint:null,lamports:'1',owner}}])
  assert.equal((await on(request(bad))).status,400)
})

test('a refusal written for customers reaches them; anything else stays masked',async()=>{
 const refusing=message=>({createReview:async()=>{throw Object.assign(Error(message),{code:'HOOKLAB_USER_REFUSAL'})}})
 const shown=await createInclusiveTradeHandler({...options,runtime:()=>({origin:'https://repo.ing',lifecycle:refusing('Not enough SOL: keep about 0.001 SOL in your wallet for fees and its own rent.'),walletFunding:true,walletWithdraw:true})})(request({action:'fund',signingId:id,request:{mint:null,lamports:'1'}}))
 assert.equal(shown.status,409);assert.match((await shown.json()).error,/keep about 0\.001 SOL/)
 const masked=await createInclusiveTradeHandler({...options,runtime:()=>({origin:'https://repo.ing',lifecycle:{createReview:async()=>{throw Error('RPC SECRET DETAIL')}},walletFunding:true,walletWithdraw:true})})(request({action:'fund',signingId:id,request:{mint:null,lamports:'1'}}))
 assert.ok(!(await masked.text()).includes('SECRET'))
})
