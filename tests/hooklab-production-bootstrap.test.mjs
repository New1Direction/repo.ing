// Injected reads only; no RPC, database or keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { productionSettings,productionKeyRing,chainObservers } from '../src/hooklab-production-bootstrap.mjs'
import { register } from '../instrumentation.js'

const admin='DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5'
const bundleBytes=Buffer.from(JSON.stringify({schema:'repoing/production-operator-bundle/1',profile:{providers:['helius','publicnode']},
 config:{reviewer:admin,economics:{launchFeeLamports:'0',poolCreationFeeLamports:'0'}},dossierJson:'{}'}))
const ring=JSON.stringify({'k-2026-10':Buffer.alloc(32,7).toString('base64')})
const env={HOOK_OWNER_APPROVED_LAUNCHES:'true',HOOK_NATIVE_LAUNCH_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOKLAB_PRODUCTION_BUNDLE_FILE:'/approved/bundle.json',HOOKLAB_PRODUCTION_BUNDLE_SHA256:createHash('sha256').update(bundleBytes).digest('hex'),
 HOOK_LAUNCH_ADMIN_ADDRESS:admin,HOOKLAB_PRODUCTION_RPC_PRIMARY_URL:'https://mainnet.helius-rpc.com/?api-key=x',HOOKLAB_PRODUCTION_RPC_SECONDARY_URL:'https://solana-rpc.publicnode.com',
 HOOK_NATIVE_KEYRING_JSON:ring,HOOK_NATIVE_ACTIVE_KEY_ID:'k-2026-10'}
// Mainnet's rent rate today (5,080 lamports per byte, 128 bytes of account overhead).
const fake=(slot,blockHeight)=>({getSlot:async()=>slot,getBlockHeight:async()=>blockHeight,getMinimumBalanceForRentExemption:async size=>(128+size)*5080})
const deps={readBundle:async()=>bundleBytes,connectionFor:()=>fake(1000,900)}

test('production settings verify the approved bundle, admin, RPCs, key ring and fees before anything installs',async()=>{
 const s=await productionSettings({env,...deps})
 assert.deepEqual(s.connections.map(c=>c.provider),['helius','publicnode']);assert.equal(s.activeKeyId,'k-2026-10');assert.equal(s.keyRing['k-2026-10'].length,32)
 const limits=await s.launchLimits();assert.equal(limits.launchLimits.computeUnitPriceMicroLamports,'0');assert.equal(limits.launchLimits.maxNetworkFeeLamports,'15000')
 assert.equal(limits.setupLimits.computeUnitLimit,1400000)
 assert.equal(limits.setupLimits.maxRentLamports,'20000000')
 assert.equal(limits.setupLimits.maxTotalDebitLamports,'20015000')
 assert.equal(limits.setupLimits.validUntilSlot,limits.preparationLimits.validUntilSlot)
 assert.equal(limits.setupLimits.reviewExpiresAtMs,limits.preparationLimits.reviewExpiresAtMs)
 assert.equal((await productionSettings({env:{...env,HOOKLAB_PRIORITY_MICROLAMPORTS:'10000'},...deps})).tradeLimits.maxNetworkFeeLamports,'29000')
 for(const [change,message] of [
  [{HOOK_OWNER_APPROVED_LAUNCHES:'false'},/not enabled/],
  [{HOOK_NATIVE_LAUNCH_ENABLED:undefined},/switches must both be on/],
  [{HOOK_WALLET_IDENTITY_ENABLED:'false'},/switches must both be on/],
  [{HOOKLAB_PRODUCTION_BUNDLE_SHA256:'0'.repeat(64)},/differs from its approved hash/],
  [{HOOK_LAUNCH_ADMIN_ADDRESS:'9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md'},/not the configured launch admin/],
  [{HOOKLAB_PRODUCTION_RPC_SECONDARY_URL:'http://insecure.example'},/two HTTPS production RPC URLs/],
  [{HOOKLAB_PRODUCTION_RPC_PRIMARY_URL:undefined},/two HTTPS production RPC URLs/],
  [{HOOK_NATIVE_KEYRING_JSON:'not json'},/missing or not JSON/],
  [{HOOK_NATIVE_KEYRING_JSON:JSON.stringify({k:Buffer.alloc(16).toString('base64')}),HOOK_NATIVE_ACTIVE_KEY_ID:'k'},/32-byte keys/],
  [{HOOK_NATIVE_ACTIVE_KEY_ID:'other'},/not in the key ring/],
  [{HOOKLAB_PRIORITY_MICROLAMPORTS:'-1'},/small integer/],
 ])await assert.rejects(productionSettings({env:{...env,...change},...deps}),message,JSON.stringify(change))
 assert.throws(()=>productionKeyRing({}),/missing or not JSON/)
})

test('observers sign against the later view and expire only when both providers are past',async()=>{
 const o=chainObservers([{connection:fake(100,80)},{connection:fake(120,95)}])
 const live=await o.live();assert.equal(live.slot,120);assert.equal(live.blockHeight,95)
 const past=await o.bothPast();assert.equal(past.slot,100);assert.equal(past.blockHeight,80)
})

test('instrumentation does nothing unless the production bootstrap is explicitly enabled',async()=>{
 const before=process.env.HOOK_PRODUCTION_BOOTSTRAP,runtime=process.env.NEXT_RUNTIME
 try{process.env.NEXT_RUNTIME='nodejs';delete process.env.HOOK_PRODUCTION_BOOTSTRAP;assert.equal(await register(),undefined)}
 finally{if(before===undefined)delete process.env.HOOK_PRODUCTION_BOOTSTRAP;else process.env.HOOK_PRODUCTION_BOOTSTRAP=before;if(runtime===undefined)delete process.env.NEXT_RUNTIME;else process.env.NEXT_RUNTIME=runtime}
})

