// Server-only lifecycle. All signing/send dependencies are unconfigured by default.
// Explicit operator activation and a deployment/state resolver are required; no env discovery.
import { createPublicKey,verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PublicKey,VersionedMessage,VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { z } from 'zod'
import { inspectHookLabMessage,verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'
import { lockWalletPrincipal } from './hooklab-wallet-principal-lock.mjs'
import { localAcceptanceNetwork } from './hooklab-local-acceptance.mjs'
const fail=()=>Object.assign(Error('Native signing operation unavailable or changed; preserve the original identity'),{code:'NATIVE_SIGNING_UNAVAILABLE'})
const check=value=>{if(!value)throw fail()}
function context(resolved){
 check(typeof resolved.configurationSha256==='string'&&/^[a-f0-9]{64}$/.test(resolved.configurationSha256))
 check(resolved.settlementContext&&typeof resolved.settlementContext==='object')
 const serialized=JSON.stringify(resolved.settlementContext);check(Buffer.byteLength(serialized)<=64*1024*1024)
 return {configurationSha256:resolved.configurationSha256,settlementContext:JSON.parse(serialized)}
}
const pending=new Set(['reviewed','partial','signed'])
function transactionBytes(review,wire){
 const raw=Buffer.from(wire,'base64');check(raw.length<=1232&&raw.toString('base64')===wire)
 const tx=VersionedTransaction.deserialize(raw);check(Buffer.from(tx.serialize()).equals(raw)&&Buffer.from(tx.message.serialize()).toString('base64')===review.messageBase64)
 check(tx.signatures.length===review.requiredSigners.length)
 for(const [i,key] of review.requiredSigners.entries())if(tx.signatures[i].some(x=>x!==0)){
  const pub=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(key).toBuffer()]),format:'der',type:'spki'})
  check(verify(null,tx.message.serialize(),pub,tx.signatures[i]))
 }
 return tx
}
const wire=tx=>Buffer.from(tx.serialize()).toString('base64')
const complete=tx=>tx.signatures.every(s=>s.some(x=>x!==0))
function publicSettlement(row){
 const value=row.first_finalized??row.first_conflict;if(!value)return null
 const take=(object,keys)=>Object.fromEntries(keys.filter(k=>typeof object?.[k]==='boolean'||(typeof object?.[k]==='string'&&object[k].length<=256)||(Number.isSafeInteger(object?.[k])&&object[k]>=0)).map(k=>[k,object[k]]))
 return Object.freeze({...take(value,['status','executionStatus','policyReviewRequired','reviewBoundsSatisfied','reviewSlotBoundExceeded','onchainMinimumOutputSatisfied','impactCeilingEnforcedOnchain','signature','messageSha256','profileSha256','feeLamports']),
  evidenceConflict:!!row.first_conflict,inclusion:take(value.inclusion,['slot','blockHeight','blockhash','previousBlockhash']),
  quote:take(value.quote,['delivered','priceImpactBps','priceImpactReviewBoundExceeded','grossCreatorFee','protocolFee','netCreatorFee','platformCollector'])})
}
const summary=row=>Object.freeze({id:row.id,owner:row.owner_wallet,custodyOperationId:row.custody_operation_id,stage:row.stage,profileSha256:row.profile_sha256,
 messageSha256:row.message_sha256,status:row.status,revision:String(row.revision),signature:row.signature,review:row.review,request:row.resolved_request,configurationSha256:row.configuration_sha256,
 signedBy:transactionBytes(row.review,row.partial_transaction).signatures.flatMap((s,i)=>s.some(x=>x!==0)?[row.review.requiredSigners[i]]:[]),
 walletRequestIssued:row.wallet_requested_at!=null,settlement:publicSettlement(row),executionAuthorized:false,canSign:false,canSubmit:false})
