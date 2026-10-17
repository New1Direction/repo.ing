import {publicNativeOperation} from './hooklab-native-operation-public.mjs'
import pg from 'pg'
import { z } from 'zod'
import { assertSameOrigin } from './auth.mjs'
import { walletIdentityConfiguration,walletIdentitySessionToken,walletIdentityQuota } from './hooklab-wallet-identity.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { nativeLaunchRuntime } from './hooklab-native-launch-runtime.mjs'
const uuid=z.uuid(),text=max=>z.string().refine(x=>Buffer.byteLength(x)<=max)
const inputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('reserve'),operationId:uuid,capBps:z.number().int().min(1).max(9999),label:text(32).min(1),name:text(32).min(1),symbol:text(10).min(1),uri:text(200),virtualQuote:z.string().regex(/^(0|[1-9][0-9]*)$/).max(20),creatorFeeBps:z.number().int().min(0).max(9999)}).strict(),
 z.object({action:z.literal('review'),operationId:uuid,signingId:uuid,stage:z.enum(['preparation','launch'])}).strict(),
 z.object({action:z.enum(['get','refresh-review','wallet-request','cosign','submit','reconcile']),signingId:uuid}).strict(),
 z.object({action:z.literal('retain-wallet'),signingId:uuid,signedTransactionBase64:z.string().max(1644)}).strict(),
])
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'}})
export function createNativeLaunchHandler({env=process.env,configuration=walletIdentityConfiguration,runtime=nativeLaunchRuntime,
 database=c=>new pg.Pool({connectionString:c.databaseUrl,max:2,connectionTimeoutMillis:5000,query_timeout:5000}),principalStore=walletPrincipalStore,quota=walletIdentityQuota}={}){
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
   if(!await quota(pool,[[`native-launch:${clientAddress(request)??'unknown'}`,30]]))return reply({error:'Too many requests. Try again later.'},429)
   const principal=principalStore(pool,config),owner=await principal.resolve(token)
   const service=runtime()
   if(!service)return reply({status:'blocked',blockers:[{code:'APPROVED_RUNTIME_UNCONFIGURED',message:'Owner-approved custody, exact deployment and fee settings are not configured.'}]})
   const lifecycle=service.lifecycle
   let result
   if(input.action==='reserve'){
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
    else operation=await lifecycle.reconcile(token,input.signingId)
    result={operation:publicNativeOperation(operation)}
   }
   // Durable signatures/outcomes remain retained even if this response loses auth.
   if((await principal.resolve(token)).wallet!==owner.wallet)throw Error()
   return reply({status:'available',...result})
  }catch(error){return reply({error:error.status===401?'Wallet session expired. Sign in again.':'Launcher unavailable or changed. Preserve the operation IDs and reconcile any pending transaction.'},error.status===401?401:409)}
  finally{await pool?.end().catch(()=>{})}
 }
}
