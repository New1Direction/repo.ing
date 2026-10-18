// Explicit operator dependency. Never constructed by the default route.
import { VersionedTransaction } from '@solana/web3.js'
import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { assertLocalExecutionEndpoint } from './hooklab-local-acceptance.mjs'
const check=x=>{if(!x)throw Error('Transaction submission unavailable or changed')}
export function nativeTransactionSender({enabled=false,connections,fetchImpl=fetch,timeoutMs=15000,clock=Date.now}={}){
 check(enabled===true&&Array.isArray(connections)&&connections.length===2&&typeof clock==='function')
 const readers=connections.map(x=>({provider:x.provider,connection:x.connection}))
 check(readers[0].provider!==readers[1].provider&&readers[0].connection!==readers[1].connection)
 const endpoints=readers.map(x=>x.connection.rpcEndpoint)
 if(endpoints.some(Boolean))check(endpoints.every(x=>typeof x==='string'&&new URL(x).protocol==='https:')&&new URL(endpoints[0]).origin!==new URL(endpoints[1]).origin)
 endpoints.forEach(assertLocalExecutionEndpoint)
 return Object.freeze({async send({signedTransactionBase64,signature,messageSha256,review}){
  try{
   const bytes=Buffer.from(signedTransactionBase64,'base64');check(bytes.length<=1232&&bytes.toString('base64')===signedTransactionBase64)
   const tx=VersionedTransaction.deserialize(bytes)
   check(Buffer.from(tx.serialize()).equals(bytes)&&bs58.encode(tx.signatures[0])===signature&&createHash('sha256').update(tx.message.serialize()).digest('hex')===messageSha256)
   check(review?.messageSha256===messageSha256&&Number.isSafeInteger(review.validUntilSlot)&&Number.isSafeInteger(review.reviewExpiresAtMs)&&clock()<review.reviewExpiresAtMs)
   // sigVerify must remain true; never replace a blockhash or rebuild signatures.
   const simulations=await Promise.all(readers.map(x=>x.connection.simulateTransaction(tx,{sigVerify:true,replaceRecentBlockhash:false,commitment:'confirmed'})))
   check(simulations.every(x=>x?.value?.err===null&&Number.isSafeInteger(x.context?.slot)&&x.context.slot<review.validUntilSlot)&&clock()<review.reviewExpiresAtMs)
   // Lifecycle persisted the one-send claim before entering this method. This is
   // exactly one invocation; the RPC client may not retry transaction submission.
   check(typeof endpoints[0]==='string'&&new URL(endpoints[0]).protocol==='https:')
   assertLocalExecutionEndpoint(endpoints[0])
   const response=await fetchImpl(endpoints[0],{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
    headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'native-submit-once',method:'sendTransaction',
     params:[signedTransactionBase64,{encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'}]})})
   check(response.ok)
   const reader=response.body.getReader();let size=0,chunks=[]
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;check(size<=4096);chunks.push(Buffer.from(part.value))}}finally{await reader.cancel().catch(()=>{})}
   const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'))
   check(payload.id==='native-submit-once'&&!payload.error&&payload.result===signature);return payload.result
  }catch{throw Error('Transaction outcome requires reconciliation')}
 }})
}
