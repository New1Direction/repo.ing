// Exact-wire, two-provider finalized receipt verification for native-SOL trades. No retry or resend authority.
// A success settles only when the signed bytes and their inclusion match, the swap's own events give the executed trade
// (which the quote model reproduces exactly), every account's lamports moved exactly as that trade says (the payer, the
// launch PDA, the pool and a new coin holding; nothing else), and the one coin transfer agrees. A graduating buy also
// needs graduate's events and the launch reading graduated afterwards.
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {BorshCoder} from '@anchor-lang/core'
import {PublicKey,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {verifyHookLabSignedMessage,inspectHookLabMessage} from './hooklab-message-boundary.mjs'
import {validateMaxWalletOperatorBindings} from './hooklab-max-wallet-launch-collector.mjs'
import {compileNativeSwapReview,selectedNativeMeasuredQuote} from './hooklab-native-swap.mjs'
import {loadNativeArtifacts,nativeErrorName} from './hooklab-native-pins.mjs'
import {loadArtifacts} from './hooklab-owner-driver/artifacts.mjs'
import {canonicalObservation} from './hooklab-canonical-observation.mjs'
import {REVIEWED_PROFILE_SHA256,reviewedEnvelope} from './hooklab-reviewed-profiles.mjs'
import {inclusiveCreatorFee,modelInclusiveCreatorQuote} from './hooklab-inclusive-fee-quote.mjs'
import {STATUS_GRADUATED} from './hooklab-graduation.mjs'
const check=v=>{if(!v)throw Error('Native receipt evidence differs')},sha=x=>createHash('sha256').update(x).digest('hex')
const n=x=>x.toString(),B=x=>BigInt(n(x)),pk=x=>new PublicKey(x),tag=Buffer.from('e445a52e51cb9a1d','hex'),zero='11111111111111111111111111111111'
const integer=x=>{check(Number.isSafeInteger(x)&&x>=0);return x}
const authority=program=>PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],pk(program))[0].toBase58()