export function nativeSigningLifecycle(pool,{enabled=false,origin,resolver=null,serverSigner=null,sender=null,custodyAdapter=null,stageOperations={preparation:'max-wallet-preparation',launch:'max-wallet-launch'}}={}){
 const operations=Object.freeze({...stageOperations}),allowed={preparation:['max-wallet-preparation','inclusive-max-wallet-preparation'],launch:['max-wallet-launch'],'inclusive-buy':['inclusive-max-wallet-buy'],'inclusive-sell':['inclusive-max-wallet-sell'],
  ...(localAcceptanceNetwork()?{'local-prepare-holding':['local-prepare-holding'],'local-inclusive-collection':['local-inclusive-collection']}:{})}
 check(Object.keys(operations).length>0&&Object.entries(operations).every(([stage,operation])=>allowed[stage]?.includes(operation)))
 check(!custodyAdapter||Object.keys(operations).every(stage=>['preparation','launch'].includes(stage)))
 async function transaction(sessionToken,id,work,custodyOperationId=null,retainClaimedSignature=false){
  let db
  try{
   check(enabled===true);z.uuid().parse(id);db=await pool.connect();await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`native-signing:${id}`])
   const {rows:[row]}=await db.query('select * from hook_lab_native_signing_operations where id=$1 for update',[id])
   const lockedCustody=custodyAdapter?await custodyAdapter.lock(db,row?.custody_operation_id??custodyOperationId):null
   const principal=await lockWalletPrincipal(db,sessionToken,origin)
   if(lockedCustody)check(lockedCustody.owner===principal.wallet)
   if(row){check(row.owner_wallet===principal.wallet&&operations[row.stage]===row.review.operation);inspectHookLabMessage(row.review);transactionBytes(row.review,row.partial_transaction)}
   const result=await work(db,row,principal.wallet)
   // Session is share-locked through commit; expiry still blocks new work.
   if(!retainClaimedSignature)await lockWalletPrincipal(db,sessionToken,origin)
   await db.query('commit');return result
  }catch{try{await db?.query('rollback')}catch{}throw fail()}finally{if(db)custodyAdapter?.release(db);db?.release()}
 }
 async function currentReview(db,review){
  const {rows:[clock]}=await db.query('select clock_timestamp() as now')
  check(clock.now.getTime()>=review.observedAtMs&&clock.now.getTime()<review.reviewExpiresAtMs)
 }
 async function fresh(row,owner,sessionToken){
  check(resolver&&typeof resolver.revalidate==='function')
  const verified=await resolver.revalidate({sessionToken,owner,custodyOperationId:row.custody_operation_id,stage:row.stage,review:structuredClone(row.review),configurationSha256:row.configuration_sha256,settlementContext:structuredClone(row.settlement_context)})
  // A trusted server resolver must verify pinned deployment, exact stage state,
  // grants/custody, lifetime, simulation and fees. HTTP never supplies this object.
  check(verified?.status==='operator-pins-and-state-verified'&&verified.owner===owner&&verified.stage===row.stage
   &&verified.profileSha256===row.profile_sha256&&verified.messageSha256===row.message_sha256
   &&verified.configurationSha256===row.configuration_sha256)
  return verified
 }
 async function save(db,row,tx){
  const status=complete(tx)?'signed':'partial'
  if(status==='signed'){verifyHookLabSignedMessage(row.review,wire(tx));if(custodyAdapter&&row.status!=='signed')await custodyAdapter.completeStage({db,owner:row.owner_wallet,custodyOperationId:row.custody_operation_id,stage:row.stage})}
  const {rows:[saved]}=await db.query('update hook_lab_native_signing_operations set partial_transaction=$2,status=$3,pending_signer=null,revision=revision+1,updated_at=clock_timestamp() where id=$1 returning *',[row.id,wire(tx),status])
  return summary(saved)
 }
 return Object.freeze({
  async createReview(sessionToken,id,{custodyOperationId,stage,intent}){
   try{
    z.uuid().parse(custodyOperationId);check(Object.hasOwn(operations,stage))
    const captured=await transaction(sessionToken,id,async(_db,row,owner)=>({row,owner}),custodyOperationId)
    if(captured.row){check(captured.row.custody_operation_id===custodyOperationId&&captured.row.stage===stage);return summary(captured.row)}
    check(resolver&&typeof resolver.prepare==='function')
    // Network and journal reads happen outside signing/custody/session locks.
    const resolved=await resolver.prepare({sessionToken,owner:captured.owner,custodyOperationId,stage,intent:structuredClone(intent)}),review=inspectHookLabMessage(resolved.review).review
    return transaction(sessionToken,id,async(db,row,owner)=>{
     if(row){check(row.custody_operation_id===custodyOperationId&&row.stage===stage);return summary(row)}
     check(review.wallet===owner&&review.payer===owner&&resolved.status==='operator-pins-and-state-verified'
      &&resolved.owner===owner&&resolved.stage===stage&&resolved.profileSha256===review.profileSha256&&resolved.messageSha256===review.messageSha256)
     check(review.requiredSigners.includes(owner)&&review.operation===operations[stage])
     await currentReview(db,review)
     if(custodyAdapter)await custodyAdapter.beginStage({db,owner,custodyOperationId,stage,review,request:resolved.request})
     const retainedContext=context(resolved)
     const tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(review.messageBase64,'base64')))
     const {rows:[saved]}=await db.query(`insert into hook_lab_native_signing_operations(id,owner_wallet,custody_operation_id,stage,profile_sha256,review,message_sha256,partial_transaction,status,configuration_sha256,settlement_context,resolved_request)
      values($1,$2,$3,$4,$5,$6,$7,$8,'reviewed',$9,$10,$11) returning *`,[id,owner,custodyOperationId,stage,review.profileSha256,review,review.messageSha256,wire(tx),retainedContext.configurationSha256,retainedContext.settlementContext,resolved.request??null])
     return summary(saved)
    },custodyOperationId)
   }catch{throw fail()}
  },
  async get(sessionToken,id){return transaction(sessionToken,id,async(_db,row)=>{check(row);return summary(row)})},
  async refreshReview(sessionToken,id){
   try{
    const captured=await transaction(sessionToken,id,async(_db,row)=>{
     check(row&&row.status==='reviewed'&&!row.signature&&!row.pending_signer&&!row.wallet_requested_at)
     check(transactionBytes(row.review,row.partial_transaction).signatures.every(s=>s.every(x=>x===0)));return row
    })
    check(resolver&&typeof resolver.prepare==='function')
    const resolved=await resolver.prepare({sessionToken,owner:captured.owner_wallet,custodyOperationId:captured.custody_operation_id,stage:captured.stage,intent:structuredClone(captured.resolved_request)})
    const review=inspectHookLabMessage(resolved.review).review,retainedContext=context(resolved)
    check(resolved.status==='operator-pins-and-state-verified'&&resolved.owner===captured.owner_wallet&&resolved.stage===captured.stage
     &&resolved.profileSha256===captured.profile_sha256&&resolved.configurationSha256===captured.configuration_sha256
     &&isDeepStrictEqual(resolved.request??null,captured.resolved_request)&&review.intentSha256===captured.review.intentSha256
     &&review.wallet===captured.owner_wallet&&review.payer===captured.owner_wallet&&review.operation===captured.review.operation
     &&review.profileSha256===captured.profile_sha256&&review.messageSha256===resolved.messageSha256)
    return transaction(sessionToken,id,async(db,row)=>{
     check(row&&row.status==='reviewed'&&String(row.revision)===String(captured.revision)&&!row.signature&&!row.pending_signer&&!row.wallet_requested_at)
     check(transactionBytes(row.review,row.partial_transaction).signatures.every(s=>s.every(x=>x===0)))
     await currentReview(db,review)
     if(isDeepStrictEqual(row.review,review))return summary(row)
     const tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(review.messageBase64,'base64')))
     const {rows:[saved]}=await db.query('update hook_lab_native_signing_operations set review=$2,message_sha256=$3,partial_transaction=$4,settlement_context=$5,review_generation=review_generation+1,revision=revision+1,updated_at=clock_timestamp() where id=$1 returning *',[id,review,review.messageSha256,wire(tx),retainedContext.settlementContext])
     return summary(saved)
    })
   }catch{throw fail()}
  },

  async walletRequest(sessionToken,id){
   try{
    const captured=await transaction(sessionToken,id,async(_db,row)=>{check(row&&pending.has(row.status));return row})
    await fresh(captured,captured.owner_wallet,sessionToken)
    return transaction(sessionToken,id,async(db,row)=>{
     check(row&&pending.has(row.status)&&String(row.revision)===String(captured.revision))
     await currentReview(db,row.review)
     if(!row.wallet_requested_at)await db.query('update hook_lab_native_signing_operations set wallet_requested_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where id=$1',[id])
     return {review:row.review,partialTransactionBase64:row.partial_transaction,canSubmit:false}
    })
   }catch{throw fail()}
  },
  async retainWalletSignature(sessionToken,id,signedTransactionBase64){
   return transaction(sessionToken,id,async(db,row,owner)=>{
    check(row&&pending.has(row.status))
    const previous=transactionBytes(row.review,row.partial_transaction),incoming=transactionBytes(row.review,signedTransactionBase64),index=row.review.requiredSigners.indexOf(owner)
    check(index>=0&&incoming.signatures[index].some(x=>x!==0))
    for(let i=0;i<previous.signatures.length;i++){
     if(i!==index)check(Buffer.from(incoming.signatures[i]).equals(Buffer.from(previous.signatures[i])))
     else if(previous.signatures[i].some(x=>x!==0))check(Buffer.from(incoming.signatures[i]).equals(Buffer.from(previous.signatures[i])))
    }
    // Retain an exact valid wallet response even if its review expired. It never
    // authorizes another signer/send until fresh() succeeds again.
    return save(db,row,incoming)
   })
  },
  async coSignNext(sessionToken,id,signerAddress){
   let claimed
   try{
    const captured=await transaction(sessionToken,id,async(_db,row)=>{check(row&&['partial','signed'].includes(row.status));return row})
    const capturedTx=transactionBytes(captured.review,captured.partial_transaction),index=captured.review.requiredSigners.indexOf(signerAddress)
    check(index>=0&&signerAddress!==captured.owner_wallet&&capturedTx.signatures[captured.review.requiredSigners.indexOf(captured.owner_wallet)].some(x=>x!==0))
    if(capturedTx.signatures[index].some(x=>x!==0))return summary(captured)
    const verified=await fresh(captured,captured.owner_wallet,sessionToken)
    claimed=await transaction(sessionToken,id,async(db,row)=>{
     check(row&&String(row.revision)===String(captured.revision)&&row.status==='partial')
     await currentReview(db,row.review)
     check((custodyAdapter??serverSigner)&&typeof (custodyAdapter??serverSigner).sign==='function')
     await db.query("insert into hook_lab_native_signing_attempts(operation_id,signer_address,message_sha256,status) values($1,$2,$3,'claimed')",[id,signerAddress,row.message_sha256])
     const {rows:[saved]}=await db.query("update hook_lab_native_signing_operations set status='signing-claimed',pending_signer=$2,revision=revision+1,updated_at=clock_timestamp() where id=$1 returning *",[id,signerAddress])
     return saved
    })
    // Claim committed before invoking a signer. Any lost result requires recovery,
    // never another signing request. Keep an already-returned signature on expiry.
    return await transaction(sessionToken,id,async(db,row,owner)=>{
     check(row&&row.status==='signing-claimed'&&row.pending_signer===signerAddress&&String(row.revision)===String(claimed.revision))
     await currentReview(db,row.review)
     const tx=transactionBytes(row.review,row.partial_transaction),signer=custodyAdapter??serverSigner
     const signature=await signer.sign({db,sessionToken,owner,custodyOperationId:row.custody_operation_id,stage:row.stage,signerAddress,
      message:Buffer.from(tx.message.serialize()),messageSha256:row.message_sha256,review:row.review,observedAdmin:verified.observedAdmin,request:verified.request})
     check(signature instanceof Uint8Array&&signature.length===64&&signature.some(x=>x!==0));tx.signatures[index]=Uint8Array.from(signature)
     transactionBytes(row.review,wire(tx))
     const saved=await save(db,row,tx)
     await db.query("update hook_lab_native_signing_attempts set status='completed',completed_at=clock_timestamp() where operation_id=$1 and signer_address=$2 and status='claimed'",[id,signerAddress])
     return saved
    },null,true)
   }catch{
    if(claimed){try{
     await pool.query("update hook_lab_native_signing_operations set status='signing-unknown',revision=revision+1,updated_at=clock_timestamp() where id=$1 and status='signing-claimed' and pending_signer=$2 and message_sha256=$3",[id,signerAddress,claimed.message_sha256])
     await pool.query("update hook_lab_native_signing_attempts set status='unknown' where operation_id=$1 and signer_address=$2 and status='claimed'",[id,signerAddress])
    }catch{}}
    throw fail()
   }
  },
  async retainRecoveredServerSignature(sessionToken,id,signatureBase64){
   return transaction(sessionToken,id,async(db,row)=>{
    check(row&&['signing-claimed','signing-unknown'].includes(row.status)&&row.pending_signer)
    const signature=Buffer.from(signatureBase64,'base64');check(signature.length===64&&signature.some(x=>x!==0)&&signature.toString('base64')===signatureBase64)
    const tx=transactionBytes(row.review,row.partial_transaction),index=row.review.requiredSigners.indexOf(row.pending_signer)
    check(index>=0&&row.pending_signer!==row.owner_wallet&&!tx.signatures[index].some(x=>x!==0));tx.signatures[index]=signature
    transactionBytes(row.review,wire(tx));const saved=await save(db,row,tx)
    await db.query("update hook_lab_native_signing_attempts set status='completed',completed_at=clock_timestamp() where operation_id=$1 and signer_address=$2 and status in ('claimed','unknown')",[id,row.pending_signer])
    return saved
   })
  },
  async reconcile(sessionToken,id){
   const retained=await transaction(sessionToken,id,async(_db,row)=>{
    check(row&&row.signature&&['submission-claimed','outcome-unknown','submitted','finalized-success','finalized-failure','review-required'].includes(row.status))
    return structuredClone(row)
   })
   check(resolver&&typeof resolver.reconcile==='function')
   let evidence;try{evidence=await resolver.reconcile({sessionToken,owner:retained.owner_wallet,custodyOperationId:retained.custody_operation_id,stage:retained.stage,
    review:retained.review,configurationSha256:retained.configuration_sha256,settlementContext:structuredClone(retained.settlement_context),signedTransactionBase64:retained.partial_transaction,signature:retained.signature})}catch{throw fail()}
   return transaction(sessionToken,id,async(db,row)=>{
    check(row&&row.message_sha256===retained.message_sha256&&row.signature===retained.signature)
    check(evidence&&['unresolved','finalized-success','finalized-failure','conflict'].includes(evidence.status)
     &&evidence.signature===row.signature&&evidence.messageSha256===row.message_sha256&&evidence.profileSha256===row.profile_sha256)
    let first=row.first_finalized,conflict=row.first_conflict,status=row.status
    if(evidence.status==='conflict')conflict??=evidence
    if(['finalized-success','finalized-failure'].includes(evidence.status)){
     if(first&&!isDeepStrictEqual(first,evidence))conflict??=evidence
     else first??=evidence
    }
    // A finalized execution can still exceed an off-chain review bound.
    status=conflict||first?.policyReviewRequired===true?'review-required':first?.status??'outcome-unknown'
    if(custodyAdapter&&['finalized-success','finalized-failure','review-required'].includes(status))await custodyAdapter.settleStage({db,owner:row.owner_wallet,custodyOperationId:row.custody_operation_id,stage:row.stage,status})
    const {rows:[saved]}=await db.query('update hook_lab_native_signing_operations set status=$2,first_finalized=$3,first_conflict=$4,revision=revision+1,updated_at=clock_timestamp() where id=$1 returning *',[id,status,first,conflict])
    return summary(saved)
   })
  },
  async submitOnce(sessionToken,id){
   let captured;try{captured=await transaction(sessionToken,id,async(_db,row)=>{check(row&&row.status==='signed');return row});await fresh(captured,captured.owner_wallet,sessionToken)}catch{throw fail()}
   const claimed=await transaction(sessionToken,id,async(db,row,owner)=>{
    check(row&&row.status==='signed'&&String(row.revision)===String(captured.revision)&&sender&&typeof sender.send==='function')
    await currentReview(db,row.review)
    const verified=verifyHookLabSignedMessage(row.review,row.partial_transaction)
    const {rows:[saved]}=await db.query("update hook_lab_native_signing_operations set status='submission-claimed',signature=$2,revision=revision+1,updated_at=clock_timestamp() where id=$1 returning *",[id,verified.signature])
    return saved
   })
   // Claim is durable before I/O. Never retry after timeout, crash, or lost response.
   let status='outcome-unknown'
   try{const sent=await sender.send({signedTransactionBase64:claimed.partial_transaction,signature:claimed.signature,messageSha256:claimed.message_sha256,review:claimed.review});if(sent===claimed.signature)status='submitted'}catch{}
   // Retain outcome even if auth expired/revoked while I/O was in progress. This is
   // an internal exact claimed-row update, not fresh authority or a second send.
   try{
    const {rows:[saved]}=await pool.query("update hook_lab_native_signing_operations set status=$2,revision=revision+1,updated_at=clock_timestamp() where id=$1 and status='submission-claimed' and message_sha256=$3 and signature=$4 returning *",[id,status,claimed.message_sha256,claimed.signature])
    check(saved);return summary(saved)
   }catch{throw fail()}
  },
 })
}
