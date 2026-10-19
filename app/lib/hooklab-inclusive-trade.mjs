import {publicNativeOperation} from './hooklab-native-operation-public.mjs'
import {createHookLabDatabasePool} from '../../src/hooklab-database.mjs'
import {z} from 'zod'
import {assertSameOrigin} from './auth.mjs'
import {walletIdentityConfiguration,walletIdentitySessionToken,walletIdentityQuota} from './hooklab-wallet-identity.mjs'
import {walletPrincipalStore} from '../../src/hooklab-wallet-principal.mjs'
import {readLimitedBody} from '../../src/token-image.mjs'
import {clientAddress} from '../../src/client-address.mjs'
import {inclusiveMaxWalletSwapRequestSchema} from '../../src/hooklab-inclusive-max-wallet-swap.mjs'
import {inclusiveTradeRuntime} from './hooklab-inclusive-trade-runtime.mjs'
import { servedFromConfiguredOrigin } from './hooklab-origin.mjs'
import { ownerApprovalStore } from '../../src/hooklab-owner-approval.mjs'
import { openLaunchesEnabled } from '../../src/hooklab-open-creation.mjs'
import { DELISTED_BUY_REFUSAL } from '../../src/hooklab-coin-moderation.mjs'
const intent=inclusiveMaxWalletSwapRequestSchema.pick({mint:true,selectedConfig:true,capBps:true,creatorFeeBps:true,side:true,amountIn:true,minAmountOut:true,maxInput:true,maxPriceImpactBps:true}).strict()
const lamports=z.string().regex(/^[1-9]\d{0,19}$/),mintKey=z.string().max(44)
const body=z.discriminatedUnion('action',[
 z.object({action:z.literal('quote'),signingId:z.uuid(),request:intent}).strict(),
 // A native-SOL coin's trade (one approval, no Add SOL); graduate: this buy is the exact final fill and graduates the coin.
 z.object({action:z.literal('native-quote'),signingId:z.uuid(),request:intent.extend({graduate:z.boolean()}).strict()}).strict(),
 // Wallet funding: add SOL to Hook Lab (creating the needed holdings), or withdraw bridged SOL back to the wallet.
 z.object({action:z.literal('fund'),signingId:z.uuid(),request:z.object({mint:mintKey.nullable(),lamports:z.string().regex(/^(0|[1-9]\d{0,19})$/)}).strict()}).strict(),
 z.object({action:z.literal('withdraw'),signingId:z.uuid(),request:z.object({lamports}).strict()}).strict(),
 z.object({action:z.enum(['get','refresh-review','wallet-request','submit','reconcile']),signingId:z.uuid()}).strict(),
 z.object({action:z.literal('retain-wallet'),signingId:z.uuid(),signedTransactionBase64:z.string().max(1644)}).strict(),
])
// Until HOOK_TRADING_PUBLIC=true, only listed tester wallets may start trades or funding (existing operations stay recoverable).
export function tradingOpenFor(env,wallet){
 if(env.HOOK_TRADING_PUBLIC==='true')return true
 return (env.HOOK_TRADING_TESTER_WALLETS??'').split(',').map(x=>x.trim()).filter(Boolean).includes(wallet)
}
const STAGES=['inclusive-buy','inclusive-sell','wallet-fund','wallet-withdraw','native-buy','native-sell']
// Native-SOL trading needs its switch here and in the installed runtime (which then registers the native stages).
export const nativeTradingOn=(env,service)=>env.HOOK_NATIVE_TRADING_ENABLED==='true'&&service?.nativeTrading===true
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'}})
// moderation(pool, mint): the coin's delisting state. A delisted coin can still be sold (and its creator still claims);
// only a new BUY is refused.
const delistedState=(env)=>(pool,mint)=>openLaunchesEnabled(env)?ownerApprovalStore(pool,{adminAddress:env.HOOK_LAUNCH_ADMIN_ADDRESS,openLaunches:true}).moderationByMint(mint):{delisted:false}
export function createInclusiveTradeHandler({env=process.env,configuration=walletIdentityConfiguration,runtime=inclusiveTradeRuntime,
 database=createHookLabDatabasePool,principalStore=walletPrincipalStore,quota=walletIdentityQuota,moderation=delistedState(env)}={}){
 return async request=>{
  if(env.HOOK_INCLUSIVE_TRADING_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')return reply({status:'blocked',blockers:[{code:'INCLUSIVE_TRADING_DISABLED',message:'Trading awaits explicit deployment and fee approval.'}]})
  let pool
  try{
   const config=configuration(env)
   if(request.method!=='POST')return reply({error:'Method unavailable.'},405)
   try{assertSameOrigin(request,config.origin);if(!servedFromConfiguredOrigin(request,config.origin)||request.headers.get('sec-fetch-site')==='cross-site')throw Error()}catch{return reply({error:'Open the configured trading origin.'},403)}
   if(new URL(request.url).search)return reply({error:'Query parameters unavailable.'},400)
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply({error:'JSON required.'},415)
   const token=walletIdentitySessionToken(request);if(!token)return reply({error:'Sign in with your wallet first.'},401)
   let input;try{input=body.parse(JSON.parse((await readLimitedBody(request,8192)).toString('utf8')))}catch{return reply({error:'Invalid trading request.'},400)}
   pool=database(config)
   const observing=input.action==='get'||input.action==='reconcile'
   if(!await quota(pool,[[`inclusive-trade:${observing?'observe':'action'}:${clientAddress(request)??'unknown'}`,observing?120:30]]))return reply({error:'Too many requests.'},429)
   const principal=principalStore(pool,{enabled:true,origin:config.origin,audience:config.audience,genesisHash:config.genesisHash}),owner=await principal.resolve(token),service=runtime()
   if(!service)return reply({status:'blocked',blockers:[{code:'INCLUSIVE_TRADE_RUNTIME_UNCONFIGURED',message:'Exact approved program pins and trading settings are not installed.'}]})
   if(service.origin!==config.origin)throw Error()
   const lifecycle=service.lifecycle
   // Withdrawing is never gated: anyone with SOL in Hook Lab can always take it back out.
   if(['quote','native-quote','fund'].includes(input.action)&&!tradingOpenFor(env,owner.wallet))return reply({status:'blocked',blockers:[{code:'TRADING_NOT_OPEN',message:'Trading opens to everyone soon.'}]})
   if(input.action==='native-quote'&&!nativeTradingOn(env,service))return reply({status:'blocked',blockers:[{code:'NATIVE_TRADING_DISABLED',message:'Trading this coin on repo.ing opens soon.'}]})
   if(['quote','native-quote'].includes(input.action)&&input.request.side==='buy'&&(await moderation(pool,input.request.mint)).delisted)
    return reply({status:'blocked',blockers:[{code:'COIN_DELISTED',message:DELISTED_BUY_REFUSAL}]})
   if(input.action==='fund'&&!service.walletFunding)return reply({status:'blocked',blockers:[{code:'WALLET_FUNDING_DISABLED',message:'Adding SOL to Hook Lab is paused right now. Withdrawals still work.'}]})
   if(input.action==='withdraw'&&!service.walletWithdraw)return reply({status:'blocked',blockers:[{code:'WALLET_WITHDRAW_UNAVAILABLE',message:'Withdrawals are unavailable right now.'}]})
   let result
   if(input.action==='wallet-request')result=await lifecycle.walletRequest(token,input.signingId)
   else{
    let operation
    if(input.action==='quote')operation=await lifecycle.createReview(token,input.signingId,{custodyOperationId:input.signingId,stage:`inclusive-${input.request.side}`,intent:input.request})
    else if(input.action==='native-quote')operation=await lifecycle.createReview(token,input.signingId,{custodyOperationId:input.signingId,stage:`native-${input.request.side}`,intent:input.request})
    else if(input.action==='fund')operation=await lifecycle.createReview(token,input.signingId,{custodyOperationId:input.signingId,stage:'wallet-fund',intent:{action:'fund',...input.request}})
    else if(input.action==='withdraw')operation=await lifecycle.createReview(token,input.signingId,{custodyOperationId:input.signingId,stage:'wallet-withdraw',intent:{action:'withdraw',mint:null,...input.request}})
    else if(input.action==='get')operation=await lifecycle.get(token,input.signingId)
    else if(input.action==='refresh-review')operation=await lifecycle.refreshReview(token,input.signingId)
    else if(input.action==='retain-wallet')operation=await lifecycle.retainWalletSignature(token,input.signingId,input.signedTransactionBase64)
    else if(input.action==='submit')operation=await lifecycle.submitOnce(token,input.signingId)
    else operation=await lifecycle.reconcile(token,input.signingId)
    if(operation.owner!==owner.wallet||!STAGES.includes(operation.stage))throw Error()
    result={operation:publicNativeOperation(operation)}
   }
   if((await principal.resolve(token)).wallet!==owner.wallet)throw Error()
   return reply({status:'available',...result})
  }catch(error){
   if(error.status===401)return reply({error:'Wallet session expired. Sign in again.'},401)
   // Refusals written for customers (balance, rent, paused bridge...) are shown as they are; nothing else is.
   return reply({error:error?.code==='HOOKLAB_USER_REFUSAL'?error.message:'Trade unavailable or changed. Your transaction is saved; check its status before starting another.'},409)
  }
  finally{await pool?.end().catch(()=>{})}
 }
}
