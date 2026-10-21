// Trusted server adapter only. Use with the signing coordinator's SAME transaction.
// Lock custody before wallet-session row. No key discovery or public secret API.
import { createHash,createPrivateKey,sign } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseMaxWalletLaunchRequest, launchPreparationRequest } from './hooklab-max-wallet-launch.mjs'
import { parseMaxWalletPreparationRequest } from './hooklab-inclusive-max-wallet-profile.mjs'
import { selectedHookPreparationRequestSchema } from './hooklab-selected-hook-preparation.mjs'
import { selectedHookSetupRequestSchema } from './hooklab-selected-hook-setup.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { nativeSignerCustodyCodec,verifyNativeAdminSignerIdentity } from './hooklab-native-signer-custody.mjs'
const fail=()=>Object.assign(Error('Native custody signing unavailable or changed'),{code:'NATIVE_CUSTODY_SIGNING_UNAVAILABLE'})
const check=value=>{if(!value)throw fail()}
const sha=value=>createHash('sha256').update(value).digest('hex')
const identity=row=>({schema:'repoing/native-signer-custody/1',operationId:row.operation_id,custodySessionId:row.custody_session_id,
 owner:row.owner_wallet,profileSha256:row.profile_sha256,mint:row.mint,selectedConfig:row.selected_config,stage:row.stage})
