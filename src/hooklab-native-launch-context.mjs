// Durable server-only composition. The browser never supplies resolver evidence.
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { lockWalletPrincipal } from './hooklab-wallet-principal-lock.mjs'
import { parseMaxWalletLaunchRequest, launchPreparationRequest } from './hooklab-max-wallet-launch.mjs'
import { parseMaxWalletPreparationRequest } from './hooklab-inclusive-max-wallet-profile.mjs'
import { selectedHookPreparationRequestSchema } from './hooklab-selected-hook-preparation.mjs'
const check=x=>{if(!x)throw Error('Launch context unavailable or changed')}
export function nativeLaunchContext(pool,{enabled=false,origin,preparationResolver,launchResolver,launchResolverFor,preparationLimits,launchLimits,reviewTiming,clock=Date.now}={}){
 const limits=structuredClone({preparationLimits,launchLimits})
 check(reviewTiming===undefined||typeof reviewTiming==='function')
 check(launchResolverFor===undefined||typeof launchResolverFor==='function')
 async function transaction(token,id,work){
  let db
  try{
   check(enabled===true);z.uuid().parse(id);db=await pool.connect();await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`native-context:${id}`])
   const {rows:[custody]}=await db.query('select * from hook_lab_native_signer_custody where operation_id=$1 for update',[id])
   const principal=await lockWalletPrincipal(db,token,origin);check(custody?.owner_wallet===principal.wallet)
   const {rows:[context]}=await db.query('select * from hook_lab_native_launch_context where custody_operation_id=$1',[id])
   const result=await work(db,custody,context)
   await lockWalletPrincipal(db,token,origin);await db.query('commit');return result
  }catch{try{await db?.query('rollback')}catch{}throw Error('Launch context unavailable or changed')}finally{db?.release()}
 }
 async function get(token,id){return transaction(token,id,async(_db,custody,context)=>{check(context&&context.owner_wallet===custody.owner_wallet);return context})}
 async function resolve(input,expectedReview){
  const c=await get(input.sessionToken,input.custodyOperationId)
  check(input.owner===c.owner_wallet)
  const approved=input.stage==='preparation'?c.preparation_limits:input.stage==='launch'?c.launch_limits:null
  check(approved)
  const activeLaunchResolver=input.stage==='launch'&&launchResolverFor?await launchResolverFor({preparationId:input.custodyOperationId,review:expectedReview}):launchResolver
  // Only unsigned review creation can obtain a new timing lease. Revalidation
  // keeps the issued deadline and slot ceiling; financial limits never change.
  const timing=expectedReview?{nowMs:clock(),validUntilSlot:expectedReview.validUntilSlot,reviewExpiresAtMs:expectedReview.reviewExpiresAtMs}
   :reviewTiming?await reviewTiming({stage:input.stage}):approved
  const activeLimits={...approved,nowMs:timing.nowMs,validUntilSlot:timing.validUntilSlot,reviewExpiresAtMs:timing.reviewExpiresAtMs}
  const result=input.stage==='preparation'?await preparationResolver.resolve({sessionToken:input.sessionToken,custodyOperationId:input.custodyOperationId,limits:activeLimits,expectedReview,expectedSimulation:input.settlementContext?.simulation})
   :await activeLaunchResolver.resolve({sessionToken:input.sessionToken,preparationId:input.custodyOperationId,request:c.launch_request,limits:activeLimits,expectedReview})
  check(result&&isDeepStrictEqual(c,await get(input.sessionToken,input.custodyOperationId)))
  return result
 }
 return Object.freeze({
  async bind(sessionToken,custodyOperationId,request){
   const launch=parseMaxWalletLaunchRequest(request)
   return transaction(sessionToken,custodyOperationId,async(db,custody,current)=>{
    check(launch.creator===custody.owner_wallet&&launch.feePayer===custody.owner_wallet&&launch.mint===custody.mint&&launch.selectedConfig===custody.selected_config)
    const prepared=custody.preparation_request?.policyKind==='selected-hook'?selectedHookPreparationRequestSchema.parse(custody.preparation_request):parseMaxWalletPreparationRequest(custody.preparation_request)
    check(isDeepStrictEqual(launchPreparationRequest(launch),prepared))
    if(current){check(isDeepStrictEqual(current.launch_request,launch));return {operationId:custodyOperationId}}
    check(custody.stage==='preparation-reviewed')
    await db.query('insert into hook_lab_native_launch_context(custody_operation_id,owner_wallet,launch_request,preparation_limits,launch_limits) values($1,$2,$3,$4,$5)',[custodyOperationId,custody.owner_wallet,launch,limits.preparationLimits,limits.launchLimits])
    return {operationId:custodyOperationId}
   })
  },
  prepare:input=>resolve(input),
  revalidate:input=>resolve(input,input.review),
  async reconcile(input){
   const c=await get(input.sessionToken,input.custodyOperationId);check(c.owner_wallet===input.owner)
   const activeLaunchResolver=input.stage==='launch'&&launchResolverFor?await launchResolverFor({preparationId:input.custodyOperationId,review:input.review}):launchResolver
   const result=input.stage==='preparation'?await preparationResolver.reconcile(input)
    :input.stage==='launch'?await activeLaunchResolver.reconcile({...input,preparationId:input.custodyOperationId}):null
   check(result&&isDeepStrictEqual(c,await get(input.sessionToken,input.custodyOperationId)));return result
  },
 })
}
