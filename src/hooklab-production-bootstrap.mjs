// Production start-up for owner-approved hooks, called once from instrumentation.js. It installs the
// launch and trade runtimes only when explicitly enabled and every pinned input verifies; otherwise
// it refuses and hooks stay visibly unavailable. The admin key is never here: launch admin
// signatures come from the owner's Mac through the remote admin signer.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Connection } from '@solana/web3.js'
import { programDataCachedConnection } from './hooklab-program-data-cache.mjs'
import { remoteAdminSigner } from './hooklab-owner-approval.mjs'
import { remoteLaunchLookupTable } from './hooklab-owner-launch-tables.mjs'
import { openLaunchRent, openLaunchesEnabled, siteLaunchesEnabled } from './hooklab-open-creation.mjs'
import { isStackProfile } from './hooklab-stack.mjs'
import { localAcceptanceNetwork } from './hooklab-local-acceptance.mjs'
import { selectedHookPinSchema } from './hooklab-max-wallet-launch.mjs'
import { validateSelectedHookReleaseBindings } from './hooklab-max-wallet-launch-collector.mjs'
import { validateLocalSelectedHookPolicy } from './hooklab-selected-hook-compatibility.mjs'
import { selectedTradeQuoteStore, readySelectedTradeQuoteStore } from './hooklab-selected-trade-quotes.mjs'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const refuse=message=>{throw Object.assign(Error(message),{code:'PRODUCTION_BOOTSTRAP_REFUSED'})}
const need=(ok,message)=>{if(!ok)refuse(message)}

// Two independent providers are never on exactly the same finalized slot. A read that names a
// minContextSlot the slower provider has not reached yet fails with RPC error -32016; wait for it to
// catch up (bounded) instead of refusing every launch and trade. Any other error, and every send,
// passes through untouched; non-function properties (rpcEndpoint) are unchanged.
const BEHIND=/Minimum context slot has not been reached|-32016/
// Snapshot-to-blockhash slack across two real providers (the second waits to catch up): ~6 s. The
// on-chain guards (deadline slot, minimum output, price impact) are unchanged.
const SLOT_LAG=16
// A review's slot lease. Mainnet slots run about 210 ms (2026-10-27) and finalized trails confirmed by about one slot,
// so 96 slots left about 20 s for the wallet, the server's co-signature and the send (each step re-reads the chain for
// about 7 s). 140 keeps the deadline within the 150-slot ceiling the lifetime check allows from the snapshot
// (src/hooklab-max-wallet-launch.mjs) with a 10-slot margin for finality lag; a larger lag refuses the review safely.
export const REVIEW_LEASE_SLOTS=140
// The most rent an owner-invited (legacy) launch may lock, as the program's debit guard counts it. An open launch's bound
// is exact instead: computed from the chain's rent when the launch is reserved (openLaunchRent).
const LEGACY_LAUNCH_MAX_RENT_LAMPORTS=45000000n
export function catchUpConnection(connection,{attempts=12,delayMs=500,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 return new Proxy(connection,{get(target,property,receiver){
  const value=Reflect.get(target,property,receiver)
  if(typeof value!=='function')return value
  return async(...args)=>{
   for(let attempt=1;;attempt++){
    try{return await value.apply(target,args)}
    catch(error){if(attempt>=attempts||!BEHIND.test(String(error?.message??'')+String(error?.code??'')))throw error;await sleep(delayMs)}
   }
  }
 }})
}

// live: the later of the two providers (never sign late). bothPast: the earlier finalized view
// (an attempt only expires once BOTH providers are past its limits).
export function chainObservers(connections){
 const read=commitment=>Promise.all(connections.map(async({connection})=>({slot:await connection.getSlot(commitment),blockHeight:await connection.getBlockHeight(commitment)})))
 return Object.freeze({
  async live(){const v=await read('confirmed');return {slot:Math.max(...v.map(x=>x.slot)),blockHeight:Math.max(...v.map(x=>x.blockHeight)),nowMs:Date.now()}},
  async bothPast(){const v=await read('finalized');return {slot:Math.min(...v.map(x=>x.slot)),blockHeight:Math.min(...v.map(x=>x.blockHeight))}},
 })
}

// What a launch may debit its creator: the creation fee and pool fee the bundle pins, the rent bound (for an open launch
// the exact guard bound from openLaunchRent), and the network fee.
export function launchDebitLimits({launchFeeLamports,poolCreationFeeLamports},networkFee,rentBound=LEGACY_LAUNCH_MAX_RENT_LAMPORTS){
 const maxRent=BigInt(rentBound),instruction=BigInt(launchFeeLamports)+BigInt(poolCreationFeeLamports)+maxRent
 return {maxLaunchFeeLamports:String(launchFeeLamports),maxPoolCreationFeeLamports:String(poolCreationFeeLamports),maxRentLamports:String(maxRent),
  maxInstructionDebitLamports:String(instruction),maxTotalDebitLamports:String(instruction+BigInt(networkFee))}
}

export function productionKeyRing(env){
 let ring
 try{ring=JSON.parse(env.HOOK_NATIVE_KEYRING_JSON??'')}catch{refuse('HOOK_NATIVE_KEYRING_JSON is missing or not JSON')}
 const entries=Object.entries(ring??{}).map(([id,value])=>[id,Buffer.from(String(value),'base64')])
 need(entries.length>0&&entries.every(([id,key])=>/^[a-z0-9-]{1,32}$/.test(id)&&key.length===32),'key ring needs 32-byte keys with short ids')
 need(entries.some(([id])=>id===env.HOOK_NATIVE_ACTIVE_KEY_ID),'HOOK_NATIVE_ACTIVE_KEY_ID is not in the key ring')
 return {keyRing:Object.fromEntries(entries),activeKeyId:env.HOOK_NATIVE_ACTIVE_KEY_ID}
}

// Our own stack's bundle (HOOKLAB_STACK_BUNDLE_FILE, approved by HOOKLAB_STACK_BUNDLE_SHA256): new coins' open launches,
// native trades and creator claims. Its admin is HOOK_STACK_ADMIN_ADDRESS; it reads through the same two providers as
// bundle 2 and shares no program with the legacy stack. null when neither variable is set.
async function stackBundleFrom({env,readBundle,legacy}){
 const file=env.HOOKLAB_STACK_BUNDLE_FILE,digest=env.HOOKLAB_STACK_BUNDLE_SHA256
 if(file===undefined&&digest===undefined)return null
 need(typeof file==='string'&&file.length>0&&/^[a-f0-9]{64}$/.test(digest??''),'set both HOOKLAB_STACK_BUNDLE_FILE and HOOKLAB_STACK_BUNDLE_SHA256')
 const bytes=await readBundle(file)
 need(sha(bytes)===digest,'our stack\'s bundle differs from its approved hash')
 const bundle=JSON.parse(bytes),profile=JSON.parse(bundle.profile.json),legacyProfile=JSON.parse(legacy.profile.json)
 need(bundle.schema==='repoing/production-operator-bundle/1'&&bundle.genesisHash===legacy.genesisHash&&isStackProfile(profile),'the stack bundle is not a production bundle of our own stack')
 need(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env.HOOK_STACK_ADMIN_ADDRESS??'')&&bundle.config.reviewer===env.HOOK_STACK_ADMIN_ADDRESS,'stack bundle reviewer is not the configured stack admin (HOOK_STACK_ADMIN_ADDRESS)')
 need(bundle.profile.providers.length===2&&bundle.profile.providers.every((p,i)=>p===legacy.profile.providers[i]),'the stack bundle must read through the same two providers as bundle 2')
 need(!['launch','swap','gate','token'].some(role=>Object.values(legacyProfile.programs).includes(profile.programs[role])),'our stack shares a program with the legacy stack')
 return bundle
}

