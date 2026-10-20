// Server-owned two-provider collection for native-SOL trades (stages native-buy and native-sell), as the inclusive
// resolver does it for bridged coins. No request-supplied observations, endpoints or pins. Before anything is signed,
// both providers simulate the exact message and must show every account it pays or is paid by moving exactly as reviewed.
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {PublicKey,VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import {validateMaxWalletOperatorBindings,validateSelectedHookReleaseBindings} from './hooklab-max-wallet-launch-collector.mjs'
import {inspectProductionEvidence,tradeEvidenceAddresses} from './hooklab-production-observer.mjs'
import {compileNativeSwapReview,nativeSwapInventory,nativeSwapRequestSchema,selectedNativeHookPinSchema,selectedNativeHookEvidence} from './hooklab-native-swap.mjs'
import {collectNativeTradeSettlement} from './hooklab-native-trade-settlement.mjs'
import {approvedCreatorFees} from './hooklab-launch-menus.mjs'
import {canonicalObservation} from './hooklab-canonical-observation.mjs'
import {provenLatestBlockhash} from './hooklab-blockhash-proof.mjs'
import {REVIEWED_PROFILE_SHA256,reviewedEnvelope} from './hooklab-reviewed-profiles.mjs'
import {STATUS_GRADUATED} from './hooklab-graduation.mjs'
import {loadNativeArtifacts} from './hooklab-native-pins.mjs'
import {refuseUnsupportedSelectedHook} from './hooklab-selected-hook.mjs'
import {collectSelectedHookSimulation} from './hooklab-selected-hook-simulation.mjs'
import {isLocalExecutionDossier,localAcceptanceNetwork} from './hooklab-local-acceptance.mjs'
const check=v=>{if(!v)throw Error('Native trade state, intent or operator pins changed')}
const sha=x=>createHash('sha256').update(x).digest('hex'),pk=x=>new PublicKey(x)
const integer=x=>{check(Number.isSafeInteger(x)&&x>=0);return x}
const withoutSupply=base64=>{const b=Buffer.from(base64,'base64');if(b.length>=18)b.fill(0,10,18);return b.toString('base64')}
const SIGNING_WINDOW_SLOTS=100
// The most a new 204-byte coin holding can cost the payer in rent (about 2.3 times today's mainnet rent); the review
// carries the exact amount, this only bounds it.
export const HOLDING_RENT_CEILING_LAMPORTS=4000000n
// reviewedProfiles: the reconcile allowlist (src/hooklab-reviewed-profiles.mjs); tests pass their own synthetic ones.
export function nativeTradeResolver({config,profile,dossierJson,connections,limits,selectedHookPin=config?.selectedHookPin??null,selectedNativeTradingEnabled=false,clock=Date.now,reviewedProfiles=REVIEWED_PROFILE_SHA256}){
 const selectedSettings=selectedHookPin===null?null:selectedNativeHookPinSchema.parse(selectedHookPin)
 const selectedOpen=selectedNativeTradingEnabled===true&&selectedSettings!==null
 if(selectedOpen){
  const local=localAcceptanceNetwork()
  if(local)check(isLocalExecutionDossier(JSON.parse(dossierJson))&&connections.every(x=>local.endpoints.includes(x.connection.rpcEndpoint)))
  else{
   check(config?.selectedHookRelease)
   const approved=validateSelectedHookReleaseBindings({config,profile,dossierJson,connections})
   check(isDeepStrictEqual(approved.config.selectedHookPin,selectedSettings))
  }
 }
 const retained=structuredClone({config,profile,dossierJson,limits,...(selectedSettings?{selectedHookPin:selectedSettings,selectedNativeTradingEnabled:selectedOpen}:{})}),providers=connections.map(x=>({...x}))
 const bound=validateMaxWalletOperatorBindings({...retained,connections:providers}),p=bound.profile
 check(bound.config.feeModel===2&&bound.profile.buildFeature==='inclusive-fees-candidate')
 // Its own domain, and without the boot clock (limits.nowMs): a restart or deploy must not move this hash.
 const configurationSha256=sha(JSON.stringify({schema:'repoing/native-trade-configuration/1',...retained,limits:{...retained.limits,nowMs:undefined}}))
 async function collect({owner,stage,intent,expectedReview,originalContext}){
  const {quote:ignored,...raw}=intent??{}
  // Never relabel a creator-selected hook as max-wallet to obtain a deterministic quote.
  const selected=raw.policyKind==='selected-hook'
  if((raw.selectedHook||raw.policyKind&&raw.policyKind!=='max-wallet')&&(!selected||!selectedOpen))refuseUnsupportedSelectedHook()
  const request=nativeSwapRequestSchema.parse({...raw,schema:'repoing/native-swap-request/1',policyKind:selected?'selected-hook':'max-wallet',policyVersion:2,feeModel:2,protocolShareBps:2500,trader:owner})
  check(stage===`native-${request.side}`&&approvedCreatorFees(bound.profile).includes(request.creatorFeeBps))
  if(originalContext)check(originalContext.configurationSha256===configurationSha256&&isDeepStrictEqual(originalContext.compilationInput.request,request))
  const started=integer(clock())
  let hookEvidence=null
  if(selected){
   check(request.selectedHook.program===selectedSettings.program)
   const H=request.selectedHook.program,derive=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(x=>typeof x==='string'?Buffer.from(x):x),pk(program))[0].toBase58()
   const addresses=[H,derive('BPFLoaderUpgradeab1e11111111111111111111111',pk(H).toBuffer()),derive(H,'bordrless-hook-accounts',pk(request.mint).toBuffer())]
   const snapshots=await Promise.all(providers.map(async({connection})=>{
    check(await connection.getGenesisHash()===p.genesisHash)
    const row=await connection.getMultipleAccountsInfoAndContext(addresses.map(pk),{commitment:'finalized',minContextSlot:expectedReview?.observedSlot??bound.dossier.minSlot})
    check(row.value.length===addresses.length)
    return row.value.map((v,i)=>v?{address:addresses[i],owner:v.owner.toBase58(),executable:v.executable,lamports:String(integer(v.lamports)),dataBase64:Buffer.from(v.data).toString('base64')}:null)
   }))
   check(isDeepStrictEqual(snapshots[0],snapshots[1]))
   hookEvidence=selectedNativeHookEvidence(p,request,new Map(addresses.map((a,i)=>[a,snapshots[0][i]])),selectedSettings)
  }
  const inventory=nativeSwapInventory(bound.profile,request,hookEvidence)
  // Trade-scope evidence only (programs, swap config and governance, quote mint): a launch-side pause or policy change
  // must not stop holders trading (src/hooklab-production-observer.mjs LAUNCH_SIDE_ROLES).
  const extras=[...new Set([...tradeEvidenceAddresses(bound.dossier),...(bound.config.lookupTable?[bound.config.lookupTable.address]:[])])]
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
  const evidence=inspectProductionEvidence({dossierJson:retained.dossierJson,expectedSha256:bound.config.dossierSha256,nowMs:integer(clock()),idls:retained.profile.idls,scope:'trade',
   observations:observations.map(o=>({...o,accounts:extras.filter(x=>x!==bound.config.lookupTable?.address).map(address=>{const v=map.get(address);check(v);const {lamports,...rest}=v;return rest})}))})
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
  // The payer's bound: fees, the buy's lamports and a new holding's rent; the review states the exact debit within it.
  const debitCeiling=String(BigInt(retained.limits.maxNetworkFeeLamports)+(request.side==='buy'?BigInt(request.maxInput):0n)+HOLDING_RENT_CEILING_LAMPORTS)
  const l=originalContext?{...originalContext.compilationInput.limits,nowMs:integer(clock())}:{...retained.limits,nowMs:integer(clock()),validUntilSlot:Math.min(Math.min(...liveSlots)+SIGNING_WINDOW_SLOTS,slot+150),
   reviewExpiresAtMs:started+retained.limits.maxAgeMs,maxTotalDebitLamports:debitCeiling}
  const priority=(BigInt(l.computeUnitLimit)*BigInt(l.computeUnitPriceMicroLamports)+999999n)/1000000n
  const recentBlockhash={...latest.value,genesisHash:bound.profile.genesisHash,providers:profile.providers,observedAtMs:started,currentBlockHeight:Math.max(...confirmations.map(x=>x.height)),
   blockhashValid:true,observedSlot:Math.max(...confirmations.map(x=>x.slot)),networkFeeLamports:String(BigInt(bound.config.lamportsPerSignature)+priority),lamportsPerSignature:bound.config.lamportsPerSignature}
  const lookup=bound.config.lookupTable?map.get(bound.config.lookupTable.address):null
  if(bound.config.lookupTable)check(lookup&&!lookup.executable&&sha(Buffer.from(lookup.dataBase64,'base64'))===bound.config.lookupTable.sha256)
  // Revalidating a first buy keeps its create_holding and reviewed rent: a holding that appeared since is a no-op.
  const original=originalContext?compileNativeSwapReview(originalContext.compilationInput):null
  const compilationInput={profile:retained.profile,request,provenance:'server-collected-finalized-state-not-execution-authorization',
   observations:observations.map(o=>({...o,accounts:o.accounts.filter(x=>inventory.includes(x.address))})),recentBlockhash,
   lookupTable:lookup?{address:lookup.address,owner:lookup.owner,dataBase64:lookup.dataBase64,sha256:bound.config.lookupTable.sha256}:null,limits:l,
   ...(original?.createsHolding?{holdingCreation:{maxRentLamports:original.quote.holdingRentLamports}}:{}),
   ...(selected?{selectedHookPin:selectedSettings,...(originalContext?{selectedTokenDeltas:originalContext.compilationInput.selectedTokenDeltas}:{})}:{})}
  let plan=compileNativeSwapReview(compilationInput),selectedSimulation=null
  if(selected){
   const measured=await collectSelectedNativeTradeReview({compilationInput,configurationSha256,connections:providers,clock,expectedReview,
    expectedSimulation:originalContext?.selectedSimulation})
   selectedSimulation=measured.selectedSimulation;plan=measured.plan
   compilationInput.selectedTokenDeltas=measured.compilationInput.selectedTokenDeltas
  }
  if(expectedReview){const stable=r=>{const {observedSlot,observedAtMs,policySha256,...rest}=r;return rest};check(isDeepStrictEqual(stable(plan.review),stable(expectedReview)))
   check(original&&isDeepStrictEqual(plan.quote,original.quote))}
  await simulateExactly(providers,plan,recentBlockhash)
  check(clock()<plan.review.reviewExpiresAtMs)
  return {status:'operator-pins-and-state-verified',owner,stage,profileSha256:bound.config.profileSha256,messageSha256:plan.review.messageSha256,
   configurationSha256,review:expectedReview??plan.review,request:{...request,quote:plan.quote},settlementContext:{schema:'repoing/native-trade-settlement-context/1',configurationSha256,compilationInput,
    ...(selected?{selectedSimulation}:{})},canSign:false,canSubmit:false}
 }
 return Object.freeze({
  configurationSha256,
  prepare:collect,
  async revalidate({owner,stage,review,configurationSha256:hash,settlementContext}){
   check(hash===configurationSha256);return collect({owner,stage,intent:settlementContext.compilationInput.request,expectedReview:review,originalContext:settlementContext})
  },
  async reconcile(args){
   // A trade that landed must stay reconcilable after an operator settings change or a new bundle: a row whose stored
   // context binds its own hash settles under the profile it was reviewed under, if that is today's or a reviewed one
   // (settlement recompiles the full review from that context).
   const stored=args.settlementContext?.compilationInput?.profile
   check(args.configurationSha256===configurationSha256||(args.settlementContext?.configurationSha256===args.configurationSha256
    &&(isDeepStrictEqual(stored,retained.profile)||reviewedEnvelope(stored,retained.profile,reviewedProfiles))))
   return collectNativeTradeSettlement({...retained,connections:providers,...args,reviewedProfiles})
  },
 })
}

