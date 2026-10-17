// Actual two-reader planning collection; no browser observations, signing or sends.
// Returned plans remain candidate/offline reviews, not adoption or authority.
import { PublicKey,VersionedMessage } from '@solana/web3.js'
import { isDeepStrictEqual } from 'node:util'
import { hookLabReviewSchema,inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { createHash } from 'node:crypto'
import { maxWalletProfileSchema,maxWalletPreparationRequestSchema,planMaxWalletPreparation } from './hooklab-max-wallet-preparation.mjs'
const fail=()=>Object.assign(Error('Max-wallet preparation reads unavailable or changed'),{code:'MAX_WALLET_PREPARATION_READS_UNAVAILABLE'})
const check=value=>{if(!value)throw fail()}
const integer=value=>{check(Number.isSafeInteger(value)&&value>=0);return value}
const pk=value=>new PublicKey(value)
const pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),pk(program))[0].toBase58()
export function maxWalletPreparationInventory(profile,request){
 const p=maxWalletProfileSchema.parse(profile),r=maxWalletPreparationRequestSchema.parse(request),L=p.programs.launch,G=p.programs.gate,loader='BPFLoaderUpgradeab1e11111111111111111111111'
 return [L,G,pda(loader,pk(L).toBuffer()),pda(loader,pk(G).toBuffer()),pda(L,'config'),pda(G,'policy',pk(r.mint).toBuffer()),
  pda(G,'bordrless-hook-accounts',pk(r.mint).toBuffer()),r.mint,r.selectedConfig,r.creator,r.feePayer,pda(L,'launch',pk(r.mint).toBuffer())]
}
export async function collectMaxWalletPreparationReview({profile,request,connections,limits,expectedReview,clock=Date.now}){
 try{
  const retainedReview=expectedReview===undefined?null:hookLabReviewSchema.parse(expectedReview)
  if(retainedReview)inspectHookLabMessage(retainedReview)
  const p=maxWalletProfileSchema.parse(JSON.parse(profile.json)),r=maxWalletPreparationRequestSchema.parse(request)
  check(createHash('sha256').update(profile.json).digest('hex')===profile.expectedSha256)
  check(Array.isArray(connections)&&connections.length===2&&new Set(connections.map(x=>x.provider)).size===2
   &&JSON.stringify(connections.map(x=>x.provider))===JSON.stringify(profile.providers))
  check(connections[0].connection!==connections[1].connection)
  const endpoints=connections.map(x=>x.connection.rpcEndpoint)
  if(endpoints.some(x=>x!==undefined)){
   check(endpoints.every(x=>typeof x==='string'))
   const urls=endpoints.map(x=>new URL(x));check(urls.every(x=>x.protocol==='https:'&&!x.username&&!x.password&&!x.hash))
   check(urls[0].origin!==urls[1].origin)
  }
  const inventory=maxWalletPreparationInventory(p,r),keys=inventory.map(pk),start=integer(clock())
  const observations=await Promise.all(connections.map(async({provider,connection})=>{
   const genesisHash=await connection.getGenesisHash();check(genesisHash===p.genesisHash)
   const response=await connection.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized'})
   check(response.value.length===keys.length);integer(response.context.slot)
   const rents=await Promise.all([85,81,176].map(size=>connection.getMinimumBalanceForRentExemption(size,'finalized')))
   return {provider,genesisHash,commitment:'finalized',slot:response.context.slot,observedAtMs:start,
    accounts:response.value.map((a,i)=>({address:inventory[i],account:a===null?null:{address:inventory[i],owner:a.owner.toBase58(),executable:a.executable,
     lamports:String(integer(a.lamports)),dataBase64:Buffer.from(a.data).toString('base64')}})),
    rentExemptionLamports:Object.fromEntries(['policy','registry','selectedConfig'].map((role,i)=>[role,String(integer(rents[i]))]))}
  }))
  const slot=Math.max(...observations.map(x=>x.slot)),latest=retainedReview?{context:{slot},value:{blockhash:VersionedMessage.deserialize(Buffer.from(retainedReview.messageBase64,'base64')).recentBlockhash,lastValidBlockHeight:retainedReview.lastValidBlockHeight}}:await connections[0].connection.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:slot})
  integer(latest.context.slot);check(latest.context.slot>=slot)
  const confirmations=await Promise.all(connections.map(async({connection})=>{
   const valid=await connection.isBlockhashValid(latest.value.blockhash,{commitment:'finalized',minContextSlot:latest.context.slot})
   check(valid.value===true&&integer(valid.context.slot)>=latest.context.slot)
   return {slot:valid.context.slot,height:integer(await connection.getBlockHeight({commitment:'finalized',minContextSlot:valid.context.slot}))}
  }))
  // This candidate supports the current explicit 5,000-lamport signature basis only.
  // Both providers quote the exact final message below; any change fails closed.
  const priority=(BigInt(limits.computeUnitLimit)*BigInt(limits.computeUnitPriceMicroLamports)+999999n)/1000000n
  const signatures=new Set([r.creator,r.feePayer,r.mint,r.selectedConfig]).size
  const now=integer(clock());check(now>=start)
  const recentBlockhash={...latest.value,genesisHash:p.genesisHash,providers:profile.providers,observedAtMs:start,
   currentBlockHeight:Math.max(...confirmations.map(x=>x.height)),blockhashValid:true,
   observedSlot:Math.max(...confirmations.map(x=>x.slot)),networkFeeLamports:String(BigInt(signatures)*5000n+priority),lamportsPerSignature:'5000'}
  const input={profile,request:r,observations,recentBlockhash,lookupTable:null,limits:{...limits,nowMs:now}}
  const computed=planMaxWalletPreparation(input)
  if(retainedReview){const stable=value=>{const {observedSlot,observedAtMs,policySha256,...rest}=value;return rest};check(isDeepStrictEqual(stable(computed.review),stable(retainedReview)))}
  const plan=retainedReview?{...computed,review:retainedReview}:computed,message=VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64'))
  const fees=await Promise.all(connections.map(({connection})=>connection.getFeeForMessage(message,'finalized')))
  for(const fee of fees)check(fee.value!==null&&String(integer(fee.value))===recentBlockhash.networkFeeLamports&&integer(fee.context.slot)>=recentBlockhash.observedSlot)
  const finished=integer(clock());check(finished>=now&&finished-start<=limits.maxAgeMs&&finished<limits.reviewExpiresAtMs)
  return Object.freeze({plan,preparationInput:input,collection:{schema:'repoing/max-wallet-planning-collection/1',providers:[...profile.providers],startedAtMs:start,finishedAtMs:finished,
   feeQuotedByBoth:true,productionApprovalVerified:false,canSign:false,canSubmit:false}})
 }catch{throw fail()}
}
