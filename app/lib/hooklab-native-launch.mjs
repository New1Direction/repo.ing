import {publicNativeOperation} from './hooklab-native-operation-public.mjs'
import {createHookLabDatabasePool} from '../../src/hooklab-database.mjs'
import { z } from 'zod'
import { assertSameOrigin } from './auth.mjs'
import { walletIdentityConfiguration,walletIdentitySessionToken,walletIdentityQuota } from './hooklab-wallet-identity.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { nativeLaunchRuntime } from './hooklab-native-launch-runtime.mjs'
import { ownerApprovalStore } from '../../src/hooklab-owner-approval.mjs'
const uuid=z.uuid(),text=max=>z.string().refine(x=>Buffer.byteLength(x)<=max)
const inputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('reserve'),operationId:uuid,capBps:z.number().int().min(1).max(9999),label:text(32).min(1),name:text(32).min(1),symbol:text(10).min(1),uri:text(200),virtualQuote:z.string().regex(/^(0|[1-9][0-9]*)$/).max(20),creatorFeeBps:z.number().int().min(0).max(9999)}).strict(),
 z.object({action:z.literal('review'),operationId:uuid,signingId:uuid,stage:z.enum(['preparation','launch'])}).strict(),
 z.object({action:z.enum(['get','refresh-review','wallet-request','cosign','submit','reconcile','expire']),signingId:uuid}).strict(),
 z.object({action:z.literal('retain-wallet'),signingId:uuid,signedTransactionBase64:z.string().max(1644)}).strict(),
])
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'}})
export function createNativeLaunchHandler({env=process.env,configuration=walletIdentityConfiguration,runtime=nativeLaunchRuntime,
 database=createHookLabDatabasePool,principalStore=walletPrincipalStore,quota=walletIdentityQuota,ownerApprovals=ownerApprovalStore}={}){
 return async request=>{
  if(env.HOOK_NATIVE_LAUNCH_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')return reply({status:'blocked',blockers:[{code:'NATIVE_LAUNCH_DISABLED',message:'The native launcher is not enabled.'}]})
  let pool
  try{
   const config=configuration(env)
   if(request.method!=='POST')return reply({error:'Method unavailable.'},405)
   try{assertSameOrigin(request,config.origin);if(new URL(request.url).origin!==config.origin||request.headers.get('sec-fetch-site')==='cross-site')throw Error()}catch{return reply({error:'Open the configured launcher origin.'},403)}
   if(new URL(request.url).search)return reply({error:'Query parameters unavailable.'},400)
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply({error:'JSON required.'},415)
   const token=walletIdentitySessionToken(request);if(!token)return reply({error:'Sign in with your wallet first.'},401)
   let input;try{input=inputSchema.parse(JSON.parse((await readLimitedBody(request,8192)).toString('utf8')))}catch{return reply({error:'Invalid launcher request.'},400)}
   pool=database(config)
   const observing=input.action==='get'||input.action==='reconcile'
   if(!await quota(pool,[[`native-launch:${observing?'observe':'action'}:${clientAddress(request)??'unknown'}`,observing?120:30]]))return reply({error:'Too many requests. Try again later.'},429)
   const principal=principalStore(pool,{enabled:true,origin:config.origin,audience:config.audience,genesisHash:config.genesisHash}),owner=await principal.resolve(token)
   const service=runtime()
   if(!service)return reply({status:'blocked',blockers:[{code:'APPROVED_RUNTIME_UNCONFIGURED',message:'Owner-approved custody, exact deployment and fee settings are not configured.'}]})
   const lifecycle=service.lifecycle
   let result
   if(input.action==='reserve'){
    if(env.HOOK_OWNER_APPROVED_LAUNCHES==='true'){
     // Owner-approved release: prepare only the exact coin the owner invited for this wallet.
     const approvals=ownerApprovals(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS}),db=await pool.connect()
     try{await db.query('begin');await approvals.bindLaunch(db,owner.wallet,input.operationId,{name:input.name,symbol:input.symbol,uri:input.uri,creatorFeeBps:input.creatorFeeBps,capBps:input.capBps});await db.query('commit')}
     catch(error){await db.query('rollback').catch(()=>{});return reply({status:'awaiting-owner',error:error?.code==='OWNER_APPROVAL_UNAVAILABLE'?error.message:'Wait for repo.ing to invite your launch request.'},409)}
     finally{db.release()}
    }
    const reserved=await service.reserve({sessionToken:token,owner:owner.wallet,input})
    if(reserved.owner!==owner.wallet||reserved.operationId!==input.operationId)throw Error()
    result={operationId:reserved.operationId,mint:reserved.mint,selectedConfig:reserved.selectedConfig,request:reserved.request}
   }else if(input.action==='wallet-request')result=await lifecycle.walletRequest(token,input.signingId)
   else {
    let operation
    if(input.action==='review')operation=await lifecycle.createReview(token,input.signingId,{custodyOperationId:input.operationId,stage:input.stage})
    else if(input.action==='get')operation=await lifecycle.get(token,input.signingId)
    else if(input.action==='refresh-review')operation=await lifecycle.refreshReview(token,input.signingId)
    else if(input.action==='retain-wallet')operation=await lifecycle.retainWalletSignature(token,input.signingId,input.signedTransactionBase64)
    else if(input.action==='cosign'){
     const existing=await lifecycle.get(token,input.signingId)
     if(existing.status!=='partial')throw Error()
     const signer=existing.review.requiredSigners.find(x=>x!==owner.wallet&&!existing.signedBy.includes(x));if(!signer)throw Error()
     operation=await lifecycle.coSignNext(token,input.signingId,signer)
    }else if(input.action==='submit')operation=await lifecycle.submitOnce(token,input.signingId)
    else if(input.action==='expire')operation=await lifecycle.expire(token,input.signingId)
    else{
     operation=await lifecycle.reconcile(token,input.signingId)
     if(env.HOOK_OWNER_APPROVED_LAUNCHES==='true'&&operation?.stage==='launch'&&operation?.status==='finalized-success')
      await ownerApprovals(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS}).markLaunched(operation.custodyOperationId)
    }
    result={operation:publicNativeOperation(operation)}
   }
   // Durable signatures/outcomes remain retained even if this response loses auth.
   if((await principal.resolve(token)).wallet!==owner.wallet)throw Error()
   return reply({status:'available',...result})
  }catch(error){
   // Owner-approval messages are fixed, customer-facing and secret-free (e.g. the owner is still preparing the launch table).
   const message=error.status===401?'Wallet session expired. Sign in again.':error?.code==='OWNER_APPROVAL_UNAVAILABLE'?error.message:'Launcher unavailable or changed. Preserve the operation IDs and reconcile any pending transaction.'
   return reply({error:message},error.status===401?401:409)}
  finally{await pool?.end().catch(()=>{})}
 }
}
