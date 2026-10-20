// SERVER-ONLY composition. Configuration, connections and database come from the
// application composition root, never a request body. This module does no signing.
import { collectMaxWalletLaunchSettlement, collectOpenLaunchSettlement } from './hooklab-max-wallet-launch-settlement.mjs'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { coLocatedWalletPreparationJournal } from './hooklab-wallet-preparation.mjs'
import { collectMaxWalletLaunchReview, collectOpenLaunchReview, validateMaxWalletOperatorBindings } from './hooklab-max-wallet-launch-collector.mjs'
import { parseMaxWalletLaunchRequest } from './hooklab-max-wallet-launch.mjs'
import { passRefusal } from './hooklab-open-creation.mjs'
const check=(v,m)=>{if(!v)throw Object.assign(Error(m),{code:'MAX_WALLET_LAUNCH_UNAVAILABLE'})}
// open: self-serve launches (create_launch_open_v1, no reviewer). Settlement follows each operation's own context, so a
// launch reviewed before the switch to open launches still settles.
export function coLocatedMaxWalletLaunchResolver(pool,{origin,config,profile,dossierJson,connections,clock=Date.now,nativeLaunches=false,open=false}){
 // Copy immutable JSON configuration so concurrent callers cannot repin an in-flight collection.
 const retained=JSON.parse(JSON.stringify({config,profile,dossierJson}))
 const providers=connections.map(({provider,connection})=>({provider,connection}))
 validateMaxWalletOperatorBindings({...retained,connections:providers})
 const journal=coLocatedWalletPreparationJournal(pool,{enabled:retained.config.enabled,origin,providers,expectedProfileSha256:retained.config.profileSha256})
 return Object.freeze({
  async reconcile({sessionToken,preparationId,settlementContext,review,signedTransactionBase64,signature}){
   try{
    z.uuid().parse(preparationId)
    const prep=await journal.get(sessionToken,preparationId),r=settlementContext.compilationInput.request
    check(prep.wallet===r.creator&&prep.profileSha256===retained.config.profileSha256
     &&prep.preparationIntentSha256===settlementContext.compilationInput.preparationEvidence.preparationIntentSha256
     &&prep.retainedFinalizedEvidence&&!prep.evidenceConflict,'Preparation identity differs')
    const settle=settlementContext?.schema==='repoing/open-launch-settlement-context/1'?collectOpenLaunchSettlement:collectMaxWalletLaunchSettlement
    const result=await settle({...retained,connections:providers,settlementContext,review,signedTransactionBase64,signature})
    const current=await journal.get(sessionToken,preparationId)
    check(current.wallet===prep.wallet&&current.signature===prep.signature&&!current.evidenceConflict,'Preparation changed')
    return result
   }catch{throw Object.assign(Error('Max-wallet launch settlement unavailable or changed'),{code:'MAX_WALLET_LAUNCH_UNAVAILABLE'})}
  },
  async resolve({sessionToken,preparationId,request,limits,expectedReview}){
   try{
   z.uuid().parse(preparationId)
   const r=parseMaxWalletLaunchRequest(request),boundLimits=structuredClone(limits)
   const prep=await journal.resolveForLaunch(sessionToken,preparationId)
   check(prep.wallet===r.creator,'Session wallet does not own preparation')
   check(open===(r.schema==='repoing/open-launch-request/1'),'Launch request kind differs from this server')
   const result=await (open?collectOpenLaunchReview:collectMaxWalletLaunchReview)({...retained,connections:providers,preparation:prep,request:r,limits:boundLimits,expectedReview,clock,nativeLaunches:nativeLaunches===true})
   // Recheck current principal and durable identity after network work. No network
   // work is performed while the principal/database transaction lock is held.
   const final=await journal.get(sessionToken,preparationId)
   check(final.wallet===prep.wallet&&final.profileSha256===prep.profileSha256&&final.signature===prep.signature
    &&final.preparationIntentSha256===prep.preparationIntentSha256&&isDeepStrictEqual(final.preparedRequest,prep.preparedRequest)
    &&!final.evidenceConflict&&final.status==='candidate-preparation-matched'&&final.lastCollectionPrelaunchEligible,'Preparation changed during collection')
   check(clock()<result.plan.review.reviewExpiresAtMs,'Review expired during principal revalidation')
   return Object.freeze({status:'operator-pins-and-state-verified',owner:prep.wallet,stage:'launch',observedAdmin:result.observedAdmin,configurationSha256:result.configurationSha256,settlementContext:result.settlementContext,preparationId,
    preparationSignature:prep.signature,preparationIntentSha256:prep.preparationIntentSha256,request:result.plan.request,
    profileSha256:result.profileSha256,messageSha256:result.plan.review.messageSha256,review:result.plan.review,
    approvalReference:result.approvalReference,collection:result.collection,canSign:false,canSubmit:false,canRetry:false})
   }catch(error){passRefusal(error,()=>Object.assign(Error('Max-wallet launch unavailable or changed'),{code:'MAX_WALLET_LAUNCH_UNAVAILABLE'}))}
  },
 })
}
