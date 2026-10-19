// A native-SOL buy and sale through the real signing lifecycle and its PostgreSQL rows (127.0.0.1:55432, a scratch
// database), the native resolver and the reviewed native ELFs: the stage is refused until the native-stages migration
// is applied; then review, the wallet signs the exact bytes, one send, and a finalized receipt settles each trade.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {VersionedTransaction} from '@solana/web3.js'
import pg from 'pg'
import {nativeSigningLifecycle} from '../src/hooklab-native-signing.mjs'
import {nativeTradeResolver} from '../src/hooklab-native-trade-resolver.mjs'
import {stagedResolver} from '../src/hooklab-wallet-funding-resolver.mjs'
import {productionSchema,migrationSchema} from '../scripts/hooklab-production-schema.mjs'
import {nativeWorld,NATIVE_SKIP} from './fixtures/hooklab-native-world.mjs'
import {dropTestDatabase} from './fixtures/drop-test-database.mjs'

const LIMITS={maxAgeMs:60000,maxSlotLag:5,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:'10000',maxTotalDebitLamports:'10000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}
const ORIGIN='https://repo.ing',token=Buffer.alloc(32,41).toString('base64url')

test('native buy and sale through the signing lifecycle: one wallet approval each, sent once, settled from the receipt',{skip:NATIVE_SKIP,timeout:300000},async t=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`native_trade_${randomUUID().replaceAll('-','')}`
 let pool,w
 t.after(async()=>{await pool?.end().catch(()=>{});await dropTestDatabase(admin,database).catch(()=>{});await admin.end();w?.close()})
 await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
 await pool.query(productionSchema().sql);await pool.query(migrationSchema('wallet-funding').sql)
 w=await nativeWorld({capBps:5000})
 const {roles}=w,owner=roles.creator,wallet=w.walletKey('creator');assert.equal(wallet.publicKey.toBase58(),owner)
 await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,$3,'general-launcher',$4,clock_timestamp()+interval '30 minutes')",
  [createHash('sha256').update(token).digest('hex'),owner,ORIGIN,JSON.parse(w.state.profile.json).genesisHash])
 const native=nativeTradeResolver({...w.bindings,connections:w.connections(),limits:{...LIMITS,nowMs:Date.now()}})
 let sends=0
 const lifecycle=nativeSigningLifecycle(pool,{enabled:true,origin:ORIGIN,resolver:stagedResolver({'native-buy':native,'native-sell':native}),custodyAdapter:null,
  sender:{send:async({signedTransactionBase64})=>{sends++;return (await w.submit(signedTransactionBase64)).signature}},
  stageOperations:{'native-buy':'native-max-wallet-buy','native-sell':'native-max-wallet-sell'}})
 const intent=(side,amountIn)=>({side,creatorFeeBps:100,capBps:5000,mint:roles.mint,selectedConfig:roles.config,amountIn:String(amountIn),minAmountOut:'1',maxInput:String(amountIn),maxPriceImpactBps:1000,graduate:false})
 async function trade(side,amount){
  const id=randomUUID(),reviewed=await lifecycle.createReview(token,id,{custodyOperationId:id,stage:`native-${side}`,intent:intent(side,amount)})
  assert.equal(reviewed.status,'reviewed');assert.equal(reviewed.review.operation,`native-max-wallet-${side}`);assert.deepEqual(reviewed.review.requiredSigners,[owner])
  const request=await lifecycle.walletRequest(token,id),tx=VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64,'base64'))
  tx.sign([wallet])
  assert.equal((await lifecycle.retainWalletSignature(token,id,Buffer.from(tx.serialize()).toString('base64'))).status,'signed')
  const submitted=await lifecycle.submitOnce(token,id);assert.equal(submitted.status,'submitted')
  const settled=await lifecycle.reconcile(token,id)
  assert.equal(settled.status,'finalized-success');assert.equal(settled.settlement.executionStatus,'finalized-executed')
  return settled
 }
 await t.test('the native stages need the native-stages migration',async()=>{
  const id=randomUUID(),create=()=>lifecycle.createReview(token,id,{custodyOperationId:id,stage:'native-buy',intent:intent('buy',5000000)})
  await assert.rejects(create());assert.equal((await pool.query('select count(*)::int as n from hook_lab_native_signing_operations')).rows[0].n,0)
  await pool.query(migrationSchema('native-stages').sql)
  assert.equal((await create()).status,'reviewed','the same request, once the stage is allowed')
 })
 await t.test('a buy, then a sale, each one approval and one send',async()=>{
  const bought=await trade('buy',1000003)
  assert.deepEqual([bought.settlement.quote.grossCreatorFee,bought.settlement.quote.protocolFee,bought.settlement.quote.netCreatorFee],['10001','2500','7501'])
  const sold=await trade('sell',BigInt(bought.settlement.quote.delivered)/3n)
  assert.deepEqual([sold.settlement.quote.grossCreatorFee,sold.settlement.quote.protocolFee,sold.settlement.quote.netCreatorFee],['3303','825','2478'])
  assert.equal(sends,2)
  const rows=(await pool.query("select stage,status from hook_lab_native_signing_operations where owner_wallet=$1 order by created_at",[owner])).rows
  assert.deepEqual(rows,[{stage:'native-buy',status:'reviewed'},{stage:'native-buy',status:'finalized-success'},{stage:'native-sell',status:'finalized-success'}])
 })
})
