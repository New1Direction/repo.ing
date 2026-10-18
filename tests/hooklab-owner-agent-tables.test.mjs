// Owner agent table executor against a scripted chain. Synthetic admin key; no RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash,createPrivateKey,sign } from 'node:crypto'
import bs58 from 'bs58'
import { AddressLookupTableProgram,Keypair,PublicKey,SYSVAR_SLOT_HASHES_PUBKEY,VersionedTransaction } from '@solana/web3.js'
import { ownerTableExecutor } from '../src/hooklab-owner-agent-tables.mjs'

const seed=createHash('sha256').update('OWNER AGENT TABLE TEST ONLY admin').digest(),adminPair=Keypair.fromSeed(seed)
const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'})
const inventory=Array.from({length:38},(_,i)=>Keypair.fromSeed(createHash('sha256').update(`address ${i}`).digest()).publicKey.toBase58()).sort()
const inventorySha256=createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
const job={preparationId:'0f3c9a52-6a43-4e0e-b8a8-2a1c1d9e7b10',launchRequestId:'5b7f4c1e-8a0f-4d55-9a49-3f7c0c2b9d11',creator:'c',mint:'m',inventory,inventorySha256}

function chain({drop=new Set(),balance=1_000_000_000}={}){
 const state={height:1000,signed:0,sends:[],landed:new Map(),table:null,blockhashes:0}
 const admin={address:adminPair.publicKey.toBase58(),signBase64:m=>{state.signed++;return sign(null,Buffer.from(m),key).toString('base64')}}
 const connection={
  async getAccountInfo(k){
   if(k.equals(SYSVAR_SLOT_HASHES_PUBKEY)){const b=Buffer.alloc(48);b.writeBigUInt64LE(1n,0);b.writeBigUInt64LE(5000n,8);return {data:b}}
   if(state.table&&k.toBase58()===state.table.address){const h=Buffer.alloc(56);h.writeUInt32LE(1,0);h.writeBigUInt64LE(0xffffffffffffffffn,4);h[21]=1;adminPair.publicKey.toBuffer().copy(h,22)
    return {owner:AddressLookupTableProgram.programId,data:Buffer.concat([h,...state.table.addresses.map(a=>new PublicKey(a).toBuffer())])}}
   return null},
  async getLatestBlockhash(){state.blockhashes++;return {blockhash:bs58.encode(createHash('sha256').update(`bh ${state.blockhashes}`).digest()),lastValidBlockHeight:state.height+150}},
  async getMinimumBalanceForRentExemption(n){return (128+n)*6960},async getBalance(){return balance},
  async getBlockHeight(){return state.height},async getSlot(){return 6000},
  async sendRawTransaction(wire){
   const tx=VersionedTransaction.deserialize(wire),signature=bs58.encode(tx.signatures[0]);state.sends.push(signature)
   if(drop.has(state.landed.size)){drop.delete(state.landed.size);state.height+=200;return signature}   // this step never lands; its blockhash expires
   if(!state.landed.has(signature)){
    state.landed.set(signature,'finalized')
    for(const ix of tx.message.compiledInstructions){
     const program=tx.message.staticAccountKeys[ix.programIdIndex]
     if(!program.equals(AddressLookupTableProgram.programId))continue
     const kind=Buffer.from(ix.data).readUInt32LE(0),table=tx.message.staticAccountKeys[ix.accountKeyIndexes[0]].toBase58()
     if(kind===0)state.table={address:table,addresses:[]}
     if(kind===2){const data=Buffer.from(ix.data),n=Number(data.readBigUInt64LE(4));for(let i=0;i<n;i++)state.table.addresses.push(new PublicKey(data.subarray(12+32*i,44+32*i)).toBase58())}
    }
   }
   return signature},
  async getSignatureStatuses([s]){return {value:[state.landed.has(s)?{err:null,confirmationStatus:state.landed.get(s)}:null]}},
 }
 return {state,admin,connections:[connection,connection]}
}
const withDir=async work=>{const dir=mkdtempSync(path.join(tmpdir(),'owner-tables-'));try{await work(dir)}finally{rmSync(dir,{recursive:true,force:true})}}
const sleep=async()=>{}

test('creates the exact table with one journaled signature per step',async()=>withDir(async dir=>{
 const {state,admin,connections}=chain(),tables=ownerTableExecutor({connections,admin,journalDir:dir,sleep})
 const address=await tables.ensure(job)
 assert.equal(address,state.table.address);assert.deepEqual(state.table.addresses,inventory);assert.equal(state.signed,2)
 const record=JSON.parse(readFileSync(path.join(dir,`${job.preparationId}.json`),'utf8'))
 assert.equal(record.status,'created');assert.ok(!JSON.stringify(record).includes(bs58.encode(adminPair.secretKey)),'journal holds no key')
 assert.equal(await tables.ensure(job),address);assert.equal(state.signed,2,'a finished table is never signed again')
 await assert.rejects(tables.ensure({...job,inventorySha256:'0'.repeat(64)}),/journaled table differs/)
}))

test('a step that expires unseen is re-signed once; a crash resumes the same signature',async()=>withDir(async dir=>{
 const {state,admin,connections}=chain({drop:new Set([1])})
 await ownerTableExecutor({connections,admin,journalDir:dir,sleep}).ensure(job)
 const record=JSON.parse(readFileSync(path.join(dir,`${job.preparationId}.json`),'utf8'))
 assert.equal(record.expiredSteps.length,1);assert.equal(record.expiredSteps[0].key,'step-1');assert.equal(state.signed,3)
 assert.deepEqual(state.table.addresses,inventory)
}))

test('a resumed agent sends the journaled transaction instead of signing a new one',async()=>withDir(async dir=>{
 const first=chain({drop:new Set([0])})
 first.connections[0].getBlockHeight=async()=>0   // the blockhash is still valid: nothing may be re-signed
 const stalled=ownerTableExecutor({connections:first.connections,admin:first.admin,journalDir:dir,sleep:async()=>{throw Error('agent stopped')}})
 await assert.rejects(stalled.ensure(job),/agent stopped/)
 const journaled=JSON.parse(readFileSync(path.join(dir,`${job.preparationId}.json`),'utf8')).steps['step-0'].signature
 const second=chain();second.state.signed=0
 await ownerTableExecutor({connections:second.connections,admin:second.admin,journalDir:dir,sleep}).ensure(job)
 assert.equal(second.state.sends[0],journaled,'the same signature is broadcast again');assert.equal(second.state.signed,1,'only the remaining step is signed')
}))

test('refuses before signing when the admin cannot pay the table rent',async()=>withDir(async dir=>{
 const {state,admin,connections}=chain({balance:1_000})
 await assert.rejects(ownerTableExecutor({connections,admin,journalDir:dir,sleep}).ensure(job),/admin needs/);assert.equal(state.signed,0)
}))
