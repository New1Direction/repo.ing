// Synthetic account bytes only, assembled with the pinned account codecs. No RPC.
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { selectedLaunchFixture } from './selected-hook-launch.mjs'
import { deriveOpenLaunchPostconditions } from '../../src/hooklab-max-wallet-launch-settlement.mjs'
import { compileNativeSwapReview, nativeSwapInventory, selectedNativeHookEvidence, RENT_SYSVAR } from '../../src/hooklab-native-swap.mjs'
import { hookCoinAddresses } from '../../src/hooklab-inclusive-max-wallet-swap.mjs'
import { pk, pda, key } from './selected-hook-preparation.mjs'
export function selectedNativeTradeFixture(side='buy') {
  const f=selectedLaunchFixture(),{input:launch,p,accounts}=f,T=p.programs.token
  const post=deriveOpenLaunchPostconditions({schema:'repoing/open-launch-settlement-context/1',compilationInput:launch},{slot:100,timestamp:1000})
  for(const a of post.accounts) accounts.set(a.address,{...a,lamports:'10000000000'})
  const r={schema:'repoing/native-swap-request/1',policyKind:'selected-hook',policyVersion:2,creatorFeeBps:100,feeModel:2,protocolShareBps:2500,capBps:0,
    side,trader:launch.request.creator,mint:launch.request.mint,selectedConfig:launch.request.selectedConfig,selectedHook:launch.request.selectedHook,
    amountIn:side==='buy'?'10':'10000',minAmountOut:side==='buy'?'1':'10',maxInput:side==='buy'?'10':'10000',maxPriceImpactBps:1000,graduate:false}
  const a={...hookCoinAddresses(p,r.mint),traderBase:pda(T,'holding',pk(r.mint).toBuffer(),pk(r.trader).toBuffer())}
  if(side==='sell'){
    const bytes=Buffer.from(accounts.get(a.pool).dataBase64,'base64'),pool=f.coders.swap.accounts.decode('Pool',bytes)
    pool.quote_reserve=new BN(1000);f.coders.swap.types.encode('Pool',pool).copy(bytes,8)
    accounts.set(a.pool,{...accounts.get(a.pool),dataBase64:bytes.toString('base64')})
  }
  const token=new BorshCoder(JSON.parse(readFileSync(new URL('../../vendor/hooklab-production-candidate/idl/bordrless_token.json',import.meta.url))))
  const holding=Buffer.from(accounts.get(a.baseVault).dataBase64,'base64'),h=token.accounts.decode('Holding',holding)
  h.owner=pk(r.trader);h.bump=PublicBump(T,'holding',pk(r.mint).toBuffer(),pk(r.trader).toBuffer());h.amount=new BN(side==='sell'?100000:0)
  const hb=Buffer.alloc(204);holding.copy(hb,0,0,8);token.types.encode('Holding',h).copy(hb,8)
  accounts.set(a.traderBase,{address:a.traderBase,owner:T,executable:false,lamports:'2310720',dataBase64:hb.toString('base64')})
  const taxOwner=key(95),taxHolding=pda(T,'holding',pk(r.mint).toBuffer(),pk(taxOwner).toBuffer())
  h.owner=pk(taxOwner);h.bump=PublicBump(T,'holding',pk(r.mint).toBuffer(),pk(taxOwner).toBuffer());h.amount=new BN(0)
  const tb=Buffer.from(hb);tb.fill(0,8);token.types.encode('Holding',h).copy(tb,8)
  accounts.set(taxHolding,{address:taxHolding,owner:T,executable:false,lamports:'2310720',dataBase64:tb.toString('base64')})
  const registry=pda(r.selectedHook.program,'bordrless-hook-accounts',pk(r.mint).toBuffer())
  accounts.set(registry,{...accounts.get(registry),dataBase64:Buffer.concat([Buffer.from('02daf6662c38c0cd01010000000100','hex'),pk(taxHolding).toBuffer()]).toString('base64')})
  const rent=Buffer.alloc(17);rent.writeBigUInt64LE(3480n);rent.writeDoubleLE(2,8);rent[16]=50
  accounts.set(RENT_SYSVAR,{address:RENT_SYSVAR,owner:'Sysvar1111111111111111111111111111111111111',executable:false,lamports:'1',dataBase64:rent.toString('base64')})
  const ev=selectedNativeHookEvidence(p,r,accounts,launch.hookPin),inventory=nativeSwapInventory(p,r,ev)
  return {accounts,p,a,taxHolding,coders:f.coders,request:r,input:{profile:launch.profile,selectedHookPin:launch.hookPin,request:r,provenance:'server-collected-finalized-state-not-execution-authorization',
    observations:launch.observations.map(o=>({...o,accounts:inventory.map(address=>({address,account:accounts.get(address)??null}))})),
    recentBlockhash:{...launch.recentBlockhash,networkFeeLamports:'5000'},lookupTable:null,
    limits:{nowMs:1000,maxAgeMs:5000,maxSlotLag:5,validUntilSlot:150,reviewExpiresAtMs:6000,maxNetworkFeeLamports:'10000',maxTotalDebitLamports:'10000000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}}}
}
import { PublicKey } from '@solana/web3.js'
const PublicBump=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(x=>typeof x==='string'?Buffer.from(x):x),pk(program))[1]

// RPC framing only: after bytes are explicit synthetic observations, not an SBF execution.
export function selectedNativeSimulationFixture(side='buy',mutate=()=>{}){
  const f=selectedNativeTradeFixture(side),initial=compileNativeSwapReview(f.input),gross=BigInt(initial.quote.delivered)
  const deltas=side==='buy'?{[f.a.baseVault]:String(-gross),[f.a.traderBase]:String(gross*97n/100n),[f.taxHolding]:String(gross-gross*97n/100n)}
    :{[f.a.baseVault]:'9000',[f.a.traderBase]:'-10000',[f.taxHolding]:'1000'}
  if(side==='buy')f.input.request.minAmountOut=String(BigInt(deltas[f.a.traderBase])*98n/100n)
  const plan=compileNativeSwapReview({...f.input,selectedTokenDeltas:deltas}),after=new Map([...f.accounts].map(([k,v])=>[k,structuredClone(v)]))
  for(const [address,delta]of Object.entries(deltas)){
    const a=after.get(address),b=Buffer.from(a.dataBase64,'base64');b.writeBigUInt64LE(b.readBigUInt64LE(74)+BigInt(delta),74);a.dataBase64=b.toString('base64')
  }
  for(const [address,delta]of Object.entries(plan.lamportDeltas))after.get(address).lamports=String(BigInt(after.get(address).lamports)+BigInt(delta))
  const connections=f.input.profile.providers.map((provider,index)=>({provider,connection:{
    getGenesisHash:async()=>f.p.genesisHash,
    getMultipleAccountsInfoAndContext:async keys=>({context:{slot:100},value:keys.map(k=>{const a=f.accounts.get(k.toBase58());return a?{owner:pk(a.owner),executable:a.executable,lamports:Number(a.lamports),data:Buffer.from(a.dataBase64,'base64')}:null})}),
    isBlockhashValid:async()=>({context:{slot:100},value:true}),getBlockHeight:async()=>100,getFeeForMessage:async()=>({context:{slot:100},value:5000}),
    simulateTransaction:async(tx,options)=>{
      if(Buffer.from(tx.message.serialize()).toString('base64')!==plan.review.messageBase64||options.replaceRecentBlockhash!==false)throw Error('Wrong message')
      const response={context:{slot:100},value:{err:null,unitsConsumed:50000,accounts:options.accounts.addresses.map(address=>{const a=after.get(address);return a?{owner:a.owner,executable:a.executable,lamports:Number(a.lamports),data:[a.dataBase64,'base64']}:null})}}
      mutate({response,addresses:options.accounts.addresses,index,f});return response
    },
  }}))
  return {...f,plan,connections,compilationInput:f.input,configurationSha256:'a'.repeat(64),clock:()=>1200}
}
