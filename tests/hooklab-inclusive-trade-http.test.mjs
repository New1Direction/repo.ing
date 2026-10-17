import test from 'node:test'
import assert from 'node:assert/strict'
import {createInclusiveTradeHandler} from '../app/lib/hooklab-inclusive-trade.mjs'
import {inclusiveTradeRuntime,createInclusiveTradeRuntime} from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
const id='11111111-1111-4111-8111-111111111111',token=Buffer.alloc(32,9).toString('base64url'),owner='11111111111111111111111111111111'
const options={env:{HOOK_INCLUSIVE_TRADING_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true'},configuration:()=>({origin:'https://repo.ing'}),database:()=>({end:async()=>{}}),quota:async()=>true,principalStore:()=>({resolve:async()=>({wallet:owner})})}
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
