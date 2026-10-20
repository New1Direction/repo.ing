// Read-only actual-chain collection. No injected observations, fixture compiler,
// default endpoints, signing, sending, deployment, or owner approval inference.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey, VersionedMessage } from '@solana/web3.js'
import { z } from 'zod'
import { hookAddress, hookDigest, hookRawAmount } from './hooklab-execution-contract.mjs'
import { parseMaxWalletProfile, parseMaxWalletPreparationRequest } from './hooklab-inclusive-max-wallet-profile.mjs'
import { compileMaxWalletLaunchReview, compileOpenLaunchReview, maxWalletLaunchInventory, openLaunchInventory, openLaunchRequestSchema, parseMaxWalletLaunchRequest } from './hooklab-max-wallet-launch.mjs'
import { hookLabReviewSchema, inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { parseExecutionDossier, inspectProductionEvidence } from './hooklab-production-observer.mjs'
import { assertLocalExecutionEndpoint, isLocalExecutionDossier } from './hooklab-local-acceptance.mjs'
import { LAUNCH_STATE_HASHES, canonicalLaunchProof, canonicalObservation } from './hooklab-canonical-observation.mjs'
import { launchSettingsChanged,launchesPaused,openCreatorFeeCeiling,openLaunchErrorText,passRefusal } from './hooklab-open-creation.mjs'
import { parseLaunchConfigReserved } from './hooklab-launch-config-reserved.mjs'
import { selectedHookPinSchema, selectedHookLaunchInventory, compileSelectedHookLaunchReview, launchPreparationRequest } from './hooklab-max-wallet-launch.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex')
const check=(v,m)=>{if(!v)throw Object.assign(Error(m),{code:'MAX_WALLET_LAUNCH_UNAVAILABLE'})}
const integer=v=>{check(Number.isSafeInteger(v)&&v>=0,'Invalid RPC integer');return v}
const pk=v=>new PublicKey(v)
const bps=z.number().int().min(0).max(9999)
// The operator bundle's approved hash adopts this record; these hashes alone are not owner consent.
const selectedHookReleaseSchema=z.object({
 schema:z.literal('repoing/selected-hook-release/1'),approvalReference:z.string().min(1).max(256),
 sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),profileSha256:hookDigest,dossierSha256:hookDigest,
 hookPin:selectedHookPinSchema,acceptanceSha256:hookDigest,releaseVerificationSha256:hookDigest,
}).strict()
export const selectedHookReleaseEvidenceSchema=selectedHookReleaseSchema.pick({hookPin:true,acceptanceSha256:true,releaseVerificationSha256:true})
// A server-owned record of operational approval, not a cryptographic protocol envelope.
// No fee defaults: the currently implemented adapter only supports creator/author zero.
export const maxWalletOperatorConfigSchema=z.object({
 schema:z.literal('repoing/max-wallet-operator-config/1'),enabled:z.boolean().default(false),
 approvalReference:z.string().min(1).max(256),profileSha256:hookDigest,dossierSha256:hookDigest,
 providerTrustDomains:z.array(z.object({provider:z.string(),trustDomain:z.string().min(1),origin:z.url()}).strict()).length(2),
 economics:z.object({creatorFeeBps:z.literal(0),authorShareBps:z.literal(0),lpFeeBps:bps,maxCreatorFeeBps:bps,
  protocolFeeBps:bps,launchProtocolShareBps:z.number().int().min(0).max(10000),launchFeeLamports:hookRawAmount,poolCreationFeeLamports:hookRawAmount}).strict(),
 reviewer:hookAddress,treasury:hookAddress,lookupTable:z.object({address:hookAddress,sha256:hookDigest}).strict().nullable(),
 lamportsPerSignature:hookRawAmount.refine(v=>BigInt(v)>0n),
 selectedHookPin:selectedHookPinSchema.optional(),
 selectedHookRelease:selectedHookReleaseSchema.optional(),
}).strict()
export const inclusiveMaxWalletOperatorConfigSchema=maxWalletOperatorConfigSchema.extend({
 schema:z.literal('repoing/inclusive-max-wallet-operator-config/1'),feeModel:z.literal(2),
 // The owner's shared, frozen launch lookup table for open (self-serve) launches, pinned by its exact bytes.
 launchLookupTable:z.object({address:hookAddress,sha256:hookDigest}).strict().optional(),
 economics:maxWalletOperatorConfigSchema.shape.economics.extend({creatorFeeBps:z.number().int().min(0).max(9999),lpFeeBps:z.literal(0),protocolFeeBps:z.literal(0),launchProtocolShareBps:z.literal(2500)}).strict(),
}).strict()
export function validateMaxWalletOperatorBindings({config,profile,dossierJson,connections}){
 const c=(config?.schema==='repoing/inclusive-max-wallet-operator-config/1'?inclusiveMaxWalletOperatorConfigSchema:maxWalletOperatorConfigSchema).parse(config),p=parseMaxWalletProfile(JSON.parse(profile.json))
 check((c.feeModel===2)===(p.buildFeature==='inclusive-fees-candidate'),'Operator compiler family differs')
 check(c.enabled,'Operator configuration is disabled')
 check(sha(profile.json)===c.profileSha256&&profile.expectedSha256===c.profileSha256,'Profile pin differs')
 check(sha(dossierJson)===c.dossierSha256,'Dossier pin differs')
 const d=parseExecutionDossier(JSON.parse(dossierJson))
 check(d.artifacts.profileSha256===c.profileSha256&&d.artifacts.sourceCommit===p.sourceCommit&&d.genesisHash===p.genesisHash,'Dossier profile binding differs')
 check(Array.isArray(connections)&&connections.length===2&&connections[0].connection!==connections[1].connection,'Two independent connections required')
 const names=connections.map(x=>x.provider)
 check(new Set(names).size===2&&isDeepStrictEqual(names,profile.providers)&&isDeepStrictEqual(names,d.providers)
  &&isDeepStrictEqual(names,c.providerTrustDomains.map(x=>x.provider)),'Provider names differ')
 if(!isLocalExecutionDossier(d))check(new Set(c.providerTrustDomains.map(x=>x.trustDomain)).size===2,'Independent operator-reviewed trust domains required')
 const origins=connections.map(({connection},i)=>{
  const u=new URL(connection.rpcEndpoint),pin=new URL(c.providerTrustDomains[i].origin)
  assertLocalExecutionEndpoint(connection.rpcEndpoint)
  check(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&pin.href===`${pin.origin}/`&&u.origin===pin.origin,'Provider origin differs')
  return u.origin
 })
 check(new Set(origins).size===2,'Independent provider origins required')
 for(const role of ['launch','swap','gate','token']){
  const pin=d.programs.find(x=>x.role===role)
  check(pin?.address===p.programs[role],'Missing exact executable dependency pin')
  if(role==='token')check(pin.elfSha256===p.dependencyObservation.tokenElfSha256,'Token ELF pin differs')
  else check(pin.elfSha256===p.elfSha256[role]&&pin.elfLength===profile.elfLengths[role]
   &&sha(Buffer.from(profile.idls[role],'base64'))===p.idlSha256[role],'Program ELF or IDL pin differs')
  if(role==='gate')check(pin.upgradeAuthority===null,'Gate must be immutable')
 }
 return {config:c,profile:p,dossier:d}
}
export function validateSelectedHookReleaseBindings(input){
 const bound=validateMaxWalletOperatorBindings(input),{config:c,profile:p,dossier:d}=bound
 const r=selectedHookReleaseSchema.parse(c.selectedHookRelease)
 check(d.schema==='repoing/production-observation/2'&&p.stack?.open===true&&!p.programs.bridge&&c.feeModel===2
  &&c.launchLookupTable,'Selected production release needs the independent open stack')
 check(r.approvalReference===c.approvalReference&&r.sourceCommit===p.sourceCommit&&r.profileSha256===c.profileSha256
  &&r.dossierSha256===c.dossierSha256&&isDeepStrictEqual(r.hookPin,c.selectedHookPin),'Selected production release binding differs')
 check(![...Object.values(p.programs),p.quoteMint,p.stack.kitProgram,'11111111111111111111111111111111',
  'FbAuVaTqVPzs43KdsQE8ByfbMJdRFABanya3fuEVjdRM'].includes(r.hookPin.program),'Selected production hook is a stack role or acceptance fixture')
 check(['launch-config','swap-config'].every(role=>d.accounts.some(a=>a.role===role&&a.binding==='config-counters-v1')),
  'Selected production release needs stable config bindings')
 return bound
}
export async function collectMaxWalletLaunchReview(input){
 try{return await collectLaunchReview(input)}
 catch{throw Object.assign(Error('Max-wallet launch evidence unavailable or changed'),{code:'MAX_WALLET_LAUNCH_UNAVAILABLE'})}
}
// An open (self-serve) launch: native, no reviewer, through the operator's shared launch table.
export async function collectOpenLaunchReview(input){
 try{return await collectLaunchReview({...input,nativeLaunches:true,open:true})}
 catch(error){passRefusal(error,()=>Object.assign(Error('Open launch evidence unavailable or changed'),{code:'MAX_WALLET_LAUNCH_UNAVAILABLE'}))}
}
// nativeLaunches: HOOK_NATIVE_LAUNCHES_ENABLED on this server. The compiler then reads launch Config byte 186 from the two
// providers' identical snapshots: on, it compiles create_launch_custom_v4; off, v3 exactly as before.
// The launch Config as an open launch meets it, in the creator's words: creation paused, open launches or native launches
// switched off, or a choice no longer on the menu under the current ceiling (the compiler refuses the same).
function openLaunchState(config,request){
 const reserved=parseLaunchConfigReserved(Buffer.from(config.reserved)),refuse=message=>Object.assign(Error(message),{code:'HOOKLAB_USER_REFUSAL'})
 if(config.paused)throw launchesPaused()
 if(!reserved?.native)throw refuse(openLaunchErrorText(6103))
 if(!reserved.open)throw refuse(openLaunchErrorText(6120))
 if(!reserved.creatorFeeBps.includes(request.creatorFeeBps)||request.creatorFeeBps>openCreatorFeeCeiling(config)||(request.policyKind!=='selected-hook'&&!reserved.capBps.includes(request.capBps)))throw refuse(openLaunchErrorText(6121))
}
async function collectLaunchReview({config,profile,dossierJson,connections,preparation,request,limits,expectedReview,clock=Date.now,nativeLaunches=false,open=false}){
 const {config:c,profile:p,dossier:d}=validateMaxWalletOperatorBindings({config,profile,dossierJson,connections})
 const r=parseMaxWalletLaunchRequest(request),selected=r.policyKind==='selected-hook',table=open?c.launchLookupTable:c.lookupTable
 check(!selected||open&&c.selectedHookPin?.program===r.selectedHook.program,'Selected hook approval unavailable')
 if(open)check(table,'No shared launch table is configured')
 const retainedReview=expectedReview===undefined?null:hookLabReviewSchema.parse(expectedReview)
 if(retainedReview)inspectHookLabMessage(retainedReview)
 const prep=launchPreparationRequest(r)
 check(preparation.wallet===r.creator&&preparation.profileSha256===c.profileSha256
  &&preparation.preparationIntentSha256===sha(JSON.stringify(prep))&&isDeepStrictEqual(preparation.preparedRequest,prep),'Durable preparation identity differs')
 if(!open)check(r.reviewer===c.reviewer,'Current reviewer differs')
 const started=integer(clock()),L=p.programs.launch,S=p.programs.swap
 const configAddress=PublicKey.findProgramAddressSync([Buffer.from('config')],pk(L))[0].toBase58()
 // Bootstrap only derives the inventory; the final snapshot must contain the same config bytes.
 const bootstrap=await connections[0].connection.getMultipleAccountsInfoAndContext([pk(configAddress)],{commitment:'finalized',minContextSlot:preparation.executionSlot})
 check(bootstrap.value.length===1&&bootstrap.value[0],'Launch config unavailable')
 let selectedBootstrap,selectedBootstrapSlot=0
 if(selected){
  const H=r.selectedHook.program, pd=PublicKey.findProgramAddressSync([pk(H).toBuffer()],pk('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58(),registry=PublicKey.findProgramAddressSync([Buffer.from('bordrless-hook-accounts'),pk(r.mint).toBuffer()],pk(H))[0].toBase58()
  const keys=[H,pd,registry],snapshot=await connections[0].connection.getMultipleAccountsInfoAndContext(keys.map(pk),{commitment:'finalized',minContextSlot:integer(bootstrap.context.slot)})
  check(snapshot.value.length===keys.length&&integer(snapshot.context.slot)>=bootstrap.context.slot,'Selected bootstrap stale')
  selectedBootstrapSlot=snapshot.context.slot
  selectedBootstrap=new Map(keys.map((address,i)=>{const v=snapshot.value[i];check(v,'Selected dependency missing');return [address,{address,owner:v.owner.toBase58(),executable:v.executable,dataBase64:Buffer.from(v.data).toString('base64')}]}))
 }
 const {addresses:a,inventory}=selected?selectedHookLaunchInventory(profile,r,bootstrap.value[0].data,{accounts:selectedBootstrap,hookPin:c.selectedHookPin}):(open?openLaunchInventory:maxWalletLaunchInventory)(profile,r,bootstrap.value[0].data)
 const extra=[...d.programs.flatMap(x=>[x.address,x.programData]),...d.accounts.map(x=>x.address),...(table?[table.address]:[])]
 const all=[...new Set([...inventory,...extra])].sort(),minContextSlot=Math.max(integer(bootstrap.context.slot),selectedBootstrapSlot,integer(preparation.executionSlot),d.minSlot)
 const observations=await Promise.all(connections.map(async({provider,connection})=>{
  const genesisHash=await connection.getGenesisHash();check(genesisHash===p.genesisHash,'Wrong chain')
  const snapshot=await connection.getMultipleAccountsInfoAndContext(all.map(pk),{commitment:'finalized',minContextSlot})
  check(snapshot.value.length===all.length&&integer(snapshot.context.slot)>=minContextSlot,'Incomplete or stale snapshot')
  return canonicalObservation({provider,genesisHash,commitment:'finalized',slot:snapshot.context.slot,observedAtMs:started,
   accounts:snapshot.value.map((v,i)=>({address:all[i],account:v===null?null:{address:all[i],owner:v.owner.toBase58(),executable:v.executable,lamports:String(integer(v.lamports)),dataBase64:Buffer.from(v.data).toString('base64')}}))})
 }))
 check(isDeepStrictEqual(observations[0].accounts,observations[1].accounts),'Provider account snapshots disagree')
 const map=new Map(observations[0].accounts.map(x=>[x.address,x.account]))
 check(map.get(configAddress)?.dataBase64===Buffer.from(bootstrap.value[0].data).toString('base64'),'Bootstrap config changed')
 if(selected)for(const [address,value]of selectedBootstrap)check(isDeepStrictEqual((({lamports,...v})=>v)(map.get(address)),value),'Selected bootstrap changed')
 const evidence=inspectProductionEvidence({dossierJson,expectedSha256:c.dossierSha256,nowMs:integer(clock()),idls:profile.idls,observations:observations.map(o=>({...o,accounts:extra.filter(x=>x!==table?.address).map(address=>{const v=map.get(address);check(v,'Pinned account missing');const {lamports,...rest}=v;return rest})}))})
 // Creation paused on chain (the launch Config mirrors the governance creation gate): say so plainly. Otherwise, the launch
 // settings moved since the bundle was collected (an owner's governed change): say that, until it is collected again.
 if(open)openLaunchState(new BorshCoder(JSON.parse(Buffer.from(profile.idls.launch,'base64'))).accounts.decode('Config',Buffer.from(map.get(configAddress).dataBase64,'base64')),r)
 if(evidence.accountBindingsMatched!==true)throw launchSettingsChanged()
 // Require the reviewed dossier to bind every shared economic/governance account.
 for(const address of [a.launchConfig,a.swapConfig,a.launchGovernance,a.swapGovernance,p.quoteMint])check(d.accounts.some(x=>x.address===address),'Missing reviewed governance/economics pin')
 // An open launch's fee is the creator's choice from the chain's menu (the compiler checks it there); everything else is pinned.
 const decode=(role,name,address)=>new BorshCoder(JSON.parse(Buffer.from(profile.idls[role],'base64'))).accounts.decode(name,Buffer.from(map.get(address).dataBase64,'base64'))
 const lc=decode('launch','Config',a.launchConfig),sc=decode('swap','Config',a.swapConfig)
 check(lc.admin.toBase58()===c.reviewer&&lc.treasury.toBase58()===c.treasury&&sc.treasury.toBase58()===c.treasury,'Operator admin or treasury differs')
 check(isDeepStrictEqual(open?{...c.economics,creatorFeeBps:r.creatorFeeBps}:c.economics,{creatorFeeBps:r.creatorFeeBps,authorShareBps:0,lpFeeBps:lc.lp_fee_bps,maxCreatorFeeBps:lc.max_creator_fee_bps,
  protocolFeeBps:sc.protocol_fee_bps,launchProtocolShareBps:sc.launch_protocol_share_bps,launchFeeLamports:lc.launch_fee_lamports.toString(),poolCreationFeeLamports:sc.pool_creation_fee_lamports.toString()}),'Unapproved or unsupported economics')
 const slot=Math.max(...observations.map(x=>x.slot)),latest=retainedReview
  ?{context:{slot},value:{blockhash:VersionedMessage.deserialize(Buffer.from(retainedReview.messageBase64,'base64')).recentBlockhash,lastValidBlockHeight:retainedReview.lastValidBlockHeight}}
  :await connections[0].connection.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:slot})
 check(integer(latest.context.slot)>=slot,'Stale blockhash context')
 const confirmations=await Promise.all(connections.map(async({connection})=>{
  const v=await connection.isBlockhashValid(latest.value.blockhash,{commitment:'finalized',minContextSlot:latest.context.slot})
  check(v.value===true&&integer(v.context.slot)>=latest.context.slot,'Blockhash invalid')
  return {slot:v.context.slot,height:integer(await connection.getBlockHeight({commitment:'finalized',minContextSlot:v.context.slot}))}
 }))
 const priority=(BigInt(limits.computeUnitLimit)*BigInt(limits.computeUnitPriceMicroLamports)+999999n)/1000000n
 const recentBlockhash={...latest.value,genesisHash:p.genesisHash,providers:profile.providers,observedAtMs:started,currentBlockHeight:Math.max(...confirmations.map(x=>x.height)),
  blockhashValid:true,observedSlot:Math.max(...confirmations.map(x=>x.slot)),networkFeeLamports:String(BigInt(new Set([r.creator,r.feePayer,r.mint,...(open?[]:[r.reviewer])]).size)*BigInt(c.lamportsPerSignature)+priority),lamportsPerSignature:c.lamportsPerSignature}
 const lookup=table?map.get(table.address):null
 if(table)check(lookup&&!lookup.executable&&sha(Buffer.from(lookup.dataBase64,'base64'))===table.sha256,'Lookup table pin differs')
 const compilationInput={profile,request:r,preparationEvidence:canonicalLaunchProof({schema:'repoing/max-wallet-durable-prepared-state/1',profileSha256:preparation.profileSha256,
  preparationIntentSha256:preparation.preparationIntentSha256,executionSlot:preparation.executionSlot,preparedAccountHashes:preparation.preparedAccountHashes}),
  reviewedStateHashes:Object.fromEntries(LAUNCH_STATE_HASHES.filter(name=>!open||name!=='authorization').map(name=>[name,sha(Buffer.from(map.get(name==='quoteMint'?p.quoteMint:a[name]).dataBase64,'base64'))])),
  observations:observations.map(o=>({...o,accounts:o.accounts.filter(x=>inventory.includes(x.address))})),recentBlockhash,...(selected?{hookPin:c.selectedHookPin}:{}),
  lookupTable:lookup?{address:lookup.address,owner:lookup.owner,dataBase64:lookup.dataBase64,sha256:table.sha256}:null,limits:{...limits,nowMs:integer(clock())},...(nativeLaunches===true?{nativeLaunches:true}:{})}
 const plan=(selected?compileSelectedHookLaunchReview:open?compileOpenLaunchReview:compileMaxWalletLaunchReview)(compilationInput)
 if(retainedReview){
  // Only observation metadata may refresh. Wallet-consented bytes, accounts,
  // fees, deadlines, identities and blockhash remain byte-for-byte retained.
  const stable=review=>{const {observedSlot,observedAtMs,policySha256,...rest}=review;return rest}
  check(isDeepStrictEqual(stable(plan.review),stable(retainedReview)),'Retained review changed; new wallet consent required')
 }
 const message=VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64'))
 const fees=await Promise.all(connections.map(({connection})=>connection.getFeeForMessage(message,'finalized')))
 for(const fee of fees)check(fee.value!==null&&String(integer(fee.value))===recentBlockhash.networkFeeLamports&&integer(fee.context.slot)>=recentBlockhash.observedSlot,'Exact message fee differs')
 const finished=integer(clock());check(finished>=started&&finished-started<=Math.min(limits.maxAgeMs,d.maxAgeMs)&&finished<limits.reviewExpiresAtMs,'Collection expired')
 return Object.freeze({plan:retainedReview?Object.freeze({...plan,review:Object.freeze(retainedReview)}):plan,settlementContext:{schema:open?'repoing/open-launch-settlement-context/1':'repoing/max-wallet-launch-settlement-context/1',configurationSha256:sha(JSON.stringify(c)),compilationInput},configurationSha256:sha(JSON.stringify(c)),observedAdmin:lc.admin.toBase58(),profileSha256:c.profileSha256,approvalReference:c.approvalReference,collection:{startedAtMs:started,finishedAtMs:finished,providers:[...profile.providers],feeQuotedByBoth:true},canSign:false,canSubmit:false})
}
