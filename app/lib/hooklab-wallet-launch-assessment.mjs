import pg from 'pg'
import { z } from 'zod'
import { assertSameOrigin } from './auth.mjs'
import { walletIdentityConfiguration,walletIdentitySessionToken,walletIdentityQuota } from './hooklab-wallet-identity.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { coLocatedWalletPreparationJournal } from '../../src/hooklab-wallet-preparation.mjs'
import { preparationReadConnections } from '../../src/hooklab-preparation-read-transport.mjs'
import { assessWalletLaunchPreparation,walletLaunchAssessmentRequestSchema } from '../../src/hooklab-wallet-launch-assessment.mjs'
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'}
const reply=(body,status=200)=>Response.json({...body,executionAuthorized:false,canSign:false,canSubmit:false,canLaunch:false},{status,headers})
export function walletLaunchAssessmentConfiguration(env=process.env){
 const identity=walletIdentityConfiguration(env)
 const settings=z.array(z.object({provider:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),url:z.string()}).strict()).length(2).parse(JSON.parse(env.HOOK_WALLET_PREPARATION_READERS))
 const expectedProfileSha256=z.literal('f366d222e7257e86ac23d8350741b3c20c08ea084a4445c7b0d2d913593b5ea0').parse(env.HOOK_WALLET_PREPARATION_PROFILE_SHA256)
 return {...identity,providers:preparationReadConnections(settings),expectedProfileSha256}
}
export function createWalletLaunchAssessmentHandler({env=process.env,configuration=walletLaunchAssessmentConfiguration,
 database=config=>new pg.Pool({connectionString:config.databaseUrl,max:2,connectionTimeoutMillis:5000,query_timeout:5000}),
 journal=(pool,config)=>coLocatedWalletPreparationJournal(pool,{enabled:true,origin:config.origin,providers:config.providers,expectedProfileSha256:config.expectedProfileSha256}),
 quota=walletIdentityQuota}={}){
 return async request=>{
  if(env.HOOK_WALLET_LAUNCH_ASSESSMENT_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')return reply({status:'disabled'},404)
  let pool
  try{
   const config=configuration(env)
   if(new URL(request.url).origin!==config.origin||request.headers.get('sec-fetch-site')==='cross-site')return reply({error:'Open the configured launcher origin.'},403)
   if(!['GET','POST'].includes(request.method))return reply({error:'Method unavailable.'},405)
   if(request.method==='POST'){try{assertSameOrigin(request,config.origin)}catch{return reply({error:'Open the configured launcher origin.'},403)}}
   const token=walletIdentitySessionToken(request);if(!token)return reply({error:'Sign in with your wallet first.'},401)
   let input,id
   if(request.method==='GET'){
    const query=new URL(request.url).searchParams
    if([...query.keys()].some(k=>k!=='id')||query.getAll('id').length!==1)return reply({error:'Invalid preparation ID.'},400)
    id=z.uuid().parse(query.get('id'))
   }else{
    if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply({error:'JSON required.'},415)
    try{input=walletLaunchAssessmentRequestSchema.parse(JSON.parse((await readLimitedBody(request,4096)).toString('utf8')))}catch{return reply({error:'Invalid review request.'},400)}
   }
   pool=database(config)
   if(!await quota(pool,[[`wallet-assessment:${clientAddress(request)??'unknown'}`,20]]))return reply({error:'Too many reviews. Try again later.'},429)
   const records=journal(pool,config)
   if(request.method==='GET')return reply({status:'retained-candidate',preparation:await records.get(token,id),unsignedLaunchMessage:null})
   return reply(await assessWalletLaunchPreparation({journal:records,sessionToken:token,input}))
  }catch(error){return reply({error:error.status===401?'Wallet session expired. Sign in again.':'Preparation assessment unavailable or changed. Preserve the original mint and signature.',unsignedLaunchMessage:null},error.status===401?401:409)}
  finally{if(pool)await pool.end().catch(()=>{})}
 }
}
