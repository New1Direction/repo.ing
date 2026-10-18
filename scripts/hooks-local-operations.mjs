// Explicit LOCAL-ONLY operations absent from the public production release.
// Uses the same durable sign-once/send-once lifecycle and real validator receipts.
import { sign } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ComputeBudgetProgram, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { nativeTransactionSender } from '../src/hooklab-native-transaction-sender.mjs'
import { inspectHookLabMessage, verifyHookLabSignedMessage } from '../src/hooklab-message-boundary.mjs'
import { readProductionEvidence } from '../src/hooklab-production-rpc.mjs'
import { localAcceptanceNetwork } from '../src/hooklab-local-acceptance.mjs'
import { readInclusiveFeePolicy } from '../src/hooklab-inclusive-fee-abi.mjs'
import { localInstruction, pda, pk, sha } from './hooks-local-common.mjs'
const check=value=>{if(!value)throw Error('Local operation identity, bytes or account state changed')}
const eventTag=Buffer.from('e445a52e51cb9a1d','hex')
export function createLocalOperationsRuntime({pool,base,bundle,chain,privateKey}){
 const network=localAcceptanceNetwork();check(network&&network.genesisHash===chain.genesisHash)
 const {connections,profile,config,dossierJson}=base,p=bundle.profile,L=p.programs.launch,S=p.programs.swap,T=p.programs.token
 const configurationSha256=sha(JSON.stringify({config,scope:'LOCAL-ONLY-HOLDING-AND-COLLECTION'}))
 const holding=(mint,owner)=>pda(T,'holding',pk(mint).toBuffer(),pk(owner).toBuffer())
 async function snapshot(addresses){
  const rows=await Promise.all(connections.map(async({connection})=>{check(await connection.getGenesisHash()===network.genesisHash);const result=await connection.getMultipleAccountsInfoAndContext(addresses.map(pk),{commitment:'finalized'});return result.value.map(a=>a&&({owner:a.owner.toBase58(),executable:a.executable,data:Buffer.from(a.data).toString('base64')}))}))
  check(isDeepStrictEqual(rows[0],rows[1]));return new Map(addresses.map((address,i)=>[address,rows[0][i]]))
 }
 const decode=(map,address,role,name)=>{const a=map.get(address);check(a&&!a.executable&&a.owner===p.programs[role]);return bundle.coders[role].accounts.decode(name,Buffer.from(a.data,'base64'))}
 async function build({owner,stage,intent,expectedReview,originalContext}){
  check(localAcceptanceNetwork()&&owner===chain.roles.wallet&&['local-prepare-holding','local-inclusive-collection'].includes(stage))
  const mint=pk(intent.mint).toBase58(),kind=stage==='local-prepare-holding'?'prepare-trading':'collect-fees';check(intent.kind===kind)
  const evidence=await readProductionEvidence({dossierJson,expectedSha256:config.dossierSha256,providers:connections});check(evidence.accountBindingsMatched)
  const launch=pda(L,'launch',pk(mint).toBuffer()),baseHolding=holding(mint,owner),launchQuote=holding(p.quoteMint,launch),creatorQuote=holding(p.quoteMint,owner),collectorQuote=holding(p.quoteMint,config.treasury)
  const first=await snapshot([launch]),launchState=decode(first,launch,'launch','Launch')
  check(launchState.creator.toBase58()===owner&&launchState.mint.toBase58()===mint&&launchState.quote_mint.toBase58()===p.quoteMint&&launchState.creator_fee_bps===100&&launchState.author_share_bps===0)
  const pool=launchState.pool.toBase58(),policy=pda(S,'inclusive-fee-policy',pk(pool).toBuffer()),quoteVault=holding(p.quoteMint,pool)
  const state=await snapshot([launch,pool,policy,baseHolding,launchQuote,creatorQuote,collectorQuote,quoteVault])
  const policyAccount=state.get(policy);check(policyAccount)
  const feePolicy=readInclusiveFeePolicy({...policyAccount,address:policy,data:Buffer.from(policyAccount.data,'base64'),signer:false,writable:false},S,pool),poolState=decode(state,pool,'swap','Pool')
  check(feePolicy.collector===config.treasury&&poolState.fee_model===2)
  let rent=0,creatorDue='0',platformDue='0',instructions=[]
  const tokenValues={token_program:T,token_event_authority:pda(T,'__event_authority')}
  if(kind==='prepare-trading'){
   check(state.get(baseHolding)===null)
   instructions=[localInstruction(bundle,'token','create_holding',{}, {payer:owner,mint,owner,holding:baseHolding})]
   rent=await connections[0].connection.getMinimumBalanceForRentExemption(204,'finalized')
  }else{
   creatorDue=decode(state,launchQuote,'token','Holding').amount.toString();platformDue=poolState.protocol_fees_quote.toString()
   check(BigInt(creatorDue)+BigInt(platformDue)>0n)
   if(BigInt(creatorDue)>0n)instructions.push(localInstruction(bundle,'launch','claim_creator_fees',{}, {creator:owner,launch,quote_mint:p.quoteMint,launch_quote:launchQuote,creator_quote:creatorQuote,...tokenValues}))
   if(BigInt(platformDue)>0n){const collect=localInstruction(bundle,'swap','collect_protocol_fees',{quote_hook_accounts:0},{admin:config.reviewer,pool,quote_mint:p.quoteMint,quote_vault:quoteVault,collector_quote:collectorQuote,...tokenValues});collect.keys.push({pubkey:pk(policy),isWritable:false,isSigner:false});instructions.push(collect)}
  }
  const slot=await connections[0].connection.getSlot('finalized'),now=Date.now(),latest=expectedReview?{blockhash:VersionedMessage.deserialize(Buffer.from(expectedReview.messageBase64,'base64')).recentBlockhash,lastValidBlockHeight:expectedReview.lastValidBlockHeight}:await connections[0].connection.getLatestBlockhash('finalized')
  const table=await connections[0].connection.getAddressLookupTable(pk(chain.lookupTable),{commitment:'finalized'});check(table.value)
  const message=new TransactionMessage({payerKey:pk(owner),recentBlockhash:latest.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),...instructions]}).compileToV0Message([table.value])
  const tx=new VersionedTransaction(message),keys=message.getAccountKeys({addressLookupTableAccounts:[table.value]}),tableAccount=await connections[0].connection.getAccountInfo(pk(chain.lookupTable),'finalized')
  const fee=await connections[0].connection.getFeeForMessage(message,'finalized');check(fee.value===message.header.numRequiredSignatures*5000)
  const review={schema:'hooklab-message-review/1',operation:stage,genesisHash:network.genesisHash,profileSha256:profile.expectedSha256,policySha256:sha(JSON.stringify([...state])),intentSha256:sha(JSON.stringify({kind,mint})),payer:owner,wallet:owner,
   messageBase64:Buffer.from(message.serialize()).toString('base64'),messageSha256:sha(message.serialize()),requiredSigners:message.staticAccountKeys.slice(0,message.header.numRequiredSignatures).map(x=>x.toBase58()),
   accounts:Array.from({length:keys.length},(_,i)=>({address:keys.get(i).toBase58(),signer:message.isAccountSigner(i),writable:message.isAccountWritable(i)})),
   lookupTables:message.addressTableLookups.length?[{address:chain.lookupTable,owner:tableAccount.owner.toBase58(),dataBase64:tableAccount.data.toString('base64'),sha256:sha(tableAccount.data)}]:[],
   observedSlot:slot,validUntilSlot:expectedReview?.validUntilSlot??Math.min(...(await Promise.all(connections.map(({connection})=>connection.getSlot('confirmed')))))+96,observedAtMs:now,reviewExpiresAtMs:expectedReview?.reviewExpiresAtMs??now+60000,lastValidBlockHeight:latest.lastValidBlockHeight,
   baseFeeLamports:String(fee.value),maxFeeLamports:String(fee.value),instructionDebitLamports:String(rent),maxNativeDebitLamports:String(rent+fee.value)}
  inspectHookLabMessage(review)
  const quote={kind,mint,launch,pool,policy,baseHolding,launchQuote,creatorQuote,collectorQuote,quoteVault,creatorDue,platformDue,collector:config.treasury}
  if(expectedReview){const stable=r=>{const{observedSlot,observedAtMs,policySha256,...rest}=r;return rest};check(isDeepStrictEqual(stable(review),stable(expectedReview))&&isDeepStrictEqual(quote,originalContext.quote))}
  await Promise.all(connections.map(async({connection})=>{check((await connection.isBlockhashValid(latest.blockhash,{commitment:'finalized'})).value);check((await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:false,commitment:'finalized'})).value.err===null)}))
  check(Date.now()<review.reviewExpiresAtMs)
  return {status:'operator-pins-and-state-verified',owner,stage,profileSha256:profile.expectedSha256,messageSha256:review.messageSha256,observedAdmin:config.reviewer,configurationSha256,
   review:expectedReview??review,request:{kind,mint,quote},settlementContext:{schema:'repoing/local-operation-settlement/1',quote,request:{kind,mint}},canSign:false,canSubmit:false}
 }
 function events(transaction){
  const keys=transaction.transaction.message.getAccountKeys({accountKeysFromLookups:transaction.meta.loadedAddresses??{writable:[],readonly:[]}}),out=[]
  const addresses=Array.from({length:keys.length},(_,i)=>keys.get(i).toBase58()),top=transaction.transaction.message.compiledInstructions,groups=new Set()
  for(const group of transaction.meta.innerInstructions){check(Number.isInteger(group.index)&&group.index>=0&&group.index<top.length&&!groups.has(group.index));groups.add(group.index)
   const root=addresses[top[group.index].programIdIndex],stack=[null,root]
   for(const ix of group.instructions){const program=addresses[ix.programIdIndex],height=ix.stackHeight;check(program&&Number.isInteger(height)&&height>=2&&height<=stack.length);stack.length=height;const parent=stack[height-1];stack[height]=program
    const role=Object.entries(p.programs).find(([,id])=>id===program)?.[0],coder=bundle.coders[role];if(!coder)continue
    const data=Buffer.from(bs58.decode(ix.data));if(!data.subarray(0,8).equals(eventTag))continue
    check(parent===program&&ix.accounts.length===1&&addresses[ix.accounts[0]]===pda(program,'__event_authority')&&[L,S,T].includes(root))
    if(program===T&&root!==T)check([L,S].includes(stack[height-2]))
    const event=coder.events.decode(data.subarray(8).toString('base64'));check(event)
    const idl=JSON.parse(role==='token'?bundle.tokenIdl:bundle.idls[role]),definition=idl.events.find(e=>e.name===event.name)
    check(Buffer.concat([eventTag,Buffer.from(definition.discriminator),coder.types.encode(event.name,event.data)]).equals(data));out.push({program,name:event.name,data:event.data})
   }
  }return out
 }
 async function reconcile(input){
  const identity={signature:input.signature,messageSha256:input.review.messageSha256,profileSha256:input.review.profileSha256},q=input.settlementContext.quote
  try{
   check(localAcceptanceNetwork()&&input.configurationSha256===configurationSha256&&verifyHookLabSignedMessage(input.review,input.signedTransactionBase64).signature===input.signature)
   const rows=await Promise.all(connections.map(async({connection})=>{check(await connection.getGenesisHash()===network.genesisHash);const tx=await connection.getTransaction(input.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx)return null
    const actual=new VersionedTransaction(tx.transaction.message);actual.signatures=tx.transaction.signatures.map(s=>bs58.decode(s));check(Buffer.from(actual.serialize()).toString('base64')===input.signedTransactionBase64&&tx.meta&&Array.isArray(tx.meta.innerInstructions))
    const block=await connection.getBlockSignatures(tx.slot,'finalized');check(block&&block.signatures.filter(s=>s===input.signature).length===1&&block.blockHeight<=input.review.lastValidBlockHeight)
    return {tx,block}
   }))
   if(rows.some(row=>!row))return {...identity,status:'unresolved'}
   check(isDeepStrictEqual(rows[0],rows[1]));const{tx,block}=rows[0],inclusion={slot:tx.slot,blockHeight:block.blockHeight,blockhash:block.blockhash,previousBlockhash:block.previousBlockhash}
   check(String(tx.meta.fee)===input.review.baseFeeLamports)
   if(tx.meta.err!==null)return {...identity,status:'finalized-failure',inclusion,feeLamports:String(tx.meta.fee)}
   const decoded=events(tx)
   if(q.kind==='prepare-trading'){
    const holdingState=await snapshot([q.baseHolding]),account=decode(holdingState,q.baseHolding,'token','Holding')
    check(account.owner.toBase58()===input.owner&&account.mint.toBase58()===q.mint&&!account.frozen&&account.amount.isZero())
   }else{
    const transfer=decoded.filter(e=>e.program===T&&e.name==='Transferred').map(e=>e.data),routes=[]
    if(BigInt(q.creatorDue)>0n){routes.push({source:q.launchQuote,destination:q.creatorQuote,authority:q.launch,amount:q.creatorDue});const event=decoded.filter(e=>e.program===L&&e.name==='CreatorFeesClaimed');check(event.length===1&&event[0].data.creator.toBase58()===input.owner&&event[0].data.amount.toString()===q.creatorDue)}
    if(BigInt(q.platformDue)>0n){routes.push({source:q.quoteVault,destination:q.collectorQuote,authority:q.pool,amount:q.platformDue});const event=decoded.filter(e=>e.program===S&&e.name==='ProtocolFeesCollected');check(event.length===1&&event[0].data.collector.toBase58()===q.collector&&event[0].data.quote_amount.toString()===q.platformDue)}
    check(transfer.length===routes.length)
    for(let i=0;i<routes.length;i++){const event=transfer[i],route=routes[i];check(event.mint.toBase58()===p.quoteMint&&event.source.toBase58()===route.source&&event.destination.toBase58()===route.destination&&event.authority.toBase58()===route.authority&&event.amount.toString()===route.amount&&event.slot.toString()===String(tx.slot)&&event.deltas.length===0)}
   }
   const reviewSlotBoundExceeded=tx.slot>input.review.validUntilSlot
   return {...identity,status:'finalized-success',executionStatus:'finalized-executed',reviewSlotBoundExceeded,
    reviewSlotCeilingEnforcedOnchain:false,policyReviewRequired:reviewSlotBoundExceeded,reviewBoundsSatisfied:!reviewSlotBoundExceeded,
    inclusion,feeLamports:String(tx.meta.fee),quote:{netCreatorFee:q.creatorDue,protocolFee:q.platformDue,platformCollector:q.collector}}
  }catch{return {...identity,status:'unresolved'}}
 }
 const resolver={prepare:build,revalidate:input=>{check(input.configurationSha256===configurationSha256);return build({...input,intent:input.settlementContext.request,expectedReview:input.review,originalContext:input.settlementContext})},reconcile}
 const serverSigner={async sign(input){check(localAcceptanceNetwork()&&input.signerAddress===chain.roles.admin&&input.observedAdmin===chain.roles.admin&&sha(input.message)===input.messageSha256&&input.stage==='local-inclusive-collection');return new Uint8Array(sign(null,input.message,privateKey))}}
 const lifecycle=nativeSigningLifecycle(pool,{enabled:true,origin:network.origin,resolver,serverSigner,sender:nativeTransactionSender({enabled:true,connections}),
  stageOperations:{'local-prepare-holding':'local-prepare-holding','local-inclusive-collection':'local-inclusive-collection'}})
 return Object.freeze({origin:network.origin,lifecycle,admin:chain.roles.admin})
}
