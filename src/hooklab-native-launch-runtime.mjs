// Complete server composition, opt-in only. No credentials or endpoint discovery.
import { nativeSignerCustodyStore } from './hooklab-native-signer-custody-store.mjs'
import { nativeCustodySigningAdapter } from './hooklab-native-custody-signing.mjs'
import { nativeSigningLifecycle } from './hooklab-native-signing.mjs'
import { nativeLaunchContext } from './hooklab-native-launch-context.mjs'
import { nativeTransactionSender } from './hooklab-native-transaction-sender.mjs'
import { coLocatedMaxWalletPreparationResolver } from './hooklab-max-wallet-preparation-resolver.mjs'
import { coLocatedMaxWalletLaunchResolver } from './hooklab-max-wallet-launch-resolver.mjs'
import { reviewNewMintPreparationCandidate } from './hooklab-new-mint-preparation.mjs'
import { parseMaxWalletLaunchRequest } from './hooklab-max-wallet-launch.mjs'
import { isLocalExecutionDossier } from './hooklab-local-acceptance.mjs'
export function createNativeLaunchRuntime(pool,{enabled=false,origin,ownerCustodyApproved=false,operatorDeploymentApproved=false,economicsApproved=false,
 config,profile,dossierJson,connections,keyRing,activeKeyId,adminSigner,expiryObserver,preparationLimits,launchLimits,reviewTiming,launchLookupTable,clock=Date.now}={}){
 if(enabled!==true||!ownerCustodyApproved||!operatorDeploymentApproved||!economicsApproved)throw Error('Explicit complete release approvals required')
 config=structuredClone(config);profile=structuredClone(profile);preparationLimits=structuredClone(preparationLimits);launchLimits=structuredClone(launchLimits)
 if(!adminSigner||typeof adminSigner.sign!=='function'||adminSigner.address!==config.reviewer)throw Error('Exact approved admin signer required')
 if(JSON.parse(profile.json).buildFeature==='inclusive-fees-candidate'){
  const dossier=JSON.parse(dossierJson)
  if((dossier.schema!=='repoing/production-observation/2'&&!isLocalExecutionDossier(dossier))||!['launch-config','swap-config'].every(role=>dossier.accounts.some(a=>a.role===role&&a.binding==='config-counters-v1')))throw Error('Explicit stable counter bindings required')
 }
 const settings={enabled,origin,keyRing,activeKeyId}
 const custody=nativeSignerCustodyStore(pool,settings)
 const preparationResolver=coLocatedMaxWalletPreparationResolver(pool,{origin,config,profile,dossierJson,connections,custody,clock})
 const launchResolver=coLocatedMaxWalletLaunchResolver(pool,{origin,config,profile,dossierJson,connections,clock})
 if(launchLookupTable!==undefined&&typeof launchLookupTable!=='function')throw Error('Explicit launch lookup-table provider required')
 const launchResolverFor=launchLookupTable?async({preparationId,review})=>coLocatedMaxWalletLaunchResolver(pool,{origin,config:{...config,lookupTable:await launchLookupTable({preparationId,allowCreate:review===undefined})},profile,dossierJson,connections,clock}):undefined
 const context=nativeLaunchContext(pool,{enabled,origin,preparationResolver,launchResolver,launchResolverFor,preparationLimits,launchLimits,reviewTiming,clock})
 const adapter=nativeCustodySigningAdapter({...settings,adminSigner}),sender=nativeTransactionSender({enabled,connections,clock})
 const lifecycle=nativeSigningLifecycle(pool,{enabled,origin,resolver:context,custodyAdapter:adapter,sender,expiryObserver,stageOperations:{preparation:JSON.parse(profile.json).buildFeature==='inclusive-fees-candidate'?'inclusive-max-wallet-preparation':'max-wallet-preparation',launch:'max-wallet-launch'}})
 const preparationProfile={json:profile.json,expectedSha256:profile.expectedSha256,providers:profile.providers,
  idls:{launch:profile.idls.launch,gate:profile.idls.gate},elfLengths:{launch:profile.elfLengths.launch,gate:profile.elfLengths.gate}}
 return Object.freeze({ownerCustodyApproved,operatorDeploymentApproved,economicsApproved,lifecycle,
  async reserve({sessionToken,owner,input}){
   try{
    // Creator rate is an explicit immutable approved profile/configuration input.
    if(input.creatorFeeBps!==config.economics.creatorFeeBps)throw Error()
    const result=await reviewNewMintPreparationCandidate({custody,sessionToken,input:{operationId:input.operationId,capBps:input.capBps,label:input.label,creatorFeeBps:input.creatorFeeBps},
     profile:preparationProfile,connections,limits:preparationLimits,clock})
    if(result.custody.owner!==owner)throw Error()
    const request=parseMaxWalletLaunchRequest({...result.request,schema:result.request.policyVersion===2?'repoing/inclusive-max-wallet-launch-request/1':'repoing/max-wallet-launch-request/1',reviewer:config.reviewer,
     name:input.name,symbol:input.symbol,uri:input.uri,virtualQuote:input.virtualQuote})
    await context.bind(sessionToken,input.operationId,request)
    return {owner,operationId:input.operationId,mint:result.custody.mint,selectedConfig:result.custody.selectedConfig,request}
   }catch{throw Error('Mint preparation unavailable or changed; preserve the operation ID')}
  },
 })
}
