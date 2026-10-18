// LOCAL ONLY: real ALT transactions paid by the existing synthetic admin role.
// A per-launch table avoids changing the lookup pin of any prepared/signed operation.
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises'
import {AddressLookupTableAccount,AddressLookupTableProgram,SYSVAR_SLOT_HASHES_PUBKEY,TransactionMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {maxWalletLaunchInventory} from '../src/hooklab-max-wallet-launch.mjs'
import {localAcceptanceNetwork} from '../src/hooklab-local-acceptance.mjs'
import {assertLocalChain,localConnection,localKey,pda,pk,sha} from './hooks-local-common.mjs'
const check=(value,message)=>{if(!value)throw Error(message)}

export function createLocalLaunchLookupTable({pool,profile,chain,state}){
 return async({preparationId,allowCreate})=>{
  const network=localAcceptanceNetwork()
  check(network&&network.genesisHash===chain.genesisHash,'Explicit local launch-table scope required')
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(preparationId),'Invalid retained preparation ID')
  const connection=localConnection();await assertLocalChain(connection,chain.genesisHash)
  const client=await pool.connect(),lock=`local-launch-lookup:${preparationId}`
  await client.query('select pg_advisory_lock(hashtextextended($1,0))',[lock])
  try{
   const {rows:[context]}=await client.query('select owner_wallet,launch_request from hook_lab_native_launch_context where custody_operation_id=$1',[preparationId])
   check(context&&context.owner_wallet===chain.roles.wallet&&context.launch_request.creator===context.owner_wallet,'Local preparation owner differs')
   const programs=JSON.parse(profile.json).programs,config=await connection.getAccountInfo(pk(pda(programs.launch,'config')),'finalized')
   check(config&&config.owner.equals(pk(programs.launch)),'Real launch config missing')
   const {inventory}=maxWalletLaunchInventory(profile,context.launch_request,config.data)
   check(inventory.length>0&&inventory.length<=256,'Canonical launch inventory exceeds ALT capacity')
   const inventorySha256=sha(JSON.stringify(inventory)),directory=`${state}/launch-lookups`,path=`${directory}/${preparationId}.public.json`
   await mkdir(directory,{recursive:true,mode:0o700})
   let record
   try{record=JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
   const save=async()=>{await writeFile(`${path}.next`,JSON.stringify(record),{mode:0o600});await rename(`${path}.next`,path)}
   const payer=localKey('admin')
   if(!record){
    check(allowCreate===true,'Retained launch lookup proof missing; never replace a signed table')
    const hashes=(await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY,'finalized'))?.data
    check(hashes&&hashes.readBigUInt64LE(0)>0n,'Real finalized slot ancestor required')
    const recentSlot=Number(hashes.readBigUInt64LE(8))
    check(Number.isSafeInteger(recentSlot),'ALT ancestor exceeds exact integer range')
    const [,table]=AddressLookupTableProgram.createLookupTable({authority:payer.publicKey,payer:payer.publicKey,recentSlot})
    record={scope:'disposable-local-launch-lookup/1',genesisHash:chain.genesisHash,preparationId,mint:context.launch_request.mint,
     payer:payer.publicKey.toBase58(),table:table.toBase58(),recentSlot,inventory,inventorySha256,steps:{}}
    await save()
   }
   check(record.scope==='disposable-local-launch-lookup/1'&&record.genesisHash===chain.genesisHash&&record.preparationId===preparationId
    &&record.mint===context.launch_request.mint&&record.inventorySha256===inventorySha256&&JSON.stringify(record.inventory)===JSON.stringify(inventory)
    &&record.payer===payer.publicKey.toBase58(),'Retained launch lookup identity differs')
   const table=pk(record.table)
   async function step(name,instructions){
    let retained=record.steps[name]
    if(!retained){
     check(allowCreate===true,'Signed operation cannot create new infrastructure')
     const latest=await connection.getLatestBlockhash('finalized'),tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:latest.blockhash,instructions}).compileToV0Message())
     tx.sign([payer]);const wire=tx.serialize();check(wire.length<=1232,'Infrastructure packet exceeds Solana limit')
     retained=record.steps[name]={signature:bs58.encode(tx.signatures[0]),signedTransactionBase64:Buffer.from(wire).toString('base64'),...latest,status:'submission-claimed'}
     // Persist the exact one-send claim before I/O. A lost response resumes this signature.
     await save()
     try{check(await connection.sendRawTransaction(wire,{maxRetries:0,skipPreflight:false,preflightCommitment:'confirmed'})===retained.signature,'Infrastructure signature differs')}
     catch{/* Unknown response is not success or permission to send again. Confirm only. */}
    }
    if(retained.status!=='finalized-success'){
     const result=await connection.confirmTransaction({signature:retained.signature,blockhash:retained.blockhash,lastValidBlockHeight:retained.lastValidBlockHeight},'finalized')
     check(result.value.err===null,'Local infrastructure transaction finalized with a failure')
     retained.status='finalized-success';await save()
    }
   }
   if(!record.lookupTable){
    check(allowCreate===true,'Incomplete infrastructure cannot revalidate an issued request')
    const [create]=AddressLookupTableProgram.createLookupTable({authority:payer.publicKey,payer:payer.publicKey,recentSlot:record.recentSlot})
    const extend=addresses=>AddressLookupTableProgram.extendLookupTable({authority:payer.publicKey,payer:payer.publicKey,lookupTable:table,addresses:addresses.map(pk)})
    await step('create-and-first-extend',[create,extend(inventory.slice(0,20))])
    for(let offset=20;offset<inventory.length;offset+=20)await step(`extend-${offset}`,[extend(inventory.slice(offset,offset+20))])
   }
   const account=await connection.getAccountInfo(table,'finalized')
   check(account&&account.owner.equals(AddressLookupTableProgram.programId)&&!account.executable,'Actual ALT account differs')
   const decoded=AddressLookupTableAccount.deserialize(account.data)
   check(decoded.authority?.equals(payer.publicKey)&&decoded.deactivationSlot===0xffffffffffffffffn
    &&JSON.stringify(decoded.addresses.map(x=>x.toBase58()))===JSON.stringify(inventory),'Actual ALT authority, activation or canonical addresses differ')
   const deadline=Date.now()+15000
   while(await connection.getSlot('finalized')<=decoded.lastExtendedSlot){check(Date.now()<deadline,'ALT is not warmed');await new Promise(resolve=>setTimeout(resolve,100))}
   const pin={address:record.table,sha256:sha(account.data)}
   if(record.lookupTable)check(JSON.stringify(pin)===JSON.stringify(record.lookupTable),'Issued launch ALT bytes changed')
   else{record.lookupTable=pin;await save()}
   return Object.freeze(pin)
  }finally{await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[lock]).catch(()=>{});client.release()}
 }
}
