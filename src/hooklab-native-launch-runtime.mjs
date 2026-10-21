// Complete server composition, opt-in only. No credentials or endpoint discovery.
import { isApprovedLaunchChoice } from './hooklab-launch-menus.mjs'
import { nativeSignerCustodyStore } from './hooklab-native-signer-custody-store.mjs'
import { nativeCustodySigningAdapter } from './hooklab-native-custody-signing.mjs'
import { nativeSigningLifecycle } from './hooklab-native-signing.mjs'
import { nativeLaunchContext } from './hooklab-native-launch-context.mjs'
import { nativeTransactionSender } from './hooklab-native-transaction-sender.mjs'
import { coLocatedMaxWalletPreparationResolver } from './hooklab-max-wallet-preparation-resolver.mjs'
import { coLocatedMaxWalletLaunchResolver } from './hooklab-max-wallet-launch-resolver.mjs'
import { reviewNewMintPreparationCandidate, reviewNewMintSelectedHookPreparationCandidate } from './hooklab-new-mint-preparation.mjs'
import { parseMaxWalletLaunchRequest } from './hooklab-max-wallet-launch.mjs'
import { isLocalExecutionDossier, localAcceptanceNetwork } from './hooklab-local-acceptance.mjs'
import { validateSelectedHookReleaseBindings,observeReleasedSelectedHookCompatibility } from './hooklab-max-wallet-launch-collector.mjs'
import { readOpenCreation } from './hooklab-open-creation.mjs'
import { refuseUnsupportedSelectedHook } from './hooklab-selected-hook.mjs'
import { isDeepStrictEqual as equal } from 'node:util'
import { z } from 'zod'
import { lockWalletPrincipal } from './hooklab-wallet-principal-lock.mjs'
import { reserveNewMintSelectedHookPreparationIntent } from './hooklab-new-mint-preparation.mjs'
import { resolveHookPublicationSelection, bindSelectedHookSetupIntent, selectedHookSetupResolver } from './hooklab-selected-hook-setup-resolver.mjs'
import { hookCatalogStore, revalidateHookPublication } from './hooklab-hook-catalog.mjs'
import { selectedHookEconomics } from '../app/lib/hooklab-native-launch-form.mjs'
// openLaunches (HOOK_OPEN_LAUNCHES): self-serve launches. Anyone may launch while open creation is on chain; the launch
// is create_launch_open_v1 through the operator's shared launch table, signed by the creator and the sealed mint key, with
// no admin key and no owner approval. Launches reviewed before the switch still settle.
export function createNativeLaunchRuntime(pool,{enabled=false,origin,ownerCustodyApproved=false,operatorDeploymentApproved=false,economicsApproved=false,
 config,profile,dossierJson,connections,keyRing,activeKeyId,adminSigner,expiryObserver,preparationLimits,launchLimits,setupLimits,reviewTiming,launchLookupTable,nativeLaunches=false,openLaunches=false,selectedHooksEnabled=false,clock=Date.now}={}){
 if(enabled!==true||!ownerCustodyApproved||!operatorDeploymentApproved||!economicsApproved)throw Error('Explicit complete release approvals required')
 config=structuredClone(config);profile=structuredClone(profile);preparationLimits=structuredClone(preparationLimits);launchLimits=structuredClone(launchLimits);setupLimits=structuredClone(setupLimits)
 if(selectedHooksEnabled){
  if(!openLaunches||(!config.selectedHookPin&&config.selectedHookRelease?.schema!=='repoing/selected-hook-release/2'))refuseUnsupportedSelectedHook()
  const local=localAcceptanceNetwork()
  if(local){
   if(!isLocalExecutionDossier(JSON.parse(dossierJson))||!connections.every(x=>local.endpoints.includes(x.connection.rpcEndpoint)))refuseUnsupportedSelectedHook()
  }else validateSelectedHookReleaseBindings({config,profile,dossierJson,connections})
 }
 if(openLaunches){if(nativeLaunches!==true||!config.launchLookupTable)throw Error('Open launches need native launches and the shared launch table')}
 else if(!adminSigner||typeof adminSigner.sign!=='function'||adminSigner.address!==config.reviewer)throw Error('Exact approved admin signer required')
 if(JSON.parse(profile.json).buildFeature==='inclusive-fees-candidate'){
  const dossier=JSON.parse(dossierJson)
  if((dossier.schema!=='repoing/production-observation/2'&&!isLocalExecutionDossier(dossier))||!['launch-config','swap-config'].every(role=>dossier.accounts.some(a=>a.role===role&&a.binding==='config-counters-v1')))throw Error('Explicit stable counter bindings required')
 }
 const settings={enabled,origin,keyRing,activeKeyId}
 const observeSelectedHook=selectedHooksEnabled&&config.selectedHookRelease?.schema==='repoing/selected-hook-release/2'
  ?(program,{stage,expectedEvidence}={})=>observeReleasedSelectedHookCompatibility({config,profile,dossierJson,connections,program,stage,expectedEvidence}):undefined
 const custody=nativeSignerCustodyStore(pool,settings)
 // Setup authorization reads public custody identity only. In particular a reload of a
 // reserved setup must not decrypt the mint/config pair merely to discover its identity.
 async function selectedIdentity(sessionToken,id,{optional=false}={}){
  z.uuid().parse(id);let db
  try{
   db=await pool.connect();await db.query('begin')
   const principal=await lockWalletPrincipal(db,sessionToken,origin)
   const {rows:[r]}=await db.query('select operation_id,custody_session_id,owner_wallet,profile_sha256,mint,selected_config,stage,revision,preparation_request,selected_authority_evidence from hook_lab_native_signer_custody where operation_id=$1',[id])
   if((!r&&!optional)||(r&&r.owner_wallet!==principal.wallet))throw Error('Selected custody differs')
   await db.query('commit')
   return r?{operationId:r.operation_id,custodySessionId:r.custody_session_id,owner:r.owner_wallet,profileSha256:r.profile_sha256,mint:r.mint,selectedConfig:r.selected_config,stage:r.stage,revision:String(r.revision),preparedRequest:r.preparation_request??null,selectedAuthorityEvidence:r.selected_authority_evidence??null}:null
  }catch(error){try{await db?.query('rollback')}catch{}throw error}finally{db?.release()}
 }
 const selectedCustody={...custody,get:selectedIdentity,async reserveNewCandidate(token,id,hash){
  const existing=await selectedIdentity(token,id,{optional:true})
  if(existing){if(existing.profileSha256!==hash)throw Error('Selected profile differs');return existing}
  return custody.reserveNewCandidate(token,id,hash)
 }}
 const observeSelectedHookCompatibility=({program,expectedEvidence,stage})=>{
  if(!observeSelectedHook)refuseUnsupportedSelectedHook()
  return observeSelectedHook(program,{stage:stage??(expectedEvidence?'revalidation':'initial'),expectedEvidence})
 }
 const parsedProfile=JSON.parse(profile.json)
 const setupResolver=selectedHookSetupResolver(pool,{enabled:selectedHooksEnabled,releaseVerified:selectedHooksEnabled&&config.selectedHookRelease?.schema==='repoing/selected-hook-release/2',
  requireAuthorityEvidence:config.selectedHookRelease?.schema==='repoing/selected-hook-release/2',
  profile:{programs:parsedProfile.programs,genesisHash:parsedProfile.genesisHash,profileSha256:profile.expectedSha256,envelope:profile},connections,observe:observeSelectedHookCompatibility,authorize:selectedIdentity,clock})
 const ensurePreparation=async({sessionToken,custodyOperationId,request})=>{
  const original=await selectedIdentity(sessionToken,custodyOperationId)
  if(original.stage!=='reserved')return
  const timing=reviewTiming?await reviewTiming({stage:'preparation'}):preparationLimits
  await reviewNewMintSelectedHookPreparationCandidate({custody:selectedCustody,sessionToken,
   input:{operationId:custodyOperationId,selectedHook:request.selectedHook,label:request.label,creatorFeeBps:request.creatorFeeBps,...selectedHookEconomics(request)},
   profile:preparationProfile,hookPin:config.selectedHookPin,observeSelectedHook,connections,
   limits:{...preparationLimits,nowMs:timing.nowMs,validUntilSlot:timing.validUntilSlot,reviewExpiresAtMs:timing.reviewExpiresAtMs},clock})
 }
 const preparationResolver=coLocatedMaxWalletPreparationResolver(pool,{origin,config,profile,dossierJson,connections,custody,observeSelectedHook,clock,open:openLaunches})
 // nativeLaunches (HOOK_NATIVE_LAUNCHES_ENABLED): v4 native-SOL launches compile once launch Config byte 186 is on.
 const launchResolver=coLocatedMaxWalletLaunchResolver(pool,{origin,config,profile,dossierJson,connections,custody,observeSelectedHook,clock,nativeLaunches,open:openLaunches})
 if(launchLookupTable!==undefined&&typeof launchLookupTable!=='function')throw Error('Explicit launch lookup-table provider required')
 // Open launches retain the shared table; selected launches additionally consume
 // the immutable supplemental table from their finalized hook-setup journal.
 const launchResolverFor=launchLookupTable&&!openLaunches?async({preparationId,review})=>coLocatedMaxWalletLaunchResolver(pool,{origin,config:{...config,lookupTable:await launchLookupTable({preparationId,allowCreate:review===undefined})},profile,dossierJson,connections,clock,nativeLaunches}):undefined
 const context=nativeLaunchContext(pool,{enabled,origin,setupResolver,setupLimits,ensurePreparation,preparationResolver,launchResolver,launchResolverFor,preparationLimits,launchLimits,reviewTiming,clock})
 const adapter=nativeCustodySigningAdapter({...settings,adminSigner:openLaunches?null:adminSigner,openLaunches}),sender=nativeTransactionSender({enabled,connections,clock})
 const gatePreparation=JSON.parse(profile.json).buildFeature==='inclusive-fees-candidate'?'inclusive-max-wallet-preparation':'max-wallet-preparation'
 const lifecycle=nativeSigningLifecycle(pool,{enabled,origin,resolver:context,custodyAdapter:adapter,sender,expiryObserver,stageOperations:{'hook-setup':'selected-hook-setup',preparation:selectedHooksEnabled?[gatePreparation,'selected-hook-preparation']:gatePreparation,launch:openLaunches?'open-launch':'max-wallet-launch'},
  ...(openLaunches?{retiredOperations:{launch:['max-wallet-launch']}}:{})})
 const preparationProfile={json:profile.json,expectedSha256:profile.expectedSha256,providers:profile.providers,
  idls:{launch:profile.idls.launch,gate:profile.idls.gate},elfLengths:{launch:profile.elfLengths.launch,gate:profile.elfLengths.gate}}
 const openCreation=async()=>({...await readOpenCreation(connections,JSON.parse(profile.json).programs),selectedHooksEnabled})
 return Object.freeze({ownerCustodyApproved,operatorDeploymentApproved,economicsApproved,lifecycle,openLaunches,selectedHooksEnabled,
  // The chain's open-creation state and menus, from both providers (identical bytes), for the creator's form.
  openCreation,observeSelectedHook,observeSelectedHookCompatibility,
  async reserve({sessionToken,owner,input}){
   if(input.selectedHook&&!selectedHooksEnabled)refuseUnsupportedSelectedHook()
   try{
    // Creator rate is an explicit immutable approved profile/configuration input; an open launch's comes from the chain.
    const reviewedProfile=JSON.parse(profile.json)
    if(openLaunches){const chain=await openCreation();if(!chain.native||!chain.open||chain.paused||!chain.creatorFeeBps.includes(input.creatorFeeBps)||(input.selectedHook?input.capBps!==0:!chain.capBps.includes(input.capBps)))throw Error()}
    else if(reviewedProfile.capability.creatorFeeBpsChoices?!isApprovedLaunchChoice(reviewedProfile,input):input.creatorFeeBps!==config.economics.creatorFeeBps)throw Error()
    let publication
    if(input.selectedHook){
     if(!observeSelectedHook||!setupLimits)throw Error('Explicit selected setup limits and release required')
     const {rows:[coin]}=await pool.query('select * from hook_lab_launch_requests where custody_operation_id=$1',[input.operationId])
     if(!coin||coin.creator_wallet!==owner||coin.status!=='launching'||!equal(coin.selected_hook,input.selectedHook)||!equal(coin.hook_publication,input.hookPublication)||coin.name!==input.name||coin.symbol!==input.symbol||coin.uri!==input.uri||coin.creator_fee_bps!==input.creatorFeeBps||coin.cap_bps!==input.capBps)throw Error('Original creator request differs')
     if(!equal(selectedHookEconomics(coin.selected_economics??{}),selectedHookEconomics(input)))throw Error('Original creator economics differ')
     publication=await resolveHookPublicationSelection({pool,selection:input.hookPublication,selectedHook:input.selectedHook,creator:owner})
     await revalidateHookPublication({store:hookCatalogStore(pool),digest:publication.digest,observe:observeSelectedHookCompatibility})
    }
    const result=await (input.selectedHook?reserveNewMintSelectedHookPreparationIntent:reviewNewMintPreparationCandidate)({custody:input.selectedHook?selectedCustody:custody,sessionToken,
     input:{operationId:input.operationId,...(input.selectedHook?{selectedHook:input.selectedHook,...selectedHookEconomics(input)}:{capBps:input.capBps}),label:input.label,creatorFeeBps:input.creatorFeeBps},
     profile:preparationProfile,hookPin:config.selectedHookPin,observeSelectedHook,connections,limits:input.selectedHook?undefined:{...preparationLimits,...(reviewTiming?await reviewTiming({stage:'preparation'}):{})},clock})
    if(result.custody.owner!==owner)throw Error()
    const setup=input.selectedHook?await bindSelectedHookSetupIntent(pool,{custodyOperationId:input.operationId,owner,profileSha256:profile.expectedSha256,mint:result.custody.mint,selectedConfig:result.custody.selectedConfig,selectedHook:input.selectedHook,hookPublication:publication}):null
    const {schema:_,...prepared}=result.request
    const request=parseMaxWalletLaunchRequest(openLaunches?{...prepared,...(setup?.hookPublication.manifest.postMintHoldings?{postMintSetup:setup.hookPublication}:{}),schema:input.selectedHook?'repoing/selected-hook-launch-request/1':'repoing/open-launch-request/1',name:input.name,symbol:input.symbol,uri:input.uri,virtualQuote:input.virtualQuote}
     :{...result.request,schema:result.request.policyVersion===2?'repoing/inclusive-max-wallet-launch-request/1':'repoing/max-wallet-launch-request/1',reviewer:config.reviewer,
     name:input.name,symbol:input.symbol,uri:input.uri,virtualQuote:input.virtualQuote})
    await context.bind(sessionToken,input.operationId,request)
    return {owner,operationId:input.operationId,mint:result.custody.mint,selectedConfig:result.custody.selectedConfig,request,...(setup?{hookSetupRequest:setup.request,hookPublication:setup.hookPublication}:{})}
   }catch(error){
    throw Error('Mint preparation unavailable or changed; preserve the operation ID')
   }
  },
 })
}