// Everything the runtimes need, verified. Separate from installation so it can be tested.
export async function productionSettings({env=process.env,readBundle=path=>readFile(path),connectionFor=url=>catchUpConnection(programDataCachedConnection(new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true})))}={}){
 need(siteLaunchesEnabled(env),'site launches are not enabled (neither HOOK_OWNER_APPROVED_LAUNCHES nor HOOK_OPEN_LAUNCHES is true)')
 need(!openLaunchesEnabled(env)||env.HOOK_NATIVE_LAUNCHES_ENABLED==='true','open launches need HOOK_NATIVE_LAUNCHES_ENABLED=true (they are native SOL only)')
 need(env.HOOK_NATIVE_LAUNCH_ENABLED==='true'&&env.HOOK_WALLET_IDENTITY_ENABLED==='true','native launch and wallet identity switches must both be on')
 const bytes=await readBundle(env.HOOKLAB_PRODUCTION_BUNDLE_FILE??refuse('HOOKLAB_PRODUCTION_BUNDLE_FILE is not set'))
 need(/^[a-f0-9]{64}$/.test(env.HOOKLAB_PRODUCTION_BUNDLE_SHA256??'')&&sha(bytes)===env.HOOKLAB_PRODUCTION_BUNDLE_SHA256,'production bundle differs from its approved hash')
 const bundle=JSON.parse(bytes)
 need(bundle.schema==='repoing/production-operator-bundle/1'&&bundle.config.reviewer===env.HOOK_LAUNCH_ADMIN_ADDRESS,'bundle reviewer is not the configured launch admin')
 const stack=await stackBundleFrom({env,readBundle,legacy:bundle})
 need(!openLaunchesEnabled(env)||stack,'open launches launch on our own stack: set HOOKLAB_STACK_BUNDLE_FILE and HOOKLAB_STACK_BUNDLE_SHA256')
 const urls=[env.HOOKLAB_PRODUCTION_RPC_PRIMARY_URL,env.HOOKLAB_PRODUCTION_RPC_SECONDARY_URL]
 need(urls.every(u=>typeof u==='string'&&u.startsWith('https://')),'two HTTPS production RPC URLs are required')
 const connections=bundle.profile.providers.map((provider,i)=>({provider,connection:connectionFor(urls[i])}))
 const observers=chainObservers(connections)
 async function reviewTiming(){
  const slot=await connections[0].connection.getSlot('confirmed'),now=Date.now()
  return {nowMs:now,validUntilSlot:slot+REVIEW_LEASE_SLOTS,reviewExpiresAtMs:now+60000}
 }
 const priority=env.HOOKLAB_PRIORITY_MICROLAMPORTS??'0'
 need(/^(0|[1-9][0-9]{0,6})$/.test(priority),'HOOKLAB_PRIORITY_MICROLAMPORTS must be a small integer')
 const networkFee=String(3*5000+Math.ceil(1400000*Number(priority)/1e6))
 const common=async()=>({...await reviewTiming(),maxAgeMs:60000,maxSlotLag:SLOT_LAG,maxNetworkFeeLamports:networkFee,computeUnitLimit:1400000,computeUnitPriceMicroLamports:priority})
 // Launches use the bundle of the stack they launch on (our own stack for open launches).
 const launchBundle=openLaunchesEnabled(env)?stack:bundle
 return {bundle,stack,launchBundle,connections,observers,reviewTiming,
  async launchLimits(){const c=await common();return {preparationLimits:{...c,maxRentLamports:'20000000',maxTotalDebitLamports:String(20000000+Number(networkFee))},
   setupLimits:{...c,maxRentLamports:'20000000',maxTotalDebitLamports:String(20000000+Number(networkFee))},
   launchLimits:{...c,...launchDebitLimits(launchBundle.config.economics,networkFee,
    openLaunchesEnabled(env)?(await openLaunchRent(size=>connections[0].connection.getMinimumBalanceForRentExemption(size,'finalized'))).guard:undefined)}}},
  tradeLimits:{nowMs:Date.now(),maxAgeMs:60000,maxSlotLag:SLOT_LAG,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:networkFee,maxTotalDebitLamports:networkFee,
   computeUnitLimit:1400000,computeUnitPriceMicroLamports:priority},
  ...productionKeyRing(env)}
}

