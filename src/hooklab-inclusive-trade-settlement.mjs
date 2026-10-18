// Exact-wire, two-provider finalized receipt verification. No retry or resend authority.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {BorshCoder} from '@anchor-lang/core'
import {PublicKey,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import BN from 'bn.js'
import {verifyHookLabSignedMessage,inspectHookLabMessage} from './hooklab-message-boundary.mjs'
import {validateMaxWalletOperatorBindings} from './hooklab-max-wallet-launch-collector.mjs'
import {inclusiveCreatorFee,modelInclusiveCreatorQuote} from './hooklab-inclusive-fee-quote.mjs'
import {compileInclusiveMaxWalletSwapReview} from './hooklab-inclusive-max-wallet-swap.mjs'
const check=v=>{if(!v)throw Error('Inclusive receipt evidence differs')},sha=x=>createHash('sha256').update(x).digest('hex')
const n=x=>x.toString(),pk=x=>new PublicKey(x),tag=Buffer.from('e445a52e51cb9a1d','hex')
const tokenIdlBytes=readFileSync(`${process.cwd()}/vendor/hooklab-production-candidate/idl/bordrless_token.json`)
check(sha(tokenIdlBytes)==='93aaa54d2e0c22e444793ac84387c357d73b745d482becada32d7d6e23d2c506')
const tokenCoder=new BorshCoder(JSON.parse(tokenIdlBytes))
const integer=x=>{check(Number.isSafeInteger(x)&&x>=0);return x}
// Derive exact affected post-state from retained authenticated pre-state and event timestamp.
export function deriveInclusiveTradePostconditions(ci, timestamp) {
 const plan=compileInclusiveMaxWalletSwapReview(ci),q=plan.quote,r=plan.request,a=plan.addresses,buy=r.side==='buy'
 const before=new Map(ci.observations[0].accounts.map(x=>[x.address,x.account]))
 const expected=new Map([...before].map(([address,v])=>[address,v?(({lamports,...rest})=>rest)(v):null]))
 const update=(role,type,address,edit)=>{
  const codec=new BorshCoder(JSON.parse(Buffer.from(ci.profile.idls[role],'base64'))),old=expected.get(address),bytes=Buffer.from(old.dataBase64,'base64')
  const value=codec.accounts.decode(type,bytes);edit(value);const encoded=codec.types.encode(type,value)
  check(encoded.length+8<=bytes.length);encoded.copy(bytes,8);expected.set(address,{...old,dataBase64:bytes.toString('base64')})
 }
 update('swap','Pool',a.pool,v=>{
  v.base_reserve=new BN(q.after.baseReserve);v.quote_reserve=new BN(q.after.quoteReserve);v.protocol_fees_quote=new BN(q.after.protocolFeesQuote)
  v.swap_count=new BN(q.after.swapCount);v.last_swap_at=new BN(String(timestamp))
  v.base_volume=v.base_volume.add(new BN(buy?q.delivered:r.amountIn))
  v.quote_volume=v.quote_volume.add(new BN(String(buy?BigInt(r.amountIn)-BigInt(q.netCreatorFee):BigInt(q.delivered)+BigInt(q.grossCreatorFee))))
 })
 update('launch','Launch',a.launch,v=>{v.creator_fees_accrued=new BN(q.after.creatorFeesAccrued)})
 for(const [name,amount]of [['baseVault',q.after.baseReserve],['quoteVault',q.after.quoteVault],['traderBase',q.after.traderBase],['traderQuote',q.after.traderQuote],['launchQuote',q.after.launchQuote]]){
  const old=expected.get(a[name]),bytes=Buffer.from(old.dataBase64,'base64');bytes.writeBigUInt64LE(BigInt(amount),74);expected.set(a[name],{...old,dataBase64:bytes.toString('base64')})
 }
 return [...expected].map(([address,account])=>({address,account}))
}
export async function collectInclusiveTradeSettlement({config,profile,dossierJson,connections,settlementContext,review,signedTransactionBase64,signature}){
 const identity={signature,messageSha256:review?.messageSha256,profileSha256:review?.profileSha256}
 try{
  const bound=validateMaxWalletOperatorBindings({config,profile,dossierJson,connections}),ci=settlementContext.compilationInput
  check(settlementContext.schema==='repoing/inclusive-trade-settlement-context/1'&&isDeepStrictEqual(ci.profile,profile))
  const plan=compileInclusiveMaxWalletSwapReview(ci),r=plan.request,q=plan.quote,p=bound.profile
  check(isDeepStrictEqual(plan.review,review)&&verifyHookLabSignedMessage(review,signedTransactionBase64).signature===signature)
  const pinned=[...new Set(bound.dossier.programs.flatMap(p=>[p.address,p.programData]))]
  const inventory=[...pinned,plan.addresses.policy,plan.addresses.inclusiveFeePolicy]
  const observedAtMs=Date.now()
  const rows=await Promise.all(connections.map(async({provider,connection})=>{
   check(await connection.getGenesisHash()===p.genesisHash)
   const tx=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx)return null
   const meta=tx.meta;check(meta&&Array.isArray(meta.innerInstructions)&&meta.err!==undefined)
   const wire=new VersionedTransaction(tx.transaction.message);wire.signatures=tx.transaction.signatures.map(s=>bs58.decode(s))
   check(Buffer.from(wire.serialize()).toString('base64')===signedTransactionBase64)
   const slot=integer(tx.slot);check(bound.dossier.programs.every(pin=>pin.deploySlot<=slot));const block=await connection.getBlockSignatures(slot,'finalized')
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
   return {provider,stateAccounts,observation:{provider,genesisHash:p.genesisHash,commitment:'finalized',slot:snapshot.context.slot,observedAtMs,
     accounts:stateAccounts.filter(x=>pinned.includes(x.address)).map(x=>{check(x.account);return x.account})},
    evidence:{slot,parentSlot:block.parentSlot,blockHeight:block.blockHeight,transactionIndex:block.signatures.indexOf(signature),blockhash:block.blockhash,previousBlockhash:block.previousBlockhash,error:meta.err,fee:integer(meta.fee),pre:meta.preBalances,post:meta.postBalances,
     keys:addresses,instructions:tx.transaction.message.compiledInstructions.map(x=>({programIdIndex:x.programIdIndex})),innerInstructions:meta.innerInstructions}}
  }))
  if(rows.some(x=>x===null))return {...identity,status:'unresolved'}
  if(!isDeepStrictEqual(rows[0].evidence,rows[1].evidence))return {...identity,status:'conflict'}
  // Mutable pool/config/holding state is not historical receipt evidence. Only
  // exact executable identities and immutable policy bytes are rechecked here.
  const live=new Map(rows[0].stateAccounts.map(x=>[x.address,x.account]))
  for(const pin of bound.dossier.programs){
   const program=live.get(pin.address),data=live.get(pin.programData);check(program&&data&&program.executable&&!data.executable
    &&program.owner==='BPFLoaderUpgradeab1e11111111111111111111111'&&data.owner===program.owner)
   const pb=Buffer.from(program.dataBase64,'base64');check(pb.length===36&&pb.readUInt32LE()===2&&pb.subarray(4).equals(pk(pin.programData).toBuffer()))
   check(sha(Buffer.from(data.dataBase64,'base64'))===pin.programDataSha256)
  }
  for(const address of [plan.addresses.policy,plan.addresses.inclusiveFeePolicy]){
   const before=ci.observations[0].accounts.find(x=>x.address===address)?.account
   check(before&&isDeepStrictEqual(live.get(address),(({lamports,...rest})=>rest)(before)))
  }
  check(isDeepStrictEqual(rows[0].stateAccounts,rows[1].stateAccounts))
  const tx=rows[0].evidence,fee=inspectHookLabMessage(review).totalFeeLamports
  check(String(tx.fee)===fee&&tx.pre.length===tx.keys.length&&tx.post.length===tx.keys.length)
  check(tx.keys.every((k,i)=>BigInt(integer(tx.post[i]))-BigInt(integer(tx.pre[i]))===(k===review.payer?-BigInt(fee):0n)))
  const inclusion={slot:tx.slot,parentSlot:tx.parentSlot,blockHeight:tx.blockHeight,transactionIndex:tx.transactionIndex,blockhash:tx.blockhash,previousBlockhash:tx.previousBlockhash}
  if(tx.error!==null)return {...identity,status:'finalized-failure',inclusion,feeLamports:fee,transactionSha256:sha(JSON.stringify(tx))}
  const idl=JSON.parse(Buffer.from(profile.idls.swap,'base64')),coder=new BorshCoder(idl),events=[],transfers=[]
  const eventAuthority=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],pk(p.programs.swap))[0].toBase58(),groups=new Set()
  for(const group of tx.innerInstructions){check(Number.isInteger(group.index)&&group.index>=0&&group.index<tx.instructions.length&&!groups.has(group.index));groups.add(group.index)
   const stack=[null,tx.keys[tx.instructions[group.index].programIdIndex]]
   for(const ix of group.instructions){const program=tx.keys[ix.programIdIndex],h=ix.stackHeight;check(program&&Number.isInteger(h)&&h>=2&&h<=stack.length);stack.length=h;const parent=stack[h-1];stack[h]=program
    if(program===p.programs.token){
     const bytes=Buffer.from(bs58.decode(ix.data));if(!bytes.subarray(0,8).equals(tag))continue
     const authority=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],pk(program))[0].toBase58()
     check(group.index===2&&parent===program&&stack[h-2]===p.programs.swap&&ix.accounts.length===1&&tx.keys[ix.accounts[0]]===authority)
     const event=tokenCoder.events.decode(bytes.subarray(8).toString('base64'));check(event?.name==='Transferred')
     const def=JSON.parse(tokenIdlBytes).events.find(x=>x.name===event.name)
     check(Buffer.concat([tag,Buffer.from(def.discriminator),tokenCoder.types.encode(event.name,event.data)]).equals(bytes))
     transfers.push(event.data);continue
    }
    if(program!==p.programs.swap)continue
    const bytes=Buffer.from(bs58.decode(ix.data));if(!bytes.subarray(0,8).equals(tag))continue
    check(group.index===2&&parent===program&&ix.accounts.length===1&&tx.keys[ix.accounts[0]]===eventAuthority)
    const event=coder.events.decode(bytes.subarray(8).toString('base64'));check(event)
    const def=idl.events.find(e=>e.name===event.name);check(Buffer.concat([tag,Buffer.from(def.discriminator),coder.types.encode(event.name,event.data)]).equals(bytes))
    if(['InclusiveCreatorFeeAccrued','Swapped'].includes(event.name))events.push(event)
   }
  }
  check(events.length===2)
  const f=events.find(x=>x.name==='InclusiveCreatorFeeAccrued')?.data,s=events.find(x=>x.name==='Swapped')?.data,buy=r.side==='buy'
  const execution=verifyInclusiveTradeExecution({ci,plan,feeEvent:f,swapEvent:s,transfers,slot:tx.slot})
  return {...identity,status:'finalized-success',executionStatus:'finalized-executed',
   reviewSlotBoundExceeded:tx.slot>review.validUntilSlot,reviewSlotCeilingEnforcedOnchain:false,
   policyReviewRequired:execution.quote.priceImpactReviewBoundExceeded||tx.slot>review.validUntilSlot,reviewBoundsSatisfied:!execution.quote.priceImpactReviewBoundExceeded&&tx.slot<=review.validUntilSlot,
   onchainMinimumOutputSatisfied:true,impactCeilingEnforcedOnchain:false,inclusion,feeLamports:fee,quote:execution.quote,
   tokenBalances:execution.tokenBalances,transactionSha256:sha(JSON.stringify(tx)),authenticatedFeeEvent:true,authenticatedTokenBalanceEvents:true}
 }catch{return {...identity,status:'unresolved'}}
}

