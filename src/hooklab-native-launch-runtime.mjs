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
import { readOpenCreation } from './hooklab-open-creation.mjs'
import { refuseUnsupportedSelectedHook } from './hooklab-selected-hook.mjs'
// openLaunches (HOOK_OPEN_LAUNCHES): self-serve launches. Anyone may launch while open creation is on chain; the launch
// is create_launch_open_v1 through the operator's shared launch table, signed by the creator and the sealed mint key, with
// no admin key and no owner approval. Launches reviewed before the switch still settle.
export function createNativeLaunchRuntime(pool,{enabled=false,origin,ownerCustodyApproved=false,operatorDeploymentApproved=false,economicsApproved=false,
 config,profile,dossierJson,connections,keyRing,activeKeyId,adminSigner,expiryObserver,preparationLimits,launchLimits,reviewTiming,launchLookupTable,nativeLaunches=false,openLaunches=false,selectedHooksEnabled=false,clock=Date.now}={}){
 if(enabled!==true||!ownerCustodyApproved||!operatorDeploymentApproved||!economicsApproved)throw Error('Explicit complete release approvals required')
 config=structuredClone(config);profile=structuredClone(profile);preparationLimits=structuredClone(preparationLimits);launchLimits=structuredClone(launchLimits)
 // Acceptance is opt-in and loopback-only until the complete selected lifecycle is adopted.
 if(selectedHooksEnabled&&(!localAcceptanceNetwork()||!openLaunches||!config.selectedHookPin))refuseUnsupportedSelectedHook()
 if(openLaunches){if(nativeLaunches!==true||!config.launchLookupTable)throw Error('Open launches need native launches and the shared launch table')}
 else if(!adminSigner||typeof adminSigner.sign!=='function'||adminSigner.address!==config.reviewer)throw Error('Exact approved admin signer required')
 if(JSON.parse(profile.json).buildFeature==='inclusive-fees-candidate'){
  const dossier=JSON.parse(dossierJson)
  if((dossier.schema!=='repoing/production-observation/2'&&!isLocalExecutionDossier(dossier))||!['launch-config','swap-config'].every(role=>dossier.accounts.some(a=>a.role===role&&a.binding==='config-counters-v1')))throw Error('Explicit stable counter bindings required')
 }
 const settings={enabled,origin,keyRing,activeKeyId}
 const custody=nativeSignerCustodyStore(pool,settings)
 const preparationResolver=coLocatedMaxWalletPreparationResolver(pool,{origin,config,profile,dossierJson,connections,custody,clock,open:openLaunches})
 // nativeLaunches (HOOK_NATIVE_LAUNCHES_ENABLED): v4 native-SOL launches compile once launch Config byte 186 is on.
 const launchResolver=coLocatedMaxWalletLaunchResolver(pool,{origin,config,profile,dossierJson,connections,clock,nativeLaunches,open:openLaunches})
 if(launchLookupTable!==undefined&&typeof launchLookupTable!=='function')throw Error('Explicit launch lookup-table provider required')
 // An open launch uses the one shared launch table; there is no per-launch table.
 const launchResolverFor=launchLookupTable&&!openLaunches?async({preparationId,review})=>coLocatedMaxWalletLaunchResolver(pool,{origin,config:{...config,lookupTable:await launchLookupTable({preparationId,allowCreate:review===undefined})},profile,dossierJson,connections,clock,nativeLaunches}):undefined
 const context=nativeLaunchContext(pool,{enabled,origin,preparationResolver,launchResolver,launchResolverFor,preparationLimits,launchLimits,reviewTiming,clock})
 const adapter=nativeCustodySigningAdapter({...settings,adminSigner:openLaunches?null:adminSigner,openLaunches}),sender=nativeTransactionSender({enabled,connections,clock})
 const gatePreparation=JSON.parse(profile.json).buildFeature==='inclusive-fees-candidate'?'inclusive-max-wallet-preparation':'max-wallet-preparation'
 const lifecycle=nativeSigningLifecycle(pool,{enabled,origin,resolver:context,custodyAdapter:adapter,sender,expiryObserver,stageOperations:{preparation:selectedHooksEnabled?[gatePreparation,'selected-hook-preparation']:gatePreparation,launch:openLaunches?'open-launch':'max-wallet-launch'},
  ...(openLaunches?{retiredOperations:{launch:['max-wallet-launch']}}:{})})
 const preparationProfile={json:profile.json,expectedSha256:profile.expectedSha256,providers:profile.providers,
  idls:{launch:profile.idls.launch,gate:profile.idls.gate},elfLengths:{launch:profile.elfLengths.launch,gate:profile.elfLengths.gate}}
 const openCreation=async()=>({...await readOpenCreation(connections,JSON.parse(profile.json).programs),selectedHooksEnabled})
 return Object.freeze({ownerCustodyApproved,operatorDeploymentApproved,economicsApproved,lifecycle,openLaunches,selectedHooksEnabled,
  // The chain's open-creation state and menus, from both providers (identical bytes), for the creator's form.
  openCreation,
  async reserve({sessionToken,owner,input}){
   if(input.selectedHook&&!selectedHooksEnabled)refuseUnsupportedSelectedHook()
   try{
    // Creator rate is an explicit immutable approved profile/configuration input; an open launch's comes from the chain.
    const reviewedProfile=JSON.parse(profile.json)
    if(openLaunches){const chain=await openCreation();if(!chain.native||!chain.open||chain.paused||!chain.creatorFeeBps.includes(input.creatorFeeBps)||(input.selectedHook?input.capBps!==0:!chain.capBps.includes(input.capBps)))throw Error()}
    else if(reviewedProfile.capability.creatorFeeBpsChoices?!isApprovedLaunchChoice(reviewedProfile,input):input.creatorFeeBps!==config.economics.creatorFeeBps)throw Error()
    const result=await (input.selectedHook?reviewNewMintSelectedHookPreparationCandidate:reviewNewMintPreparationCandidate)({custody,sessionToken,
     input:{operationId:input.operationId,...(input.selectedHook?{selectedHook:input.selectedHook}:{capBps:input.capBps}),label:input.label,creatorFeeBps:input.creatorFeeBps},
     profile:preparationProfile,hookPin:config.selectedHookPin,connections,limits:{...preparationLimits,...(reviewTiming?await reviewTiming({stage:'preparation'}):{})},clock})
    if(result.custody.owner!==owner)throw Error()
    const {schema:_,...prepared}=result.request
    const request=parseMaxWalletLaunchRequest(openLaunches?{...prepared,schema:input.selectedHook?'repoing/selected-hook-launch-request/1':'repoing/open-launch-request/1',name:input.name,symbol:input.symbol,uri:input.uri,virtualQuote:input.virtualQuote}
     :{...result.request,schema:result.request.policyVersion===2?'repoing/inclusive-max-wallet-launch-request/1':'repoing/max-wallet-launch-request/1',reviewer:config.reviewer,
     name:input.name,symbol:input.symbol,uri:input.uri,virtualQuote:input.virtualQuote})
    await context.bind(sessionToken,input.operationId,request)
    return {owner,operationId:input.operationId,mint:result.custody.mint,selectedConfig:result.custody.selectedConfig,request}
   }catch(error){
    if(error?.code==='SELECTED_HOOK_REGISTRY_REQUIRED'){
     const reserved=await custody.get(sessionToken,input.operationId)
     throw Object.assign(error,{mint:reserved.mint,selectedConfig:reserved.selectedConfig})
    }
    throw Error('Mint preparation unavailable or changed; preserve the operation ID')
   }
  },
 })
}
