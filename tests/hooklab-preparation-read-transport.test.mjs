import test from 'node:test'
import assert from 'node:assert/strict'
import { preparationReadConnections } from '../src/hooklab-preparation-read-transport.mjs'
const settings=[{provider:'alpha',url:'https://alpha.invalid/private-key'},{provider:'beta',url:'https://beta.invalid/private-key'}]
test('two independently configured origins, HTTPS and strict labels required before transport use',()=>{
  for(const values of [[settings[0],settings[0]],[settings[0],{...settings[1],url:'https://alpha.invalid/other'}],[settings[0],{...settings[1],url:'http://beta.invalid'}],[settings[0],{...settings[1],url:'https://user:secret@beta.invalid'}],[settings[0],{...settings[1],extra:true}]])assert.throws(()=>preparationReadConnections(values))
})
test('bounded transport permits read RPC only and forces no redirects with abort signal',async()=>{
  let reads=0
  const [adapter]=preparationReadConnections(settings,{fetchImpl:async(url,init)=>{reads++;assert.equal(url,settings[0].url);assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);const req=JSON.parse(init.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result:'genesis'}))}})
  assert.equal(await adapter.connection.getGenesisHash(),'genesis');assert.equal(reads,1)
  await assert.rejects(adapter.connection.sendRawTransaction(Buffer.from([1])));assert.equal(reads,1)
})
test('oversized, failed and redirect responses are redacted, cancelled and refused',async()=>{
  for(const fetchImpl of [async()=>new Response('x'.repeat(100),{headers:{'content-length':'100'}}),async()=>new Response('x'.repeat(100)),async()=>new Response('bad',{status:500}),async()=>{throw Error('private-key')}]){
    const [adapter]=preparationReadConnections(settings,{fetchImpl,maxResponseBytes:32})
    await assert.rejects(adapter.connection.getGenesisHash(),error=>{assert.doesNotMatch(error.message,/private-key/);return true})
  }
})

test('timeout aborts the configured fetch and oversized streams cancel their reader',async()=>{
 let aborted=false,cancelled=false
 const [timed]=preparationReadConnections(settings,{timeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{
  const keeper=setTimeout(()=>reject(Error('unexpected timeout')),100)
  signal.addEventListener('abort',()=>{aborted=true;clearTimeout(keeper);reject(Error('aborted private-key'))},{once:true})
 })})
 await assert.rejects(timed.connection.getGenesisHash());assert.equal(aborted,true)
 const [oversized]=preparationReadConnections(settings,{maxResponseBytes:8,fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(9))},cancel(){cancelled=true}}))})
 await assert.rejects(oversized.connection.getGenesisHash());assert.equal(cancelled,true)
})
