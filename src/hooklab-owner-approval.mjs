// Owner-approved launches. The admin key stays on the owner's Mac: this server only queues
// launch intents, records owner presence, and waits for admin signatures that it verifies
// against the configured admin address. Nothing here can sign.
import { createHash,createPublicKey,randomUUID,verify } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { CREATOR_FEE_BPS_CHOICES,WALLET_CAP_BPS_CHOICES } from './hooklab-launch-menus.mjs'
import { UNSAFE_TEXT,coinProfileFields } from './hooklab-coin-profile.mjs'
import { STANDARD_VIRTUAL_QUOTE,checkLaunchPricing } from './hooklab-launch-pricing.mjs'
import { checkLiveBounds } from './hooklab-launch-bounds.mjs'
const fail=(message='Owner approval unavailable or changed')=>Object.assign(Error(message),{code:'OWNER_APPROVAL_UNAVAILABLE'})
const check=(value,message)=>{if(!value)throw fail(message)}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const address=z.string().refine(x=>{try{return new PublicKey(x).toBase58()===x}catch{return false}})
const text=max=>z.string().min(1).refine(x=>Buffer.byteLength(x)<=max).refine(x=>!UNSAFE_TEXT.test(x))
// Coin images are stored for good, so one wallet can attach at most this many per day.
const PROFILES_PER_CREATOR_PER_DAY=5
export const launchIntentSchema=z.object({name:text(32),symbol:text(10),uri:z.string().refine(x=>Buffer.byteLength(x)<=200),
 creatorFeeBps:z.number().int().refine(x=>CREATOR_FEE_BPS_CHOICES.includes(x)),capBps:z.number().int().refine(x=>WALLET_CAP_BPS_CHOICES.includes(x))}).strict()

const parseIntent=intent=>{try{return launchIntentSchema.parse(intent)}catch{throw fail('Choose a name, symbol, an approved creator fee (0.5%, 1% or 2%) and an approved wallet cap (1%, 2%, 3% or 5%)')}}

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
// Rows read with withProfile also carry the coin profile (null for requests queued before profiles existed).
const publicProfile=row=>row.has_profile?Object.freeze({description:row.description,x:row.x_handle,website:row.website,telegram:row.telegram}):null
// With USD pricing on, rows also carry the price fixed at invite (null until then); with it off the key is absent.
const publicPricing=row=>row.has_pricing?Object.freeze({solUsdMicros:String(row.sol_usd_micros),sources:row.price_sources,virtualQuote:String(row.virtual_quote),pricedAt:row.priced_at.toISOString()}):null
const publicRequest=row=>row&&Object.freeze({id:row.id,creator:row.creator_wallet,name:row.name,symbol:row.symbol,uri:row.uri,creatorFeeBps:row.creator_fee_bps,capBps:row.cap_bps,status:row.status,
 invitedAt:row.invited_at?.toISOString?.()??null,inviteExpiresAt:row.invite_expires_at?.toISOString?.()??null,custodyOperationId:row.custody_operation_id,createdAt:row.created_at.toISOString(),
 ...(row.has_profile!==undefined&&{profile:publicProfile(row)}),...(row.has_pricing!==undefined&&{pricing:publicPricing(row)}),...(row.status==='launched'&&row.mint&&{mint:row.mint})})
const priceColumns=row=>({sol_usd_micros:row.sol_usd_micros,price_sources:row.sources,virtual_quote:row.virtual_quote,priced_at:row.priced_at,has_pricing:true})
const requestQuery=usdPricing=>`select r.*,p.description,p.x_handle,p.website,p.telegram,(p.request_id is not null) as has_profile,
 ${usdPricing?'pr.sol_usd_micros,pr.sources as price_sources,pr.virtual_quote,pr.priced_at,(pr.request_id is not null) as has_pricing,':''}
 (select o.resolved_request->>'mint' from hook_lab_native_signing_operations o where o.custody_operation_id=r.custody_operation_id and o.stage='launch') as mint
 from hook_lab_launch_requests r left join hook_lab_coin_profiles p on p.request_id=r.id${usdPricing?' left join hook_lab_launch_request_prices pr on pr.request_id=r.id':''}`
// Shown publicly (metadata and image) while the coin can still launch or has launched.
const PUBLIC_COIN_STATUSES=['queued','invited','launching','launched']
const publicTableRequest=row=>Object.freeze({preparationId:row.preparation_id,launchRequestId:row.launch_request_id,creator:row.creator_wallet,launchRequest:row.launch_request,
 inventory:row.inventory,inventorySha256:row.inventory_sha256,status:row.status,tableAddress:row.table_address,createdAt:row.created_at.toISOString()})
const publicSignRequest=row=>Object.freeze({id:row.id,signer:row.signer_address,messageBase64:row.message_base64,messageSha256:row.message_sha256,context:row.context,
 validUntilSlot:String(row.valid_until_slot),lastValidBlockHeight:String(row.last_valid_block_height),reviewExpiresAt:row.review_expires_at.toISOString(),status:row.status,createdAt:row.created_at.toISOString()})

