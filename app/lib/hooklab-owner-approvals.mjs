// Owner-agent endpoint for owner-approved launches. The owner's Mac authenticates with a bearer
// token whose SHA-256 is configured on the server. The token cannot approve anything by itself:
// every admin signature is verified against the configured admin address before it is stored.
import { createHash,timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { ownerApprovalStore } from '../../src/hooklab-owner-approval.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { walletIdentityConfiguration } from './hooklab-wallet-identity.mjs'
import { usdLaunchPricingEnabled } from '../../src/hooklab-launch-pricing.mjs'
import { launchBoundsAtInvite,launchPriceAtInvite } from './hooklab-launch-price.mjs'
const uuid=z.uuid()
const inputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('heartbeat'),accepting:z.boolean(),agentAddress:z.string().max(44)}).strict(),
 z.object({action:z.literal('invite'),requestId:uuid,inviteSeconds:z.number().int().min(60).max(3600)}).strict(),
 z.object({action:z.literal('decline'),requestId:uuid}).strict(),
 z.object({action:z.literal('sign'),signRequestId:uuid,signatureBase64:z.string().max(100)}).strict(),
 z.object({action:z.literal('decline-sign'),signRequestId:uuid}).strict(),
 z.object({action:z.literal('table'),preparationId:uuid,tableAddress:z.string().min(32).max(44)}).strict(),
 z.object({action:z.literal('decline-table'),preparationId:uuid}).strict(),
])
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})
export function ownerTokenMatches(header,expectedSha256){
 if(!/^[a-f0-9]{64}$/.test(expectedSha256??'')||typeof header!=='string'||!header.startsWith('Bearer '))return false
 const token=header.slice(7);if(token.length<32||token.length>256)return false
 return timingSafeEqual(createHash('sha256').update(token).digest(),Buffer.from(expectedSha256,'hex'))
}
// Fixed, owner-facing and secret-free: store refusals and launch-price refusals (public source prices only).
const ownerFacing=error=>['OWNER_APPROVAL_UNAVAILABLE','LAUNCH_PRICE_REFUSED'].includes(error?.code)
export function createOwnerApprovalsHandler({env=process.env,configuration=walletIdentityConfiguration,database=createHookLabDatabasePool,store=ownerApprovalStore,
 launchPrice=launchPriceAtInvite,launchBounds=()=>launchBoundsAtInvite(env)}={}){
 return async request=>{
  if(env.HOOK_OWNER_APPROVED_LAUNCHES!=='true')return reply({status:'blocked',error:'Owner-approved launches are not enabled.'},503)
  if(request.method!=='POST')return reply({error:'Method unavailable.'},405)
  if(!ownerTokenMatches(request.headers.get('authorization'),env.HOOK_OWNER_APPROVAL_TOKEN_SHA256))return reply({error:'Owner agent authentication required.'},401)
  if(new URL(request.url).search)return reply({error:'Query parameters unavailable.'},400)
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply({error:'JSON required.'},415)
  let input;try{input=inputSchema.parse(JSON.parse((await readLimitedBody(request,4096)).toString('utf8')))}catch{return reply({error:'Invalid owner request.'},400)}
  let pool
  try{
   pool=database(configuration(env))
   const usdPricing=usdLaunchPricingEnabled(env),approvals=store(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS,usdPricing})
   let result
   if(input.action==='heartbeat')result=await approvals.heartbeat({accepting:input.accepting,agentAddress:input.agentAddress})
   // The SOL price and the live on-chain limits are read fresh for each invite, before the invite transaction; the
   // store fixes the price only if the chain would accept its opening quote.
   else if(input.action==='invite'){
    const [price,liveBounds]=usdPricing?await Promise.all([launchPrice(),launchBounds()]):[]
    result={request:await approvals.invite(input.requestId,{inviteMs:input.inviteSeconds*1000,...(usdPricing&&{price,liveBounds})})}
   }
   else if(input.action==='decline')result={request:await approvals.decline(input.requestId)}
   else if(input.action==='sign')result={signRequest:await approvals.submitSignature(input.signRequestId,input.signatureBase64)}
   else if(input.action==='decline-sign')result={signRequest:await approvals.declineSignRequest(input.signRequestId)}
   else if(input.action==='table')result={tableRequest:await approvals.submitTable(input.preparationId,input.tableAddress)}
   else result={tableRequest:await approvals.declineTable(input.preparationId)}
   return reply({status:'ok',...result})
  }catch(error){
   return reply({error:ownerFacing(error)?error.message:'Owner approval unavailable.'},409)
  }finally{await pool?.end().catch(()=>{})}
 }
}
