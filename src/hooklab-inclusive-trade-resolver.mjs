// Server-owned two-provider collection. No request-supplied observations, endpoints or pins.
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {PublicKey,VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import {validateMaxWalletOperatorBindings} from './hooklab-max-wallet-launch-collector.mjs'
import {inspectProductionEvidence} from './hooklab-production-observer.mjs'
import {compileInclusiveMaxWalletSwapReview,inclusiveMaxWalletSwapInventory,inclusiveMaxWalletSwapRequestSchema} from './hooklab-inclusive-max-wallet-swap.mjs'
import {collectInclusiveTradeSettlement} from './hooklab-inclusive-trade-settlement.mjs'
import {approvedCreatorFees} from './hooklab-launch-menus.mjs'
import {canonicalObservation} from './hooklab-canonical-observation.mjs'
import {provenLatestBlockhash} from './hooklab-blockhash-proof.mjs'
import {REVIEWED_PROFILE_SHA256,reviewedEnvelope} from './hooklab-reviewed-profiles.mjs'
const check=v=>{if(!v)throw Error('Inclusive trade state, intent or operator pins changed')}
const sha=x=>createHash('sha256').update(x).digest('hex'),pk=x=>new PublicKey(x)
const integer=x=>{check(Number.isSafeInteger(x)&&x>=0);return x}
// Mint.supply: bytes 10-17 (discriminator, version, decimals); the quote-mint pin (mint-supply-v1) ignores only it too.
const withoutSupply=base64=>{const b=Buffer.from(base64,'base64');if(b.length>=18)b.fill(0,10,18);return b.toString('base64')}
// About 40 seconds from review to send, so a wallet approval fits; the swap compiler allows up to 150 slots.
const SIGNING_WINDOW_SLOTS=100
// reviewedProfiles: the reconcile allowlist (src/hooklab-reviewed-profiles.mjs); tests pass their own synthetic ones.
export function inclusiveTradeResolver({config,profile,dossierJson,connections,limits,clock=Date.now,reviewedProfiles=REVIEWED_PROFILE_SHA256}){
 const retained=structuredClone({config,profile,dossierJson,limits}),providers=connections.map(x=>({...x}))
 const bound=validateMaxWalletOperatorBindings({...retained,connections:providers}),p=bound.profile
 check(bound.config.feeModel===2&&bound.profile.buildFeature==='inclusive-fees-candidate')
 // limits.nowMs is the boot time, so it is left out (JSON drops undefined): a restart or deploy must not move this hash.
 const configurationSha256=sha(JSON.stringify({...retained,limits:{...retained.limits,nowMs:undefined}}))
 async function collect({owner,stage,intent,expectedReview,originalContext}){
  const {quote:ignored,...raw}=intent??{}
  const request=inclusiveMaxWalletSwapRequestSchema.parse({...raw,schema:'repoing/inclusive-max-wallet-swap-request/1',policyKind:'max-wallet',policyVersion:2,
   feeModel:2,protocolShareBps:2500,trader:owner,recipient:owner,feePayer:owner})
  // Any fee from the owner's menu; the compiler then requires it to equal the coin's on-chain PolicyV2 fee.
  check(stage===`inclusive-${request.side}`&&approvedCreatorFees(bound.profile).includes(request.creatorFeeBps))
  if(originalContext)check(originalContext.configurationSha256===configurationSha256&&isDeepStrictEqual(originalContext.compilationInput.request,request))
  const started=integer(clock()),inventory=inclusiveMaxWalletSwapInventory(bound.profile,request)
  const extras=[...new Set([...bound.dossier.programs.flatMap(p=>[p.address,p.programData]),...bound.dossier.accounts.map(x=>x.address),...(bound.config.lookupTable?[bound.config.lookupTable.address]:[])])]
  const all=[...new Set([...inventory,...extras])].sort(),minSlot=expectedReview?.observedSlot??bound.dossier.minSlot
  const observations=await Promise.all(providers.map(async({provider,connection})=>{
   check(await connection.getGenesisHash()===bound.profile.genesisHash)
   const state=await connection.getMultipleAccountsInfoAndContext(all.map(pk),{commitment:'finalized',minContextSlot:minSlot})
   check(state.value.length===all.length&&integer(state.context.slot)>=minSlot)
   return canonicalObservation({provider,genesisHash:bound.profile.genesisHash,commitment:'finalized',slot:state.context.slot,observedAtMs:started,
    accounts:state.value.map((v,i)=>({address:all[i],account:v?{address:all[i],owner:v.owner.toBase58(),executable:v.executable,lamports:String(integer(v.lamports)),dataBase64:Buffer.from(v.data).toString('base64')}:null}))})
  }))
  // The bridged-SOL quote mint's supply moves with every wrap and unwrap through the public bridge, so providers
  // answering at different slots differ there: compare without it, then use the first provider's mint for both.
  const steady=o=>o.accounts.map(x=>x.address===p.quoteMint&&x.account?{...x,account:{...x.account,dataBase64:withoutSupply(x.account.dataBase64)}}:x)
  check(isDeepStrictEqual(steady(observations[0]),steady(observations[1])))
  const quoteMint=observations[0].accounts.find(x=>x.address===p.quoteMint)
  observations[1].accounts=observations[1].accounts.map(x=>x.address===p.quoteMint?quoteMint:x)
  const map=new Map(observations[0].accounts.map(x=>[x.address,x.account]))
  const evidence=inspectProductionEvidence({dossierJson:retained.dossierJson,expectedSha256:bound.config.dossierSha256,nowMs:integer(clock()),
   observations:observations.map(o=>({...o,accounts:extras.filter(a=>a!==bound.config.lookupTable?.address).map(address=>{const a=map.get(address);check(a);const {lamports,...rest}=a;return rest})}))})
  check(evidence.accountBindingsMatched===true)
  const slot=Math.max(...observations.map(x=>x.slot))
  const latest=expectedReview?{context:{slot},value:{blockhash:VersionedMessage.deserialize(Buffer.from(expectedReview.messageBase64,'base64')).recentBlockhash,lastValidBlockHeight:expectedReview.lastValidBlockHeight}}
   :await provenLatestBlockhash(providers,{minContextSlot:slot})
  check(integer(latest.context.slot)>=slot)
  const confirmations=await Promise.all(providers.map(async({connection})=>{
   const valid=await connection.isBlockhashValid(latest.value.blockhash,{commitment:'finalized',minContextSlot:latest.context.slot})
   check(valid.value===true&&integer(valid.context.slot)>=latest.context.slot)
   return {slot:valid.context.slot,height:integer(await connection.getBlockHeight({commitment:'finalized',minContextSlot:valid.context.slot}))}
  }))
  const liveSlots=originalContext?null:await Promise.all(providers.map(async({connection})=>integer(await connection.getSlot('confirmed'))))
  if(liveSlots)check(Math.max(...liveSlots)-Math.min(...liveSlots)<=retained.limits.maxSlotLag)
  const l=originalContext?{...originalContext.compilationInput.limits,nowMs:integer(clock())}:{...retained.limits,nowMs:integer(clock()),validUntilSlot:Math.min(Math.min(...liveSlots)+SIGNING_WINDOW_SLOTS,slot+150),reviewExpiresAtMs:started+retained.limits.maxAgeMs}
  const priority=(BigInt(l.computeUnitLimit)*BigInt(l.computeUnitPriceMicroLamports)+999999n)/1000000n
  const recentBlockhash={...latest.value,genesisHash:bound.profile.genesisHash,providers:profile.providers,observedAtMs:started,currentBlockHeight:Math.max(...confirmations.map(x=>x.height)),
   blockhashValid:true,observedSlot:Math.max(...confirmations.map(x=>x.slot)),networkFeeLamports:String(BigInt(bound.config.lamportsPerSignature)+priority),lamportsPerSignature:bound.config.lamportsPerSignature}
  const lookup=bound.config.lookupTable?map.get(bound.config.lookupTable.address):null
  if(bound.config.lookupTable)check(lookup&&!lookup.executable&&sha(Buffer.from(lookup.dataBase64,'base64'))===bound.config.lookupTable.sha256)
  const compilationInput={profile:retained.profile,request,provenance:'server-collected-finalized-state-not-execution-authorization',
   observations:observations.map(o=>({...o,accounts:o.accounts.filter(x=>inventory.includes(x.address))})),recentBlockhash,
   lookupTable:lookup?{address:lookup.address,owner:lookup.owner,dataBase64:lookup.dataBase64,sha256:bound.config.lookupTable.sha256}:null,limits:l}
  const plan=compileInclusiveMaxWalletSwapReview(compilationInput)
  if(expectedReview){const stable=r=>{const {observedSlot,observedAtMs,policySha256,...rest}=r;return rest};check(isDeepStrictEqual(stable(plan.review),stable(expectedReview)))
   check(originalContext&&isDeepStrictEqual(plan.quote,compileInclusiveMaxWalletSwapReview(originalContext.compilationInput).quote))}
  const message=VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64'))
  await Promise.all(providers.map(async({connection})=>{
   const fee=await connection.getFeeForMessage(message,'finalized');check(fee.value!==null&&String(integer(fee.value))===recentBlockhash.networkFeeLamports&&integer(fee.context.slot)>=recentBlockhash.observedSlot)
   const simulation=await connection.simulateTransaction(new VersionedTransaction(message),{sigVerify:false,replaceRecentBlockhash:false,commitment:'finalized',minContextSlot:recentBlockhash.observedSlot})
   check(simulation.value.err===null&&integer(simulation.context.slot)>=recentBlockhash.observedSlot)
  }))
  check(clock()<plan.review.reviewExpiresAtMs)
  return {status:'operator-pins-and-state-verified',owner,stage,profileSha256:bound.config.profileSha256,messageSha256:plan.review.messageSha256,
   configurationSha256,review:expectedReview??plan.review,request:{...request,quote:plan.quote},settlementContext:{schema:'repoing/inclusive-trade-settlement-context/1',configurationSha256,compilationInput},canSign:false,canSubmit:false}
 }
 return Object.freeze({
  configurationSha256,
  prepare:collect,
  async revalidate({owner,stage,review,configurationSha256:hash,settlementContext}){
   check(hash===configurationSha256);return collect({owner,stage,intent:settlementContext.compilationInput.request,expectedReview:review,originalContext:settlementContext})
  },
  async reconcile(args){
   // Rows stored under another hash (the boot clock it once held, other operator settings, a new bundle) settle only bound
   // to their own context, under the profile they were reviewed under: today's, or a reviewed one (settlement recompiles
   // the full review from that context).
   const stored=args.settlementContext?.compilationInput?.profile
   check(args.configurationSha256===configurationSha256||(args.settlementContext?.configurationSha256===args.configurationSha256
    &&(isDeepStrictEqual(stored,retained.profile)||reviewedEnvelope(stored,retained.profile,reviewedProfiles))))
   return collectInclusiveTradeSettlement({...retained,connections:providers,...args,reviewedProfiles})
  },
 })
}
