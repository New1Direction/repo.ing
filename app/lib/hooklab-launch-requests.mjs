// Creator side of owner-approved launches: queue a launch intent and see whether repo.ing
// approvals are online. Queuing prepares and signs nothing; transactions start only after the
// owner invites this exact coin.
import { z } from 'zod'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { ownerApprovalStore } from '../../src/hooklab-owner-approval.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { assertSameOrigin } from './auth.mjs'
import { walletIdentityConfiguration,walletIdentitySessionToken,walletIdentityQuota } from './hooklab-wallet-identity.mjs'
const uuid=z.uuid(),text=max=>z.string().refine(x=>Buffer.byteLength(x)<=max)
const inputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),requestId:uuid,name:text(32).min(1),symbol:text(10).min(1),uri:text(200)}).strict(),
 z.object({action:z.literal('get')}).strict(),
 z.object({action:z.literal('cancel'),requestId:uuid}).strict(),
])
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'}})
const enabled=env=>env.HOOK_OWNER_APPROVED_LAUNCHES==='true'&&env.HOOK_WALLET_IDENTITY_ENABLED==='true'
export function createLaunchRequestsHandler({env=process.env,configuration=walletIdentityConfiguration,database=createHookLabDatabasePool,
 store=ownerApprovalStore,principalStore=walletPrincipalStore,quota=walletIdentityQuota}={}){
 return async request=>{
  if(!enabled(env))return reply({status:'blocked',online:false,error:'Launch requests are not open yet.'})
  let pool
  try{
   const config=configuration(env);pool=database(config)
   const approvals=store(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS})
   if(request.method==='GET'){
    if(new URL(request.url).search)return reply({error:'Query parameters unavailable.'},400)
    return reply({status:'available',...await approvals.availability()})
   }
   if(request.method!=='POST')return reply({error:'Method unavailable.'},405)
   try{assertSameOrigin(request,config.origin);if(new URL(request.url).origin!==config.origin||request.headers.get('sec-fetch-site')==='cross-site')throw Error()}catch{return reply({error:'Open the configured launcher origin.'},403)}
   if(new URL(request.url).search)return reply({error:'Query parameters unavailable.'},400)
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply({error:'JSON required.'},415)
   const token=walletIdentitySessionToken(request);if(!token)return reply({error:'Sign in with your wallet first.'},401)
   let input;try{input=inputSchema.parse(JSON.parse((await readLimitedBody(request,2048)).toString('utf8')))}catch{return reply({error:'Invalid launch request.'},400)}
   if(!await quota(pool,[[`launch-request:${input.action==='get'?'observe':'action'}:${clientAddress(request)??'unknown'}`,input.action==='get'?120:10]]))return reply({error:'Too many requests. Try again later.'},429)
   const owner=await principalStore(pool,{enabled:true,origin:config.origin,audience:config.audience,genesisHash:config.genesisHash}).resolve(token)
   let launchRequest
   if(input.action==='create')launchRequest=await approvals.createRequest(owner.wallet,{id:input.requestId,name:input.name,symbol:input.symbol,uri:input.uri})
   else if(input.action==='cancel')launchRequest=await approvals.cancelRequest(owner.wallet,input.requestId)
   else launchRequest=await approvals.requestFor(owner.wallet)
   return reply({status:'available',request:launchRequest,...await approvals.availability()})
  }catch(error){
   if(error?.status===401)return reply({error:'Wallet session expired. Sign in again.'},401)
   return reply({error:error?.code==='OWNER_APPROVAL_UNAVAILABLE'?error.message:'Launch requests unavailable.'},409)
  }finally{await pool?.end().catch(()=>{})}
 }
}