// Called only after the collector authenticates canonical self-CPI event bytes,
// complete ordered CPI ancestry, exact signed wire and two-provider inclusion.
export function verifyInclusiveTradeExecution({ci,plan,feeEvent:f,swapEvent:s,transfers,slot}) {
 const r=plan.request,p=JSON.parse(ci.profile.json),a=plan.addresses,buy=r.side==='buy',B=x=>BigInt(n(x))
 check(f&&s&&f.version===1&&f.pool.toBase58()===a.pool&&f.quote_mint.toBase58()===p.quoteMint&&f.direction===(buy?1:0)
  &&f.platform_collector.toBase58()===plan.quote.platformCollector&&s.pool.toBase58()===a.pool&&s.trader.toBase58()===r.trader
  &&s.recipient.toBase58()===r.recipient&&s.direction===(buy?1:0)&&n(s.amount_in)===r.amountIn&&n(s.slot)===String(slot))
 const fees=inclusiveCreatorFee(buy?BigInt(r.amountIn):B(s.amount_out),r.creatorFeeBps),gross=fees.grossQuote,creator=fees.creatorQuote,platform=fees.platformQuote
 check(B(f.gross_quote)===gross&&B(f.creator_quote)===creator&&B(f.platform_quote)===platform&&B(s.protocol_fee)===platform
  &&f.creator_holding.toBase58()===(gross===0n?'11111111111111111111111111111111':a.launchQuote)
  &&B(s.delivered_out)===(buy?B(s.amount_out):B(s.amount_out)-gross)&&B(s.delivered_out)>=BigInt(r.minAmountOut)
  &&B(s.lp_fee)===0n&&s.lp_fee_bps===0&&B(s.burn_in)===0n&&B(s.burn_out)===0n)
 const expectedCut=creator>0n?[{holding:a.launchQuote,amount:String(creator)}]:[]
 const cut=list=>list.map(x=>({holding:x.holding.toBase58(),amount:n(x.amount)}))
 check(isDeepStrictEqual(cut(s.deltas_in),buy?expectedCut:[])&&isDeepStrictEqual(cut(s.deltas_out),buy?[]:expectedCut)
  &&B(s.cuts_in)===(buy?creator:0n)&&B(s.cuts_out)===(buy?0n:creator)
  &&B(s.received_in)===BigInt(r.amountIn)-(buy?creator:0n)&&B(s.swap_count)>0n)
 const routes=[],route=(mint,source,destination,sourceOwner,destinationOwner,authority,amount)=>routes.push({mint,source,destination,sourceOwner,destinationOwner,authority,amount})
 if(buy){
  if(creator>0n)route(p.quoteMint,a.traderQuote,a.launchQuote,r.trader,a.launch,r.trader,creator)
  route(p.quoteMint,a.traderQuote,a.quoteVault,r.trader,a.pool,r.trader,BigInt(r.amountIn)-creator)
  route(r.mint,a.baseVault,a.traderBase,a.pool,r.recipient,a.pool,B(s.delivered_out))
 }else{
  route(r.mint,a.traderBase,a.baseVault,r.trader,a.pool,r.trader,BigInt(r.amountIn))
  if(creator>0n)route(p.quoteMint,a.quoteVault,a.launchQuote,a.pool,a.launch,a.pool,creator)
  route(p.quoteMint,a.quoteVault,a.traderQuote,a.pool,r.recipient,a.pool,B(s.delivered_out))
 }
 check(transfers.length===routes.length)
 const initial=new Map(),current=new Map()
 const balance=(address,before,after)=>{check(before>=0n&&before<=0xffffffffffffffffn&&after>=0n&&after<=0xffffffffffffffffn)
  if(current.has(address))check(current.get(address)===before);else initial.set(address,before);current.set(address,after)}
 for(let i=0;i<routes.length;i++){
  const e=transfers[i],v=routes[i];check(e.mint.toBase58()===v.mint&&e.source.toBase58()===v.source&&e.destination.toBase58()===v.destination
   &&e.source_owner.toBase58()===v.sourceOwner&&e.destination_owner.toBase58()===v.destinationOwner&&e.authority.toBase58()===v.authority
   &&B(e.amount)===v.amount&&e.deltas.length===0&&n(e.slot)===String(slot)&&n(e.ts)===n(s.ts))
  balance(v.source,B(e.source_post)+v.amount,B(e.source_post));balance(v.destination,B(e.destination_post)-v.amount,B(e.destination_post))
 }
 check(current.get(a.baseVault)===B(s.base_reserve)&&current.get(a.quoteVault)===B(s.quote_reserve)+B(f.protocol_fees_quote_after))
 const priorProtocol=B(f.protocol_fees_quote_after)-platform;check(priorProtocol>=0n)
 const bytes=Buffer.from(ci.observations[0].accounts.find(x=>x.address===a.policy).account.dataBase64,'base64')
 const policy=new BorshCoder(JSON.parse(Buffer.from(ci.profile.idls.gate,'base64'))).accounts.decode('PolicyV2',bytes)
 const oldPool=new BorshCoder(JSON.parse(Buffer.from(ci.profile.idls.swap,'base64'))).accounts.decode('Pool',Buffer.from(ci.observations[0].accounts.find(x=>x.address===a.pool).account.dataBase64,'base64'))
 check(n(s.virtual_base)===n(oldPool.virtual_base)&&n(s.virtual_quote)===n(oldPool.virtual_quote))
 const actual=modelInclusiveCreatorQuote({side:r.side,amountIn:BigInt(r.amountIn),minAmountOut:BigInt(r.minAmountOut),maxInput:BigInt(r.maxInput),creatorFeeBps:r.creatorFeeBps,
  feeModel:2,protocolShareBps:2500,lpFeeBps:0,flatProtocolFeeBps:0,sniperWindowSecs:0,sniperStartBps:0,quoteHook:'none',modules:0,authorShareBps:0,rules:'none',rewards:false,
  recipientBaseBalance:initial.get(a.traderBase),pool:{baseReserve:initial.get(a.baseVault),quoteReserve:initial.get(a.quoteVault)-priorProtocol,
   virtualBase:B(s.virtual_base),virtualQuote:B(s.virtual_quote),protocolFeesQuote:priorProtocol},
  policy:{version:2,feeModel:2,protocolShareBps:2500,creatorFeeBps:r.creatorFeeBps,lpFeeBps:0,initialSupply:B(policy.initial_supply),capBps:r.capBps}})
 check(actual.delivered===B(s.delivered_out)&&actual.grossOutput===B(s.amount_out)&&actual.after.baseReserve===B(s.base_reserve)&&actual.after.quoteReserve===B(s.quote_reserve))
 return {quote:{...plan.quote,priceImpactBps:String(actual.priceImpactBps),priceImpactReviewBoundExceeded:actual.priceImpactBps>BigInt(r.maxPriceImpactBps),delivered:n(s.delivered_out),protocolFee:String(platform),grossCreatorFee:String(gross),netCreatorFee:String(creator),
  after:{baseReserve:n(s.base_reserve),quoteReserve:n(s.quote_reserve),protocolFeesQuote:n(f.protocol_fees_quote_after),swapCount:n(s.swap_count)}},
  tokenBalances:[...initial].map(([address,before])=>({address,before:String(before),after:String(current.get(address))}))}
}