export function selectedHookSettings({env=process.env,stack,open,connections=stack?.connections,tradeQuoteStore}){
 const local=env.HOOK_LOCAL_SELECTED_HOOKS_ENABLED==='true',production=env.HOOK_SELECTED_HOOKS_ENABLED==='true'
 if(!local&&!production)return {selectedHooksEnabled:false,selectedHookPin:null}
 need(!(local&&production),'local and production selected-hook switches cannot be combined')
 need(stack&&open,'selected hooks require our open-launch stack')
 if(local){
  need(localAcceptanceNetwork(env),'local selected hooks require local acceptance')
  if(stack.config.selectedHookRelease?.schema==='repoing/selected-hook-release/2'){
   need(env.HOOK_LOCAL_SELECTED_HOOK_PIN_JSON===undefined,'local policy cannot be combined with a singleton pin')
   return {selectedHooksEnabled:true,selectedHookPin:null,selectedHookRelease:validateLocalSelectedHookPolicy({...stack,connections,env})}
  }
  return {selectedHooksEnabled:true,selectedHookPin:selectedHookPinSchema.parse(JSON.parse(env.HOOK_LOCAL_SELECTED_HOOK_PIN_JSON??'null'))}
 }
 need(!localAcceptanceNetwork(env),'production selected hooks cannot use local acceptance')
 const bound=validateSelectedHookReleaseBindings({...stack,connections})
 // Policy releases require the durable estimate adapter and its verified database
 // migration, in addition to per-operation custody/compiler/recovery authority checks.
 const policy=bound.config.selectedHookRelease.schema==='repoing/selected-hook-release/2'
 need(!policy||readySelectedTradeQuoteStore(tradeQuoteStore),'selected-hook policy requires durable authority-evidence integration before runtime enablement')
 return {selectedHooksEnabled:true,selectedHookPin:policy?null:bound.config.selectedHookPin}
}

