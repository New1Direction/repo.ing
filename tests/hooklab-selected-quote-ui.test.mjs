import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { VersionedMessage,VersionedTransaction } from '@solana/web3.js'
import { selectedNativeSimulationFixture } from './fixtures/selected-native-trade.mjs'
import { collectSelectedNativeTradeReview } from '../src/hooklab-native-trade-resolver.mjs'
import { compileNativeSwapReview } from '../src/hooklab-native-swap.mjs'
import { measuredTradeMinimum,estimateTrade,finalFillLamports } from '../app/lib/hooklab-trade-math.mjs'
import { appModule,h,html } from './fixtures/render-jsx.mjs'
import { createInclusiveTradeHandler } from '../app/lib/hooklab-inclusive-trade.mjs'

test('quote-only measures asymmetric deductions greater than slippage without returning a review',async()=>{
  const f=selectedNativeSimulationFixture('sell') // ten percent input tax
  const oldMinimum=BigInt(compileNativeSwapReview(f.input).quote.delivered)*97n/100n
  assert.ok(oldMinimum>BigInt(f.plan.quote.delivered))
  const originalTx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(f.plan.review.messageBase64,'base64')))
  f.compilationInput.request.minAmountOut='1'
  for(const {connection}of f.connections){
    const simulate=connection.simulateTransaction
    connection.simulateTransaction=async(tx,options)=>{
      assert.notEqual(Buffer.from(tx.message.serialize()).toString('base64'),f.plan.review.messageBase64)
      return simulate(originalTx,options)
    }
  }
  const measured=await collectSelectedNativeTradeReview({...f,quoteOnly:true})
  assert.equal(measured.plan.quote.delivered,f.plan.quote.delivered)
  assert.deepEqual(Object.keys(measured).sort(),['canSign','canSubmit','plan'])
  assert.deepEqual(Object.keys(measured.plan),['quote'])
  assert.equal(measured.canSign,false)
  const minimum=measuredTradeMinimum(measured.plan.quote,300)
  assert.ok(minimum<BigInt(measured.plan.quote.delivered))
  assert.throws(()=>measuredTradeMinimum(measured.plan.quote,501))
  f.input.request.minAmountOut=String(minimum)
  const exact=compileNativeSwapReview({...f.input,selectedTokenDeltas:{[f.a.traderBase]:'-10000',[f.a.baseVault]:'9000'}})
  assert.equal(exact.request.minAmountOut,String(minimum))
})

test('selected initial arithmetic has no executable minimum and measured fee UI separates units',async()=>{
  const market={policyKind:'selected-hook',feeModel:1,creatorFeeBps:100,protocolShareBps:2500,decimals:6,
    pool:{baseReserve:'1000000000',quoteReserve:'1000000000',virtualBase:'0',virtualQuote:'0',protocolFeesQuote:'0'}}
  const estimate=estimateTrade(market,{side:'buy',amount:10000n})
  assert.equal(estimate.minAmountOut,null)
  assert.equal(estimate.hookDeductionsUnmeasured,true)
  const {SelectedTradeFees,HookTradeSummary}=await appModule('app/components/hooklab-trade-panel.jsx')
  const rough=html(h(HookTradeSummary,{market,symbol:'TOK',buying:true,estimate,native:true}))
  assert.match(rough,/Unmeasured/)
  const fees=html(h(SelectedTradeFees,{market,symbol:'TOK',quote:{feeModel:1,grossCreatorFee:'120',netCreatorFee:'90',
    hookTokenFee:'1200000',burnedToken:'300000',hookQuoteFee:'20',protocolFee:'31',networkFeeLamports:'5000',holdingRentLamports:'0',payerDebitLamports:'15000'}}))
  assert.match(fees,/1.2 TOK/);assert.match(fees,/0.3 TOK/)
  assert.match(fees,/Gross quote fee budget/)
  assert.match(fees,/Custom SOL cut \(included in gross budget\)/)
  assert.match(fees,/Protocol fees \(included creator share \+ LP fee\)/)
  assert.doesNotMatch(fees,/Additional protocol charge/)
})

test('selected share estimates allow an oversized buy to consume only the final fill',()=>{
  const market={policyKind:'selected-hook',feeModel:1,creatorFeeBps:1000,protocolShareBps:2500,decimals:0,graduationQuote:'2000',
    pool:{baseReserve:'10',quoteReserve:'1000',virtualBase:'1000',virtualQuote:'0',protocolFeesQuote:'7'}}
  // 12 consumed: gross creator fee 2 (platform rounds to zero), curve 10; 89 unspent.
  assert.equal(finalFillLamports(market),12n)
  const estimate=estimateTrade(market,{side:'buy',amount:101n})
  assert.equal(estimate.error,undefined)
  assert.equal(estimate.delivered,10n)
  assert.equal(estimate.consumedInput,12n)
  assert.equal(estimate.unspentInput,89n)
  assert.equal(estimate.graduates,true)
  assert.equal(estimate.minAmountOut,null)
})

