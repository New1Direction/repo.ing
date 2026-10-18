// Owner-approved launches. The admin key stays on the owner's Mac: this server only queues
// launch intents, records owner presence, and waits for admin signatures that it verifies
// against the configured admin address. Nothing here can sign.
import { createHash,createPublicKey,randomUUID,verify } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
const fail=(message='Owner approval unavailable or changed')=>Object.assign(Error(message),{code:'OWNER_APPROVAL_UNAVAILABLE'})
const check=(value,message)=>{if(!value)throw fail(message)}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const address=z.string().refine(x=>{try{return new PublicKey(x).toBase58()===x}catch{return false}})
const text=max=>z.string().min(1).refine(x=>Buffer.byteLength(x)<=max)
export const launchIntentSchema=z.object({name:text(32),symbol:text(10),uri:z.string().refine(x=>Buffer.byteLength(x)<=200)}).strict()

export function verifyEd25519(signerAddress,message,signature){
 try{
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(signerAddress).toBuffer()]),format:'der',type:'spki'})
  return signature.length===64&&verify(null,Buffer.from(message),key,Buffer.from(signature))
 }catch{return false}
}

async function inTransaction(pool,work){
 const db=await pool.connect()
 try{await db.query('begin');const result=await work(db);await db.query('commit');return result}
 catch(error){await db.query('rollback').catch(()=>{});throw error}
 finally{db.release()}
}
const publicRequest=row=>row&&Object.freeze({id:row.id,creator:row.creator_wallet,name:row.name,symbol:row.symbol,uri:row.uri,status:row.status,
 invitedAt:row.invited_at?.toISOString?.()??null,inviteExpiresAt:row.invite_expires_at?.toISOString?.()??null,custodyOperationId:row.custody_operation_id,createdAt:row.created_at.toISOString()})
const publicSignRequest=row=>Object.freeze({id:row.id,signer:row.signer_address,messageBase64:row.message_base64,messageSha256:row.message_sha256,context:row.context,
 validUntilSlot:String(row.valid_until_slot),lastValidBlockHeight:String(row.last_valid_block_height),reviewExpiresAt:row.review_expires_at.toISOString(),status:row.status,createdAt:row.created_at.toISOString()})

