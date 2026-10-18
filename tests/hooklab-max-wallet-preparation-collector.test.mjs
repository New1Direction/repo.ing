import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { collectMaxWalletPreparationReview } from '../src/hooklab-max-wallet-preparation-collector.mjs'
import { planMaxWalletPreparation } from '../src/hooklab-max-wallet-preparation.mjs'
import { maxWalletPlanningReadConnections } from '../src/hooklab-preparation-read-transport.mjs'
import { maxWalletPreparationFixture } from './fixtures/hooklab-max-wallet-preparation.mjs'
import { fakePlanningReaders as fake } from './fixtures/hooklab-max-wallet-planning-readers.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const test = testRequiring(missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json']))
test('two-reader collector reproduces exact independently executed preparation message with both fee quotes',async()=>{
 const f=maxWalletPreparationFixture(),out=await collectMaxWalletPreparationReview({...f,connections:fake(f),clock:()=>1000})
 assert.deepEqual(out.plan,planMaxWalletPreparation(f));assert.equal(out.collection.feeQuotedByBoth,true);assert.equal(out.plan.canSign,false)
})
test('collector rejects disagreement, wrong chain, invalid blockhash, stale/null/wrong fees and expiry',async()=>{
 for(const mutation of [
  f=>{f.observations[1].genesisHash=f.request.mint},
  f=>{f.observations[1].accounts[9].account.lamports='1'},
 ]){const f=maxWalletPreparationFixture();mutation(f);await assert.rejects(collectMaxWalletPreparationReview({...f,connections:fake(f),clock:()=>1000}),{code:'MAX_WALLET_PREPARATION_READS_UNAVAILABLE'})}
 for(const mutate of [(kind,x,i)=>{if(kind==='valid'&&i===1)x.value=false},(kind,x,i)=>{if(kind==='fee'&&i===1)x.value=null},(kind,x)=>{if(kind==='fee')x.value++},(kind,x)=>{if(kind==='fee')x.context.slot--}]){
  const f=maxWalletPreparationFixture();await assert.rejects(collectMaxWalletPreparationReview({...f,connections:fake(f,mutate),clock:()=>1000}))
 }
 const f=maxWalletPreparationFixture();let calls=0
 await assert.rejects(collectMaxWalletPreparationReview({...f,connections:fake(f),clock:()=>++calls<3?1000:6000}))
})
test('planning transport uses exact SDK read RPC params and rejects write/simulation methods before fetch',async()=>{
 const seen=[],f=maxWalletPreparationFixture()
 const [reader]=maxWalletPlanningReadConnections([{provider:'a',url:'https://a.invalid/key'},{provider:'b',url:'https://b.invalid/key'}],{fetchImpl:async(_url,init)=>{
  const body=JSON.parse(init.body);seen.push(body);assert.equal(init.redirect,'error')
  const result=body.method==='getMinimumBalanceForRentExemption'?123:{context:{slot:1},value:15000}
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}))
 }})
 assert.equal(await reader.connection.getMinimumBalanceForRentExemption(85,'finalized'),123)
 assert.deepEqual(seen[0].params,[85,{commitment:'finalized'}])
 await assert.rejects(reader.connection.sendRawTransaction(Buffer.from([1,2,3])))
 assert.equal(seen.length,1)
})
test('collector runs through actual bounded Connection SDK serialization for every planning read',async()=>{
 const f=maxWalletPreparationFixture(),seen=new Set(),settings=f.profile.providers.map((provider,i)=>({provider,url:`https://provider-${i}.invalid/secret`}))
 const readers=maxWalletPlanningReadConnections(settings,{fetchImpl:async(url,init)=>{
  const i=settings.findIndex(x=>x.url===url),o=f.observations[i],body=JSON.parse(init.body);seen.add(body.method)
  let result;const context={slot:o.slot}
  assert.equal(init.redirect,'error');assert.equal(body.params?.at(-1)?.commitment??'finalized','finalized')
  switch(body.method){
   case 'getGenesisHash':result=o.genesisHash;break
   case 'getMultipleAccounts':result={context,value:o.accounts.map(x=>x.account&&{owner:x.account.owner,executable:x.account.executable,lamports:Number(x.account.lamports),data:[x.account.dataBase64,'base64'],rentEpoch:0})};break
   case 'getMinimumBalanceForRentExemption':result=Number(o.rentExemptionLamports[{85:'policy',81:'registry',176:'selectedConfig'}[body.params[0]]]);break
   case 'getLatestBlockhash':result={context,value:{blockhash:f.recentBlockhash.blockhash,lastValidBlockHeight:f.recentBlockhash.lastValidBlockHeight}};break
   case 'isBlockhashValid':result={context,value:true};break
   case 'getBlockHeight':result=f.recentBlockhash.currentBlockHeight;break
   case 'getFeeForMessage':assert.equal(body.params[0],planMaxWalletPreparation(f).review.messageBase64);result={context,value:Number(f.recentBlockhash.networkFeeLamports)};break
   default:throw Error('Unexpected method')
  }
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}))
 }})
 const out=await collectMaxWalletPreparationReview({...f,connections:readers,clock:()=>1000})
 assert.equal(out.plan.review.messageSha256,planMaxWalletPreparation(f).review.messageSha256)
 assert.equal(seen.size,7)
})

test('collector rejects the same connection or known provider origin behind distinct labels',async()=>{
 const f=maxWalletPreparationFixture()
 for(const change of [readers=>{readers[1].connection=readers[0].connection},readers=>{readers[0].connection.rpcEndpoint='https://same.invalid/a';readers[1].connection.rpcEndpoint='https://same.invalid/b'},readers=>{readers[0].connection.rpcEndpoint='https://one.invalid/a'}]){
  const connections=fake(f);change(connections)
  await assert.rejects(collectMaxWalletPreparationReview({...f,connections,clock:()=>1000}),{code:'MAX_WALLET_PREPARATION_READS_UNAVAILABLE'})
 }
})

test('preparation refresh preserves exact retained blockhash/message and never silently rebuilds wallet consent',async()=>{
 const f=maxWalletPreparationFixture(),expectedReview=planMaxWalletPreparation(f).review,connections=fake(f)
 connections[0].connection.getLatestBlockhashAndContext=async()=>{throw Error('must not replace blockhash')}
 const out=await collectMaxWalletPreparationReview({...f,connections,expectedReview,clock:()=>1001})
 assert.deepEqual(out.plan.review,expectedReview);assert.equal(out.preparationInput.request.mint,f.request.mint)
 await assert.rejects(collectMaxWalletPreparationReview({...f,connections,expectedReview:{...expectedReview,maxNativeDebitLamports:'1'},clock:()=>1001}))
})
