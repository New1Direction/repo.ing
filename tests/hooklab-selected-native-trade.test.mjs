import test from 'node:test'
import assert from 'node:assert/strict'
import { compileNativeSwapReview,selectedNativeHookPinSchema,nativeSwapRequestSchema } from '../src/hooklab-native-swap.mjs'
import { selectedNativeTradeFixture,selectedNativeSimulationFixture } from './fixtures/selected-native-trade.mjs'
import { collectSelectedNativeTradeReview,nativeTradeResolver } from '../src/hooklab-native-trade-resolver.mjs'
import { finalFillLamports } from '../src/hooklab-graduation.mjs'
import { compileNativeClaimReview,nativeClaimInventory } from '../src/hooklab-native-claim.mjs'
import { pk,pda } from './fixtures/selected-hook-preparation.mjs'
import BN from 'bn.js'

test('selected native buy measures net tokens, keeps independent identity and exact onchain minimum',()=>{
  const f=selectedNativeTradeFixture(),initial=compileNativeSwapReview(f.input),gross=BigInt(initial.quote.delivered),net=gross*97n/100n
  f.input.request.minAmountOut=String(net*98n/100n)
  const preview=compileNativeSwapReview(f.input)
  const plan=compileNativeSwapReview({...f.input,selectedTokenDeltas:{[f.a.baseVault]:String(-gross),[f.a.traderBase]:String(net)}})
  assert.equal(plan.review.operation,'native-selected-hook-buy');assert.equal(plan.quote.capRaw,'0')
  assert.equal(plan.quote.delivered,String(net));assert.equal(plan.review.messageSha256,preview.review.messageSha256)
  assert.ok(!plan.instructions.some(ix=>ix.program===f.p.programs.gate))
  assert.equal(plan.onchainExactInputAndMinimumOutput,true)
  assert.throws(()=>compileNativeSwapReview({...f.input,selectedTokenDeltas:{[f.a.baseVault]:String(-gross-1n),[f.a.traderBase]:String(net)}}),/vault debit/)
  assert.throws(()=>compileNativeSwapReview({...f.input,selectedTokenDeltas:{[f.a.baseVault]:String(-gross),[f.a.traderBase]:'0'}}),/minimum net/)
})

test('selected native sale prices actual vault credit, not nominal input or symmetric hook fees',()=>{
  const f=selectedNativeTradeFixture('sell')
  const initial=compileNativeSwapReview(f.input)
  const deltas={[f.a.traderBase]:'-10000',[f.a.baseVault]:'9000'}
  const measured=compileNativeSwapReview({...f.input,selectedTokenDeltas:deltas})
  f.input.request.minAmountOut=measured.quote.delivered
  const plan=compileNativeSwapReview({...f.input,selectedTokenDeltas:deltas})
  assert.ok(BigInt(plan.quote.delivered)<BigInt(initial.quote.delivered))
  assert.equal(plan.quote.after.traderBase,'90000')
  assert.throws(()=>compileNativeSwapReview({...f.input,selectedTokenDeltas:{...deltas,[f.a.traderBase]:'-10001'}}),/max debit/)
  assert.throws(()=>compileNativeSwapReview({...f.input,selectedTokenDeltas:{...deltas,[f.a.baseVault]:'10001'}}),/input credit/)
})

test('selected native pin and request remain strict; invalid hook program/account bytes fail closed',()=>{
  const f=selectedNativeTradeFixture()
  assert.throws(()=>selectedNativeHookPinSchema.parse({...f.input.selectedHookPin,approved:true}))
  assert.throws(()=>nativeSwapRequestSchema.parse({...f.request,capBps:200}))
  assert.throws(()=>compileNativeSwapReview({...f.input,selectedHookPin:{...f.input.selectedHookPin,elfSha256:'0'.repeat(64)}}),/ELF/)
  const corrupt=structuredClone(f.input)
  for(const o of corrupt.observations)o.accounts.find(x=>x.address===f.request.selectedHook.program).account.owner=f.p.programs.token
  assert.throws(()=>compileNativeSwapReview(corrupt),/ProgramData linkage/)
})

test('server collector compiles the exact simulated selected message and revalidates asymmetric buy/sell deltas',async()=>{
  for(const side of ['buy','sell']){
    const f=selectedNativeSimulationFixture(side),result=await collectSelectedNativeTradeReview(f)
    assert.equal(result.plan.quote.delivered,f.plan.quote.delivered)
    assert.equal(result.selectedSimulation.tokenDeltas[f.taxHolding],side==='buy'?String(BigInt(compileNativeSwapReview(f.input).quote.delivered)-BigInt(result.plan.quote.delivered)):'1000')
    const again=await collectSelectedNativeTradeReview({...f,compilationInput:JSON.parse(JSON.stringify(result.compilationInput)),expectedReview:result.plan.review,expectedSimulation:result.selectedSimulation})
    assert.deepEqual(again.plan.quote,result.plan.quote);assert.equal(result.canSign,false)
    await assert.rejects(collectSelectedNativeTradeReview({...f,configurationSha256:'b'.repeat(64),expectedSimulation:result.selectedSimulation}))
    await assert.rejects(collectSelectedNativeTradeReview({...f,expectedReview:{...result.plan.review,messageSha256:'b'.repeat(64)}}))
  }
})

