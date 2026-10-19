// Server-owned two-provider collection for native-SOL trades (stages native-buy and native-sell), as the inclusive
// resolver does it for bridged coins. No request-supplied observations, endpoints or pins. Before anything is signed,
// both providers simulate the exact message and must show every account it pays or is paid by moving exactly as reviewed.
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {PublicKey,VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import {validateMaxWalletOperatorBindings} from './hooklab-max-wallet-launch-collector.mjs'
import {inspectProductionEvidence} from './hooklab-production-observer.mjs'
import {compileNativeSwapReview,nativeSwapInventory,nativeSwapRequestSchema} from './hooklab-native-swap.mjs'
import {collectNativeTradeSettlement} from './hooklab-native-trade-settlement.mjs'
import {approvedCreatorFees} from './hooklab-launch-menus.mjs'
import {canonicalObservation} from './hooklab-canonical-observation.mjs'
import {STATUS_GRADUATED} from './hooklab-graduation.mjs'
import {loadNativeArtifacts} from './hooklab-native-pins.mjs'
const check=v=>{if(!v)throw Error('Native trade state, intent or operator pins changed')}
const sha=x=>createHash('sha256').update(x).digest('hex'),pk=x=>new PublicKey(x)
const integer=x=>{check(Number.isSafeInteger(x)&&x>=0);return x}
const withoutSupply=base64=>{const b=Buffer.from(base64,'base64');if(b.length>=18)b.fill(0,10,18);return b.toString('base64')}
const SIGNING_WINDOW_SLOTS=100
// The most a new 204-byte coin holding can cost the payer in rent (about 2.3 times today's mainnet rent); the review
// carries the exact amount, this only bounds it.
export const HOLDING_RENT_CEILING_LAMPORTS=4000000n
export function nativeTradeResolver({config,profile,dossierJson,connections,limits,clock=Date.now}){
 const retained=structuredClone({config,profile,dossierJson,limits}),providers=connections.map(x=>({...x}))
 const bound=validateMaxWalletOperatorBindings({...retained,connections:providers}),p=bound.profile
 check(bound.config.feeModel===2&&bound.profile.buildFeature==='inclusive-fees-candidate')
 // Its own domain, and without the boot clock (limits.nowMs): a restart or deploy must not move this hash.
 const configurationSha256=sha(JSON.stringify({schema:'repoing/native-trade-configuration/1',...retained,limits:{...retained.limits,nowMs:undefined}}))
 async function collect({owner,stage,intent,expectedReview,originalContext}){
  const {quote:ignored,...raw}=intent??{}
  const request=nativeSwapRequestSchema.parse({...raw,schema:'repoing/native-swap-request/1',policyKind:'max-wallet',policyVersion:2,feeModel:2,protocolShareBps:2500,trader:owner})
  check(stage===`native-${request.side}`&&approvedCreatorFees(bound.profile).includes(request.creatorFeeBps))
  if(originalContext)check(originalContext.configurationSha256===configurationSha256&&isDeepStrictEqual(originalContext.compilationInput.request,request))
  const started=integer(clock()),inventory=nativeSwapInventory(bound.profile,request)
  const extras=[...new Set([...bound.dossier.programs.flatMap(x=>[x.address,x.programData]),...bound.dossier.accounts.map(x=>x.address),...(bound.config.lookupTable?[bound.config.lookupTable.address]:[])])]
  const all=[...new Set([...inventory,...extras])].sort(),minSlot=expectedReview?.observedSlot??bound.dossier.minSlot
  const observations=await Promise.all(providers.map(async({provider,connection})=>{
   check(await connection.getGenesisHash()===bound.profile.genesisHash)
   const state=await connection.getMultipleAccountsInfoAndContext(all.map(pk),{commitment:'finalized',minContextSlot:minSlot})
   check(state.value.length===all.length&&integer(state.context.slot)>=minSlot)
   return canonicalObservation({provider,genesisHash:bound.profile.genesisHash,commitment:'finalized',slot:state.context.slot,observedAtMs:started,
    accounts:state.value.map((v,i)=>({address:all[i],account:v?{address:all[i],owner:v.owner.toBase58(),executable:v.executable,lamports:String(integer(v.lamports)),dataBase64:Buffer.from(v.data).toString('base64')}:null}))})
  }))
  // As for bridged trades: the bridged-SOL mint's supply moves with every wrap, so compare without it and keep one copy.
  const steady=o=>o.accounts.map(x=>x.address===p.quoteMint&&x.account?{...x,account:{...x.account,dataBase64:withoutSupply(x.account.dataBase64)}}:x)
  check(isDeepStrictEqual(steady(observations[0]),steady(observations[1])))
  const quoteMint=observations[0].accounts.find(x=>x.address===p.quoteMint)
  observations[1].accounts=observations[1].accounts.map(x=>x.address===p.quoteMint?quoteMint:x)
  const map=new Map(observations[0].accounts.map(x=>[x.address,x.account]))
  const evidence=inspectProductionEvidence({dossierJson:retained.dossierJson,expectedSha256:bound.config.dossierSha256,nowMs:integer(clock()),
   observations:observations.map(o=>({...o,accounts:extras.filter(x=>x!==bound.config.lookupTable?.address).map(address=>{const v=map.get(address);check(v);const {lamports,...rest}=v;return rest})}))})
  check(evidence.accountBindingsMatched===true)
  const slot=Math.max(...observations.map(x=>x.slot))
  const latest=expectedReview?{context:{slot},value:{blockhash:VersionedMessage.deserialize(Buffer.from(expectedReview.messageBase64,'base64')).recentBlockhash,lastValidBlockHeight:expectedReview.lastValidBlockHeight}}
   :await providers[0].connection.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:slot})
  check(integer(latest.context.slot)>=slot)
  const confirmations=await Promise.all(providers.map(async({connection})=>{
   const valid=await connection.isBlockhashValid(latest.value.blockhash,{commitment:'finalized',minContextSlot:latest.context.slot})
   check(valid.value===true&&integer(valid.context.slot)>=latest.context.slot)
   return {slot:valid.context.slot,height:integer(await connection.getBlockHeight({commitment:'finalized',minContextSlot:valid.context.slot}))}
  }))
  const liveSlots=originalContext?null:await Promise.all(providers.map(async({connection})=>integer(await connection.getSlot('confirmed'))))
  if(liveSlots)check(Math.max(...liveSlots)-Math.min(...liveSlots)<=retained.limits.maxSlotLag)
  // The payer's bound: fees, the buy's lamports and a new holding's rent; the review states the exact debit within it.
  const debitCeiling=String(BigInt(retained.limits.maxNetworkFeeLamports)+(request.side==='buy'?BigInt(request.maxInput):0n)+HOLDING_RENT_CEILING_LAMPORTS)
  const l=originalContext?{...originalContext.compilationInput.limits,nowMs:integer(clock())}:{...retained.limits,nowMs:integer(clock()),validUntilSlot:Math.min(Math.min(...liveSlots)+SIGNING_WINDOW_SLOTS,slot+150),
   reviewExpiresAtMs:started+retained.limits.maxAgeMs,maxTotalDebitLamports:debitCeiling}
  const priority=(BigInt(l.computeUnitLimit)*BigInt(l.computeUnitPriceMicroLamports)+999999n)/1000000n
  const recentBlockhash={...latest.value,genesisHash:bound.profile.genesisHash,providers:profile.providers,observedAtMs:started,currentBlockHeight:Math.max(...confirmations.map(x=>x.height)),
   blockhashValid:true,observedSlot:Math.max(...confirmations.map(x=>x.slot)),networkFeeLamports:String(BigInt(bound.config.lamportsPerSignature)+priority),lamportsPerSignature:bound.config.lamportsPerSignature}
  const lookup=bound.config.lookupTable?map.get(bound.config.lookupTable.address):null
  if(bound.config.lookupTable)check(lookup&&!lookup.executable&&sha(Buffer.from(lookup.dataBase64,'base64'))===bound.config.lookupTable.sha256)
  const compilationInput={profile:retained.profile,request,provenance:'server-collected-finalized-state-not-execution-authorization',
   observations:observations.map(o=>({...o,accounts:o.accounts.filter(x=>inventory.includes(x.address))})),recentBlockhash,
   lookupTable:lookup?{address:lookup.address,owner:lookup.owner,dataBase64:lookup.dataBase64,sha256:bound.config.lookupTable.sha256}:null,limits:l}
  const plan=compileNativeSwapReview(compilationInput)
  if(expectedReview){const stable=r=>{const {observedSlot,observedAtMs,policySha256,...rest}=r;return rest};check(isDeepStrictEqual(stable(plan.review),stable(expectedReview)))
   check(originalContext&&isDeepStrictEqual(plan.quote,compileNativeSwapReview(originalContext.compilationInput).quote))}
  await simulateExactly(providers,plan,recentBlockhash)
  check(clock()<plan.review.reviewExpiresAtMs)
  return {status:'operator-pins-and-state-verified',owner,stage,profileSha256:bound.config.profileSha256,messageSha256:plan.review.messageSha256,
   configurationSha256,review:expectedReview??plan.review,request:{...request,quote:plan.quote},settlementContext:{schema:'repoing/native-trade-settlement-context/1',configurationSha256,compilationInput},canSign:false,canSubmit:false}
 }
 return Object.freeze({
  configurationSha256,
  prepare:collect,
  async revalidate({owner,stage,review,configurationSha256:hash,settlementContext}){
   check(hash===configurationSha256);return collect({owner,stage,intent:settlementContext.compilationInput.request,expectedReview:review,originalContext:settlementContext})
  },
  async reconcile(args){
   check(args.configurationSha256===configurationSha256&&args.settlementContext?.configurationSha256===configurationSha256)
   return collectNativeTradeSettlement({...retained,connections:providers,...args})
  },
 })
}