export function ownerApprovalStore(pool,{adminAddress,presenceWindowMs=20_000,maxInviteMs=3_600_000}={}){
 address.parse(adminAddress)
 const expireInvites=db=>db.query("update hook_lab_launch_requests set status='invite-expired',updated_at=clock_timestamp() where status='invited' and invite_expires_at<=clock_timestamp()")
 return Object.freeze({
  async availability(){
   const {rows:[p]}=await pool.query('select accepting,last_seen_at,(last_seen_at>clock_timestamp()-make_interval(secs=>$1)) as fresh from hook_lab_owner_presence where id=1',[presenceWindowMs/1000])
   return Object.freeze({online:!!(p?.accepting&&p.fresh),lastSeenAt:p?.last_seen_at?.toISOString?.()??null})
  },
  // Owner agent only (authenticated by the caller). Records presence and returns the work queue.
  async heartbeat({accepting,agentAddress}){
   check(typeof accepting==='boolean'&&agentAddress===adminAddress,'Agent must present the configured admin address')
   return inTransaction(pool,async db=>{
    await db.query('update hook_lab_owner_presence set accepting=$1,agent_address=$2,last_seen_at=clock_timestamp(),updated_at=clock_timestamp() where id=1',[accepting,agentAddress])
    await expireInvites(db)
    await db.query("update hook_lab_owner_sign_requests set status='expired',decided_at=clock_timestamp() where status='pending' and review_expires_at<=clock_timestamp()")
    const {rows:requests}=await db.query("select * from hook_lab_launch_requests where status in ('queued','invited','launching') order by created_at limit 50")
    const {rows:signs}=await db.query("select * from hook_lab_owner_sign_requests where status='pending' order by created_at limit 10")
    return Object.freeze({requests:requests.map(publicRequest),signRequests:signs.map(publicSignRequest)})
   })
  },
  async createRequest(creator,{id,...intent}){
   address.parse(creator);z.uuid().parse(id);const value=launchIntentSchema.parse(intent)
   try{
    const {rows:[row]}=await pool.query("insert into hook_lab_launch_requests(id,creator_wallet,name,symbol,uri,status) values($1,$2,$3,$4,$5,'queued') returning *",[id,creator,value.name,value.symbol,value.uri])
    return publicRequest(row)
   }catch(error){if(error.code==='23505')throw fail('You already have an open launch request');throw error}
  },
  async requestFor(creator){
   address.parse(creator)
   await expireInvites(pool)
   const {rows:[row]}=await pool.query('select * from hook_lab_launch_requests where creator_wallet=$1 order by created_at desc limit 1',[creator])
   return publicRequest(row)??null
  },
  async cancelRequest(creator,id){
   const {rows:[row]}=await pool.query("update hook_lab_launch_requests set status='cancelled',updated_at=clock_timestamp() where id=$1 and creator_wallet=$2 and status in ('queued','invited') returning *",[z.uuid().parse(id),address.parse(creator)])
   check(row,'Only a queued or invited request can be cancelled');return publicRequest(row)
  },
  // Owner agent only. The agent issues the creator grant on chain before inviting.
  async invite(id,{inviteMs}){
   check(Number.isSafeInteger(inviteMs)&&inviteMs>=60_000&&inviteMs<=maxInviteMs,'Invite window must be 1-60 minutes')
   return inTransaction(pool,async db=>{
    await expireInvites(db)
    try{
     const {rows:[row]}=await db.query("update hook_lab_launch_requests set status='invited',invited_at=clock_timestamp(),invite_expires_at=clock_timestamp()+make_interval(secs=>$2),updated_at=clock_timestamp() where id=$1 and status='queued' returning *",[z.uuid().parse(id),inviteMs/1000])
     check(row,'Only a queued request can be invited');return publicRequest(row)
    }catch(error){if(error.code==='23505')throw fail('Another creator is already invited; finish or expire that launch first');throw error}
   })
  },
  async decline(id){
   const {rows:[row]}=await pool.query("update hook_lab_launch_requests set status='declined',updated_at=clock_timestamp() where id=$1 and status in ('queued','invited') returning *",[z.uuid().parse(id)])
   check(row,'Only a queued or invited request can be declined');return publicRequest(row)
  },
  // Called on reserve: the creator may prepare only the exact coin the owner invited.
  async bindLaunch(db,creator,custodyOperationId,intent){
   const value=launchIntentSchema.parse(intent)
   await expireInvites(db)
   const {rows:[row]}=await db.query("select * from hook_lab_launch_requests where creator_wallet=$1 and status in ('invited','launching') for update",[address.parse(creator)])
   check(row,'Wait for repo.ing to invite your launch request')
   check(row.name===value.name&&row.symbol===value.symbol&&row.uri===value.uri,'Launch details differ from the approved request')
   if(row.status==='launching'){check(row.custody_operation_id===custodyOperationId,'This request is already bound to another launch');return publicRequest(row)}
   check(row.invite_expires_at>new Date(),'Your launch invite expired')
   const {rows:[bound]}=await db.query("update hook_lab_launch_requests set status='launching',custody_operation_id=$2,updated_at=clock_timestamp() where id=$1 and status='invited' returning *",[row.id,z.uuid().parse(custodyOperationId)])
   return publicRequest(bound)
  },
  async markLaunched(custodyOperationId){
   const {rows:[row]}=await pool.query("update hook_lab_launch_requests set status='launched',updated_at=clock_timestamp() where custody_operation_id=$1 and status='launching' returning *",[z.uuid().parse(custodyOperationId)])
   return publicRequest(row)??null
  },
  // Owner agent only. The signature must verify over the stored message for the admin address.
  async submitSignature(id,signatureBase64){
   const signature=Buffer.from(z.string().max(100).parse(signatureBase64),'base64')
   return inTransaction(pool,async db=>{
    const {rows:[row]}=await db.query('select * from hook_lab_owner_sign_requests where id=$1 for update',[z.uuid().parse(id)])
    check(row&&row.status==='pending','Signing request is no longer pending')
    check(row.signer_address===adminAddress&&signature.toString('base64')===signatureBase64
     &&verifyEd25519(row.signer_address,Buffer.from(row.message_base64,'base64'),signature),'Signature does not verify for the admin address')
    const {rows:[saved]}=await db.query("update hook_lab_owner_sign_requests set status='signed',signature=$2,decided_at=clock_timestamp() where id=$1 returning *",[row.id,signatureBase64])
    return publicSignRequest(saved)
   })
  },
  async declineSignRequest(id){
   const {rows:[row]}=await pool.query("update hook_lab_owner_sign_requests set status='declined',decided_at=clock_timestamp() where id=$1 and status='pending' returning *",[z.uuid().parse(id)])
   check(row,'Signing request is no longer pending');return publicSignRequest(row)
  },
 })
}

