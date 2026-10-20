// Server-only operational approval + exact-pins preparation resolver. No defaults.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BorshCoder } from '@anchor-lang/core'
import { validateMaxWalletOperatorBindings } from './hooklab-max-wallet-launch-collector.mjs'
import { collectMaxWalletPreparationReview } from './hooklab-max-wallet-preparation-collector.mjs'
import { collectInclusiveMaxWalletPreparationReview } from './hooklab-inclusive-max-wallet-preparation-collector.mjs'
import { readProductionEvidence } from './hooklab-production-rpc.mjs'
import { coLocatedWalletPreparationJournal } from './hooklab-wallet-preparation.mjs'
import { parseMaxWalletPreparationRequest } from './hooklab-inclusive-max-wallet-profile.mjs'
import { launchSettingsChanged,passRefusal } from './hooklab-open-creation.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex')
const fail=()=>Object.assign(Error('Max-wallet preparation unavailable or changed'),{code:'MAX_WALLET_PREPARATION_UNAVAILABLE'})
const check=value=>{if(!value)throw fail()}
// open: the creator fee is the creator's choice from the chain's menu (the open compiler checks it there), so only the
// rest of the economics is held to the operator's approved values.
export function coLocatedMaxWalletPreparationResolver(pool,{origin,config,profile,dossierJson,connections,custody,clock=Date.now,open=false}){
 const retained=JSON.parse(JSON.stringify({config,profile,dossierJson})),providers=connections.map(x=>({provider:x.provider,connection:x.connection}))
 const {config:c,profile:p,dossier:d}=validateMaxWalletOperatorBindings({...retained,connections:providers})
 check(c.lamportsPerSignature==='5000'&&custody&&typeof custody.get==='function')
 const preparationProfile={json:retained.profile.json,expectedSha256:c.profileSha256,providers:retained.profile.providers,
  idls:{launch:retained.profile.idls.launch,gate:retained.profile.idls.gate},elfLengths:{launch:retained.profile.elfLengths.launch,gate:retained.profile.elfLengths.gate}}
 const journal=coLocatedWalletPreparationJournal(pool,{enabled:c.enabled,origin,providers,expectedProfileSha256:c.profileSha256})
 return Object.freeze({
  async resolve({sessionToken,custodyOperationId,limits,expectedReview}){
   try{
    const bound=await custody.get(sessionToken,custodyOperationId)
    check(bound.profileSha256===c.profileSha256&&['preparation-reviewed','preparation-signed'].includes(bound.stage))
    const request=parseMaxWalletPreparationRequest(bound.preparedRequest)
    check(request.creator===bound.owner&&request.feePayer===bound.owner&&request.mint===bound.mint&&request.selectedConfig===bound.selectedConfig)
    const evidence=await readProductionEvidence({dossierJson:retained.dossierJson,expectedSha256:c.dossierSha256,providers,now:clock,timeoutMs:5000,idls:retained.profile.idls})
    // The launch settings moved since the bundle was collected: say so plainly (setup reviews bind them too).
    if(evidence.accountBindingsMatched!==true)throw launchSettingsChanged()
    const map=new Map(evidence.observations[0].accounts.map(x=>[x.address,x]))
    const decode=(role)=>{
     const address=d.accounts.find(x=>x.role===`${role}-config`)?.address;check(address&&map.has(address))
     return new BorshCoder(JSON.parse(Buffer.from(retained.profile.idls[role],'base64'))).accounts.decode('Config',Buffer.from(map.get(address).dataBase64,'base64'))
    }
    const lc=decode('launch'),sc=decode('swap')
    check(lc.admin.toBase58()===c.reviewer&&lc.treasury.toBase58()===c.treasury&&sc.treasury.toBase58()===c.treasury)
    check(isDeepStrictEqual(open?{...c.economics,creatorFeeBps:request.creatorFeeBps}:c.economics,{creatorFeeBps:request.creatorFeeBps,authorShareBps:0,lpFeeBps:lc.lp_fee_bps,maxCreatorFeeBps:lc.max_creator_fee_bps,
     protocolFeeBps:sc.protocol_fee_bps,launchProtocolShareBps:sc.launch_protocol_share_bps,launchFeeLamports:lc.launch_fee_lamports.toString(),poolCreationFeeLamports:sc.pool_creation_fee_lamports.toString()}))
    const collected=await (request.policyVersion===2?collectInclusiveMaxWalletPreparationReview:collectMaxWalletPreparationReview)({profile:preparationProfile,request,connections:providers,limits,expectedReview,clock})
    const after=await custody.get(sessionToken,custodyOperationId)
    check(isDeepStrictEqual(after,bound)&&clock()<collected.plan.review.reviewExpiresAtMs)
    return Object.freeze({status:'operator-pins-and-state-verified',owner:bound.owner,stage:'preparation',request,
     configurationSha256:sha(JSON.stringify(c)),profileSha256:c.profileSha256,messageSha256:collected.plan.review.messageSha256,review:collected.plan.review,
     settlementContext:{schema:'repoing/max-wallet-preparation-settlement-context/1',preparationInput:collected.preparationInput},
     approvalReference:c.approvalReference,collection:collected.collection,canSign:false,canSubmit:false})
   }catch(error){passRefusal(error,fail)}
  },
  async reconcile({sessionToken,custodyOperationId,review,signedTransactionBase64,signature,settlementContext,configurationSha256}){
   try{
    check(configurationSha256===sha(JSON.stringify(c))&&settlementContext?.schema==='repoing/max-wallet-preparation-settlement-context/1')
    const result=await journal.collectAndRetain(sessionToken,custodyOperationId,{preparationInput:settlementContext.preparationInput,signedTransactionBase64})
    check(result.signature===signature&&result.messageSha256===review.messageSha256&&result.profileSha256===review.profileSha256)
    const identity={signature,messageSha256:review.messageSha256,profileSha256:review.profileSha256,preparationId:custodyOperationId}
    if(result.evidenceConflict)return {status:'conflict',...identity}
    if(result.status==='finalized-failure')return {status:'finalized-failure',...identity}
    if(result.status!=='candidate-preparation-matched')return {status:'unresolved',...identity}
    const resolved=await journal.resolveForLaunch(sessionToken,custodyOperationId)
    return {status:'finalized-success',...identity,executionSlot:resolved.executionSlot,preparedAccountHashes:resolved.preparedAccountHashes}
   }catch{throw fail()}
  },
 })
}
