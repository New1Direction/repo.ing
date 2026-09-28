import test from 'node:test'
import assert from 'node:assert/strict'
import {assertExpiredUnlandedLaunch} from '../src/launch-expiry.mjs'
const now=Date.now(), market={status:'ambiguous',mint:'mint',pool:'pool',launch_signature:'sig',blockhash:'hash',last_valid_block_height:'100'}
const observation={getGenesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',getBlockHeight:300,isBlockhashValid:{value:false,context:{slot:400}},getSignatureStatuses:{value:[null],context:{slot:400}},getTransaction:null,getMultipleAccounts:{value:[null,null],context:{slot:400}}}
const evidence=()=>({independentRpc:true,checkedAt:new Date(now).toISOString(),observations:[structuredClone(observation),structuredClone(observation)]})
test('two fresh mainnet providers prove an expired launch never landed',()=>assert.equal(assertExpiredUnlandedLaunch(market,evidence(),now).status,'EXPIRED_UNLANDED'))
test('never release landed, unexpired, stale, single-provider or disputed evidence',()=>{
 for(const mutate of [e=>e.independentRpc=false,e=>e.checkedAt=new Date(now-61000).toISOString(),e=>e.observations[1].getTransaction={},e=>e.observations[1].getMultipleAccounts.value[0]={},e=>e.observations[1].getSignatureStatuses.value[0]={err:null},e=>e.observations[1].getBlockHeight=249,e=>e.observations[1].isBlockhashValid.value=true,e=>e.observations[1].getGenesisHash='devnet',e=>e.observations[1].getMultipleAccounts.context.slot=700]){
  const e=evidence();mutate(e);assert.throws(()=>assertExpiredUnlandedLaunch(market,e,now))
 }
 for(const change of [{status:'confirmed'},{indexed_at:new Date()},{launch_slot:'1'},{launch_signature:null}])assert.throws(()=>assertExpiredUnlandedLaunch({...market,...change},evidence(),now))
})
