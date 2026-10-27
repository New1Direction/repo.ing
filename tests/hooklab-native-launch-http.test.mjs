import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeLaunchHandler } from '../app/lib/hooklab-native-launch.mjs'
const id='11111111-1111-4111-8111-111111111111',token=Buffer.alloc(32,9).toString('base64url'),owner='synthetic-owner'
const options={env:{HOOK_NATIVE_LAUNCH_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true'},configuration:()=>({origin:'https://repo.ing'}),database:()=>({end:async()=>{}}),quota:async()=>true,principalStore:()=>({resolve:async()=>({wallet:owner})})}
const request=(body,headers={},url='https://repo.ing/api/hook-lab/native-launch')=>new Request(url,{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${token}`,...headers},body:JSON.stringify(body)})
test('native HTTP is default off and complete runtime must be configured',async()=>{
 assert.equal((await (await createNativeLaunchHandler()(request({action:'get',signingId:id}))).json()).status,'blocked')
 assert.equal((await (await createNativeLaunchHandler({...options,runtime:()=>null})(request({action:'get',signingId:id}))).json()).blockers[0].code,'APPROVED_RUNTIME_UNCONFIGURED')
})
test('native HTTP enforces origin, body, session and rate limits before lifecycle',async()=>{
 let calls=0;const handler=createNativeLaunchHandler({...options,runtime:()=>({lifecycle:{get:async()=>{calls++;return {id}}}})})
 for(const [req,status] of [[request({action:'get',signingId:id},{origin:'https://wrong.invalid'}),403],[request({action:'get',signingId:id},{cookie:''}),401],
  [request({action:'get',signingId:id,owner:'substitute'}),400],[request({action:'get',signingId:id},{},'https://repo.ing/api/hook-lab/native-launch?x=1'),400],
  [request({action:'retain-wallet',signingId:id,signedTransactionBase64:'x'.repeat(1645)}),400]])assert.equal((await handler(req)).status,status)
 assert.equal(calls,0)
 assert.equal((await createNativeLaunchHandler({...options,quota:async()=>false})(request({action:'get',signingId:id}))).status,429)
})
test('native HTTP advances only explicitly requested action and never retries unknown signing',async()=>{
 let calls=0;const operation={id,status:'partial',review:{requiredSigners:[owner,'mint','config']},signedBy:[owner]}
 const lifecycle={get:async()=>operation,coSignNext:async(t,i,key)=>{assert.equal(t,token);assert.equal(i,id);assert.equal(key,'mint');calls++;return {...operation,status:'signing-unknown'}}}
 const handler=createNativeLaunchHandler({...options,runtime:()=>({lifecycle})})
 const result=await (await handler(request({action:'cosign',signingId:id}))).json();assert.equal(result.operation.status,'signing-unknown');assert.equal(calls,1)
 operation.status='signing-unknown';assert.equal((await handler(request({action:'cosign',signingId:id}))).status,409);assert.equal(calls,1)
})
test('native HTTP complete runs the single pass only after the wallet has signed',async()=>{
 let calls=0;const operation={id,status:'partial',review:{requiredSigners:[owner,'mint','config']},signedBy:[owner]}
 const lifecycle={get:async()=>operation,completeSigning:async(t,i)=>{assert.equal(t,token);assert.equal(i,id);calls++;return {...operation,status:'submitted',signature:'sig'}}}
 const handler=createNativeLaunchHandler({...options,runtime:()=>({lifecycle})})
 const result=await (await handler(request({action:'complete',signingId:id}))).json();assert.equal(result.operation.status,'submitted');assert.equal(calls,1)
 operation.signedBy=[];assert.equal((await handler(request({action:'complete',signingId:id}))).status,409);assert.equal(calls,1)
 operation.signedBy=[owner];operation.status='reviewed';assert.equal((await handler(request({action:'complete',signingId:id}))).status,409);assert.equal(calls,1)
})
test('native HTTP generic errors never echo callback details or key material',async()=>{
 const handler=createNativeLaunchHandler({...options,runtime:()=>({lifecycle:{get:async()=>{throw Error('PRIVATE-KEY-SENTINEL')}}})})
 const response=await handler(request({action:'get',signingId:id}));assert.equal(response.status,409);assert.ok(!(await response.text()).includes('PRIVATE-KEY'))
})

test('public operation projection never exposes unmarked message or private context',async()=>{
 const operation={id,review:{messageBase64:'NEVER-UNMARKED',messageSha256:'a'.repeat(64)},settlementContext:{private:'NEVER-UNMARKED'},partialTransactionBase64:'NEVER-UNMARKED'}
 const response=await createNativeLaunchHandler({...options,runtime:()=>({lifecycle:{get:async()=>operation}})})(request({action:'get',signingId:id}))
 assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes('NEVER-UNMARKED'));assert.ok(text.includes('messageSha256'))
})