test('selected consent shows the protected final-fill minimum rather than the larger wire argument',async()=>{
  const {SelectedTradeReview}=await appModule('app/components/hooklab-trade-panel.jsx')
  const request={side:'buy',amountIn:'101',minAmountOut:'754',selectedHook:{program:'local-hook',flags:65}}
  const quote={consumedInput:'13',unspentInput:'88',delivered:'100',feeModel:1,grossCreatorFee:'2',netCreatorFee:'2',
    hookTokenFee:'0',burnedToken:'0',hookQuoteFee:'0',protocolFee:'1',networkFeeLamports:'5000',holdingRentLamports:'0',payerDebitLamports:'5013'}
  for(const consent of [{request,measurement:quote},{request:{...request,quote},review:{maxNativeDebitLamports:'5101',messageSha256:'local-message'}}]){
    const text=html(h(SelectedTradeReview,{consent,market:{decimals:0},symbol:'TOK',onAnswer:()=>{}}))
    assert.match(text,/Minimum received: 97 TOK/)
    assert.doesNotMatch(text,/754 TOK/)
    assert.match(text,/0\.000000088 SOL stays in your wallet/)
    const doc=new JSDOM(text).window.document
    if(!consent.measurement){
      const diagnostics=doc.querySelector('details')
      assert.ok(diagnostics && !diagnostics.open)
      assert.match(diagnostics.textContent,/local-message/)
    }
    doc.querySelectorAll('details').forEach(d=>d.remove())
    assert.match(doc.body.textContent,/Minimum received: 97 TOK/)
    assert.match(doc.body.textContent,/Network fee/)
    assert.match(doc.body.textContent,/Total wallet spend/)
    assert.doesNotMatch(doc.body.textContent,/SHA256|local-hook|flags 65|re-simulate/)
  }
  const {HookLaunchNotes}=await appModule('app/components/hooklab-coin-form.jsx')
  const notes=html(h(HookLaunchNotes,{creatorFeeBps:100,capBps:0,selectedHook:request.selectedHook}))
  assert.match(notes,/floor\(gross creator fee \/ 4\), deducted from gross/)
  assert.doesNotMatch(notes,/Additional protocol share/)
})

test('native-estimate HTTP creates no signing operation and rejects browser preview flags',async()=>{
  const owner='11111111111111111111111111111111',id='11111111-1111-4111-8111-111111111111'
  const token=Buffer.alloc(32,9).toString('base64url'),f=selectedNativeSimulationFixture()
  let estimates=0,reviews=0
  const handle=createInclusiveTradeHandler({env:{HOOK_INCLUSIVE_TRADING_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_TRADING_PUBLIC:'true',HOOK_NATIVE_TRADING_ENABLED:'true'},
    configuration:()=>({origin:'https://repo.ing'}),database:()=>({end:async()=>{}}),quota:async()=>true,principalStore:()=>({resolve:async()=>({wallet:owner})}),moderation:async()=>({delisted:false}),
    runtime:()=>({origin:'https://repo.ing',nativeTrading:true,lifecycle:{createReview:async()=>{reviews++;throw Error('must not review')}},
      nativeEstimate:async args=>{estimates++;assert.equal(args.owner,owner);assert.equal(args.quoteId,id);return {quote:{delivered:'123'},review:{messageBase64:'NEVER'}}}})})
  const request={mint:owner,selectedConfig:owner,capBps:0,creatorFeeBps:100,side:'buy',amountIn:'1000',minAmountOut:'1',maxInput:'1000',maxPriceImpactBps:1000,graduate:false,policyKind:'selected-hook',selectedHook:f.request.selectedHook}
  const post=value=>handle(new Request('https://repo.ing/api/hook-lab/inclusive-trade',{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${token}`},body:JSON.stringify(value)}))
  const response=await post({action:'native-estimate',signingId:id,request})
  assert.deepEqual(await response.json(),{status:'available',quote:{delivered:'123'},canSign:false,canSubmit:false})
  assert.equal(reviews,0);assert.equal(estimates,1)
  assert.equal((await post({action:'native-quote',signingId:id,request:{...request,preview:true}})).status,400)
  assert.equal((await post({action:'native-estimate',signingId:id,request:{...request,preview:true}})).status,400)
})
