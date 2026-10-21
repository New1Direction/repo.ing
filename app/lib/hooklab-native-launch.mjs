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
import { servedFromConfiguredOrigin } from './hooklab-origin.mjs'
import { usdLaunchPricingEnabled } from '../../src/hooklab-launch-pricing.mjs'
import { openLaunchesEnabled } from '../../src/hooklab-open-creation.mjs'
import { launchPriceAtInvite } from './hooklab-launch-price.mjs'
import { selectedHookSchema, refuseUnsupportedSelectedHook } from '../../src/hooklab-selected-hook.mjs'
import { hookPublicationSelectionSchema } from '../../src/hooklab-hook-catalog.mjs'
import { selectedHookPreparationRequestSchema as preparationSchema } from '../../src/hooklab-selected-hook-preparation.mjs'
import { selectedHookEconomics } from './hooklab-native-launch-form.mjs'
import { isOpenCreatorFeeChoice } from '../../src/hooklab-launch-menus.mjs'
const uuid=z.uuid(),text=max=>z.string().refine(x=>Buffer.byteLength(x)<=max)
const inputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('reserve'),operationId:uuid,capBps:z.number().int().min(0).max(9999),selectedHook:selectedHookSchema.optional(),hookPublication:hookPublicationSelectionSchema.optional(),quoteCut:preparationSchema.shape.quoteCut,authorShareBps:preparationSchema.shape.authorShareBps,rules:preparationSchema.shape.rules.optional(),label:text(32).min(1),name:text(32).min(1),symbol:text(10).min(1),uri:text(200),virtualQuote:z.string().regex(/^(0|[1-9][0-9]*)$/).max(20),creatorFeeBps:z.number().int().min(0).max(9999)}).strict().refine(x=>x.selectedHook?x.capBps===0:x.capBps>0&&x.quoteCut===undefined&&x.authorShareBps===undefined&&x.rules===undefined,'Selected hooks cannot claim a max-wallet cap'),
 z.object({action:z.literal('review'),operationId:uuid,signingId:uuid,stage:z.enum(['hook-setup','preparation','launch'])}).strict(),
 z.object({action:z.enum(['get','refresh-review','wallet-request','cosign','submit','reconcile','expire']),signingId:uuid}).strict(),
 z.object({action:z.literal('retain-wallet'),signingId:uuid,signedTransactionBase64:z.string().max(1644)}).strict(),
])
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'}})
// A self-serve creator's view of an operation: what the guided step needs (status, stage, signers, deadlines, the exact
// message hash), without the transaction's account list or the settlement's account detail. The stack's internal
// accounts (its quote marker among them) never reach the browser as data; the wallet still shows the transaction itself.
export function customerOperation(operation){
 if(!operation)return operation
 const {accounts,lookupTables,...review}=operation.review??{},{settlement,...rest}=operation
 return {...rest,review,...(settlement&&{settlement:{executionStatus:settlement.executionStatus??null}})}
}
const customerWalletRequest=value=>{if(!value?.review)return value;const {accounts,lookupTables,...review}=value.review;return {...value,review}}
// launchPrice: the SOL price and opening virtual quote fixed when an open launch is reserved (two agreeing sources; refused,
// never clamped, outside the bounds).
export function createNativeLaunchHandler({env=process.env,configuration=walletIdentityConfiguration,runtime=nativeLaunchRuntime,
 database=createHookLabDatabasePool,principalStore=walletPrincipalStore,quota=walletIdentityQuota,ownerApprovals=ownerApprovalStore,launchPrice=launchPriceAtInvite}={}){
 return async request=>{
  if(env.HOOK_NATIVE_LAUNCH_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')return reply({status:'blocked',blockers:[{code:'NATIVE_LAUNCH_DISABLED',message:'The native launcher is not enabled.'}]})
  let pool
  try{
   const config=configuration(env)
   if(request.method!=='POST')return reply({error:'Method unavailable.'},405)
   try{assertSameOrigin(request,config.origin);if(!servedFromConfiguredOrigin(request,config.origin)||request.headers.get('sec-fetch-site')==='cross-site')throw Error()}catch{return reply({error:'Open the configured launcher origin.'},403)}
   if(new URL(request.url).search)return reply({error:'Query parameters unavailable.'},400)
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply({error:'JSON required.'},415)
   const token=walletIdentitySessionToken(request);if(!token)return reply({error:'Sign in with your wallet first.'},401)
   let input;try{input=inputSchema.parse(JSON.parse((await readLimitedBody(request,65536)).toString('utf8')))}catch{return reply({error:'Invalid launcher request.'},400)}
   pool=database(config)
   const observing=input.action==='get'||input.action==='reconcile'
   if(!await quota(pool,[[`native-launch:${observing?'observe':'action'}:${clientAddress(request)??'unknown'}`,observing?120:30]]))return reply({error:'Too many requests. Try again later.'},429)
   const principal=principalStore(pool,{enabled:true,origin:config.origin,audience:config.audience,genesisHash:config.genesisHash}),owner=await principal.resolve(token)
   const service=runtime()
   if(!service)return reply({status:'blocked',blockers:[{code:'APPROVED_RUNTIME_UNCONFIGURED',message:'Owner-approved custody, exact deployment and fee settings are not configured.'}]})
   const lifecycle=service.lifecycle
   // Do not bind an approval, allocate custody or silently replace the selected hook with the gate.
   // Current production pins do not attest the repaired nongate instruction.
   if(input.action==='reserve'&&input.selectedHook&&!service.selectedHooksEnabled)refuseUnsupportedSelectedHook()
   let result
   if(input.action==='reserve'&&openLaunchesEnabled(env)){
    // Open launch: the creator's own coin at the price repo.ing fixes now, if the chain offers the chosen fee and cap.
    // No invite and no owner: the server binds the creator's recorded coin and stores the price with it.
    if(!service.openLaunches)throw Error()
    const chain=await service.openCreation()
    if(!chain.native||!chain.open||chain.paused)return reply({status:'paused',error:'Launches are paused right now. Your SOL was not spent; try again later.'},409)
    if(!isOpenCreatorFeeChoice(input,chain)||(input.selectedHook?input.capBps!==0:!chain.capBps.includes(input.capBps)))return reply({error:'That creator fee or max per wallet is no longer offered. Review the current chain limits.'},409)
    let pricing
    try{pricing=await launchPrice()}catch(error){return reply({error:error?.code==='LAUNCH_PRICE_REFUSED'?error.message:'The SOL price is unavailable right now. Try again in a minute.'},409)}
    if(BigInt(pricing.virtualQuote)<BigInt(chain.minVirtualQuote)||BigInt(pricing.virtualQuote)>BigInt(chain.maxVirtualQuote))return reply({error:'At today\'s SOL price the opening price is outside what the launch program accepts. Try again later.'},409)
    const approvals=ownerApprovals(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS,usdPricing:true,openLaunches:true,selectedHooksEnabled:service.selectedHooksEnabled===true}),db=await pool.connect()
    try{await db.query('begin');const bound=await approvals.bindOpenLaunch(db,owner.wallet,input.operationId,{name:input.name,symbol:input.symbol,uri:input.uri,creatorFeeBps:input.creatorFeeBps,capBps:input.capBps,...(input.selectedHook?{selectedHook:input.selectedHook,hookPublication:input.hookPublication,...selectedHookEconomics(input)}:{}),virtualQuote:pricing.virtualQuote,pricing});pricing=bound?.pricing??pricing;await db.query('commit')}
    catch(error){await db.query('rollback').catch(()=>{});return reply({error:error?.code==='OWNER_APPROVAL_UNAVAILABLE'?error.message:'Create your coin first.'},409)}
    finally{db.release()}
    const reserved=await service.reserve({sessionToken:token,owner:owner.wallet,input:{...input,virtualQuote:pricing.virtualQuote}})
    if(reserved.owner!==owner.wallet||reserved.operationId!==input.operationId)throw Error()
    result={operationId:reserved.operationId,mint:reserved.mint,selectedConfig:reserved.selectedConfig,request:reserved.request,...(reserved.hookSetupRequest?{hookSetupRequest:reserved.hookSetupRequest}:{}),pricing}
   }else if(input.action==='reserve'){
    if(env.HOOK_OWNER_APPROVED_LAUNCHES==='true'){
     // Owner-approved release: prepare only the exact coin the owner invited for this wallet.
     // The opening price is bound too: reserve compiles exactly input.virtualQuote into the launch.
     const approvals=ownerApprovals(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS,usdPricing:usdLaunchPricingEnabled(env)}),db=await pool.connect()
     try{await db.query('begin');await approvals.bindLaunch(db,owner.wallet,input.operationId,{name:input.name,symbol:input.symbol,uri:input.uri,creatorFeeBps:input.creatorFeeBps,capBps:input.capBps,virtualQuote:input.virtualQuote});await db.query('commit')}
     catch(error){await db.query('rollback').catch(()=>{});return reply({status:'awaiting-owner',error:error?.code==='OWNER_APPROVAL_UNAVAILABLE'?error.message:'Wait for repo.ing to invite your launch request.'},409)}
     finally{db.release()}
    }
    const reserved=await service.reserve({sessionToken:token,owner:owner.wallet,input})
    if(reserved.owner!==owner.wallet||reserved.operationId!==input.operationId)throw Error()
    result={operationId:reserved.operationId,mint:reserved.mint,selectedConfig:reserved.selectedConfig,request:reserved.request,...(reserved.hookSetupRequest?{hookSetupRequest:reserved.hookSetupRequest}:{})}
   }else if(input.action==='wallet-request'){result=await lifecycle.walletRequest(token,input.signingId);if(openLaunchesEnabled(env))result=customerWalletRequest(result)}
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
     // A finalized launch matched the recorded coin exactly (name, symbol, uri, fee, cap and price): it is listed.
     if((env.HOOK_OWNER_APPROVED_LAUNCHES==='true'||openLaunchesEnabled(env))&&operation?.stage==='launch'&&operation?.status==='finalized-success')
      await ownerApprovals(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS,openLaunches:openLaunchesEnabled(env)}).markLaunched(operation.custodyOperationId)
    }
    result={operation:openLaunchesEnabled(env)?customerOperation(publicNativeOperation(operation)):publicNativeOperation(operation)}
   }
   // Durable signatures/outcomes remain retained even if this response loses auth.
   if((await principal.resolve(token)).wallet!==owner.wallet)throw Error()
   return reply({status:'available',...result})
  }catch(error){
   if(error?.code==='SELECTED_HOOK_REGISTRY_REQUIRED')return reply({status:'blocked',mint:error.mint,selectedConfig:error.selectedConfig,blockers:[{code:error.code,message:error.message}]},409)
   if(error?.code==='SELECTED_HOOK_REVIEW_UNAVAILABLE')return reply({status:'blocked',blockers:[{code:error.code,message:error.message}]},409)
   // Owner-approval messages are fixed, customer-facing and secret-free (e.g. the owner is still preparing the launch table).
   const message=error.status===401?'Wallet session expired. Sign in again.':error?.code==='OWNER_APPROVAL_UNAVAILABLE'?error.message:'Launcher unavailable or changed. Preserve the operation IDs and reconcile any pending transaction.'
   return reply({error:message},error.status===401?401:409)}
  finally{await pool?.end().catch(()=>{})}
 }
}
