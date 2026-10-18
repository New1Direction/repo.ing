// Production start-up for owner-approved hooks, called once from instrumentation.js. It installs the
// launch and trade runtimes only when explicitly enabled and every pinned input verifies; otherwise
// it refuses and hooks stay visibly unavailable. The admin key is never here: launch admin
// signatures come from the owner's Mac through the remote admin signer.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Connection } from '@solana/web3.js'
import { remoteAdminSigner } from './hooklab-owner-approval.mjs'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const refuse=message=>{throw Object.assign(Error(message),{code:'PRODUCTION_BOOTSTRAP_REFUSED'})}
const need=(ok,message)=>{if(!ok)refuse(message)}

// live: the later of the two providers (never sign late). bothPast: the earlier finalized view
// (an attempt only expires once BOTH providers are past its limits).
export function chainObservers(connections){
 const read=commitment=>Promise.all(connections.map(async({connection})=>({slot:await connection.getSlot(commitment),blockHeight:await connection.getBlockHeight(commitment)})))
 return Object.freeze({
  async live(){const v=await read('confirmed');return {slot:Math.max(...v.map(x=>x.slot)),blockHeight:Math.max(...v.map(x=>x.blockHeight)),nowMs:Date.now()}},
  async bothPast(){const v=await read('finalized');return {slot:Math.min(...v.map(x=>x.slot)),blockHeight:Math.min(...v.map(x=>x.blockHeight))}},
 })
}

export function productionKeyRing(env){
 let ring
 try{ring=JSON.parse(env.HOOK_NATIVE_KEYRING_JSON??'')}catch{refuse('HOOK_NATIVE_KEYRING_JSON is missing or not JSON')}
 const entries=Object.entries(ring??{}).map(([id,value])=>[id,Buffer.from(String(value),'base64')])
 need(entries.length>0&&entries.every(([id,key])=>/^[a-z0-9-]{1,32}$/.test(id)&&key.length===32),'key ring needs 32-byte keys with short ids')
 need(entries.some(([id])=>id===env.HOOK_NATIVE_ACTIVE_KEY_ID),'HOOK_NATIVE_ACTIVE_KEY_ID is not in the key ring')
 return {keyRing:Object.fromEntries(entries),activeKeyId:env.HOOK_NATIVE_ACTIVE_KEY_ID}
}

// Everything the runtimes need, verified. Separate from installation so it can be tested.
export async function productionSettings({env=process.env,readBundle=path=>readFile(path),connectionFor=url=>new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true})}={}){
 need(env.HOOK_OWNER_APPROVED_LAUNCHES==='true','owner-approved launches are not enabled')
 const bytes=await readBundle(env.HOOKLAB_PRODUCTION_BUNDLE_FILE??refuse('HOOKLAB_PRODUCTION_BUNDLE_FILE is not set'))
 need(/^[a-f0-9]{64}$/.test(env.HOOKLAB_PRODUCTION_BUNDLE_SHA256??'')&&sha(bytes)===env.HOOKLAB_PRODUCTION_BUNDLE_SHA256,'production bundle differs from its approved hash')
 const bundle=JSON.parse(bytes)
 need(bundle.schema==='repoing/production-operator-bundle/1'&&bundle.config.reviewer===env.HOOK_LAUNCH_ADMIN_ADDRESS,'bundle reviewer is not the configured launch admin')
 const urls=[env.HOOKLAB_PRODUCTION_RPC_PRIMARY_URL,env.HOOKLAB_PRODUCTION_RPC_SECONDARY_URL]
 need(urls.every(u=>typeof u==='string'&&u.startsWith('https://')),'two HTTPS production RPC URLs are required')
 const connections=bundle.profile.providers.map((provider,i)=>({provider,connection:connectionFor(urls[i])}))
 const observers=chainObservers(connections)
 async function reviewTiming(){
  const slot=await connections[0].connection.getSlot('confirmed'),now=Date.now()
  return {nowMs:now,validUntilSlot:slot+96,reviewExpiresAtMs:now+60000}
 }
 const priority=env.HOOKLAB_PRIORITY_MICROLAMPORTS??'0'
 need(/^(0|[1-9][0-9]{0,6})$/.test(priority),'HOOKLAB_PRIORITY_MICROLAMPORTS must be a small integer')
 const networkFee=String(3*5000+Math.ceil(1400000*Number(priority)/1e6))
 const common=async()=>({...await reviewTiming(),maxAgeMs:60000,maxSlotLag:5,maxNetworkFeeLamports:networkFee,computeUnitLimit:1400000,computeUnitPriceMicroLamports:priority})
 return {bundle,connections,observers,reviewTiming,
  async launchLimits(){const c=await common();return {preparationLimits:{...c,maxRentLamports:'20000000',maxTotalDebitLamports:String(20000000+Number(networkFee))},
   launchLimits:{...c,maxLaunchFeeLamports:bundle.config.economics.launchFeeLamports,maxPoolCreationFeeLamports:bundle.config.economics.poolCreationFeeLamports,
    maxRentLamports:'100000000',maxInstructionDebitLamports:'100000000',maxTotalDebitLamports:String(100000000+Number(networkFee))}}},
  tradeLimits:{nowMs:Date.now(),maxAgeMs:60000,maxSlotLag:5,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:networkFee,maxTotalDebitLamports:networkFee,
   computeUnitLimit:1400000,computeUnitPriceMicroLamports:priority},
  ...productionKeyRing(env)}
}

export async function bootstrapProductionHooks({env=process.env}={}){
 if(env.HOOK_PRODUCTION_BOOTSTRAP!=='true')return {installed:false}
 const [{createHookLabDatabasePool},{walletIdentityConfiguration},{createNativeLaunchRuntime},{installNativeLaunchRuntime,nativeLaunchRuntime},{createInclusiveTradeRuntime,installInclusiveTradeRuntime}]=await Promise.all([
  import('./hooklab-database.mjs'),import('../app/lib/hooklab-wallet-identity.mjs'),import('./hooklab-native-launch-runtime.mjs'),
  import('../app/lib/hooklab-native-launch-runtime.mjs'),import('../app/lib/hooklab-inclusive-trade-runtime.mjs')])
 if(nativeLaunchRuntime())return {installed:true}
 const s=await productionSettings({env}),identity=walletIdentityConfiguration(env)
 const pool=createHookLabDatabasePool(identity,10,'runtime')
 const base={enabled:true,origin:identity.origin,ownerCustodyApproved:true,operatorDeploymentApproved:true,economicsApproved:true,
  config:s.bundle.config,profile:s.bundle.profile,dossierJson:s.bundle.dossierJson,connections:s.connections,keyRing:s.keyRing,activeKeyId:s.activeKeyId,
  adminSigner:remoteAdminSigner(pool,{address:s.bundle.config.reviewer,observe:s.observers.live}),expiryObserver:s.observers.bothPast}
 const launchRuntime=async()=>createNativeLaunchRuntime(pool,{...base,reviewTiming:s.reviewTiming,...await s.launchLimits()})
 const native=await launchRuntime()
 installNativeLaunchRuntime({...native,async reserve(input){return (await launchRuntime()).reserve(input)}})
 installInclusiveTradeRuntime(createInclusiveTradeRuntime(pool,{...base,ownerTradingApproved:true,limits:s.tradeLimits}))
 return {installed:true}
}