export async function collectNativeTradeSettlement({config,profile,dossierJson,connections,settlementContext,review,signedTransactionBase64,signature,reviewedProfiles=REVIEWED_PROFILE_SHA256}){
 const identity={signature,messageSha256:review?.messageSha256,profileSha256:review?.profileSha256}
 try{
  const bound=validateMaxWalletOperatorBindings({config,profile,dossierJson,connections}),stored=settlementContext.compilationInput,ci={...stored,observations:stored.observations.map(canonicalObservation)}
  check(settlementContext.schema==='repoing/native-trade-settlement-context/1')
  // Reviewed under another (allowlisted) profile: a historical receipt; today's dossier pins (deploy slots, live ELF
  // bytes) describe programs that may have been upgraded since, so they are not checked.
  const historical=!isDeepStrictEqual(ci.profile,profile);check(!historical||reviewedEnvelope(ci.profile,profile,reviewedProfiles))
  const plan=compileNativeSwapReview(ci),p=bound.profile,a=plan.addresses
  check(isDeepStrictEqual(plan.review,review)&&verifyHookLabSignedMessage(review,signedTransactionBase64).signature===signature)
  const selected=plan.request.policyKind==='selected-hook',H=plan.request.selectedHook?.program
  const selectedPins=selected?[H,PublicKey.findProgramAddressSync([pk(H).toBuffer()],pk('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58(),
   PublicKey.findProgramAddressSync([Buffer.from('bordrless-hook-accounts'),pk(plan.request.mint).toBuffer()],pk(H))[0].toBase58()]:[]
  const policies=[...(selected?selectedPins:[a.policy]),a.inclusiveFeePolicy]
  const pins=historical?[]:bound.dossier.programs,pinned=[...new Set(pins.flatMap(x=>[x.address,x.programData]))]
  // The pool and launch move with every trade, so providers at different slots differ there: they are read only to see
  // a graduation (which nothing undoes) and never compared byte for byte.
  const graduation=plan.graduates?[a.launch,a.pool]:[],inventory=[...new Set([...pinned,...policies,...graduation])]
  const rows=await Promise.all(connections.map(async({provider,connection})=>{
   check(await connection.getGenesisHash()===p.genesisHash)
   const tx=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx)return null
   const meta=tx.meta;check(meta&&Array.isArray(meta.innerInstructions)&&meta.err!==undefined)
   const wire=new VersionedTransaction(tx.transaction.message);wire.signatures=tx.transaction.signatures.map(s=>bs58.decode(s))
   check(Buffer.from(wire.serialize()).toString('base64')===signedTransactionBase64)
   const slot=integer(tx.slot);check(pins.every(pin=>pin.deploySlot<=slot));const block=await connection.getBlockSignatures(slot,'finalized')
   check(block&&pk(block.blockhash).toBase58()===block.blockhash&&pk(block.previousBlockhash).toBase58()===block.previousBlockhash
    &&block.blockhash!==block.previousBlockhash&&Array.isArray(block.signatures)
    &&block.signatures.every(s=>bs58.decode(s).length===64&&bs58.encode(bs58.decode(s))===s)
    &&block.signatures.filter(s=>s===signature).length===1&&new Set(block.signatures).size===block.signatures.length
    &&integer(block.parentSlot)<slot&&integer(block.blockHeight)<=review.lastValidBlockHeight
    &&block.blockHeight>=ci.recentBlockhash.currentBlockHeight&&slot>=review.observedSlot)
   const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:meta.loadedAddresses??{writable:[],readonly:[]}})
   const addresses=Array.from({length:keys.length},(_,i)=>keys.get(i).toBase58())
   check(isDeepStrictEqual(addresses,review.accounts.map(x=>x.address)))
   const snapshot=await connection.getMultipleAccountsInfoAndContext(inventory.map(pk),{commitment:'finalized',minContextSlot:slot})
   check(integer(snapshot.context.slot)>=slot&&snapshot.value.length===inventory.length)
   const stateAccounts=snapshot.value.map((v,i)=>({address:inventory[i],account:v?{address:inventory[i],owner:v.owner.toBase58(),executable:v.executable,dataBase64:Buffer.from(v.data).toString('base64')}:null}))
   return {provider,stateAccounts,logs:Array.isArray(meta.logMessages)?meta.logMessages:[],evidence:{slot,parentSlot:block.parentSlot,blockHeight:block.blockHeight,transactionIndex:block.signatures.indexOf(signature),blockhash:block.blockhash,previousBlockhash:block.previousBlockhash,error:meta.err,fee:integer(meta.fee),pre:meta.preBalances,post:meta.postBalances,
     keys:addresses,instructions:tx.transaction.message.compiledInstructions.map(x=>({programIdIndex:x.programIdIndex})),innerInstructions:meta.innerInstructions}}
  }))
  if(rows.some(x=>x===null))return {...identity,status:'unresolved'}
  if(!isDeepStrictEqual(rows[0].evidence,rows[1].evidence))return {...identity,status:'conflict'}
  // Program identities and the immutable policies are rechecked live; the pool and launch only for graduation, which
  // nothing can undo. Mutable trade state is not historical receipt evidence.
  const live=new Map(rows[0].stateAccounts.map(x=>[x.address,x.account]))
  for(const pin of pins){
   const program=live.get(pin.address),data=live.get(pin.programData);check(program&&data&&program.executable&&!data.executable
    &&program.owner==='BPFLoaderUpgradeab1e11111111111111111111111'&&data.owner===program.owner)
   const pb=Buffer.from(program.dataBase64,'base64');check(pb.length===36&&pb.readUInt32LE()===2&&pb.subarray(4).equals(pk(pin.programData).toBuffer()))
   check(sha(Buffer.from(data.dataBase64,'base64'))===pin.programDataSha256)
  }
  for(const address of policies){
   const before=ci.observations[0].accounts.find(x=>x.address===address)?.account
   check(before&&isDeepStrictEqual(live.get(address),(({lamports,...rest})=>rest)(before)))
  }
  const steady=row=>row.stateAccounts.filter(x=>!graduation.includes(x.address))
  check(isDeepStrictEqual(steady(rows[0]),steady(rows[1])))
  const tx=rows[0].evidence,fee=inspectHookLabMessage(review).totalFeeLamports
  check(String(tx.fee)===fee&&tx.pre.length===tx.keys.length&&tx.post.length===tx.keys.length)
  const delta=i=>BigInt(integer(tx.post[i]))-BigInt(integer(tx.pre[i]))
  const inclusion={slot:tx.slot,parentSlot:tx.parentSlot,blockHeight:tx.blockHeight,transactionIndex:tx.transactionIndex,blockhash:tx.blockhash,previousBlockhash:tx.previousBlockhash}
  if(tx.error!==null){
   // A failed transaction moves nothing but its fee.
   check(tx.keys.every((k,i)=>delta(i)===(k===review.payer?-BigInt(fee):0n)))
   // Display only, and only when both providers' logs name the same error.
   const names=rows.map(row=>failureName(row.logs,p.programs)),errorName=names[0]===names[1]?names[0]:null
   return {...identity,status:'finalized-failure',inclusion,feeLamports:fee,errorName,transactionSha256:sha(JSON.stringify(tx))}
  }
  // The fee and a buy's input are exact; a sale's output and the fee on it follow the pool it met. Every account's
  // lamports moved exactly as that executed trade says, and no other account's moved at all.
  const execution=verifyNativeTradeEvents({ci,plan,tx,fee:BigInt(fee)})
  check(tx.keys.every((k,i)=>delta(i)===BigInt(execution.lamportDeltas[k]??'0')))
  // A graduating buy also needs both providers to read the launch graduated and its pool open afterwards.
  if(plan.graduates)for(const row of rows){
   const coders=loadNativeArtifacts().coders,state=new Map(row.stateAccounts.map(x=>[x.address,x.account])),launch=state.get(a.launch),pool=state.get(a.pool)
   check(launch&&pool&&launch.owner===p.programs.launch&&pool.owner===p.programs.swap)
   const l=coders.launch.accounts.decode('Launch',Buffer.from(launch.dataBase64,'base64')),q=coders.swap.accounts.decode('Pool',Buffer.from(pool.dataBase64,'base64'))
   check(l.status===STATUS_GRADUATED&&!l.graduated_at.isZero()&&!q.curve&&q.virtual_base.isZero()&&q.virtual_quote.isZero())
  }
  return {...identity,status:'finalized-success',executionStatus:'finalized-executed',
   reviewSlotBoundExceeded:tx.slot>review.validUntilSlot,reviewSlotCeilingEnforcedOnchain:false,
   policyReviewRequired:execution.quote.priceImpactReviewBoundExceeded||tx.slot>review.validUntilSlot||!execution.curveAsReviewed,
   reviewBoundsSatisfied:!execution.quote.priceImpactReviewBoundExceeded&&tx.slot<=review.validUntilSlot&&execution.curveAsReviewed,
   onchainMinimumOutputSatisfied:true,impactCeilingEnforcedOnchain:false,inclusion,feeLamports:fee,quote:execution.quote,lamportDeltas:execution.lamportDeltas,
   tokenBalances:execution.tokenBalances,...(plan.graduates?{graduated:true}:{}),transactionSha256:sha(JSON.stringify(tx)),authenticatedFeeEvent:true,authenticatedTokenBalanceEvents:true}
 }catch{return {...identity,status:'unresolved'}}
}