// Both providers run the exact message (fees and signatures as the network will) and must agree with the review to the
// lamport: the payer, the launch PDA, the pool and a new holding, the trader's coins and the vault's, and for a
// graduating buy the launch reading graduated afterwards.
async function simulateExactly(providers,plan,recentBlockhash){
 const message=VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64')),a=plan.addresses,q=plan.quote
 const watched=[...new Set([...Object.keys(plan.lamportDeltas),a.traderBase,a.baseVault,a.launch])],launchCoder=loadNativeArtifacts().coders.launch
 await Promise.all(providers.map(async({connection})=>{
  const fee=await connection.getFeeForMessage(message,'finalized');check(fee.value!==null&&String(integer(fee.value))===recentBlockhash.networkFeeLamports&&integer(fee.context.slot)>=recentBlockhash.observedSlot)
  const simulation=await connection.simulateTransaction(new VersionedTransaction(message),{sigVerify:false,replaceRecentBlockhash:false,commitment:'finalized',
   minContextSlot:recentBlockhash.observedSlot,accounts:{encoding:'base64',addresses:watched}})
  check(simulation.value.err===null&&integer(simulation.context.slot)>=recentBlockhash.observedSlot&&simulation.value.accounts?.length===watched.length)
  const after=new Map(watched.map((address,i)=>[address,simulation.value.accounts[i]]))
  const bytes=address=>{const v=after.get(address);check(v?.data?.[1]==='base64');return Buffer.from(v.data[0],'base64')}
  for(const [address,change] of Object.entries(plan.lamportDeltas))check(BigInt(integer(after.get(address)?.lamports))===BigInt(plan.lamportsBefore[address])+BigInt(change))
  const amount=address=>{const b=bytes(address);check(b.length===204);return b.readBigUInt64LE(74)}
  check(String(amount(a.traderBase))===q.after.traderBase)
  // graduate tops the vault up from the launch's reserve after the swap, so only a plain trade pins the vault here.
  if(!plan.graduates)check(String(amount(a.baseVault))===q.after.baseReserve)
  check(launchCoder.accounts.decode('Launch',bytes(a.launch)).status===(plan.graduates||plan.graduated?STATUS_GRADUATED:0))
 }))
}