const wipe=keys=>{keys?.mint?.secretKey?.fill(0);keys?.selectedConfig?.secretKey?.fill(0)}
const preparation=request=>request?.policyKind==='selected-hook'?selectedHookPreparationRequestSchema.parse(request):parseMaxWalletPreparationRequest(request)
// openLaunches: the launch stage signs create_launch_open_v1 (creator and mint only; no admin co-signature).
export function nativeCustodySigningAdapter({enabled=false,keyRing,activeKeyId,adminSigner=null,openLaunches=false}={}){
 const codec=nativeSignerCustodyCodec({enabled,keyRing,activeKeyId}),locked=new WeakMap()
 function record(db,operationId,owner){const row=locked.get(db);check(enabled===true&&row?.operation_id===operationId&&row.owner_wallet===owner);return row}
 async function setupIdentity(db,row,request,review){
  const {rows:[bound]}=await db.query('select * from hook_lab_selected_hook_setup_intents where custody_operation_id=$1',[row.operation_id])
  check(bound&&bound.owner_wallet===row.owner_wallet&&bound.profile_sha256===row.profile_sha256&&bound.mint===row.mint&&bound.selected_config===row.selected_config)
  const original=selectedHookSetupRequestSchema.parse(bound.setup_request)
  check(original.creator===row.owner_wallet&&original.mint===row.mint)
  if(request)check(isDeepStrictEqual(original,selectedHookSetupRequestSchema.parse(request)))
  if(review)check(review.operation==='selected-hook-setup'&&review.intentSha256===sha(JSON.stringify(original))&&review.profileSha256===row.profile_sha256&&review.wallet===row.owner_wallet&&review.payer===row.owner_wallet&&isDeepStrictEqual(review.requiredSigners,[row.owner_wallet]))
  return original
 }
 async function transition(db,row,stage){
  const keys=codec.open(identity(row),row.sealed_signers)
  let sealed;try{sealed=codec.seal({...identity(row),stage},keys)}finally{wipe(keys)}
  const {rows:[saved]}=await db.query('update hook_lab_native_signer_custody set stage=$2,sealed_signers=$3,revision=revision+1,updated_at=clock_timestamp() where operation_id=$1 returning *',[row.operation_id,stage,sealed])
  check(saved);locked.set(db,saved);return saved
 }
 return Object.freeze({
  async lock(db,operationId){
   try{check(enabled===true);const {rows:[row]}=await db.query('select * from hook_lab_native_signer_custody where operation_id=$1 for update',[operationId]);check(row);locked.set(db,row);return {owner:row.owner_wallet,profileSha256:row.profile_sha256}}catch{throw fail()}
  },
  release(db){locked.delete(db)},
  async beginStage({db,owner,custodyOperationId,stage,review,request}){
   try{
    let row=record(db,custodyOperationId,owner)
    if(stage==='hook-setup'){
     check(openLaunches&&['reserved','preparation-reviewed'].includes(row.stage))
     await setupIdentity(db,row,request,review);return {mint:row.mint,selectedConfig:row.selected_config}
    }
    check(row.profile_sha256===review.profileSha256&&row.preparation_request&&review.wallet===owner&&review.payer===owner)
    if(stage==='preparation'){
     check(row.stage==='preparation-reviewed'&&review.intentSha256===sha(JSON.stringify(preparation(row.preparation_request))))
     if(row.preparation_request.policyKind==='selected-hook'){
      const original=await setupIdentity(db,row)
      check(isDeepStrictEqual(original.selectedHook,row.preparation_request.selectedHook))
      const {rows:[setup]}=await db.query("select status,first_finalized,first_conflict from hook_lab_native_signing_operations where custody_operation_id=$1 and stage='hook-setup' and status<>'expired'",[custodyOperationId])
      check(setup?.status==='finalized-success'&&setup.first_finalized?.status==='finalized-success'&&!setup.first_conflict)
     }
    }
    else {
     check(stage==='launch'&&row.stage==='preparation-finalized')
     const launch=parseMaxWalletLaunchRequest(request)
     const prepared=launchPreparationRequest(launch)
     check(isDeepStrictEqual(prepared,preparation(row.preparation_request))&&review.intentSha256===sha(JSON.stringify(launch)))
     row=await transition(db,row,'launch-reviewed')
    }
    return {mint:row.mint,selectedConfig:row.selected_config}
   }catch{throw fail()}
  },
  async sign({db,owner,custodyOperationId,stage,signerAddress,message,messageSha256,review,observedAdmin}){
   let keys
   try{
    const row=record(db,custodyOperationId,owner);inspectHookLabMessage(review)
    const selected=row.preparation_request?.policyKind==='selected-hook'
    check(!selected||openLaunches)
    check(['preparation','launch'].includes(stage)&&review.operation===(stage==='preparation'?(selected?'selected-hook-preparation':row.preparation_request?.policyVersion===2?'inclusive-max-wallet-preparation':'max-wallet-preparation'):openLaunches?'open-launch':'max-wallet-launch'))
    check(row.profile_sha256===review.profileSha256&&review.wallet===owner&&review.payer===owner
     &&sha(message)===messageSha256&&messageSha256===review.messageSha256&&Buffer.from(message).toString('base64')===review.messageBase64)
    check(row.stage===(stage==='preparation'?'preparation-reviewed':'launch-reviewed'))
    const expected=stage==='preparation'?(selected?[owner,row.selected_config]:[owner,row.mint,row.selected_config]):openLaunches?[owner,row.mint]:[owner,row.mint,adminSigner?.address]
    check(expected.length===new Set(expected).size&&review.requiredSigners.length===expected.length&&expected.every(x=>review.requiredSigners.includes(x)))
    if(stage==='launch'&&!openLaunches){
     verifyNativeAdminSignerIdentity({configuredAdmin:adminSigner?.address,observedAdmin,owner,mint:row.mint,selectedConfig:row.selected_config})
     if(signerAddress===adminSigner.address){check(typeof adminSigner.sign==='function');return Uint8Array.from(await adminSigner.sign(Buffer.from(message),{review,owner,mint:row.mint,selectedConfig:row.selected_config}))}
    }
    check(expected.includes(signerAddress)&&(signerAddress===row.mint||(stage==='preparation'&&signerAddress===row.selected_config)))
    keys=codec.open(identity(row),row.sealed_signers)
    const key=signerAddress===row.mint?keys.mint:keys.selectedConfig,seed=Buffer.from(key.secretKey).subarray(0,32)
    try{return sign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'}))}finally{seed.fill(0)}
   }catch{throw fail()}finally{wipe(keys)}
  },
  // Only after the lifecycle proves on chain that the stage's transaction can never land.
  async reopenStage({db,owner,custodyOperationId,stage}){
   try{const row=record(db,custodyOperationId,owner);if(stage==='hook-setup'){await setupIdentity(db,row);return}check([`${stage}-reviewed`,`${stage}-signed`].includes(row.stage))
    await transition(db,row,stage==='launch'?'preparation-finalized':'reserved')}catch{throw fail()}
  },
  async completeStage({db,owner,custodyOperationId,stage}){
   try{const row=record(db,custodyOperationId,owner);if(stage==='hook-setup'){await setupIdentity(db,row);return}check(row.stage===`${stage}-reviewed`);await transition(db,row,`${stage}-signed`)}catch{throw fail()}
  },
  async settleStage({db,owner,custodyOperationId,stage,status}){
   try{
    const row=record(db,custodyOperationId,owner)
    if(stage==='hook-setup'){await setupIdentity(db,row);check(['finalized-success','finalized-failure','review-required'].includes(status));return}
    check([`${stage}-signed`,`${stage}-finalized`,'reconcile-required'].includes(row.stage))
    const next=status==='finalized-success'?`${stage}-finalized`:'reconcile-required'
    if(row.stage!==next)await transition(db,row,next)
   }catch{throw fail()}
  },
 })
}
