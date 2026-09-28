import test from 'node:test'
import assert from 'node:assert/strict'
import {launchDraftKey,readLaunchDraft,saveLaunchDraft} from '../app/lib/launch-draft.mjs'
import {launchFailure} from '../src/launch-failure.mjs'
import {DefinitiveLaunchError} from '../src/meteora-launch.mjs'
import {GET} from '../app/api/launch/route.js'
test('draft saves only user inputs, restores images and expires without retaining signatures or wallets',()=>{
 const map=new Map(),storage={setItem:(k,v)=>map.set(k,v),getItem:k=>map.get(k)}
 const fields={name:'Hindsight',symbol:'HIND',choice:'custom',customBuy:'0.03',tokenImage:{image:'data:image/png;base64,AAAA',label:'Your upload'},wallet:'private',transaction:'signed',review:{id:'old'}}
 assert.equal(saveLaunchDraft(storage,'123',fields,100),true)
 const restored=readLaunchDraft(storage,'123',101)
 assert.equal(restored.tokenImage.image,fields.tokenImage.image);assert.equal(restored.customBuy,'0.03')
 assert.equal(restored.wallet,undefined);assert.doesNotMatch(map.get(launchDraftKey('123')),/signed|private|old/)
 assert.equal(readLaunchDraft(storage,'456',101),null)
 assert.equal(readLaunchDraft(storage,'123',86400200),null)
 assert.equal(saveLaunchDraft({setItem(){throw Error('quota')}},'123',fields),false)
})
test('unknown submission never offers a second launch; definitive pre-broadcast rejection can refresh',()=>{
 assert.equal(launchFailure(Error('Network lost'),'submit').canRetry,false)
 assert.equal(launchFailure(Error('Transaction submitted; pool evidence is still pending'),'prepare').canRetry,false)
 assert.equal(launchFailure(new DefinitiveLaunchError('Your wallet changed the launch transaction'),'submit').canRetry,true)
 assert.equal(launchFailure(Error('GitHub unavailable'),'prepare').canRetry,true)
})
test('status checks expose a market only after finalized indexing and do not sign or write',async()=>{
 const oldUrl=process.env.DATABASE_URL,oldPool=globalThis.__gitfunPool;process.env.DATABASE_URL='postgres://test-only'
 let row
 globalThis.__gitfunPool={query:async(sql,args)=>{assert.match(sql,/^select /);assert.deepEqual(args,['123']);return {rows:row?[row]:[]}}}
 try{
  for(const [record,expected] of [[null,'retry'],[{status:'failed'},'retry'],[{status:'ambiguous',mint:'unproven'},'pending'],[{status:'confirmed',mint:'unproven'},'pending'],[{status:'confirmed',mint:'verified',indexed_at:new Date(),launch_finality:'finalized'},'live']]){
   row=record;const body=await(await GET(new Request('https://repo.ing/api/launch?repo=123'))).json();assert.equal(body.state,expected);assert.equal(body.mint,expected==='live'?'verified':null)
  }
 }finally{if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;globalThis.__gitfunPool=oldPool}
})
