import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Keypair,TransactionMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {nativeTransactionSender} from '../src/hooklab-native-transaction-sender.mjs'
const signer=Keypair.fromSeed(Buffer.alloc(32,91)),tx=new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:Keypair.fromSeed(Buffer.alloc(32,92)).publicKey.toBase58(),instructions:[]}).compileToV0Message());tx.sign([signer])
const messageSha256=createHash('sha256').update(tx.message.serialize()).digest('hex')
const input={signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0]),messageSha256,
 review:{messageSha256,validUntilSlot:1020,reviewExpiresAtMs:2000}}
function fixture(){
 let now=1000,sends=0
 const connections=['one','two'].map(provider=>({provider,connection:{rpcEndpoint:`https://${provider}.invalid`,simulateTransaction:async()=>({context:{slot:1000},value:{err:null}})}}))
 const sender=nativeTransactionSender({enabled:true,connections,clock:()=>now,fetchImpl:async()=>{sends++;throw Error('PRIVATE-ENDPOINT lost response')}})
 return {sender,connections,advance:value=>{now=value},sends:()=>sends}
}

test('expired review at the exact deadline is rejected before any broadcast',async()=>{
 const f=fixture();f.advance(input.review.reviewExpiresAtMs)
 await assert.rejects(f.sender.send(input));assert.equal(f.sends(),0)
})

test('confirmed simulation crossing the slot ceiling blocks a stale finalized-view request',async()=>{
 const f=fixture()
 f.connections[1].connection.simulateTransaction=async()=>({context:{slot:input.review.validUntilSlot},value:{err:null}})
 await assert.rejects(f.sender.send(input));assert.equal(f.sends(),0)
})

test('a deadline reached during simulation cannot authorize a later broadcast',async()=>{
 const f=fixture()
 f.connections[1].connection.simulateTransaction=async()=>{f.advance(input.review.reviewExpiresAtMs);return {context:{slot:1000},value:{err:null}}}
 await assert.rejects(f.sender.send(input));assert.equal(f.sends(),0)
})

test('failed simulation blocks sending; a lost send response never causes an internal resend or leaks details',async()=>{
 const f=fixture()
 f.connections[1].connection.simulateTransaction=async()=>({context:{slot:1000},value:{err:{InstructionError:[0,'Custom']}}})
 await assert.rejects(f.sender.send(input));assert.equal(f.sends(),0)
 f.connections[1].connection.simulateTransaction=async()=>({context:{slot:1000},value:{err:null}})
 await assert.rejects(f.sender.send(input),error=>!error.message.includes('PRIVATE'));assert.equal(f.sends(),1)
})

test('message identity changes cannot trigger a broadcast',async()=>{
 const f=fixture()
 await assert.rejects(f.sender.send({...input,messageSha256:'0'.repeat(64)}));assert.equal(f.sends(),0)
})