// usdPricing (HOOK_LAUNCH_USD_PRICING): invites fix a SOL price and opening virtual quote, and only that quote binds.
// Off, nothing reads the price table (it may not exist yet) and every launch binds the standard 1 SOL quote.
export function ownerApprovalStore(pool,{adminAddress,presenceWindowMs=20_000,maxInviteMs=3_600_000,usdPricing=false}={}){
 address.parse(adminAddress)
 const withProfile=requestQuery(usdPricing)
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
    const {rows:requests}=await db.query(`${withProfile} where r.status in ('queued','invited','launching') order by r.created_at limit 50`)
    const {rows:signs}=await db.query("select * from hook_lab_owner_sign_requests where status='pending' order by created_at limit 10")
    const {rows:tables}=await db.query("select * from hook_lab_owner_table_requests where status='requested' order by created_at limit 10")
    return Object.freeze({requests:requests.map(publicRequest),signRequests:signs.map(publicSignRequest),tableRequests:tables.map(publicTableRequest)})
   })
  },
  // profile: { image, description, x, website, telegram } as the server validated it (image: src/token-image.mjs
  // validateTokenImage); written in the same transaction as the request and never changed afterwards.
  async createRequest(creator,{id,...intent},profile=null){
   address.parse(creator);z.uuid().parse(id);const value=parseIntent(intent)
   const coin=profile&&{...coinProfileFields(profile),image:profile.image}
   check(!coin||(typeof coin.image==='string'&&coin.image.startsWith('data:image/png;base64,')),'Add a coin image')
   try{
    return await inTransaction(pool,async db=>{
     const {rows:[row]}=await db.query("insert into hook_lab_launch_requests(id,creator_wallet,name,symbol,uri,creator_fee_bps,cap_bps,status) values($1,$2,$3,$4,$5,$6,$7,'queued') returning *",[id,creator,value.name,value.symbol,value.uri,value.creatorFeeBps,value.capBps])
     if(!coin)return publicRequest({...row,has_profile:false})
     const {rows:[{n}]}=await db.query("select count(*)::int n from hook_lab_coin_profiles p join hook_lab_launch_requests r on r.id=p.request_id where r.creator_wallet=$1 and p.created_at>clock_timestamp()-interval '1 day'",[creator])
     check(n<PROFILES_PER_CREATOR_PER_DAY,'You have sent several launch requests today. Try again tomorrow')
     await db.query('insert into hook_lab_coin_profiles(request_id,image,description,x_handle,website,telegram) values($1,$2,$3,$4,$5,$6)',[id,coin.image,coin.description,coin.x,coin.website,coin.telegram])
     return publicRequest({...row,has_profile:true,description:coin.description,x_handle:coin.x,website:coin.website,telegram:coin.telegram})
    })
   }catch(error){if(error.code==='23505')throw fail('You already have an open launch request');throw error}
  },
  async requestFor(creator){
   address.parse(creator)
   await expireInvites(pool)
   const {rows:[row]}=await pool.query(`${withProfile} where r.creator_wallet=$1 order by r.created_at desc limit 1`,[creator])
   return publicRequest(row)??null
  },
  // Public: coins launched through repo.ing approval, newest first, with their mints and profiles.
  async launchedCoins(limit=50){
   const {rows}=await pool.query(`select r.*,p.description,p.x_handle,p.website,p.telegram,(p.request_id is not null) as has_profile,o.resolved_request->>'mint' as mint
    from hook_lab_launch_requests r join hook_lab_native_signing_operations o on o.custody_operation_id=r.custody_operation_id and o.stage='launch'
    left join hook_lab_coin_profiles p on p.request_id=r.id where r.status='launched' order by r.updated_at desc limit $1`,[Math.min(Math.max(1,limit|0),100)])
   return rows.filter(row=>address.safeParse(row.mint).success).map(row=>Object.freeze({id:row.id,mint:row.mint,name:row.name,symbol:row.symbol,creator:row.creator_wallet,
    creatorFeeBps:row.creator_fee_bps,capBps:row.cap_bps,profile:publicProfile(row)}))
  },
  // Public: the launch request (and profile) behind a launched coin, found through its launch operation's mint.
  async coinByMint(mint){
   const {rows:[row]}=await pool.query(`${withProfile} join hook_lab_native_signing_operations o on o.custody_operation_id=r.custody_operation_id and o.stage='launch'
    where o.resolved_request->>'mint'=$1 and r.status='launched' order by r.created_at desc limit 1`,[address.parse(mint)])
   return row?Object.freeze({id:row.id,name:row.name,symbol:row.symbol,creator:row.creator_wallet,profile:publicProfile(row)}):null
  },
  // Public: the coin's name, symbol, profile and image for its metadata and image URLs.
  async coinFor(id){
   if(!z.uuid().safeParse(id).success)return null
   const {rows:[row]}=await pool.query(`${withProfile} where r.id=$1 and r.status=any($2) and p.request_id is not null`,[id,PUBLIC_COIN_STATUSES])
   if(!row)return null
   const {rows:[{image}]}=await pool.query('select image from hook_lab_coin_profiles where request_id=$1',[id])
   return Object.freeze({request:Object.freeze({id:row.id,name:row.name,symbol:row.symbol,status:row.status}),profile:publicProfile(row),image})
  },
  async cancelRequest(creator,id){
   const {rows:[row]}=await pool.query("update hook_lab_launch_requests set status='cancelled',updated_at=clock_timestamp() where id=$1 and creator_wallet=$2 and status in ('queued','invited') returning *",[z.uuid().parse(id),address.parse(creator)])
   check(row,'Only a queued or invited request can be cancelled');return publicRequest(row)
  },
  // Owner agent only. The agent issues the creator grant on chain before inviting. With USD pricing on, price is the
  // SOL price read at invite ({solUsdMicros,sources,virtualQuote}) and liveBounds the launch config's current
  // {min,max} virtual quote: the price is re-derived here, and stored with the invite only if the chain accepts it.
  async invite(id,{inviteMs,price,liveBounds}){
   check(Number.isSafeInteger(inviteMs)&&inviteMs>=60_000&&inviteMs<=maxInviteMs,'Invite window must be 1-60 minutes')
   const pricing=usdPricing?checkLaunchPricing(price):null
   if(pricing)checkLiveBounds(pricing.virtualQuote,liveBounds)
   return inTransaction(pool,async db=>{
    await expireInvites(db)
    try{
     const {rows:[row]}=await db.query("update hook_lab_launch_requests set status='invited',invited_at=clock_timestamp(),invite_expires_at=clock_timestamp()+make_interval(secs=>$2),updated_at=clock_timestamp() where id=$1 and status='queued' returning *",[z.uuid().parse(id),inviteMs/1000])
     check(row,'Only a queued request can be invited')
     if(!pricing)return publicRequest(row)
     const {rows:[fixed]}=await db.query('insert into hook_lab_launch_request_prices(request_id,sol_usd_micros,sources,virtual_quote) values($1,$2,$3,$4) returning *',
      [row.id,pricing.solUsdMicros,JSON.stringify(pricing.sources),pricing.virtualQuote])
     return publicRequest({...row,...priceColumns(fixed)})
    }catch(error){if(error.code==='23505')throw fail('Another creator is already invited; finish or expire that launch first');throw error}
   })
  },
  async decline(id){
   const {rows:[row]}=await pool.query("update hook_lab_launch_requests set status='declined',updated_at=clock_timestamp() where id=$1 and status in ('queued','invited') returning *",[z.uuid().parse(id)])
   check(row,'Only a queued or invited request can be declined');return publicRequest(row)
  },
  // Called on reserve: the creator may prepare only the exact coin the owner invited, at the opening price fixed with
  // the invite (the standard 1 SOL quote when USD pricing is off or the invite predates it).
  async bindLaunch(db,creator,custodyOperationId,{virtualQuote,...intent}){
   const value=parseIntent(intent)
   await expireInvites(db)
   const {rows:[row]}=await db.query("select * from hook_lab_launch_requests where creator_wallet=$1 and status in ('invited','launching') for update",[address.parse(creator)])
   check(row,'Wait for repo.ing to invite your launch request')
   check(row.name===value.name&&row.symbol===value.symbol&&row.uri===value.uri&&row.creator_fee_bps===value.creatorFeeBps&&row.cap_bps===value.capBps,'Launch details differ from the approved request')
   const fixed=usdPricing?(await db.query('select virtual_quote from hook_lab_launch_request_prices where request_id=$1',[row.id])).rows[0]:null
   check(String(virtualQuote)===String(fixed?.virtual_quote??STANDARD_VIRTUAL_QUOTE),'The opening price differs from the approved request')
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
  // Owner agent only. The address is only a claim: the server verifies the table on chain before use.
  async submitTable(preparationId,tableAddress){
   const {rows:[row]}=await pool.query("update hook_lab_owner_table_requests set status='created',table_address=$2,decided_at=clock_timestamp() where preparation_id=$1 and status='requested' returning *",[z.uuid().parse(preparationId),address.parse(tableAddress)])
   check(row,'Table request is no longer pending');return publicTableRequest(row)
  },
  async declineTable(preparationId){
   const {rows:[row]}=await pool.query("update hook_lab_owner_table_requests set status='declined',decided_at=clock_timestamp() where preparation_id=$1 and status='requested' returning *",[z.uuid().parse(preparationId)])
   check(row,'Table request is no longer pending');return publicTableRequest(row)
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
