// Public metadata and image for owner-approved coins, at the uri each launch request fixes
// (src/hooklab-coin-profile.mjs coinMetadataUri). Read-only; shown only while the coin can
// still launch or has launched.
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { ownerApprovalStore } from '../../src/hooklab-owner-approval.mjs'
import { coinMetadataJson } from '../../src/hooklab-coin-profile.mjs'
import { imageWidthParam,tokenImageResponse } from '../../src/token-image.mjs'
import { walletIdentityConfiguration } from './hooklab-wallet-identity.mjs'
import { createRateLimiter } from './csp-report.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { openLaunchesEnabled, siteLaunchesEnabled } from '../../src/hooklab-open-creation.mjs'

const notFound=()=>Response.json({error:'Coin not found.'},{status:404,headers:{'Cache-Control':'public, max-age=60','X-Content-Type-Options':'nosniff'}})
const enabled=env=>siteLaunchesEnabled(env)&&env.HOOK_WALLET_IDENTITY_ENABLED==='true'

// Each read opens the Hook Lab database, which also holds custody and signing, so reads are throttled per instance.
const defaultLimiter=createRateLimiter({limit:240,globalLimit:3000,windowMs:60_000})
// kind: 'metadata' | 'image'
export function createCoinPublicHandler({env=process.env,configuration=walletIdentityConfiguration,database=createHookLabDatabasePool,store=ownerApprovalStore,allowed=defaultLimiter}={}){
 return async(request,{id,kind})=>{
  if(!enabled(env))return notFound()
  if(!allowed(clientAddress(request)??'unknown'))return Response.json({error:'Too many requests. Try again shortly.'},{status:429,headers:{'Retry-After':'60'}})
  const width=kind==='image'?imageWidthParam(new URL(request.url).searchParams.get('w')):null
  if(width===undefined)return Response.json({error:'Unsupported image width.'},{status:400})
  let pool
  try{
   const config=configuration(env);pool=database(config)
   const coin=await store(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS,openLaunches:openLaunchesEnabled(env)}).coinFor(id)
   if(!coin)return notFound()
   // A launched coin's image never changes; before that a decline must stop it being served, so caches expire quickly.
   if(kind==='image'){
    const response=await tokenImageResponse(coin.image,width)
    if(coin.request.status!=='launched')response.headers.set('Cache-Control','public, max-age=300')
    return response
   }
   return Response.json(coinMetadataJson({origin:config.origin,request:coin.request,profile:coin.profile}),
    {headers:{'Cache-Control':'public, max-age=300','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'}})
  }catch{return Response.json({error:'Coin details are unavailable right now.'},{status:503,headers:{'Cache-Control':'no-store'}})}
  finally{await pool?.end().catch(()=>{})}
 }
}
