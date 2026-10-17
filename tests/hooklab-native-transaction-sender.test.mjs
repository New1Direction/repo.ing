import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Keypair,TransactionMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {nativeTransactionSender} from '../src/hooklab-native-transaction-sender.mjs'
const signer=Keypair.fromSeed(Buffer.alloc(32,91)),tx=new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:Keypair.fromSeed(Buffer.alloc(32,92)).publicKey.toBase58(),instructions:[]}).compileToV0Message());tx.sign([signer])
const input={signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0]),messageSha256:createHash('sha256').update(tx.message.serialize()).digest('hex')}
function fixture(){const calls=[],connections=['one','two'].map(provider=>({provider,connection:{rpcEndpoint:`https://${provider}.invalid`,simulateTransaction:async(transaction,options)=>{calls.push({provider,options});assert.deepEqual(transaction.serialize(),tx.serialize());return {value:{err:null}}}}}));return {calls,connections}}
test('sender simulates exact signatures on both readers then makes one no-redirect/no-retry request',async()=>{
 const f=fixture();let sends=0
 const sender=nativeTransactionSender({enabled:true,connections:f.connections,fetchImpl:async(url,options)=>{
  sends++;assert.equal(url,'https://one.invalid');assert.equal(options.redirect,'error');const body=JSON.parse(options.body)
  assert.equal(body.params[0],input.signedTransactionBase64);assert.deepEqual(body.params[1],{encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'})
  return Response.json({jsonrpc:'2.0',id:body.id,result:input.signature})
 }})
 assert.equal(await sender.send(input),input.signature);assert.equal(sends,1);assert.equal(f.calls.length,2)
 assert.ok(f.calls.every(x=>x.options.sigVerify===true&&x.options.replaceRecentBlockhash===false))
})
test('sender performs no send after simulation failure and never retries a lost send response',async()=>{
 const f=fixture();let sends=0;const sender=nativeTransactionSender({enabled:true,connections:f.connections,fetchImpl:async()=>{sends++;throw Error('PRIVATE-ENDPOINT')}})
 f.connections[1].connection.simulateTransaction=async()=>({value:{err:{InstructionError:[0,'Custom']}}})
 await assert.rejects(sender.send(input));assert.equal(sends,0)
 f.connections[1].connection.simulateTransaction=async()=>({value:{err:null}})
 await assert.rejects(sender.send(input),error=>!error.message.includes('PRIVATE'));assert.equal(sends,1)
 await assert.rejects(sender.send({...input,messageSha256:'0'.repeat(64)}));assert.equal(sends,1)
 assert.throws(()=>nativeTransactionSender({connections:f.connections}))
 assert.throws(()=>nativeTransactionSender({enabled:true,connections:[f.connections[0],f.connections[0]]}))
})
