import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { chartBlockEvidence, verifyChartBlock, createChartOrdering } from '../src/chart-ordering.mjs'

const encode=(size,n)=>bs58.encode(new Uint8Array(size).fill(n))
const a=encode(64,1),b=encode(64,2)
const block={blockhash:encode(32,1),previousBlockhash:encode(32,2),parentSlot:99,signatures:[b,a]}
const rpc=(endpoint,changes={})=>({rpcEndpoint:endpoint,getGenesisHash:async()=>'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  getBlockSignatures:async(slot,commitment)=>{assert.equal(slot,100);assert.equal(commitment,'finalized');return structuredClone(block)},...changes})

test('two finalized RPCs agree on exact block order, not alphabetical order',async()=>{
  const proof=await verifyChartBlock({connection:rpc('primary'),verification:rpc('secondary'),slot:100,signatures:[a,b]})
  assert.deepEqual(proof.signatures,[b,a]);assert.equal(proof.parentSlot,99)
})
test('wrong network, missing independent verifier, null block and RPC disagreement fail closed',async()=>{
  const input={connection:rpc('primary'),verification:rpc('secondary'),slot:100,signatures:[a,b]}
  await assert.rejects(verifyChartBlock({...input,verification:null}),/VERIFICATION_REQUIRED/)
  await assert.rejects(verifyChartBlock({...input,verification:rpc('primary')}),/VERIFICATION_REQUIRED/)
  await assert.rejects(verifyChartBlock({...input,verification:rpc('secondary',{getGenesisHash:async()=>'devnet'})}),/NETWORK_MISMATCH/)
  await assert.rejects(verifyChartBlock({...input,verification:rpc('secondary',{getBlockSignatures:async()=>null})}),/BLOCK_INVALID/)
  await assert.rejects(verifyChartBlock({...input,verification:rpc('secondary',{getBlockSignatures:async()=>({...block,signatures:[a,b]})})}),/RPC_DISAGREEMENT/)
})
test('reject malformed block identity, duplicate or absent trade signatures',()=>{
  assert.throws(()=>chartBlockEvidence(100,{...block,parentSlot:100},[a]),/INVALID/)
  assert.throws(()=>chartBlockEvidence(100,{...block,blockhash:'bad'},[a]),/INVALID/)
  assert.throws(()=>chartBlockEvidence(100,{...block,signatures:[a,a]},[a]),/DUPLICATE/)
  assert.throws(()=>chartBlockEvidence(100,block,[encode(64,3)]),/MISSING/)
})
test('RPC failures retain a pending slot, back off and recover without recording fabricated evidence',async()=>{
  let clock=0,calls=0,stored=null,released=0,unavailable=true
  const db={query:async(sql,values)=>{
    if(sql.includes('pg_try'))return {rows:[{locked:true}]}
    if(sql.includes('pg_advisory_unlock'))return {rows:[]}
    if(sql.includes('from trade_events'))return {rows:stored?[]:[{slot:'100',signatures:[a,b]}]}
    if(sql.startsWith('insert')){stored={slot:values[0],blockhash:values[1],previous_blockhash:values[2],parent_slot:values[3],signatures:values[4]};return {rows:[]}}
    return {rows:[stored]}
  },release:()=>{released++}}
  const worker=createChartOrdering({pool:{connect:async()=>db},now:()=>clock,connection:rpc('primary',{getBlockSignatures:async()=>{calls++;if(unavailable)throw Error('private RPC URL');return block}}),verification:rpc('secondary')})
  const first=await worker.runOnce();assert.equal(first.pending,1);assert.equal(first.errors[0].code,'CHART_RPC_UNAVAILABLE');assert.equal(stored,null)
  await worker.runOnce();assert.equal(calls,1)
  clock=600001;unavailable=false
  assert.equal((await worker.runOnce()).verified,1);assert.equal(calls,2);assert.equal(released,3)
})
