// Injected stores only; no database, RPC or keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createOwnerApprovalsHandler,ownerTokenMatches } from '../app/lib/hooklab-owner-approvals.mjs'
import { createLaunchRequestsHandler } from '../app/lib/hooklab-launch-requests.mjs'
import { createNativeLaunchHandler } from '../app/lib/hooklab-native-launch.mjs'
import { createCoinPublicHandler } from '../app/lib/hooklab-coin-public.mjs'
import sharp from 'sharp'
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

// A prepared 512 x 512 PNG, as the image upload returns it (src/token-image.mjs normalizeTokenImage).
const coinImage=`data:image/png;base64,${(await sharp({create:{width:512,height:512,channels:3,background:'#81e6ad'}}).png().toBuffer()).toString('base64')}`
const coin={image:coinImage,description:'The cat that ships.',x:'@repocat',website:'repo.ing',telegram:''}

test('creator requests use the session wallet, show availability, and prepare nothing',async()=>{
 assert.equal((await (await createLaunchRequestsHandler({env:{}})(new Request('https://repo.ing/api/hook-lab/launch-requests'))).json()).status,'blocked')
 const seen=[];const store={availability:async()=>({online:true,lastSeenAt:null}),
  createRequest:async(wallet,value,profile)=>{seen.push(['create',wallet,value,profile]);return {id:value.id,status:'queued'}},
  requestFor:async wallet=>{seen.push(['get',wallet]);return null},cancelRequest:async(wallet,requestId)=>{seen.push(['cancel',wallet,requestId]);return {status:'cancelled'}}}
 const handler=createLaunchRequestsHandler(creatorOptions(store))
 assert.equal((await (await handler(new Request('https://repo.ing/api/hook-lab/launch-requests'))).json()).online,true)
 for(const [req,status] of [[creatorRequest({action:'get'},{origin:'https://wrong.invalid'}),403],[creatorRequest({action:'get'},{cookie:''}),401],
  [creatorRequest({action:'create',requestId:id,name:'A',symbol:'B',creatorFeeBps:100,capBps:200,...coin,creator:'substitute'}),400],[creatorRequest({action:'create',requestId:id,name:'x'.repeat(33),symbol:'B',creatorFeeBps:100,capBps:200,...coin}),400],
  [creatorRequest({action:'create',requestId:id,name:'A',symbol:'B',creatorFeeBps:100,capBps:200,...coin,uri:'https://elsewhere.invalid/m.json'}),400]])
  assert.equal((await handler(req)).status,status)
 assert.equal(seen.length,0)
 for(const [body,message] of [[{...coin,image:''},/coin image/],[{...coin,image:'data:image/png;base64,AAAA'},/coin image/],[{...coin,x:'not a handle'},/X account/],[{...coin,website:'http://repo.ing'},/https website/]]){
  const refused=await handler(creatorRequest({action:'create',requestId:id,name:'Canary',symbol:'CNRY',creatorFeeBps:100,capBps:200,...body}))
  assert.equal(refused.status,400);assert.match((await refused.json()).error,message)
 }
 assert.equal(seen.length,0)
 assert.equal((await (await handler(creatorRequest({action:'create',requestId:id,name:'Canary',symbol:'CNRY',creatorFeeBps:100,capBps:200,...coin}))).json()).request.status,'queued')
 const [,,value,profile]=seen[0]
 assert.deepEqual(value,{id,name:'Canary',symbol:'CNRY',uri:`https://repo.ing/api/hook-lab/coins/${id}/metadata`,creatorFeeBps:100,capBps:200},'repo.ing sets the metadata uri')
 assert.deepEqual({...profile,image:profile.image.slice(0,22)},{image:'data:image/png;base64,',description:'The cat that ships.',x:'repocat',website:'https://repo.ing/',telegram:null})
 await handler(creatorRequest({action:'get'}));await handler(creatorRequest({action:'cancel',requestId:id}))
 assert.deepEqual(seen.map(x=>x[1]),[creator,creator,creator],'identity comes only from the wallet session')
 assert.equal((await createLaunchRequestsHandler({...creatorOptions(store),quota:async()=>false})(creatorRequest({action:'get'}))).status,429)
})

