import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Connection, Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { CpAmm, CP_AMM_PROGRAM_ID, getPriceFromSqrtPrice } from '@meteora-ag/cp-amm-sdk'
import { dammSwapEvents } from '../src/damm-trades.mjs'
import { chartSpotPrice } from '../src/market-chart.mjs'
const program=new CpAmm(new Connection('http://127.0.0.1:8909'))._program
const mint=Keypair.generate().publicKey,pool=Keypair.generate().publicKey
function transaction(patch={},accounts=[1,2,1,1,1,1,3,4],nextSqrtPrice=new BN(1).shln(64)){
 const data={pool,tradeDirection:1,collectFeeMode:1,hasReferral:false,
 params:{amount0:new BN(100),amount1:new BN(0),swapMode:0},
 swapResult:{includedFeeInputAmount:new BN(100),excludedFeeInputAmount:new BN(98),amountLeft:new BN(0),outputAmount:new BN(42),nextSqrtPrice,claimingFee:new BN(1),protocolFee:new BN(1),compoundingFee:new BN(0),referralFee:new BN(0)},
 includedTransferFeeAmountIn:new BN(100),includedTransferFeeAmountOut:new BN(42),excludedTransferFeeAmountOut:new BN(42),currentTimestamp:new BN(1790540000),reserveAAmount:new BN(1000),reserveBAmount:new BN(2000),...patch}
 const event=Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),Buffer.from(program.idl.events.find(e=>e.name==='evtSwap2').discriminator),program.coder.types.encode('evtSwap2',data)])
 return {meta:{err:null,innerInstructions:[{index:0,instructions:[{programIdIndex:0,stackHeight:2,accounts:[],data:bs58.encode(event)}]}]},transaction:{message:{accountKeys:[CP_AMM_PROGRAM_ID,Keypair.generate().publicKey,pool,mint,NATIVE_MINT],instructions:[{programIdIndex:0,accounts,data:bs58.encode(Buffer.from('414b3f4ceb5b5b88','hex'))}]}}}
}
test('installed DAMM SDK event decoding preserves SOL volume, direction and Q64 price',()=>{
 const events=dammSwapEvents(transaction(),{mint:mint.toBase58()},pool.toBase58(),program.coder)
 assert.equal(events.length,1);assert.equal(events[0].nextSqrtPrice,(1n<<64n).toString());assert.equal(events[0].quoteAmount,'100')
 assert.equal(chartSpotPrice(events[0].nextSqrtPrice),getPriceFromSqrtPrice(new BN(events[0].nextSqrtPrice),6,9).toNumber())
 const sell=dammSwapEvents(transaction({tradeDirection:0}),{mint:mint.toBase58()},pool.toBase58(),program.coder)[0]
 assert.equal(sell.direction,'sell');assert.equal(sell.quoteAmount,'42')
})
test('foreign pool, wrong mint, unsupported fee assets and invalid prices fail closed',()=>{
 assert.deepEqual(dammSwapEvents(transaction(),{mint:Keypair.generate().publicKey.toBase58()},pool.toBase58(),program.coder),[])
 assert.deepEqual(dammSwapEvents(transaction({pool:mint}),{mint:mint.toBase58()},pool.toBase58(),program.coder),[])
 assert.throws(()=>dammSwapEvents(transaction({collectFeeMode:0}),{mint:mint.toBase58()},pool.toBase58(),program.coder),/ASSET_MISMATCH/)
 assert.throws(()=>dammSwapEvents(transaction({},undefined,new BN(0)),{mint:mint.toBase58()},pool.toBase58(),program.coder),/PRICE_INVALID/)
 const tx=transaction();tx.meta.err={failed:true};assert.throws(()=>dammSwapEvents(tx,{mint:mint.toBase58()},pool.toBase58(),program.coder),/EVIDENCE_MISSING/)
})