export async function bootstrapProductionHooks({env=process.env}={}){
 if(env.HOOK_PRODUCTION_BOOTSTRAP!=='true')return {installed:false}
 const [{createHookLabDatabasePool},{walletIdentityConfiguration},{createNativeLaunchRuntime},{installNativeLaunchRuntime,nativeLaunchRuntime},{createInclusiveTradeRuntime,installInclusiveTradeRuntime}]=await Promise.all([
  import('./hooklab-database.mjs'),import('../app/lib/hooklab-wallet-identity.mjs'),import('./hooklab-native-launch-runtime.mjs'),
  import('../app/lib/hooklab-native-launch-runtime.mjs'),import('../app/lib/hooklab-inclusive-trade-runtime.mjs')])
 if(nativeLaunchRuntime())return {installed:true}
 const s=await productionSettings({env}),identity=walletIdentityConfiguration(env)
 const pool=createHookLabDatabasePool(identity,10,'runtime')
 try{
 // Two bundles: bundle 2 (legacy) for the canary and the bridged flows, our own stack's for new coins.
 const bound=b=>b&&{config:b.config,profile:b.profile,dossierJson:b.dossierJson}
 const legacy=bound(s.bundle),own=bound(s.stack)
 const base={enabled:true,origin:identity.origin,ownerCustodyApproved:true,operatorDeploymentApproved:true,economicsApproved:true,
  ...legacy,connections:s.connections,keyRing:s.keyRing,activeKeyId:s.activeKeyId,
  adminSigner:remoteAdminSigner(pool,{address:s.bundle.config.reviewer,observe:s.observers.live}),expiryObserver:s.observers.bothPast}
 // Each launch gets its own lookup table, created by the owner's Mac agent; trades use the bundle's shared table.
 const launchLookupTable=remoteLaunchLookupTable(pool,{envelope:s.bundle.profile,connections:s.connections,adminAddress:s.bundle.config.reviewer})
 // Open launches use the bundle's one shared launch table and need no admin co-signature; the owner's Mac is not involved.
 const open=openLaunchesEnabled(env)
 const tradeQuoteStore=selectedTradeQuoteStore(pool)
 if(env.HOOK_SELECTED_HOOKS_ENABLED==='true'&&own?.config.selectedHookRelease?.schema==='repoing/selected-hook-release/2')await tradeQuoteStore.verifySchema()
 const {selectedHooksEnabled,selectedHookPin}=selectedHookSettings({env,stack:own,open,connections:s.connections,tradeQuoteStore})
 if(selectedHooksEnabled){need(own&&open,'selected hooks require our open-launch stack');if(selectedHookPin)own.config={...own.config,selectedHookPin}}
 const launchRuntime=async()=>createNativeLaunchRuntime(pool,{...base,...(open?{...own,openLaunches:true}:{launchLookupTable}),selectedHooksEnabled,reviewTiming:s.reviewTiming,nativeLaunches:env.HOOK_NATIVE_LAUNCHES_ENABLED==='true',...await s.launchLimits()})
 const native=await launchRuntime()
 installNativeLaunchRuntime({...native,async reserve(input){return (await launchRuntime()).reserve(input)}})
 // Trading installs only behind its own switch, the same rule as initializeInclusiveTradeRuntime.
 // Native-SOL trading rides on the trade runtime behind its own switch (off by default), and only with a bundle that
 // pins the upgraded programs.
 let nativeTrading=false
 if(env.HOOK_INCLUSIVE_TRADING_ENABLED==='true'){
  const trade=createInclusiveTradeRuntime(pool,{...base,stack:own,ownerTradingApproved:true,limits:s.tradeLimits,openLaunches:openLaunchesEnabled(env),selectedHookPin,selectedNativeTradingEnabled:selectedHooksEnabled,
   walletFundingEnabled:env.HOOK_WALLET_FUNDING_ENABLED==='true',nativeTradingEnabled:env.HOOK_NATIVE_TRADING_ENABLED==='true'})
  installInclusiveTradeRuntime(trade);nativeTrading=trade.nativeTrading
  if(env.HOOK_NATIVE_TRADING_ENABLED==='true'&&!nativeTrading)console.error('Hook Lab native trading stays off: the production bundle does not pin the reviewed native-SOL programs')
 }
 // Native-SOL launches: their creators claim fees in SOL (stage native-claim). Off unless HOOK_NATIVE_LAUNCHES_ENABLED=true.
 if(env.HOOK_NATIVE_LAUNCHES_ENABLED==='true'){
  const {createNativeClaimRuntime,installNativeClaimRuntime}=await import('../app/lib/hooklab-native-claim-runtime.mjs')
  installNativeClaimRuntime(createNativeClaimRuntime(pool,{...base,...(own??{}),nativeLaunchesApproved:true,limits:s.tradeLimits}))
 }
 return {installed:true,trading:env.HOOK_INCLUSIVE_TRADING_ENABLED==='true',nativeTrading}
 }catch(error){if(!nativeLaunchRuntime())await pool.end().catch(()=>{});throw error}
}