test('native launch reserve waits for the owner invite; expire and launched marking are wired',async()=>{
 const launchEnv={HOOK_NATIVE_LAUNCH_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_OWNER_APPROVED_LAUNCHES:'true',HOOK_LAUNCH_ADMIN_ADDRESS:admin}
 const reserveInput={action:'reserve',operationId:id,capBps:200,label:'canary',name:'Canary',symbol:'CNRY',uri:'',virtualQuote:'1000000000',creatorFeeBps:100}
 let reserves=0,expires=0;const launched=[];let invited=false
 const approvals=()=>({bindLaunch:async(_db,wallet,operationId,intent)=>{assert.equal(wallet,creator);assert.equal(operationId,id);assert.deepEqual(intent,{name:'Canary',symbol:'CNRY',uri:'',creatorFeeBps:100,capBps:200,virtualQuote:'1000000000'},'the compiled opening price is bound too')
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

const fixedPrice={solUsdMicros:'105630000',virtualQuote:'53251917070',sources:[{source:'coingecko',usdMicros:'105620000'},{source:'jupiter',usdMicros:'105630000'}]}
test('USD pricing: the owner invite reads the SOL price and the on-chain limits fresh; off, invites stay exactly as before',async()=>{
 const widened={min:5_625_000_000n,max:112_500_000_000n}
 const seen=[],options=(env,launchPrice,launchBounds=async()=>widened)=>({env,configuration:()=>({}),database:()=>pool,launchPrice,launchBounds,
  store:(_pool,settings)=>({invite:async(requestId,input)=>{seen.push([settings.usdPricing,requestId,input]);return {id:requestId,status:'invited'}}})})
 let reads=0
 const on=createOwnerApprovalsHandler(options({...ownerEnv,HOOK_LAUNCH_USD_PRICING:'true'},async()=>{reads++;return fixedPrice}))
 assert.equal((await on(ownerRequest({action:'invite',requestId:id,inviteSeconds:600}))).status,200)
 assert.deepEqual(seen.pop(),[true,id,{inviteMs:600_000,price:fixedPrice,liveBounds:widened}]);assert.equal(reads,1)
 const off=createOwnerApprovalsHandler(options(ownerEnv,async()=>{reads++;return fixedPrice},async()=>{throw Error('never read')}))
 assert.equal((await off(ownerRequest({action:'invite',requestId:id,inviteSeconds:600}))).status,200)
 assert.deepEqual(seen.pop(),[false,id,{inviteMs:600_000}]);assert.equal(reads,1,'off: no price or chain read')
 // Limits unreadable: the owner is told why, and nothing reaches the store.
 const unread=createOwnerApprovalsHandler(options({...ownerEnv,HOOK_LAUNCH_USD_PRICING:'true'},async()=>fixedPrice,
  async()=>{throw Object.assign(Error('The RPC providers disagree on the launch config; try the invite again'),{code:'LAUNCH_PRICE_REFUSED'})}))
 const disagree=await unread(ownerRequest({action:'invite',requestId:id,inviteSeconds:600}))
 assert.equal(disagree.status,409);assert.match((await disagree.json()).error,/providers disagree on the launch config/);assert.equal(seen.length,0)
 // A refused price reaches the owner in plain words and invites nothing.
 const refused=createOwnerApprovalsHandler(options({...ownerEnv,HOOK_LAUNCH_USD_PRICING:'true'},async()=>{throw Object.assign(Error('SOL price sources disagree by more than 2% (coingecko $100.00, jupiter $103.00). Try again in a minute.'),{code:'LAUNCH_PRICE_REFUSED'})}))
 const response=await refused(ownerRequest({action:'invite',requestId:id,inviteSeconds:600}))
 assert.equal(response.status,409);assert.match((await response.json()).error,/disagree by more than 2%/);assert.equal(seen.length,0)
})

test('USD pricing: creators see a cached estimate before the invite, and nothing new while it is off',async()=>{
 const store={availability:async()=>({online:true,lastSeenAt:null})},settings=[]
 const handler=(env,launchPriceEstimate)=>createLaunchRequestsHandler({...creatorOptions(store),env,launchPriceEstimate,store:(_pool,s)=>{settings.push(s.usdPricing);return store}})
 const on=await (await handler({...creatorEnv,HOOK_LAUNCH_USD_PRICING:'true'},async()=>({solUsdMicros:'105630000',virtualQuote:'53251917070'}))(new Request('https://repo.ing/api/hook-lab/launch-requests'))).json()
 assert.deepEqual(on,{status:'available',online:true,lastSeenAt:null,launchPrice:{solUsdMicros:'105630000',virtualQuote:'53251917070'}})
 const unknown=await (await handler({...creatorEnv,HOOK_LAUNCH_USD_PRICING:'true'},async()=>null)(new Request('https://repo.ing/api/hook-lab/launch-requests'))).json()
 assert.equal(unknown.launchPrice,null,'sources down: the page shows the USD targets alone')
 const off=await (await handler(creatorEnv,async()=>{throw Error('never read')})(new Request('https://repo.ing/api/hook-lab/launch-requests'))).json()
 assert.deepEqual(off,{status:'available',online:true,lastSeenAt:null});assert.deepEqual(settings,[true,true,false])
})

test('USD pricing: reserve binds the stored opening price through the pricing-aware store',async()=>{
 const launchEnv={HOOK_NATIVE_LAUNCH_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_OWNER_APPROVED_LAUNCHES:'true',HOOK_LAUNCH_ADMIN_ADDRESS:admin,HOOK_LAUNCH_USD_PRICING:'true'}
 const bound=[],reserved=[]
 const handler=createNativeLaunchHandler({env:launchEnv,configuration:()=>({origin:'https://repo.ing'}),database:()=>pool,quota:async()=>true,principalStore:()=>({resolve:async()=>({wallet:creator})}),
  runtime:()=>({reserve:async({owner,input})=>{reserved.push(input.virtualQuote);return {owner,operationId:id,mint:'m',selectedConfig:'c',request:{}}},lifecycle:{}}),
  ownerApprovals:(_pool,settings)=>({bindLaunch:async(_db,_wallet,_op,intent)=>{bound.push([settings.usdPricing,intent.virtualQuote]);if(intent.virtualQuote!==fixedPrice.virtualQuote)throw known('The opening price differs from the approved request')}})})
 const reserve=virtualQuote=>handler(new Request('https://repo.ing/api/hook-lab/native-launch',{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${sessionToken}`},
  body:JSON.stringify({action:'reserve',operationId:id,capBps:200,label:'CNRY',name:'Canary',symbol:'CNRY',uri:'',virtualQuote,creatorFeeBps:100})}))
 const tampered=await reserve('112500000000');assert.equal(tampered.status,409);assert.match((await tampered.json()).error,/opening price differs/)
 assert.deepEqual(reserved,[],'nothing is prepared at a price the owner did not fix')
 assert.equal((await reserve(fixedPrice.virtualQuote)).status,200);assert.deepEqual(reserved,[fixedPrice.virtualQuote])
 assert.deepEqual(bound,[[true,'112500000000'],[true,fixedPrice.virtualQuote]])
})

test('coin metadata and image are public, cacheable and only for coins that can launch',async()=>{
 const coinId='22222222-2222-4222-8222-222222222222'
 const coins={[coinId]:{request:{id:coinId,name:'Repo Cat',symbol:'RCAT',status:'queued'},profile:{description:'',x:'repocat',website:null,telegram:null},image:coinImage}}
 let budget=Infinity
 const handler=createCoinPublicHandler({env:creatorEnv,configuration:()=>({origin:'https://repo.ing'}),database:()=>pool,store:()=>({coinFor:async requested=>coins[requested]??null}),allowed:()=>budget-->0})
 const metadata=await handler(new Request(`https://repo.ing/api/hook-lab/coins/${coinId}/metadata`),{id:coinId,kind:'metadata'})
 assert.equal(metadata.status,200);assert.match(metadata.headers.get('cache-control'),/public/)
 assert.deepEqual(await metadata.json(),{name:'Repo Cat',symbol:'RCAT',description:'$RCAT launched on repo.ing.',image:`https://repo.ing/api/hook-lab/coins/${coinId}/image`,
  twitter:'https://x.com/repocat',extensions:{twitter:'https://x.com/repocat'}})
 const image=await handler(new Request(`https://repo.ing/api/hook-lab/coins/${coinId}/image`),{id:coinId,kind:'image'})
 assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png')
 assert.equal(image.headers.get('cache-control'),'public, max-age=300','not launched yet: a decline must take it down quickly')
 coins[coinId]={...coins[coinId],request:{...coins[coinId].request,status:'launched'}}
 assert.match((await handler(new Request(`https://repo.ing/api/hook-lab/coins/${coinId}/image`),{id:coinId,kind:'image'})).headers.get('cache-control'),/immutable/)
 const small=await handler(new Request(`https://repo.ing/api/hook-lab/coins/${coinId}/image?w=128`),{id:coinId,kind:'image'})
 assert.equal(small.headers.get('content-type'),'image/webp')
 assert.equal((await handler(new Request(`https://repo.ing/api/hook-lab/coins/${coinId}/image?w=99`),{id:coinId,kind:'image'})).status,400)
 for(const missing of ['33333333-3333-4333-8333-333333333333','nope'])assert.equal((await handler(new Request(`https://repo.ing/api/hook-lab/coins/${missing}/metadata`),{id:missing,kind:'metadata'})).status,404)
 budget=0;assert.equal((await handler(new Request(`https://repo.ing/api/hook-lab/coins/${coinId}/metadata`),{id:coinId,kind:'metadata'})).status,429)
 assert.equal((await createCoinPublicHandler({env:{}})(new Request(`https://repo.ing/api/hook-lab/coins/${coinId}/metadata`),{id:coinId,kind:'metadata'})).status,404)
})
