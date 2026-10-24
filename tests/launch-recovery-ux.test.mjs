import test from 'node:test'
import assert from 'node:assert/strict'
import {launchDraftKey,readLaunchDraft,saveLaunchDraft} from '../app/lib/launch-draft.mjs'
import {launchFailure} from '../src/launch-failure.mjs'
import {DefinitiveLaunchError} from '../src/meteora-launch.mjs'
import {GET,POST} from '../app/api/launch/route.js'
import * as server from '../app/lib/server.mjs'
import {Keypair} from '@solana/web3.js'
import {RECOVERED_LAUNCH_CONFIG} from '../src/launch-custody.mjs'
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
test('ordinary recovery uses a separate bootstrap/config/database and refuses broader launch variants before reserving',async()=>{
 const names=['ORDINARY_LAUNCH_RECOVERY_ENABLED','ORDINARY_LAUNCH_DATABASE_URL','ORDINARY_LAUNCH_CONFIG','ORDINARY_LAUNCH_BOOTSTRAP_SECRET_KEY','DBC_CONFIG','PLATFORM_CREATOR_SECRET_KEY','PLATFORM_PARTNER_SECRET_KEY']
 const old=Object.fromEntries(names.map(name=>[name,process.env[name]])),bootstrap=Keypair.generate()
 try{
  process.env.ORDINARY_LAUNCH_RECOVERY_ENABLED='true'
  process.env.ORDINARY_LAUNCH_DATABASE_URL='postgres://repoing_ordinary_launcher:synthetic@localhost/repoing_operational?sslmode=verify-full'
  process.env.ORDINARY_LAUNCH_CONFIG=RECOVERED_LAUNCH_CONFIG
  process.env.ORDINARY_LAUNCH_BOOTSTRAP_SECRET_KEY=JSON.stringify([...bootstrap.secretKey])
  process.env.DBC_CONFIG='historical-trading-config'
  delete process.env.PLATFORM_CREATOR_SECRET_KEY;delete process.env.PLATFORM_PARTNER_SECRET_KEY
  assert.equal(typeof server.ordinaryLaunchRuntime,'function')
  const runtime=server.ordinaryLaunchRuntime()
  assert.equal(runtime.config,RECOVERED_LAUNCH_CONFIG)
  assert.equal(runtime.creator.publicKey.toBase58(),bootstrap.publicKey.toBase58())
  assert.equal(runtime.discoveryEnabled,true);assert.equal(runtime.builderAllocationEnabled,true)
  assert.equal(runtime.verificationBonusLamports,null)
  assert.equal(server.configAddress(),'historical-trading-config');assert.equal(server.creatorSigner(),null)
  for(const variant of [{initialBuyLamports:'1'},{quoteAssetId:'stock'},{earlyAccessSeconds:900},{fairRamp:true},{starUnlocks:true},{repoId:'-123'},{repoId:'4503599627370497'},{trendRevision:1}]){
   const response=await POST(new Request('https://repo.ing/api/launch',{method:'POST',body:JSON.stringify({action:'prepare',...variant})}))
   assert.equal(response.status,400)
   assert.match((await response.json()).error,/ordinary no-buy GitHub launches/i)
  }
  process.env.ORDINARY_LAUNCH_CONFIG='historical-trading-config'
  assert.throws(()=>server.ordinaryLaunchRuntime(),/recovered launch config/i)
  process.env.ORDINARY_LAUNCH_CONFIG=RECOVERED_LAUNCH_CONFIG
  process.env.ORDINARY_LAUNCH_DATABASE_URL='postgres://owner:synthetic@localhost/repoing_operational?sslmode=verify-full'
  assert.throws(()=>server.ordinaryLaunchRuntime(),/dedicated launch database/i)
  process.env.ORDINARY_LAUNCH_DATABASE_URL='postgres://repoing_ordinary_launcher:synthetic@localhost/repoing_operational?sslmode=verify-full'
  delete process.env.ORDINARY_LAUNCH_BOOTSTRAP_SECRET_KEY
  assert.throws(()=>server.ordinaryLaunchRuntime(),/bootstrap signer/i)
 }finally{
  for(const name of names)if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name]
  await globalThis.__repoingOrdinaryLaunchPool?.end();delete globalThis.__repoingOrdinaryLaunchPool
 }
})

test('recovered launch form offers no initial buy and describes paused claims and trading honestly',async()=>{
 const {appModule,h,html}=await import('./fixtures/render-jsx.mjs')
 const {LaunchForm}=await appModule('app/components/launch-form.jsx')
 const markup=html(h(LaunchForm,{repo:{repoId:'123',owner:'fixture',name:'demo',fullName:'fixture/demo'},
  available:true,recovery:true,discoveryEnabled:true,allocationEnabled:true,draft:{tokenName:'Demo',tokenSymbol:'DEMO',initialBuy:'300'}}),{wallet:true})
 assert.doesNotMatch(markup,/id="initial-buy"|Max 3%|Claim in SOL from the market page/)
 assert.match(markup,/No initial buy/)
 assert.match(markup,/Claims remain paused/)
 assert.match(markup,/Trading on newly launched markets remains paused/)
})