test('selected collector refuses excess debit, insufficient net output, invalid holding bytes and provider changes',async()=>{
  for(const change of ['debit','minimum','owner','provider','registry']){
    const f=selectedNativeSimulationFixture(change==='debit'?'sell':'buy',({response,addresses,index,f})=>{
      const address=change==='registry'?f.request.selectedHook.program:f.a.traderBase,a=response.value.accounts[addresses.indexOf(address)]
      if(change==='owner')a.owner=f.p.programs.launch
      else if(change==='provider'){if(index===1)a.lamports++}
      else if(change==='registry')a.data=[Buffer.from('changed').toString('base64'),'base64']
      else {const b=Buffer.from(a.data[0],'base64');b.writeBigUInt64LE(change==='minimum'?0n:b.readBigUInt64LE(74)-1n,74);a.data[0]=b.toString('base64')}
    })
    await assert.rejects(collectSelectedNativeTradeReview(f),undefined,change)
  }
})

test('selected native signing stays closed without explicit local acceptance even with an operator hook pin',()=>{
  const f=selectedNativeTradeFixture()
  assert.throws(()=>nativeTradeResolver({selectedHookPin:f.input.selectedHookPin,selectedNativeTradingEnabled:true,dossierJson:JSON.stringify({schema:'repoing/production-observation/2'}),connections:[]}),/operator pins changed/)
})

function changeAccount(f,role,name,address,change){
  const bytes=Buffer.from(f.accounts.get(address).dataBase64,'base64'),value=f.coders[role].accounts.decode(name,bytes)
  change(value);f.coders[role].types.encode(name,value).copy(bytes,8)
  const account={...f.accounts.get(address),dataBase64:bytes.toString('base64')};f.accounts.set(address,account)
  for(const o of f.input.observations)o.accounts.find(x=>x.address===address).account=account
}

test('selected final fill appends nongate graduation slice; post-graduation uses the same selected hook',()=>{
  const f=selectedNativeTradeFixture()
  changeAccount(f,'swap','Pool',f.a.pool,p=>{p.quote_reserve=new BN(900)})
  const before=compileNativeSwapReview(f.input),pool=f.coders.swap.accounts.decode('Pool',Buffer.from(f.accounts.get(f.a.pool).dataBase64,'base64'))
  const fill=finalFillLamports({graduated:false,graduationQuote:'1000',creatorFeeBps:100,pool:{baseReserve:BigInt(pool.base_reserve.toString()),quoteReserve:900n,virtualBase:BigInt(pool.virtual_base.toString()),virtualQuote:500n,protocolFeesQuote:0n}})
  f.input.request={...f.request,graduate:true,amountIn:String(fill),maxInput:String(fill)}
  const plan=compileNativeSwapReview(f.input),last=plan.instructions.at(-1)
  assert.equal(before.graduated,false);assert.equal(plan.graduates,true)
  assert.equal(last.program,f.p.programs.launch)
  assert.ok(last.accounts.some(x=>x.address===f.request.selectedHook.program))
  assert.ok(!last.accounts.some(x=>x.address===f.p.programs.gate))
  assert.ok(last.accounts.some(x=>x.address===f.taxHolding&&x.writable))
  const g=selectedNativeTradeFixture()
  changeAccount(g,'launch','Launch',g.a.launch,l=>{l.status=1;l.graduated_at=new BN(1001)})
  changeAccount(g,'swap','Pool',g.a.pool,p=>{p.curve=false;p.virtual_base=new BN(0);p.virtual_quote=new BN(0);p.quote_reserve=new BN(1000);p.lp_supply=new BN(2000)})
  changeAccount(g,'token','Mint',g.a.lpMint,m=>{m.supply=new BN(1000)})
  changeAccount(g,'token','Holding',g.a.launchLp,h=>{h.amount=new BN(1000)})
  const open=compileNativeSwapReview(g.input)
  assert.equal(open.graduated,true);assert.equal(open.review.operation,'native-selected-hook-buy')
})

test('native creator claim is hook-independent and needs no gate policy or token-hook invocation',()=>{
  const f=selectedNativeTradeFixture(),request={schema:'repoing/hooklab-native-claim-request/1',creator:f.request.trader,mint:f.request.mint}
  const profile={genesisHash:f.p.genesisHash,programs:f.p.programs,profileSha256:f.input.profile.expectedSha256,providers:f.input.profile.providers,
    launchElf:{trimmedSha256:f.p.elfSha256.launch,trimmedLength:f.input.profile.elfLengths.launch}}
  const inventory=nativeClaimInventory(profile,request),observations=f.input.observations.map(o=>({...o,accounts:inventory.map(address=>({address,account:f.accounts.get(address)??null}))}))
  const claim=compileNativeClaimReview({profile,request,observations,rent:{launchLamports:'5000000',walletLamports:'890880'},recentBlockhash:f.input.recentBlockhash,limits:f.input.limits})
  assert.equal(claim.review.operation,'hooklab-native-claim')
  assert.deepEqual(claim.review.requiredSigners,[request.creator])
  assert.ok(claim.instructions.every(ix=>![f.p.programs.gate,f.request.selectedHook.program].includes(ix.program)))
})