// The program error that stopped a failed trade, for the customer's message only: the runtime logs the program that
// raised it ("Program <id> failed: custom program error: 0x..."), and the same name has different numbers in the swap
// and the launch (nativeErrorName, review item I-4), while the gate has its own list. null when it is anything else.
function failureName(logs,P){
 const line=logs.map(x=>/^Program (\w{32,44}) failed: custom program error: 0x([0-9a-f]{1,8})$/.exec(x)).find(Boolean)
 if(!line)return null
 const [,program,hex]=line,code=parseInt(hex,16)
 if(program===P.gate)return loadArtifacts().idls.gate.errors?.find(e=>e.code===code)?.name??null
 return nativeErrorName(program,code,P)
}

// Self-CPI events of the trade, in instruction order, each canonical and under its program's event authority, with the
// complete CPI ancestry. The swap's own three events and its one coin transfer give the executed trade: its exact input,
// the curve output, the inclusive fee on them, and the pool it met, which the quote model must reproduce exactly.
function verifyNativeTradeEvents({ci,plan,tx,fee}){
 const p=JSON.parse(ci.profile.json),r=plan.request,a=plan.addresses,buy=r.side==='buy',P=p.programs,selected=r.policyKind==='selected-hook'
 const {idls,coders}=loadNativeArtifacts(),token={idl:loadArtifacts().idls.token,coder:loadArtifacts().coders.token}
 const bindings={[P.swap]:{idl:idls.swap,coder:coders.swap},[P.launch]:{idl:idls.launch,coder:coders.launch},[P.token]:token}
 const programAt=i=>tx.keys[tx.instructions[i].programIdIndex],swapAt=tx.instructions.findIndex((_,i)=>programAt(i)===P.swap)
 const graduateAt=plan.graduates?swapAt+1:-1,createAt=plan.createsHolding?swapAt-1:-1
 check(swapAt>=2&&(createAt<0||programAt(createAt)===P.token)&&(graduateAt<0||programAt(graduateAt)===P.launch)&&tx.instructions.length===swapAt+1+(plan.graduates?1:0))
 const events=[],groups=new Set()
 for(const group of tx.innerInstructions){check(Number.isInteger(group.index)&&group.index>=0&&group.index<tx.instructions.length&&!groups.has(group.index));groups.add(group.index)
  const stack=[null,programAt(group.index)]
  for(const ix of group.instructions){const program=tx.keys[ix.programIdIndex],h=ix.stackHeight;check(program&&Number.isInteger(h)&&h>=2&&h<=stack.length);stack.length=h;const parent=stack[h-1];stack[h]=program
   const binding=bindings[program];if(!binding)continue
   const bytes=Buffer.from(bs58.decode(ix.data));if(!bytes.subarray(0,8).equals(tag))continue
   check(parent===program&&ix.accounts.length===1&&tx.keys[ix.accounts[0]]===authority(program))
   const event=binding.coder.events.decode(bytes.subarray(8).toString('base64'));check(event)
   const def=binding.idl.events.find(e=>e.name===event.name);check(def&&Buffer.concat([tag,Buffer.from(def.discriminator),binding.coder.types.encode(event.name,event.data)]).equals(bytes))
   events.push({index:group.index,program,caller:stack[h-2],name:event.name,data:event.data})
  }
 }
 const at=(index,program,name)=>events.filter(e=>e.index===index&&e.program===program&&e.name===name).map(e=>e.data)
 check(events.filter(e=>e.index===swapAt).every(e=>(e.program===P.swap&&['InclusiveCreatorFeeAccrued','Swapped','SwappedNative'].includes(e.name))||(e.program===P.token&&e.name==='Transferred'&&e.caller===P.swap)))
 const fees=at(swapAt,P.swap,'InclusiveCreatorFeeAccrued'),swaps=at(swapAt,P.swap,'Swapped'),natives=at(swapAt,P.swap,'SwappedNative'),transfers=at(swapAt,P.token,'Transferred')
 check(fees.length===1&&swaps.length===1&&natives.length===1&&transfers.length===1)
 const [f]=fees,[s]=swaps,[nat]=natives,[e]=transfers
 // create_holding is idempotent: HoldingCreated means it created the trader's holding (and took its rent), none means the
 // holding was already a token-program holding when the buy landed (the swap's transfer into it proves it) and cost nothing.
 const creations=events.filter(x=>x.index===createAt)
 check(creations.length<=1&&creations.every(x=>x.program===P.token&&x.name==='HoldingCreated'&&x.data.holding.toBase58()===a.traderBase
  &&x.data.owner.toBase58()===r.trader&&x.data.mint.toBase58()===r.mint&&x.data.payer.toBase58()===r.trader))
 if(plan.graduates){
  const graduations=at(graduateAt,P.launch,'Graduated'),finals=at(graduateAt,P.swap,'CurveFinalized')
  check(graduations.length===1&&finals.length===1&&graduations[0].launch.toBase58()===a.launch&&graduations[0].mint.toBase58()===r.mint
   &&graduations[0].pool.toBase58()===a.pool&&finals[0].pool.toBase58()===a.pool)
 }else check(events.every(x=>x.index===swapAt||x.index===createAt))
 const q=plan.quote,amount=BigInt(r.amountIn),out=B(s.amount_out),cut=inclusiveCreatorFee(buy?amount:out,r.creatorFeeBps)
 const gross=cut.grossQuote,platform=cut.platformQuote,creator=cut.creatorQuote,delivered=buy&&selected?B(s.delivered_out):buy?out:out-gross
 const received=selected&&!buy?B(s.received_in):amount-(buy?creator:0n)
 const list=x=>x.map(d=>({holding:d.holding.toBase58(),amount:n(d.amount)})),paid=creator>0n?[{holding:a.launch,amount:String(creator)}]:[]
 check(f.version===1&&f.pool.toBase58()===a.pool&&f.quote_mint.toBase58()===p.quoteMint&&f.direction===(buy?1:0)&&f.platform_collector.toBase58()===q.platformCollector
  &&B(f.gross_quote)===gross&&B(f.creator_quote)===creator&&B(f.platform_quote)===platform&&f.creator_holding.toBase58()===(gross===0n?zero:a.launch))
 check(s.pool.toBase58()===a.pool&&s.trader.toBase58()===r.trader&&s.recipient.toBase58()===r.trader&&s.direction===(buy?1:0)&&B(s.amount_in)===amount&&n(s.slot)===String(tx.slot)
  &&B(s.delivered_out)===delivered&&delivered>=BigInt(r.minAmountOut)&&B(s.protocol_fee)===platform&&B(s.lp_fee)===0n&&s.lp_fee_bps===0&&B(s.burn_in)===0n&&B(s.burn_out)===0n
  &&B(s.received_in)===received&&received>0n&&received<=amount&&isDeepStrictEqual(list(s.deltas_in),buy?paid:[])&&isDeepStrictEqual(list(s.deltas_out),buy?[]:paid)
  &&B(s.cuts_in)===(buy?creator:amount-received)&&B(s.cuts_out)===(buy?out-delivered:creator)&&B(s.swap_count)>0n)
 const poolIndex=tx.keys.indexOf(a.pool)
 check(nat.pool.toBase58()===a.pool&&nat.direction===(buy?1:0)&&B(nat.quote_lamports)===(buy?amount-creator:delivered)&&isDeepStrictEqual(list(nat.quote_deltas),paid)
  &&poolIndex>=0&&B(nat.pool_lamports)===BigInt(tx.post[poolIndex]))
 // The one coin transfer: the pool pays the buyer, or the seller pays the pool; its balances give the trader's before.
 const route=buy?{source:a.baseVault,destination:a.traderBase,sourceOwner:a.pool,destinationOwner:r.trader,authority:a.pool,amount:out}
  :{source:a.traderBase,destination:a.baseVault,sourceOwner:r.trader,destinationOwner:a.pool,authority:r.trader,amount}
 check(e.mint.toBase58()===r.mint&&e.source.toBase58()===route.source&&e.destination.toBase58()===route.destination&&e.source_owner.toBase58()===route.sourceOwner
  &&e.destination_owner.toBase58()===route.destinationOwner&&e.authority.toBase58()===route.authority&&B(e.amount)===route.amount&&(selected||e.deltas.length===0)
  &&n(e.slot)===String(tx.slot)&&n(e.ts)===n(s.ts)&&B(buy?e.source_post:e.destination_post)===B(s.base_reserve))
 if(selected){
  const targets=e.deltas.map(d=>d.holding.toBase58()),cutSum=e.deltas.reduce((sum,d)=>sum+B(d.amount),0n)
  check(new Set(targets).size===targets.length&&targets.every(k=>![a.traderBase,a.baseVault].includes(k)&&plan.review.accounts.some(x=>x.address===k&&x.writable&&!x.signer))
   &&cutSum===(buy?out-delivered:amount-received)&&amount<=BigInt(r.maxInput))
 }
 const traderAfter=B(buy?e.destination_post:e.source_post),traderBefore=buy?traderAfter-delivered:traderAfter+amount,vaultAfter=B(s.base_reserve)
 const protocolAfter=B(f.protocol_fees_quote_after),pre={baseReserve:buy?vaultAfter+out:vaultAfter-received,quoteReserve:B(s.quote_reserve)+(buy?gross-amount:out),
  virtualBase:B(s.virtual_base),virtualQuote:B(s.virtual_quote),protocolFeesQuote:protocolAfter-platform}
 check(pre.baseReserve>=0n&&pre.quoteReserve>=0n&&pre.protocolFeesQuote>=0n&&traderBefore>=0n)
 const policy=selected?null:new BorshCoder(JSON.parse(Buffer.from(ci.profile.idls.gate,'base64'))).accounts.decode('PolicyV2',Buffer.from(ci.observations[0].accounts.find(x=>x.address===a.policy).account.dataBase64,'base64'))
 // The gate already applied the max wallet on chain, so receipt arithmetic does not apply it again.
 const actual=selected?selectedNativeMeasuredQuote({...r,graduate:false},pre,{[a.traderBase]:String(buy?delivered:-amount),[a.baseVault]:String(buy?-out:received)},a):modelInclusiveCreatorQuote({side:r.side,amountIn:amount,minAmountOut:BigInt(r.minAmountOut),maxInput:BigInt(r.maxInput),creatorFeeBps:r.creatorFeeBps,
  feeModel:2,protocolShareBps:2500,lpFeeBps:0,flatProtocolFeeBps:0,sniperWindowSecs:0,sniperStartBps:0,quoteHook:'none',modules:0,authorShareBps:0,rules:'none',rewards:false,
  recipientBaseBalance:traderBefore,maxWalletLifted:true,pool:pre,policy:{version:2,feeModel:2,protocolShareBps:2500,creatorFeeBps:r.creatorFeeBps,lpFeeBps:0,initialSupply:B(policy.initial_supply),capBps:r.capBps}})
 check(actual.delivered===delivered&&actual.grossOutput===out&&actual.after.baseReserve===vaultAfter&&actual.after.quoteReserve===B(s.quote_reserve)&&actual.after.protocolFeesQuote===protocolAfter)
 // The swap met the curve the review read (its virtual offsets, which only graduation changes). If the coin graduated in
 // between, the trade still happened, so it settles, but for a person to look at (review-required).
 const reviewed=coders.swap.accounts.decode('Pool',Buffer.from(ci.observations[0].accounts.find(x=>x.address===a.pool).account.dataBase64,'base64'))
 const curveAsReviewed=n(s.virtual_base)===n(reviewed.virtual_base)&&n(s.virtual_quote)===n(reviewed.virtual_quote)
 // The rent a created holding took is what its lamports gained; it is never more than the review stated.
 const holdingIndex=tx.keys.indexOf(a.traderBase),rent=creations.length?BigInt(tx.post[holdingIndex])-BigInt(tx.pre[holdingIndex]):0n
 check(rent>=0n&&rent<=BigInt(q.holdingRentLamports)&&(!plan.createsHolding||holdingIndex>=0))
 const lamportDeltas={[r.trader]:buy?-(fee+amount+rent):delivered-fee,[a.launch]:creator,[a.pool]:buy?amount-creator:-(delivered+creator),...(plan.createsHolding?{[a.traderBase]:rent}:{})}
 return {curveAsReviewed,lamportDeltas:Object.fromEntries(Object.entries(lamportDeltas).map(([k,v])=>[k,String(v)])),
  quote:{...q,delivered:String(delivered),grossCreatorFee:String(gross),protocolFee:String(platform),netCreatorFee:String(creator),priceImpactBps:String(actual.priceImpactBps),
   priceImpactReviewBoundExceeded:actual.priceImpactBps>BigInt(r.maxPriceImpactBps),
   after:{baseReserve:n(s.base_reserve),quoteReserve:n(s.quote_reserve),protocolFeesQuote:String(protocolAfter),swapCount:n(s.swap_count),traderBase:String(traderAfter)}},
  tokenBalances:[{address:a.traderBase,before:String(traderBefore),after:String(traderAfter)},{address:a.baseVault,before:String(pre.baseReserve),after:String(vaultAfter)}]}
}
