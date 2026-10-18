// Injected stores only; no database, RPC or keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createOwnerApprovalsHandler,ownerTokenMatches } from '../app/lib/hooklab-owner-approvals.mjs'
import { createLaunchRequestsHandler } from '../app/lib/hooklab-launch-requests.mjs'
import { createNativeLaunchHandler } from '../app/lib/hooklab-native-launch.mjs'
const ownerToken='o'.repeat(48),tokenSha=createHash('sha256').update(ownerToken).digest('hex')
const admin='DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',id='11111111-1111-4111-8111-111111111111'
const sessionToken=Buffer.alloc(32,9).toString('base64url'),creator='synthetic-creator'
const pool={end:async()=>{},connect:async()=>({query:async()=>({rows:[]}),release(){}})}
const known=message=>Object.assign(Error(message),{code:'OWNER_APPROVAL_UNAVAILABLE'})
const ownerEnv={HOOK_OWNER_APPROVED_LAUNCHES:'true',HOOK_OWNER_APPROVAL_TOKEN_SHA256:tokenSha,HOOK_LAUNCH_ADMIN_ADDRESS:admin}
const ownerRequest=(body,headers={},url='https://repo.ing/api/hook-lab/owner-approvals')=>new Request(url,{method:'POST',
 headers:{authorization:`Bearer ${ownerToken}`,'content-type':'application/json',...headers},body:JSON.stringify(body)})

test('owner token check is exact, constant-length and rejects malformed configuration',()=>{
 assert.equal(ownerTokenMatches(`Bearer ${ownerToken}`,tokenSha),true)
 for(const [header,expected] of [[`Bearer ${ownerToken}x`,tokenSha],[ownerToken,tokenSha],['Bearer short',createHash('sha256').update('short').digest('hex')],
  [`Bearer ${ownerToken}`,'not-hex'],[`Bearer ${ownerToken}`,undefined],[null,tokenSha]])assert.equal(ownerTokenMatches(header,expected),false)
})

test('owner endpoint is off by default and authenticates before reading the body',async()=>{
 let calls=0;const store=()=>({heartbeat:async input=>{calls++;assert.deepEqual(input,{accepting:true,agentAddress:admin});return {requests:[],signRequests:[]}}})
 assert.equal((await createOwnerApprovalsHandler({env:{},store})(ownerRequest({action:'heartbeat',accepting:true,agentAddress:admin}))).status,503)
 const handler=createOwnerApprovalsHandler({env:ownerEnv,configuration:()=>({}),database:()=>pool,store})
 for(const [req,status] of [[ownerRequest({action:'heartbeat',accepting:true,agentAddress:admin},{authorization:''}),401],
  [ownerRequest({action:'heartbeat',accepting:true,agentAddress:admin},{authorization:`Bearer ${'x'.repeat(48)}`}),401],
  [ownerRequest({action:'heartbeat',accepting:true,agentAddress:admin},{'content-type':'text/plain'}),415],
  [ownerRequest({action:'heartbeat',accepting:true,agentAddress:admin},{},'https://repo.ing/api/hook-lab/owner-approvals?x=1'),400],
  [ownerRequest({action:'invite',requestId:id,inviteSeconds:30}),400],[ownerRequest({action:'sign',signRequestId:id,signatureBase64:'x'.repeat(101)}),400]])
  assert.equal((await handler(req)).status,status)
 assert.equal(calls,0)
 const ok=await handler(ownerRequest({action:'heartbeat',accepting:true,agentAddress:admin}));assert.equal(ok.status,200);assert.equal(calls,1)
})

test('owner endpoint forwards only fixed store messages, never internal errors',async()=>{
 const handler=store=>createOwnerApprovalsHandler({env:ownerEnv,configuration:()=>({}),database:()=>pool,store:()=>store})
 const fixed=await handler({invite:async()=>{throw known('Another creator is already invited; finish or expire that launch first')}})(ownerRequest({action:'invite',requestId:id,inviteSeconds:600}))
 assert.equal(fixed.status,409);assert.match((await fixed.json()).error,/Another creator/)
 const hidden=await handler({submitSignature:async()=>{throw Error('PRIVATE-DATABASE-DETAIL')}})(ownerRequest({action:'sign',signRequestId:id,signatureBase64:'AAAA'}))
 assert.equal(hidden.status,409);assert.ok(!(await hidden.text()).includes('PRIVATE'))
})

const creatorEnv={HOOK_OWNER_APPROVED_LAUNCHES:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_LAUNCH_ADMIN_ADDRESS:admin}
const creatorOptions=store=>({env:creatorEnv,configuration:()=>({origin:'https://repo.ing'}),database:()=>pool,quota:async()=>true,
 principalStore:()=>({resolve:async()=>({wallet:creator})}),store:()=>store})
