// Per-launch address lookup tables for owner-approved launches. A customer launch needs 38
// accounts and does not fit a Solana packet without a table holding its own addresses, so each
// prepared launch gets one. The server records the exact inventory; the owner's Mac agent
// recomputes it independently, creates the table with the admin key (authority and payer), and
// reports only its address. The server then verifies the table on both providers before use.
// Nothing here holds a key.
import { createHash } from 'node:crypto'
import { AddressLookupTableAccount,AddressLookupTableProgram,ComputeBudgetProgram,PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { maxWalletLaunchInventory } from './hooklab-max-wallet-launch.mjs'
import { inclusiveMaxWalletSwapInventory } from './hooklab-inclusive-max-wallet-swap.mjs'
const fail=message=>Object.assign(Error(message),{code:'OWNER_APPROVAL_UNAVAILABLE'})
const check=(value,message)=>{if(!value)throw fail(message)}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const ACTIVE=0xffffffffffffffffn
export const TABLE_CHUNK=20
const syntheticKey=label=>new PublicKey(createHash('sha256').update(`repo.ing shared trade table derivation ${label}`).digest()).toBase58()
// The addresses every trade shares: the intersection of two trades that have nothing else in common.
// The shared trade table holds exactly these, frozen; the production bundle checks it.
export function sharedTradeAddresses(profile){
 const request=label=>({schema:'repoing/inclusive-max-wallet-swap-request/1',policyKind:'max-wallet',policyVersion:2,creatorFeeBps:profile.capability.creatorFeeBps,
  feeModel:2,protocolShareBps:2500,capBps:profile.capability.defaultCapBps??200,side:'buy',trader:syntheticKey(`${label} trader`),recipient:syntheticKey(`${label} trader`),
  feePayer:syntheticKey(`${label} trader`),mint:syntheticKey(`${label} mint`),selectedConfig:syntheticKey(`${label} config`),amountIn:'1',minAmountOut:'1',maxInput:'1',maxPriceImpactBps:100})
 const a=inclusiveMaxWalletSwapInventory(profile,request('a')),b=inclusiveMaxWalletSwapInventory(profile,request('b'))
 return a.filter(address=>b.includes(address))
}

export function launchTableInventory(envelope,launchRequest,launchConfigBytes){
 const {inventory}=maxWalletLaunchInventory(envelope,launchRequest,launchConfigBytes)
 check(inventory.length>0&&inventory.length<=256,'Launch inventory exceeds lookup table capacity')
 return Object.freeze({inventory,inventorySha256:sha(JSON.stringify(inventory))})
}
// The table must hold exactly the inventory, in order, under the admin's authority, still active.
export function verifyLaunchTable({data,owner,inventory,adminAddress}){
 check(owner===AddressLookupTableProgram.programId.toBase58(),'Launch lookup table is not an address lookup table')
 const state=AddressLookupTableAccount.deserialize(Uint8Array.from(data))
 check(state.authority?.toBase58()===adminAddress&&state.deactivationSlot===ACTIVE
  &&JSON.stringify(state.addresses.map(a=>a.toBase58()))===JSON.stringify(inventory),'Launch lookup table authority, activation or addresses differ')
 return state
}
async function readLaunchConfig(connections,envelope){
 const programs=JSON.parse(envelope.json).programs,address=PublicKey.findProgramAddressSync([Buffer.from('config')],new PublicKey(programs.launch))[0]
 const infos=await Promise.all(connections.map(({connection})=>connection.getAccountInfo(address,'finalized')))
 check(infos.every(i=>i&&i.owner.toBase58()===programs.launch)&&Buffer.from(infos[0].data).equals(Buffer.from(infos[1].data)),'Launch config missing or providers disagree')
 return Buffer.from(infos[0].data)
}

// Injected as the native launch runtime's launchLookupTable provider.
export function remoteLaunchLookupTable(pool,{envelope,connections,adminAddress,timeoutMs=90_000,pollMs=1_000,warmMs=20_000,
 sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,presenceWindowMs=20_000,
 readLaunch=async id=>(await pool.query(`select c.owner_wallet,c.launch_request,r.id as launch_request_id from hook_lab_native_launch_context c
  join hook_lab_launch_requests r on r.custody_operation_id=c.custody_operation_id and r.status in ('launching','launched') where c.custody_operation_id=$1`,[id])).rows[0]}={}){
 check(Array.isArray(connections)&&connections.length===2,'Two providers required')
 const select=id=>pool.query('select * from hook_lab_owner_table_requests where preparation_id=$1',[id]).then(r=>r.rows[0])
 return async({preparationId,allowCreate})=>{
  z.uuid().parse(preparationId)
  const launch=await readLaunch(preparationId)
  check(launch&&launch.launch_request.creator===launch.owner_wallet,'Launch is not bound to an owner-approved request')
  const {inventory,inventorySha256}=launchTableInventory(envelope,launch.launch_request,await readLaunchConfig(connections,envelope))
  let row=await select(preparationId)
  if(!row){
   check(allowCreate===true,'Retained launch lookup table missing; a signed launch never gets a replacement')
   await pool.query(`insert into hook_lab_owner_table_requests(preparation_id,launch_request_id,creator_wallet,launch_request,inventory,inventory_sha256,status)
    values($1,$2,$3,$4,$5,$6,'requested') on conflict do nothing`,[preparationId,launch.launch_request_id,launch.owner_wallet,JSON.stringify(launch.launch_request),JSON.stringify(inventory),inventorySha256])
   row=await select(preparationId)
  }
  check(row.inventory_sha256===inventorySha256&&JSON.stringify(row.inventory)===JSON.stringify(inventory),'Launch lookup inventory changed')
  // After a review was issued, later stages reuse its pin: revalidation re-checks the table bytes on chain
  // through the collector, and settlement does not read the table (so a reclaimed table never blocks reconcile).
  if(allowCreate!==true){check(row.status==='created'&&row.issued_table_sha256,'Retained launch lookup table missing; a signed launch never gets a replacement');return Object.freeze({address:row.table_address,sha256:row.issued_table_sha256})}
  const deadline=now()+timeoutMs
  while(row.status==='requested'){
   const {rows:[presence]}=await pool.query('select accepting and last_seen_at>clock_timestamp()-make_interval(secs=>$1) as online from hook_lab_owner_presence where id=1',[presenceWindowMs/1000])
   check(presence?.online,'repo.ing\'s approver is offline right now; try again later')
   check(now()<deadline,'repo.ing is still preparing this launch; try the review again in a minute')
   await sleep(pollMs);row=await select(preparationId)
  }
  check(row.status==='created','The owner declined this launch')
  const infos=await Promise.all(connections.map(({connection})=>connection.getAccountInfo(new PublicKey(row.table_address),'finalized')))
  check(infos.every(Boolean)&&Buffer.from(infos[0].data).equals(Buffer.from(infos[1].data)),'Launch lookup table missing or providers disagree')
  const data=Buffer.from(infos[0].data),state=verifyLaunchTable({data,owner:infos[0].owner.toBase58(),inventory,adminAddress})
  // A table is usable from the slot after its last extension; wait until both providers are past it.
  const warm=now()+warmMs
  while(Math.min(...await Promise.all(connections.map(({connection})=>connection.getSlot('finalized'))))<=state.lastExtendedSlot){check(now()<warm,'Launch lookup table is not active yet; try again shortly');await sleep(pollMs)}
  const pin={address:row.table_address,sha256:sha(data)}
  if(!row.issued_table_sha256)await pool.query('update hook_lab_owner_table_requests set issued_table_sha256=$2 where preparation_id=$1 and issued_table_sha256 is null',[preparationId,pin.sha256])
  const pinned=(await select(preparationId)).issued_table_sha256
  check(pinned===pin.sha256,'Issued launch lookup table bytes changed')
  return Object.freeze(pin)
 }
}

// Owner agent: everything in a table request comes from the server and is checked against the
// launch the owner invited and the agent's own reads before the admin key pays for anything.
export function verifyTableRequest({tableRequest,invited,envelope,launchConfigBytes,adminAddress}){
 const r=tableRequest.launchRequest
 check(invited&&invited.id===tableRequest.launchRequestId&&invited.status==='launching'&&invited.creator===tableRequest.creator&&invited.custodyOperationId===tableRequest.preparationId,'No launching request matches this table request')
 check(r.creator===invited.creator&&r.feePayer===invited.creator&&r.reviewer===adminAddress&&r.name===invited.name&&r.symbol===invited.symbol&&r.uri===invited.uri
  &&r.creatorFeeBps===invited.creatorFeeBps&&r.capBps===invited.capBps,'Table request differs from the invited launch')
 const own=launchTableInventory(envelope,r,launchConfigBytes)
 check(own.inventorySha256===tableRequest.inventorySha256&&JSON.stringify(own.inventory)===JSON.stringify(tableRequest.inventory),'Server inventory differs from the agent\'s own derivation')
 return own
}
// Instructions for the agent: create + first chunk, then one extend per further chunk.
export function launchTableInstructions({admin,recentSlot,inventory,microLamports=0}){
 const authority=new PublicKey(admin),[create,table]=AddressLookupTableProgram.createLookupTable({authority,payer:authority,recentSlot})
 const budget=[ComputeBudgetProgram.setComputeUnitLimit({units:30_000}),...(microLamports>0?[ComputeBudgetProgram.setComputeUnitPrice({microLamports})]:[])]
 const extend=addresses=>AddressLookupTableProgram.extendLookupTable({authority,payer:authority,lookupTable:table,addresses:addresses.map(a=>new PublicKey(a))})
 const steps=[[...budget,create,extend(inventory.slice(0,TABLE_CHUNK))]]
 for(let i=TABLE_CHUNK;i<inventory.length;i+=TABLE_CHUNK)steps.push([...budget,extend(inventory.slice(i,i+TABLE_CHUNK))])
 return {table:table.toBase58(),steps}
}
