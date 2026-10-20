// Candidate-only new-mint preparation orchestration. No signing or public route.
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseMaxWalletPreparationRequest,parseMaxWalletProfile,isInclusiveMaxWalletProfile } from './hooklab-inclusive-max-wallet-profile.mjs'
import { collectMaxWalletPreparationReview } from './hooklab-max-wallet-preparation-collector.mjs'
import { collectInclusiveMaxWalletPreparationReview } from './hooklab-inclusive-max-wallet-preparation-collector.mjs'
import { isApprovedLaunchChoice } from './hooklab-launch-menus.mjs'
import { selectedHookSchema } from './hooklab-selected-hook.mjs'
import { selectedHookPreparationRequestSchema } from './hooklab-selected-hook-preparation.mjs'
import { collectSelectedHookPreparationReview } from './hooklab-selected-hook-preparation-collector.mjs'
const inputSchema=z.object({operationId:z.uuid(),capBps:z.number().int().min(1).max(9999),label:z.string().min(1).refine(x=>Buffer.byteLength(x)<=32),creatorFeeBps:z.number().int().min(0).max(9999).optional()}).strict()
const identity=record=>({operationId:record.operationId,custodySessionId:record.custodySessionId,owner:record.owner,profileSha256:record.profileSha256,mint:record.mint,selectedConfig:record.selectedConfig,stage:record.stage,revision:record.revision})
export async function reviewNewMintPreparationCandidate({custody,sessionToken,input,profile,connections,limits,clock}){
 const {operationId,capBps,label,creatorFeeBps}=inputSchema.parse(input)
 const parsedProfile=parseMaxWalletProfile(JSON.parse(profile.json)),inclusive=isInclusiveMaxWalletProfile(parsedProfile)
 if(inclusive&&(creatorFeeBps===undefined||!isApprovedLaunchChoice(parsedProfile,{creatorFeeBps,capBps})))throw Error('Explicit approved creator fee and wallet cap required')
 if(!inclusive&&creatorFeeBps!==undefined&&creatorFeeBps!==0)throw Error('Unsupported creator fee')
 const reserved=await custody.reserveNewCandidate(sessionToken,operationId,profile.expectedSha256)
 if(!['reserved','preparation-reviewed'].includes(reserved.stage))throw Error('Existing mint requires reconciliation; replacement preparation refused')
 const request=parseMaxWalletPreparationRequest({schema:inclusive?'repoing/inclusive-max-wallet-preparation-request/1':'repoing/max-wallet-preparation-request/1',policyKind:'max-wallet',policyVersion:inclusive?2:1,
  creator:reserved.owner,feePayer:reserved.owner,mint:reserved.mint,selectedConfig:reserved.selectedConfig,capBps,label,creatorFeeBps:inclusive?creatorFeeBps:0,rules:'none',hookFlags:1,...(inclusive?{feeModel:2,protocolShareBps:2500}:{})})
 if(reserved.preparedRequest&&!isDeepStrictEqual(reserved.preparedRequest,request))throw Error('Preparation intent is immutable; retained mint cannot be repurposed')
 const collected=await (request.policyVersion===2?collectInclusiveMaxWalletPreparationReview:collectMaxWalletPreparationReview)({profile,request,connections,limits,clock})
 const after=await custody.get(sessionToken,operationId)
 if(!isDeepStrictEqual(identity(after),identity(reserved)))throw Error('Preparation custody identity changed during review')
 const evidenceSha256=createHash('sha256').update(JSON.stringify({request,review:collected.plan.review,collection:collected.collection})).digest('hex')
 const retained=await custody.retainPreparationReview(sessionToken,operationId,{expectedRevision:reserved.revision,request,evidenceSha256})
 return Object.freeze({schema:'repoing/new-mint-preparation-candidate/1',status:'candidate-review-only',custody:retained,request,
  candidateReview:collected.plan.review,collection:collected.collection,
  blockers:['OWNER_CUSTODY_APPROVAL_REQUIRED','OPERATOR_DEPLOYMENT_APPROVAL_REQUIRED','PRODUCTION_PREPARATION_AUTHORIZATION_REQUIRED'],
  productionUnsignedMessage:null,canSign:false,canSubmit:false,executionAuthorized:false})
}

const selectedInputSchema=inputSchema.omit({capBps:true,creatorFeeBps:true}).extend({selectedHook:selectedHookSchema,creatorFeeBps:z.number().int().min(0).max(9999)}).strict()
// Config-only candidate. Bind intent before the hook-specific registry handoff so a missing
// registry or lost response cannot issue a new mint or silently change the selected hook.
// This does not open the production runtime's SELECTED_HOOK_REVIEW_UNAVAILABLE boundary.
export async function reviewNewMintSelectedHookPreparationCandidate({custody,sessionToken,input,profile,hookPin,connections,limits,clock}){
 const {operationId,selectedHook,label,creatorFeeBps}=selectedInputSchema.parse(input)
 const reserved=await custody.reserveNewCandidate(sessionToken,operationId,profile.expectedSha256)
 if(!['reserved','preparation-reviewed'].includes(reserved.stage))throw Error('Existing mint requires reconciliation; replacement preparation refused')
 const request=selectedHookPreparationRequestSchema.parse({schema:'repoing/selected-hook-preparation-request/1',policyKind:'selected-hook',policyVersion:2,
  creator:reserved.owner,feePayer:reserved.owner,mint:reserved.mint,selectedConfig:reserved.selectedConfig,capBps:0,label,creatorFeeBps,rules:'none',
  hookFlags:selectedHook.flags,selectedHook,feeModel:2,protocolShareBps:2500})
 if(reserved.preparedRequest&&!isDeepStrictEqual(reserved.preparedRequest,request))throw Error('Preparation intent is immutable; retained mint cannot be repurposed')
 const bound=reserved.stage==='reserved'?await custody.retainPreparationIntent(sessionToken,operationId,{expectedRevision:reserved.revision,request}):reserved
 const collected=await collectSelectedHookPreparationReview({profile,hookPin,request,connections,limits,clock})
 if(!isDeepStrictEqual(identity(await custody.get(sessionToken,operationId)),identity(bound)))throw Error('Preparation custody identity changed during review')
 const evidenceSha256=createHash('sha256').update(JSON.stringify({request,review:collected.plan.review,collection:collected.collection})).digest('hex')
 const retained=await custody.retainPreparationReview(sessionToken,operationId,{expectedRevision:bound.revision,request,evidenceSha256})
 return Object.freeze({schema:'repoing/new-mint-selected-hook-preparation-candidate/1',status:'candidate-review-only',custody:retained,request,
  candidateReview:collected.plan.review,preparationInput:collected.preparationInput,selectedHook:collected.plan.selectedHook,collection:collected.collection,
  blockers:['SELECTED_HOOK_REVIEW_UNAVAILABLE'],productionUnsignedMessage:null,canSign:false,canSubmit:false,executionAuthorized:false})
}
