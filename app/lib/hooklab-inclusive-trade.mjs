import {publicNativeOperation} from './hooklab-native-operation-public.mjs'
import pg from 'pg'
import {z} from 'zod'
import {assertSameOrigin} from './auth.mjs'
import {walletIdentityConfiguration,walletIdentitySessionToken,walletIdentityQuota} from './hooklab-wallet-identity.mjs'
import {walletPrincipalStore} from '../../src/hooklab-wallet-principal.mjs'
import {readLimitedBody} from '../../src/token-image.mjs'
import {clientAddress} from '../../src/client-address.mjs'
import {inclusiveMaxWalletSwapRequestSchema} from '../../src/hooklab-inclusive-max-wallet-swap.mjs'
import {inclusiveTradeRuntime} from './hooklab-inclusive-trade-runtime.mjs'
const intent=inclusiveMaxWalletSwapRequestSchema.pick({mint:true,selectedConfig:true,capBps:true,creatorFeeBps:true,side:true,amountIn:true,minAmountOut:true,maxInput:true,maxPriceImpactBps:true}).strict()
const body=z.discriminatedUnion('action',[
 z.object({action:z.literal('quote'),signingId:z.uuid(),request:intent}).strict(),
 z.object({action:z.enum(['get','refresh-review','wallet-request','submit','reconcile']),signingId:z.uuid()}).strict(),
 z.object({action:z.literal('retain-wallet'),signingId:z.uuid(),signedTransactionBase64:z.string().max(1644)}).strict(),
])
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'}})
export function createInclusiveTradeHandler({env=process.env,configuration=walletIdentityConfiguration,runtime=inclusiveTradeRuntime,
 database=c=>new pg.Pool({connectionString:c.databaseUrl,max:2,connectionTimeoutMillis:5000,query_timeout:5000}),principalStore=walletPrincipalStore,quota=walletIdentityQuota}={}){
 return async request=>{
  if(env.HOOK_INCLUSIVE_TRADING_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')return reply({status:'blocked',blockers:[{code:'INCLUSIVE_TRADING_DISABLED',message:'Trading awaits explicit deployment and fee approval.'}]})
  let pool
  try{
   const config=configuration(env)
   if(request.method!=='POST')return reply({error:'Method unavailable.'},405)
   try{assertSameOrigin(request,config.origin);if(new URL(request.url).origin!==config.origin||request.headers.get('sec-fetch-site')==='cross-site')throw Error()}catch{return reply({error:'Open the configured trading origin.'},403)}
   if(new URL(request.url).search)return reply({error:'Query parameters unavailable.'},400)
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply({error:'JSON required.'},415)
   const token=walletIdentitySessionToken(request);if(!token)return reply({error:'Sign in with your wallet first.'},401)
   let input;try{input=body.parse(JSON.parse((await readLimitedBody(request,8192)).toString('utf8')))}catch{return reply({error:'Invalid trading request.'},400)}
   pool=database(config)
   if(!await quota(pool,[[`inclusive-trade:${clientAddress(request)??'unknown'}`,30]]))return reply({error:'Too many requests.'},429)
   const principal=principalStore(pool,config),owner=await principal.resolve(token),service=runtime()
   if(!service)return reply({status:'blocked',blockers:[{code:'INCLUSIVE_TRADE_RUNTIME_UNCONFIGURED',message:'Exact approved program pins and trading settings are not installed.'}]})
   if(service.origin!==config.origin)throw Error()
   const lifecycle=service.lifecycle
   let result
   if(input.action==='wallet-request')result=await lifecycle.walletRequest(token,input.signingId)
   else{
    let operation
    if(input.action==='quote')operation=await lifecycle.createReview(token,input.signingId,{custodyOperationId:input.signingId,stage:`inclusive-${input.request.side}`,intent:input.request})
    else if(input.action==='get')operation=await lifecycle.get(token,input.signingId)
    else if(input.action==='refresh-review')operation=await lifecycle.refreshReview(token,input.signingId)
    else if(input.action==='retain-wallet')operation=await lifecycle.retainWalletSignature(token,input.signingId,input.signedTransactionBase64)
    else if(input.action==='submit')operation=await lifecycle.submitOnce(token,input.signingId)
    else operation=await lifecycle.reconcile(token,input.signingId)
    if(operation.owner!==owner.wallet||!['inclusive-buy','inclusive-sell'].includes(operation.stage))throw Error()
    result={operation:publicNativeOperation(operation)}
   }
   if((await principal.resolve(token)).wallet!==owner.wallet)throw Error()
   return reply({status:'available',...result})
  }catch(error){return reply({error:error.status===401?'Wallet session expired. Sign in again.':'Trade unavailable or changed. Preserve the signing ID and reconcile the original transaction before starting another.'},error.status===401?401:409)}
  finally{await pool?.end().catch(()=>{})}
 }
}