test('a provider still behind the other catches up instead of refusing; other errors and plain properties pass through',async()=>{
 const {catchUpConnection}=await import('../src/hooklab-production-bootstrap.mjs')
 let calls=0
 const behind={rpcEndpoint:'https://api.mainnet-beta.solana.com',async isBlockhashValid(){if(++calls<3)throw Error('failed to determine if the blockhash is valid: Minimum context slot has not been reached');return {value:true}},
  async getSlot(){throw Error('429 Too Many Requests')}}
 const c=catchUpConnection(behind,{sleep:async()=>{}})
 assert.equal(c.rpcEndpoint,'https://api.mainnet-beta.solana.com')
 assert.deepEqual(await c.isBlockhashValid('x',{minContextSlot:5}),{value:true});assert.equal(calls,3)
 await assert.rejects(c.getSlot(),/429/,'unrelated errors are not retried')
 calls=-100;await assert.rejects(catchUpConnection(behind,{sleep:async()=>{},attempts:3}).isBlockhashValid('x'),/Minimum context slot/,'bounded')
})

test('two bundles: bundle 2 for the legacy stack and our own stack\'s bundle for open launches, each checked in its place',async()=>{
 const stackAdmin='9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md',legacyPrograms={launch:'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft',swap:'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk',
  gate:'BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb',token:'2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22',bridge:'CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7'}
 const ownPrograms={token:'Hd8ZnPitqn25jJd7bnsvAm16NAbyuBqsAt4PSisCHw61',gate:'2SXqMdMajvHb8oHXw8saTTizUnDJBHD2cVFQhsKTnJGQ',launch:'AbDhG5aFs7hSkYZ71MZ2dZkaMbMhohiKgLpepDenQ2w1',swap:'9HsALDF9rYPbm6TC9XBJR6mP5v9yHoUn9GA4HHMHNWEC'}
 const bundleOf=(programs,reviewer,extra={},fee='0')=>Buffer.from(JSON.stringify({schema:'repoing/production-operator-bundle/1',genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  profile:{providers:['helius','publicnode'],json:JSON.stringify({programs,...extra})},config:{reviewer,economics:{launchFeeLamports:fee,poolCreationFeeLamports:'0'}},dossierJson:'{}'}))
 const legacy=bundleOf(legacyPrograms,admin),own=bundleOf(ownPrograms,stackAdmin,{stack:{id:'own'}},'20000000')
 const files={'/approved/bundle.json':legacy,'/approved/stack.json':own},hex=b=>createHash('sha256').update(b).digest('hex')
 const twoEnv={...env,HOOK_OPEN_LAUNCHES:'true',HOOK_NATIVE_LAUNCHES_ENABLED:'true',HOOKLAB_PRODUCTION_BUNDLE_SHA256:hex(legacy),
  HOOKLAB_STACK_BUNDLE_FILE:'/approved/stack.json',HOOKLAB_STACK_BUNDLE_SHA256:hex(own),HOOK_STACK_ADMIN_ADDRESS:stackAdmin}
 const read={readBundle:async file=>files[file],connectionFor:()=>fake(1000,900)}
 const s=await productionSettings({env:twoEnv,...read})
 assert.equal(s.bundle.config.reviewer,admin);assert.equal(s.stack.config.reviewer,stackAdmin);assert.equal(s.launchBundle,s.stack,'open launches launch on our own stack')
 const open=(await s.launchLimits()).launchLimits
 assert.equal(open.maxLaunchFeeLamports,'20000000','the launch fee bound is our stack\'s')
 // The rent bound is exact, from the chain's rent when the launch is reserved: the launch transaction's rent (23,891,240 at
 // today's rate), the launch account's again (the program's guard counts it twice: 3,520,440) and the 100,000 margin.
 assert.equal(open.maxRentLamports,String(23891240+3520440+100000)); assert.equal(open.maxInstructionDebitLamports,String(20000000+23891240+3520440+100000))
 for(const [change,message] of [
  [{HOOKLAB_STACK_BUNDLE_FILE:undefined,HOOKLAB_STACK_BUNDLE_SHA256:undefined},/launch on our own stack/],
  [{HOOKLAB_STACK_BUNDLE_SHA256:undefined},/set both/],
  [{HOOKLAB_STACK_BUNDLE_SHA256:'0'.repeat(64)},/differs from its approved hash/],
  [{HOOK_STACK_ADMIN_ADDRESS:admin},/not the configured stack admin/],
 ])await assert.rejects(productionSettings({env:{...twoEnv,...change},...read}),message,JSON.stringify(change))
 // A stack bundle that is legacy, or shares a program with the legacy stack, is refused.
 for(const [bytes,message] of [[bundleOf(legacyPrograms,stackAdmin),/not a production bundle of our own stack/],
  [bundleOf({...ownPrograms,gate:legacyPrograms.gate},stackAdmin,{stack:{id:'own'}}),/shares a program/]]){
  const r={readBundle:async file=>file==='/approved/stack.json'?bytes:legacy,connectionFor:()=>fake(1000,900)}
  await assert.rejects(productionSettings({env:{...twoEnv,HOOKLAB_STACK_BUNDLE_SHA256:hex(bytes)},...r}),message)
 }
 // Without open launches the stack bundle is optional and launches stay on bundle 2.
 const legacyOnly=await productionSettings({env:{...env,HOOKLAB_PRODUCTION_BUNDLE_SHA256:hex(legacy)},readBundle:async()=>legacy,connectionFor:()=>fake(1000,900)})
 assert.equal(legacyOnly.stack,null);assert.equal(legacyOnly.launchBundle,legacyOnly.bundle)
})