const creatorRequest=(body,headers={})=>new Request('https://repo.ing/api/hook-lab/launch-requests',{method:'POST',
 headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${sessionToken}`,...headers},body:JSON.stringify(body)})

test('creator requests use the session wallet, show availability, and prepare nothing',async()=>{
 assert.equal((await (await createLaunchRequestsHandler({env:{}})(new Request('https://repo.ing/api/hook-lab/launch-requests'))).json()).status,'blocked')
 const seen=[];const store={availability:async()=>({online:true,lastSeenAt:null}),
  createRequest:async(wallet,value)=>{seen.push(['create',wallet,value]);return {id:value.id,status:'queued'}},
  requestFor:async wallet=>{seen.push(['get',wallet]);return null},cancelRequest:async(wallet,requestId)=>{seen.push(['cancel',wallet,requestId]);return {status:'cancelled'}}}
 const handler=createLaunchRequestsHandler(creatorOptions(store))
 assert.equal((await (await handler(new Request('https://repo.ing/api/hook-lab/launch-requests'))).json()).online,true)
 for(const [req,status] of [[creatorRequest({action:'get'},{origin:'https://wrong.invalid'}),403],[creatorRequest({action:'get'},{cookie:''}),401],
  [creatorRequest({action:'create',requestId:id,name:'A',symbol:'B',uri:'',creatorFeeBps:100,capBps:200,creator:'substitute'}),400],[creatorRequest({action:'create',requestId:id,name:'x'.repeat(33),symbol:'B',uri:'',creatorFeeBps:100,capBps:200}),400]])
  assert.equal((await handler(req)).status,status)
 assert.equal(seen.length,0)
 assert.equal((await (await handler(creatorRequest({action:'create',requestId:id,name:'Canary',symbol:'CNRY',uri:'',creatorFeeBps:100,capBps:200}))).json()).request.status,'queued')
 await handler(creatorRequest({action:'get'}));await handler(creatorRequest({action:'cancel',requestId:id}))
 assert.deepEqual(seen.map(x=>x[1]),[creator,creator,creator],'identity comes only from the wallet session')
 assert.equal((await createLaunchRequestsHandler({...creatorOptions(store),quota:async()=>false})(creatorRequest({action:'get'}))).status,429)
})

test('native launch reserve waits for the owner invite; expire and launched marking are wired',async()=>{
 const launchEnv={HOOK_NATIVE_LAUNCH_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_OWNER_APPROVED_LAUNCHES:'true',HOOK_LAUNCH_ADMIN_ADDRESS:admin}
 const reserveInput={action:'reserve',operationId:id,capBps:200,label:'canary',name:'Canary',symbol:'CNRY',uri:'',virtualQuote:'1000000000',creatorFeeBps:100}
 let reserves=0,expires=0;const launched=[];let invited=false
 const approvals=()=>({bindLaunch:async(_db,wallet,operationId,intent)=>{assert.equal(wallet,creator);assert.equal(operationId,id);assert.deepEqual(intent,{name:'Canary',symbol:'CNRY',uri:'',creatorFeeBps:100,capBps:200})
  if(!invited)throw known('Wait for repo.ing to invite your launch request')},markLaunched:async op=>launched.push(op)})
 const service={reserve:async({owner})=>{reserves++;return {owner,operationId:id,mint:'m',selectedConfig:'c',request:{}}},lifecycle:{
  expire:async()=>{expires++;return {id,status:'expired',review:{messageBase64:'x',messageSha256:'a'.repeat(64)}}},reconcile:async()=>({id,stage:'launch',status:'finalized-success',custodyOperationId:id,review:{messageBase64:'x',messageSha256:'a'.repeat(64)}})}}
 const handler=createNativeLaunchHandler({env:launchEnv,configuration:()=>({origin:'https://repo.ing'}),database:()=>pool,quota:async()=>true,
  principalStore:()=>({resolve:async()=>({wallet:creator})}),runtime:()=>service,ownerApprovals:approvals})
 const launchRequest=body=>new Request('https://repo.ing/api/hook-lab/native-launch',{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${sessionToken}`},body:JSON.stringify(body)})
 const waiting=await handler(launchRequest(reserveInput));assert.equal(waiting.status,409);assert.equal((await waiting.json()).status,'awaiting-owner');assert.equal(reserves,0,'nothing prepared before the invite')
 invited=true;assert.equal((await handler(launchRequest(reserveInput))).status,200);assert.equal(reserves,1)
 assert.equal((await (await handler(launchRequest({action:'expire',signingId:id}))).json()).operation.status,'expired');assert.equal(expires,1)
 await handler(launchRequest({action:'reconcile',signingId:id}));assert.deepEqual(launched,[id])
})
