// Candidate-only new-mint preparation orchestration. No signing or public route.
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseMaxWalletPreparationRequest,parseMaxWalletProfile,isInclusiveMaxWalletProfile,gateBurnRulesSchema } from './hooklab-inclusive-max-wallet-profile.mjs'
import { collectMaxWalletPreparationReview } from './hooklab-max-wallet-preparation-collector.mjs'
import { collectInclusiveMaxWalletPreparationReview } from './hooklab-inclusive-max-wallet-preparation-collector.mjs'
import { isPreparableLaunchChoice } from './hooklab-launch-menus.mjs'
import { selectedHookSchema } from './hooklab-selected-hook.mjs'
import { selectedHookPreparationRequestSchema } from './hooklab-selected-hook-preparation.mjs'
import { collectSelectedHookPreparationReview } from './hooklab-selected-hook-preparation-collector.mjs'
const inputSchema=z.object({operationId:z.uuid(),capBps:z.number().int().min(1).max(9999),label:z.string().min(1).refine(x=>Buffer.byteLength(x)<=32),creatorFeeBps:z.number().int().min(0).max(9999).optional(),
 // An open gate coin's token burn (owner design 2026-10-27); absent is no burn.
 rules:gateBurnRulesSchema.optional()}).strict()
const identity=record=>({operationId:record.operationId,custodySessionId:record.custodySessionId,owner:record.owner,profileSha256:record.profileSha256,mint:record.mint,selectedConfig:record.selectedConfig,stage:record.stage,revision:record.revision})
// openCreation: the chain's open-creation state an open launch was checked against (readOpenCreation); the compiler checks it again.
export async function reviewNewMintPreparationCandidate({custody,sessionToken,input,profile,connections,limits,clock,openCreation=null}){
 const {operationId,capBps,label,creatorFeeBps,rules='none'}=inputSchema.parse(input)
 const parsedProfile=parseMaxWalletProfile(JSON.parse(profile.json)),inclusive=isInclusiveMaxWalletProfile(parsedProfile)
 const chainMenus=openCreation?.open&&openCreation.continuousCreatorFee?{open:true,creatorFeeBps:[]}:null
 if(inclusive&&(creatorFeeBps===undefined||!isPreparableLaunchChoice(parsedProfile,{creatorFeeBps,capBps},chainMenus)))throw Error('Explicit approved creator fee and wallet cap required')
 if(!inclusive&&creatorFeeBps!==undefined&&creatorFeeBps!==0)throw Error('Unsupported creator fee')
 if(!inclusive&&rules!=='none')throw Error('Unsupported token burn')
 const reserved=await custody.reserveNewCandidate(sessionToken,operationId,profile.expectedSha256)
 if(!['reserved','preparation-reviewed'].includes(reserved.stage))throw Error('Existing mint requires reconciliation; replacement preparation refused')
 const request=parseMaxWalletPreparationRequest({schema:inclusive?'repoing/inclusive-max-wallet-preparation-request/1':'repoing/max-wallet-preparation-request/1',policyKind:'max-wallet',policyVersion:inclusive?2:1,
  creator:reserved.owner,feePayer:reserved.owner,mint:reserved.mint,selectedConfig:reserved.selectedConfig,capBps,label,creatorFeeBps:inclusive?creatorFeeBps:0,rules,hookFlags:1,...(inclusive?{feeModel:2,protocolShareBps:2500}:{})})
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

const selectedInputSchema=inputSchema.omit({capBps:true,creatorFeeBps:true}).extend({selectedHook:selectedHookSchema,creatorFeeBps:z.number().int().min(0).max(9999),
 quoteCut:selectedHookPreparationRequestSchema.shape.quoteCut,authorShareBps:selectedHookPreparationRequestSchema.shape.authorShareBps,rules:selectedHookPreparationRequestSchema.shape.rules.optional()}).strict()
// Reservation is deliberately independent of registry/configuration collection. Setup must
// settle before the latter is reachable, but authority and intent are bound before consent.
export async function reserveNewMintSelectedHookPreparationIntent({custody,sessionToken,input,profile,observeSelectedHook}){
 const {operationId,selectedHook,label,creatorFeeBps,quoteCut,authorShareBps,rules}=selectedInputSchema.parse(input)
 const reserved=await custody.reserveNewCandidate(sessionToken,operationId,profile.expectedSha256)
 if(reserved.stage!=='reserved'&&!reserved.preparedRequest)throw Error('Original preparation intent missing')
 const request=selectedHookPreparationRequestSchema.parse({schema:'repoing/selected-hook-preparation-request/1',policyKind:'selected-hook',policyVersion:2,
  creator:reserved.owner,feePayer:reserved.owner,mint:reserved.mint,selectedConfig:reserved.selectedConfig,capBps:0,label,creatorFeeBps,rules:rules??'none',
  ...(quoteCut!==undefined?{quoteCut}:{}),...(authorShareBps!==undefined?{authorShareBps}:{}),
  hookFlags:selectedHook.flags,selectedHook,feeModel:reserved.preparedRequest?.feeModel??1,protocolShareBps:2500})
 if(reserved.preparedRequest&&!isDeepStrictEqual(reserved.preparedRequest,request))throw Error('Preparation intent is immutable; retained mint cannot be repurposed')
 const selectedAuthorityEvidence=reserved.selectedAuthorityEvidence??(observeSelectedHook?await observeSelectedHook(selectedHook.program,{stage:'initial'}):null)
 if(observeSelectedHook&&reserved.preparedRequest&&!reserved.selectedAuthorityEvidence)throw Error('Original selected authority evidence missing')
 if(observeSelectedHook&&reserved.selectedAuthorityEvidence)await observeSelectedHook(selectedHook.program,{stage:'revalidation',expectedEvidence:selectedAuthorityEvidence})
 const bound=reserved.stage==='reserved'?await custody.retainPreparationIntent(sessionToken,operationId,{expectedRevision:reserved.revision,request,selectedAuthorityEvidence}):reserved
 return Object.freeze({custody:bound,request,selectedAuthorityEvidence})
}
export async function reviewNewMintSelectedHookPreparationCandidate({custody,sessionToken,input,profile,hookPin,observeSelectedHook,connections,limits,clock}){
 const {custody:bound,request,selectedAuthorityEvidence}=await reserveNewMintSelectedHookPreparationIntent({custody,sessionToken,input,profile,observeSelectedHook})
 if(!['reserved','preparation-reviewed'].includes(bound.stage))throw Error('Existing mint requires reconciliation; replacement preparation refused')
 const {operationId,selectedHook}=input
 const collected=await collectSelectedHookPreparationReview({profile,hookPin:selectedAuthorityEvidence?.hookPin??hookPin,selectedAuthorityEvidence,request,connections,limits,clock})
 if(observeSelectedHook)await observeSelectedHook(selectedHook.program,{stage:'revalidation',expectedEvidence:selectedAuthorityEvidence})
 if(!isDeepStrictEqual(identity(await custody.get(sessionToken,operationId)),identity(bound)))throw Error('Preparation custody identity changed during review')
 const evidenceSha256=createHash('sha256').update(JSON.stringify({request,review:collected.plan.review,collection:collected.collection})).digest('hex')
 const retained=await custody.retainPreparationReview(sessionToken,operationId,{expectedRevision:bound.revision,request,evidenceSha256})
 return Object.freeze({schema:'repoing/new-mint-selected-hook-preparation-candidate/1',status:'candidate-review-only',custody:retained,request,
  candidateReview:collected.plan.review,preparationInput:collected.preparationInput,selectedAuthorityEvidence,selectedHook:collected.plan.selectedHook,collection:collected.collection,
  blockers:['SELECTED_HOOK_REVIEW_UNAVAILABLE'],productionUnsignedMessage:null,canSign:false,canSubmit:false,executionAuthorized:false})
}