// Read-only server adapter, not an authorization boundary. Inputs must be collected
// and independently pinned by nativeTradeResolver before its result can enter signing.
export async function collectSelectedNativeTradeReview({compilationInput,configurationSha256,connections,expectedReview,expectedSimulation,clock=Date.now}){
 const input=structuredClone(compilationInput),preview=compileNativeSwapReview(input)
 check(preview.request.policyKind==='selected-hook')
 const conditions=selectedSimulationConditions(preview,input,configurationSha256)
 const selectedSimulation=await collectSelectedHookSimulation({review:expectedReview??preview.review,conditions,connections,clock,expected:expectedSimulation})
 input.selectedTokenDeltas=selectedSimulation.tokenDeltas
 const plan=compileNativeSwapReview(input)
 check(plan.review.messageSha256===selectedSimulation.messageSha256)
 for(const [address,delta]of Object.entries(selectedSimulation.lamportDeltas))check(delta===(plan.lamportDeltas[address]??'0'))
 return {plan,compilationInput:input,selectedSimulation,canSign:false,canSubmit:false}
}

function selectedSimulationConditions(plan,input,configurationSha256){
 const a=plan.addresses,r=plan.request,p=JSON.parse(input.profile.json),buy=r.side==='buy',max='18446744073709551615'
 const map=new Map(input.observations[0].accounts.map(x=>[x.address,x.account]))
 const holding=(address,mint,owner,maxDebit,minCredit='0')=>({address,mint,owner,maxDebit,minCredit})
 const holdings=[holding(a.traderBase,r.mint,r.trader,buy?'0':r.amountIn,buy?r.minAmountOut:'0'),
  holding(a.baseVault,r.mint,a.pool,buy?max:'0',buy?'0':'1'),
  ...(r.graduate?[holding(a.launchReserve,r.mint,a.launch,max),holding(a.launchLp,a.lpMint,a.launch,'0')]:[])]
 const native=plan.review.accounts.filter(x=>x.writable).map(x=>({address:x.address,maxDebit:x.address===r.trader?plan.review.maxNativeDebitLamports:x.address===a.pool&&!buy?max:'0',minCredit:'0'}))
 const unchanged=plan.review.accounts.filter(x=>!x.writable&&map.get(x.address)).map(x=>({address:x.address,sha256:sha(Buffer.from(map.get(x.address).dataBase64,'base64'))}))
 // Registry and immutable ProgramData need not be passed to the instruction itself.
 for(const address of [p.programs.gate,hookProgramData(r.selectedHook.program),hookRegistry(r.selectedHook.program,r.mint)])if(!unchanged.some(x=>x.address===address)){
  const account=map.get(address);check(account);unchanged.push({address,sha256:sha(Buffer.from(account.dataBase64,'base64'))})
 }
 return {tokenProgram:p.programs.token,configurationSha256,holdings,native,unchanged}
}
const hookProgramData=hook=>PublicKey.findProgramAddressSync([pk(hook).toBuffer()],pk('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58()
const hookRegistry=(hook,mint)=>PublicKey.findProgramAddressSync([Buffer.from('bordrless-hook-accounts'),pk(mint).toBuffer()],pk(hook))[0].toBase58()

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