// Injected as the launch runtime's adminSigner. It never holds a key: it records the exact
// message, then waits for the owner's verified signature until the earliest of the review's
// real limits (deadline slot, blockhash last valid height, review expiry) minus a margin,
// measured with live observations. It returns at most one signature per message.
export function remoteAdminSigner(pool,{address:signerAddress,observe,marginSlots=12,marginBlocks=12,marginMs=4_000,pollMs=500,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 address.parse(signerAddress);check(typeof observe==='function','Live chain observer required')
 async function decided(id){
  const {rows:[row]}=await pool.query('select status,signature,message_base64 from hook_lab_owner_sign_requests where id=$1',[id])
  if(row?.status==='signed'){
   const signature=Buffer.from(row.signature,'base64')
   check(verifyEd25519(signerAddress,Buffer.from(row.message_base64,'base64'),signature),'Stored signature does not verify')
   return Uint8Array.from(signature)
  }
  if(row?.status!=='pending')throw fail(`Owner approval ${row?.status??'missing'}`)
  return null
 }
 return Object.freeze({address:signerAddress,async sign(message,context={}){
  const review=context.review,bytes=Buffer.from(message)
  check(review&&sha(bytes)===review.messageSha256&&bytes.toString('base64')===review.messageBase64,'Message differs from its review')
  check([review.validUntilSlot,review.lastValidBlockHeight,review.reviewExpiresAtMs].every(Number.isSafeInteger),'Review limits missing')
  const {rows:[existing]}=await pool.query('select id from hook_lab_owner_sign_requests where message_sha256=$1',[review.messageSha256])
  let id=existing?.id
  if(!id){
   id=randomUUID()
   await pool.query(`insert into hook_lab_owner_sign_requests(id,signer_address,message_base64,message_sha256,context,valid_until_slot,last_valid_block_height,review_expires_at,status)
    values($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000),'pending')`,
    [id,signerAddress,review.messageBase64,review.messageSha256,JSON.stringify({owner:context.owner??null,mint:context.mint??null,selectedConfig:context.selectedConfig??null,
     operation:review.operation,requiredSigners:review.requiredSigners}),review.validUntilSlot,review.lastValidBlockHeight,review.reviewExpiresAtMs])
  }
  for(;;){
   const signature=await decided(id);if(signature)return signature
   const now=await observe()
   const late=now.slot>=review.validUntilSlot-marginSlots||now.blockHeight>=review.lastValidBlockHeight-marginBlocks||now.nowMs>=review.reviewExpiresAtMs-marginMs
   if(late){
    const {rowCount}=await pool.query("update hook_lab_owner_sign_requests set status='expired',decided_at=clock_timestamp() where id=$1 and status='pending'",[id])
    if(!rowCount){const raced=await decided(id).catch(()=>null);if(raced)return raced}
    throw fail('Owner approval window closed before a signature arrived; review again')
   }
   await sleep(pollMs)
  }
 }})
}
