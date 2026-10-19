// Ordinary inclusive trade settlement as production keeps it: the review and settlement context are read back from a
// jsonb column, and the resolver that reconciles may have restarted (new boot-time limits.nowMs) since it reviewed.
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {compileMaxWalletLaunchReview} from '../src/hooklab-max-wallet-launch.mjs'
import {inclusiveTradeResolver} from '../src/hooklab-inclusive-trade-resolver.mjs'
import {makeCanaryState,canaryCollectorBindings,localTestEnvironment,isolatedSvm,pk} from './fixtures/hooklab-canary.mjs'
import {missingArtifactEnv} from './fixtures/hooklab-generated-artifact.mjs'
import {jsonbRoundTrip} from './fixtures/jsonb-round-trip.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex')
const LIMITS={maxAgeMs:5000,maxSlotLag:5,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:'10000',maxTotalDebitLamports:'10000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}
// Boot clocks of two server processes; reviews themselves use the injected clock.
const BOOT=1800000000000,RESTARTED=BOOT+3600000

test('the trade configuration hash ignores the boot clock, and only it',()=>{
 const bundle=JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle-2.json',import.meta.url),'utf8')),origins=bundle.config.providerTrustDomains.map(t=>t.origin)
 const hash=limits=>inclusiveTradeResolver({config:bundle.config,profile:bundle.profile,dossierJson:bundle.dossierJson,limits:{...LIMITS,...limits},
  connections:bundle.profile.providers.map((provider,i)=>({provider,connection:{rpcEndpoint:origins[i]+'rpc'}}))}).configurationSha256
 assert.match(hash({nowMs:BOOT}),/^[a-f0-9]{64}$/);assert.equal(hash({nowMs:BOOT}),hash({nowMs:RESTARTED}))
 assert.notEqual(hash({nowMs:BOOT}),hash({nowMs:BOOT,maxNetworkFeeLamports:'20000'}))
})

test('a real buy settles from its jsonb-stored review and context, also after a restart',{skip:process.env.HOOKLAB_CANARY_REQUIRED!=='true'&&missingArtifactEnv(['HOOKLAB_CANARY_ELF_DIR'],'four pinned inclusive ELFs; HOOKLAB_CANARY_PYTHONPATH must hold solders 0.29.0'),timeout:120000},async t=>{
 const saved=Object.fromEntries(Object.keys(localTestEnvironment()).map(k=>[k,process.env[k]]))
 Object.assign(process.env,localTestEnvironment())
 const svm=isolatedSvm();t.after(()=>{svm.close();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}})
 const profile=JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json',import.meta.url)))
 const names={launch:'bordrless_launch',swap:'bordrless_swap',gate:'hook_max_wallet',token:'bordrless_token'},elfDirectory=process.env.HOOKLAB_CANARY_ELF_DIR
 const init=await svm.call('init',{scope:'isolated-canary-svm/1',programs:Object.entries(names).map(([role,name])=>({address:profile.programs[role],path:`${elfDirectory}/${name}.so`,sha256:role==='token'?profile.dependencyObservation.tokenElfSha256:profile.elfSha256[role]}))})
 const state=makeCanaryState({elfDirectory,roles:init.roles,blockhash:init.blockhash}),a=state.addresses,roles=init.roles
 // Ordinary (not canary) trading: swap unpaused and no governance gate.
 const edit=(role,type,address,change)=>{const row=state.accounts.get(address),bytes=Buffer.from(row.dataBase64,'base64'),value=state.bindings[role].coder.accounts.decode(type,bytes);change(value)
  const out=Buffer.alloc(bytes.length);bytes.copy(out,0,0,8);state.bindings[role].coder.types.encode(type,value).copy(out,8);state.accounts.set(address,{...row,dataBase64:out.toString('base64')})}
 edit('swap','Config',a.swapConfig,v=>{v.paused=false});edit('swap','Governance',a.swapGovernance,v=>{v.state.gates.trading=false})
 await svm.call('set',{accounts:[...state.accounts].map(([address,account])=>({address,account})).sort((x,y)=>Number(x.account.executable)-Number(y.account.executable))})
 const executed=new Map(),send=async messageBase64=>{const result=await svm.call('send',{messageBase64});if(result.historyPresent)executed.set(result.signature,result);return result}
 const launchInput={...state.launchInput,reviewedStateHashes:Object.fromEntries(Object.keys(state.launchInput.reviewedStateHashes).map(k=>[k,state.accountHash(k==='quoteMint'?profile.quoteMint:a[k])])),
  observations:state.launchInput.observations.map(o=>({...o,accounts:o.accounts.map(({address})=>({address,account:state.accounts.get(address)??null}))}))}
 const launched=await send(compileMaxWalletLaunchReview(launchInput).review.messageBase64);assert.equal(launched.error,null,JSON.stringify(launched))
 for(const row of (await svm.call('get',{addresses:[...state.accounts.keys(),...Object.values(a)]})).accounts)if(row.account)state.accounts.set(row.address,row.account)
 const funded=[state.holding(roles.mint,roles.creator,0),state.holding(profile.quoteMint,roles.creator,10000000)]
 await svm.call('set',{accounts:funded.map(address=>({address,account:state.accounts.get(address)}))})
 // Synthetic transport around the real bank: fee and simulation answers are fixed, every byte and receipt is real.
 const transport=()=>({getGenesisHash:async()=>JSON.parse(state.profile.json).genesisHash,getSlot:async()=>100,getBlockHeight:async()=>100,
  getMultipleAccountsInfoAndContext:async keys=>{const s=await svm.call('get',{addresses:keys.map(k=>k.toBase58())})
   return {context:{slot:s.slot},value:s.accounts.map(({account:v})=>v?{owner:pk(v.owner),executable:v.executable,lamports:Number(v.lamports),data:Buffer.from(v.dataBase64,'base64')}:null)}},
  getLatestBlockhashAndContext:async()=>({context:{slot:100},value:{blockhash:(await svm.call('get',{addresses:[]})).blockhash,lastValidBlockHeight:250}}),
  isBlockhashValid:async()=>({context:{slot:100},value:true}),getFeeForMessage:async m=>({context:{slot:100},value:5000*m.header.numRequiredSignatures}),
  simulateTransaction:async()=>({context:{slot:100},value:{err:null}}),
  getTransaction:async signature=>{const r=executed.get(signature);if(!r)return null;const signed=VersionedTransaction.deserialize(Buffer.from(r.wireBase64,'base64'))
   return {slot:r.slot,transaction:{message:signed.message,signatures:signed.signatures.map(s=>bs58.encode(s))},meta:{err:r.error,fee:r.fee,preBalances:[...r.preBalances],postBalances:[...r.postBalances],
    loadedAddresses:Object.fromEntries(Object.entries(r.loadedAddresses).map(([k,v])=>[k,v.map(pk)])),logMessages:[...r.logs],
    innerInstructions:r.innerInstructions.map(g=>({index:g.index,instructions:g.instructions.map(({dataBase64,...ix})=>({...ix,accounts:[...ix.accounts],data:bs58.encode(Buffer.from(dataBase64,'base64'))}))}))}}},
  getBlockSignatures:async()=>({blockhash:roles.table,previousBlockhash:roles.config,parentSlot:99,blockHeight:100,signatures:[...executed.keys()]})})
 const e=localTestEnvironment(),bindings=canaryCollectorBindings(state)
 const connections=state.profile.providers.map((provider,i)=>({provider,connection:{rpcEndpoint:[e.HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY,e.HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY][i],...transport()}}))
 const resolverAt=nowMs=>inclusiveTradeResolver({...bindings,connections,limits:{...LIMITS,nowMs},clock:()=>1000})
 const prepared=await resolverAt(BOOT).prepare({owner:roles.creator,stage:'inclusive-buy',intent:{side:'buy',creatorFeeBps:100,capBps:200,mint:roles.mint,selectedConfig:roles.config,amountIn:'1000200',minAmountOut:'1',maxInput:'1000200',maxPriceImpactBps:1000}})
 const stored=jsonbRoundTrip({review:prepared.review,configurationSha256:prepared.configurationSha256,settlementContext:prepared.settlementContext})
 assert.notEqual(JSON.stringify(stored.settlementContext),JSON.stringify(prepared.settlementContext),'jsonb reorders keys')
 // Before signing the hash must match exactly; it survives a restart.
 const verified=await resolverAt(RESTARTED).revalidate({owner:roles.creator,stage:'inclusive-buy',...stored})
 assert.equal(verified.messageSha256,prepared.messageSha256)
 const bought=await send(prepared.review.messageBase64);assert.equal(bought.error,null,JSON.stringify(bought))
 const reconcile=(nowMs,args={})=>resolverAt(nowMs).reconcile({...stored,...args,signedTransactionBase64:bought.wireBase64,signature:bought.signature})
 assert.equal((await reconcile(BOOT)).status,'finalized-success','read back from jsonb')
 const settled=await reconcile(RESTARTED);assert.equal(settled.status,'finalized-success','after a restart');assert.equal(settled.quote.grossCreatorFee,'10002')
 // A changed observed byte (an unvalidated mint tail) still compiles, but its policySha256 no longer matches the review.
 const changed=jsonbRoundTrip(stored.settlementContext)
 for(const o of changed.compilationInput.observations){const row=o.accounts.find(x=>x.address===roles.mint).account,bytes=Buffer.from(row.dataBase64,'base64');bytes[bytes.length-1]^=1;row.dataBase64=bytes.toString('base64')}
 assert.equal((await reconcile(RESTARTED,{settlementContext:changed})).status,'unresolved')
 // Rows stored under the old boot-time hash settle only when their context binds that hash and the same profile.
 const legacy=sha(JSON.stringify({config:bindings.config,profile:bindings.profile,dossierJson:bindings.dossierJson,limits:{...LIMITS,nowMs:BOOT}})),context={...stored.settlementContext,configurationSha256:legacy}
 assert.equal((await reconcile(RESTARTED,{configurationSha256:legacy,settlementContext:context})).status,'finalized-success','legacy row')
 await assert.rejects(reconcile(RESTARTED,{configurationSha256:legacy}),'context bound to another hash')
 const other=jsonbRoundTrip(context);other.compilationInput.profile.providers=[...other.compilationInput.profile.providers].reverse()
 await assert.rejects(reconcile(RESTARTED,{configurationSha256:legacy,settlementContext:other}),'another profile')
 await assert.rejects(resolverAt(RESTARTED).revalidate({owner:roles.creator,stage:'inclusive-buy',...stored,configurationSha256:legacy,settlementContext:context}),'revalidation stays strict')
})
