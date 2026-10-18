// HTTP boundary for candidate UI integration. Production custody/adoption are unset.
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { z } from 'zod'
import { assertSameOrigin } from './auth.mjs'
import { walletIdentityConfiguration,walletIdentitySessionToken,walletIdentityQuota } from './hooklab-wallet-identity.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { hookAddress } from '../../src/hooklab-execution-contract.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { clientAddress } from '../../src/client-address.mjs'
const schema=z.object({operationId:z.uuid(),wallet:hookAddress,capBps:z.number().int().min(1).max(9999),label:z.string().min(1).refine(s=>Buffer.byteLength(s)<=32)}).strict()
const blockers=[{code:'OWNER_CUSTODY_APPROVAL_REQUIRED',message:'Server custody and its encryption-key policy need owner approval before a mint can be reserved.'},
 {code:'OPERATOR_DEPLOYMENT_APPROVAL_REQUIRED',message:'Owner-approved deployment pins and their fresh chain-state verifier are not configured.'}]
const reply=(body,status=200)=>Response.json({...body,productionUnsignedMessage:null,executionAuthorized:false,canSign:false,canSubmit:false},{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'}})
export function createNewMintPreparationHandler({env=process.env,configuration=walletIdentityConfiguration,
 database=createHookLabDatabasePool,
 principalStore=walletPrincipalStore,quota=walletIdentityQuota,candidateReview=null}={}){
 return async request=>{
  if(env.HOOK_WALLET_NEW_MINT_REVIEW_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')return reply({status:'disabled'},404)
  let pool
  try{
   const config=configuration(env)
   if(request.method!=='POST')return reply({error:'Method unavailable.'},405)
   try{assertSameOrigin(request,config.origin);if(new URL(request.url).origin!==config.origin||request.headers.get('sec-fetch-site')==='cross-site')throw Error()}catch{return reply({error:'Open the configured launcher origin.'},403)}
   if(new URL(request.url).search)return reply({error:'Query parameters unavailable.'},400)
   const sessionToken=walletIdentitySessionToken(request);if(!sessionToken)return reply({error:'Sign in with your wallet first.'},401)
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply({error:'JSON required.'},415)
   let input;try{input=schema.parse(JSON.parse((await readLimitedBody(request,2048)).toString('utf8')))}catch{return reply({error:'Invalid preparation request.'},400)}
   pool=database(config)
   if(!await quota(pool,[[`new-mint:${clientAddress(request)??'unknown'}`,10],[`new-mint:wallet:${input.wallet}`,10]]))return reply({error:'Too many reviews. Try again later.'},429)
   const principal=principalStore(pool,{enabled:true,origin:config.origin,audience:config.audience,genesisHash:config.genesisHash}),owner=await principal.resolve(sessionToken)
   if(owner.wallet!==input.wallet)return reply({error:'Connected wallet does not match the signed-in owner.'},403)
   if(candidateReview===null)return reply({status:'blocked',operationId:input.operationId,wallet:owner.wallet,blockers})
   // Explicit server injection for local tests only. The deployed route supplies none.
   // This hook cannot enable execution or return transaction/key bytes through this handler.
   const result=await candidateReview({pool,config,sessionToken,input:{operationId:input.operationId,capBps:input.capBps,label:input.label}})
   if((await principal.resolve(sessionToken)).wallet!==owner.wallet||result.custody?.owner!==owner.wallet||result.custody?.operationId!==input.operationId
    ||result.request?.creator!==owner.wallet||result.request?.feePayer!==owner.wallet||result.request?.mint!==result.custody?.mint
    ||result.request?.selectedConfig!==result.custody?.selectedConfig||result.request?.capBps!==input.capBps||result.request?.label!==input.label)throw Error()
   return reply({status:'candidate-review-only',operationId:input.operationId,wallet:owner.wallet,mint:result.custody.mint,selectedConfig:result.custody.selectedConfig,
    capBps:input.capBps,label:input.label,stage:result.custody.stage,revision:result.custody.revision,blockers,
    review:{messageSha256:result.candidateReview.messageSha256,requiredSigners:result.candidateReview.requiredSigners,
     instructionDebitLamports:result.candidateReview.instructionDebitLamports,maxNativeDebitLamports:result.candidateReview.maxNativeDebitLamports,
     reviewExpiresAtMs:result.candidateReview.reviewExpiresAtMs}})
  }catch(error){return reply({error:error.status===401?'Wallet session expired. Sign in again.':'Preparation unavailable or changed. Preserve the operation ID and mint.'},error.status===401?401:409)}
  finally{if(pool)await pool.end().catch(()=>{})}
 }
}
