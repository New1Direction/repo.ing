// Owner agent: creates, deactivates and closes per-launch lookup tables with the admin key.
// Every signed transaction is journaled (public data only) BEFORE it is sent, so a crash or lost
// response resumes the same signature instead of signing a different message for the same step.
// A step is re-signed only after its blockhash has expired with no trace of it on chain.
import { mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync } from 'node:fs'
import path from 'node:path'
import bs58 from 'bs58'
import { AddressLookupTableAccount,AddressLookupTableProgram,PublicKey,SYSVAR_SLOT_HASHES_PUBKEY,TransactionMessage,VersionedTransaction } from '@solana/web3.js'
import { TABLE_CHUNK,launchTableInstructions,verifyLaunchTable } from './hooklab-owner-launch-tables.mjs'
const DEACTIVATION_COOLDOWN_SLOTS=513,MAX_EXPIRED_STEPS=3

export function ownerTableExecutor({connections,admin,journalDir,microLamports=0,sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{}}){
 const adminKey=new PublicKey(admin.address),primary=connections[0]
 mkdirSync(journalDir,{recursive:true,mode:0o700})
 const file=id=>path.join(journalDir,`${id}.json`)
 const load=id=>{try{return JSON.parse(readFileSync(file(id),'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}}
 const save=record=>{writeFileSync(`${file(record.preparationId)}.next`,JSON.stringify(record,null,1),{mode:0o600});renameSync(`${file(record.preparationId)}.next`,file(record.preparationId))}
 async function recentSlot(){
  const data=(await primary.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY,'finalized'))?.data
  if(!data||data.readBigUInt64LE(0)===0n)throw Error('SlotHashes unavailable')
  return Number(data.readBigUInt64LE(8))
 }
 // Sends (or resumes) one journaled step until it is confirmed. Returns false if it expired unseen.
 async function step(record,key,instructions){
  let s=record.steps[key]
  if(!s){
   const latest=await primary.getLatestBlockhash('confirmed')
   const message=new TransactionMessage({payerKey:adminKey,recentBlockhash:latest.blockhash,instructions}).compileToV0Message()
   const tx=new VersionedTransaction(message);tx.addSignature(adminKey,Buffer.from(admin.signBase64(message.serialize()),'base64'))
   const wire=Buffer.from(tx.serialize());if(wire.length>1232)throw Error('table transaction exceeds the packet limit')
   s=record.steps[key]={signature:bs58.encode(tx.signatures[0]),wireBase64:wire.toString('base64'),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,status:'signed'}
   save(record)
   await primary.sendRawTransaction(wire,{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}).catch(error=>{s.preflight=String(error.message).slice(0,200);save(record)})
  }
  for(;;){
   if(['confirmed','finalized'].includes(s.status))return true
   const [status]=(await primary.getSignatureStatuses([s.signature],{searchTransactionHistory:true})).value
   if(status?.err)throw Error(`table step ${key} failed on chain: ${JSON.stringify(status.err)}`)
   if(['confirmed','finalized'].includes(status?.confirmationStatus)){s.status=status.confirmationStatus;save(record);return true}
   if(!status&&await primary.getBlockHeight('finalized')>s.lastValidBlockHeight){
    // Expired with no trace on chain: this exact message can never land. Allow a fresh signature.
    record.expiredSteps=[...(record.expiredSteps??[]),{key,signature:s.signature}];delete record.steps[key];save(record)
    if(record.expiredSteps.length>MAX_EXPIRED_STEPS)throw Error(`table step ${key} keeps expiring without landing (last preflight: ${s.preflight??'none'}); stopping`)
    return false
   }
   for(const c of connections)await c.sendRawTransaction(Buffer.from(s.wireBase64,'base64'),{skipPreflight:true,maxRetries:0}).catch(()=>{})
   await sleep(2_000)
  }
 }
 async function finalized(record,key){
  for(;;){
   const [status]=(await primary.getSignatureStatuses([record.steps[key].signature],{searchTransactionHistory:true})).value
   if(status?.confirmationStatus==='finalized'){record.steps[key].status='finalized';save(record);return}
   await sleep(2_000)
  }
 }
 return Object.freeze({
  load,
  // Creates the launch's table with exactly the verified inventory. Returns the table address.
  async ensure({preparationId,launchRequestId,creator,mint,inventory,inventorySha256}){
   let record=load(preparationId)
   if(record&&(record.inventorySha256!==inventorySha256||record.launchRequestId!==launchRequestId))throw Error('journaled table differs from this request')
   if(!record){
    const rent=await primary.getMinimumBalanceForRentExemption(56+32*inventory.length),balance=await primary.getBalance(adminKey,'confirmed')
    if(balance<rent+50_000)throw Error(`admin needs ${(rent+50_000)/1e9} SOL for this table, has ${balance/1e9}`)
    record={schema:'repoing/owner-launch-table/1',preparationId,launchRequestId,creator,mint,inventory,inventorySha256,rentLamports:rent,status:'creating',steps:{}}
   }
   for(;;){
    if(!record.table){record.recentSlot=await recentSlot();record.table=launchTableInstructions({admin:admin.address,recentSlot:record.recentSlot,inventory}).table;save(record)}
    const {table,steps}=launchTableInstructions({admin:admin.address,recentSlot:record.recentSlot,inventory,microLamports})
    if(table!==record.table)throw Error('journaled table address differs from its derivation')
    let expired=false
    for(const [i,instructions] of steps.entries()){
     if(!await step(record,`step-${i}`,instructions)){expired=true;break}
    }
    if(!expired)break
    // The create step expired unseen: a new recent slot (and table address) is safe. Extends keep the table.
    if(!record.steps['step-0']&&(record.expiredSteps??[]).some(e=>e.key==='step-0'))delete record.table
    save(record)
   }
   await finalized(record,`step-${Math.ceil(inventory.length/TABLE_CHUNK)-1}`)
   const infos=await Promise.all(connections.map(c=>c.getAccountInfo(new PublicKey(record.table),'finalized')))
   if(!infos.every(Boolean)||!Buffer.from(infos[0].data).equals(Buffer.from(infos[1].data)))throw Error('created table not yet visible on both providers')
   verifyLaunchTable({data:infos[0].data,owner:infos[0].owner.toBase58(),inventory,adminAddress:admin.address})
   record.status='created';save(record)
   return record.table
  },
  // For tables whose launch request is no longer open: deactivate, then close after the cooldown.
  async reclaim(openRequestIds){
   const results=[]
   for(const name of readdirSync(journalDir).filter(n=>n.endsWith('.json'))){
    const record=JSON.parse(readFileSync(path.join(journalDir,name),'utf8'))
    if(!record.table||record.status==='closed'||openRequestIds.has(record.launchRequestId))continue
    const info=await primary.getAccountInfo(new PublicKey(record.table),'finalized')
    if(!info){record.status='closed';save(record);results.push(`${record.table} already closed`);continue}
    const state=AddressLookupTableAccount.deserialize(info.data),lookupTable=new PublicKey(record.table)
    if(state.deactivationSlot===0xffffffffffffffffn){
     if(!await step(record,'deactivate',[AddressLookupTableProgram.deactivateLookupTable({lookupTable,authority:adminKey})])){results.push(`${record.table} deactivation expired; run reclaim again`);continue}
     record.status='deactivating';save(record);results.push(`${record.table} deactivated; close after ${DEACTIVATION_COOLDOWN_SLOTS} slots`)
    }else if(await primary.getSlot('finalized')>Number(state.deactivationSlot)+DEACTIVATION_COOLDOWN_SLOTS){
     if(!await step(record,'close',[AddressLookupTableProgram.closeLookupTable({lookupTable,authority:adminKey,recipient:adminKey})])){results.push(`${record.table} close expired; run reclaim again`);continue}
     record.status='closed';save(record);results.push(`${record.table} closed; ${record.rentLamports/1e9} SOL back to admin`)
    }else results.push(`${record.table} cooling down`)
   }
   return results
  },
 })
}
