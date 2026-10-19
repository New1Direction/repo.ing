// Regressions for the independent security review of the native-SOL trade path (PR #323), through the real signing
// lifecycle and PostgreSQL (127.0.0.1:55432, a scratch database) on the reviewed native ELFs.
// F1 end to end: a first buy whose holding appears before it lands settles. F2: a sent native trade stays readable and
// settles with native trading off, and under a newer reviewed profile; an unreviewed profile still refuses.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {VersionedTransaction} from '@solana/web3.js'
import pg from 'pg'
import {nativeSigningLifecycle} from '../src/hooklab-native-signing.mjs'
import {nativeTradeResolver} from '../src/hooklab-native-trade-resolver.mjs'
import {createHolding} from '../src/hooklab-owner-driver/instructions.mjs'
import {tradeLifecycleSettings} from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
import {productionSchema,migrationSchema} from '../scripts/hooklab-production-schema.mjs'
import {nativeWorld,NATIVE_SKIP,rebound} from './fixtures/hooklab-native-world.mjs'
import {dropTestDatabase} from './fixtures/drop-test-database.mjs'

const LIMITS={maxAgeMs:60000,maxSlotLag:5,validUntilSlot:0,reviewExpiresAtMs:0,maxNetworkFeeLamports:'10000',maxTotalDebitLamports:'10000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}
const ORIGIN='https://repo.ing',token=Buffer.alloc(32,43).toString('base64url')

test('native review regressions through the signing lifecycle',{skip:NATIVE_SKIP,timeout:600000},async t=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`native_poc_${randomUUID().replaceAll('-','')}`
 let pool,w
 t.after(async()=>{await pool?.end().catch(()=>{});await dropTestDatabase(admin,database).catch(()=>{});await admin.end();w?.close()})
 await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
 await pool.query(productionSchema().sql);await pool.query(migrationSchema('wallet-funding').sql);await pool.query(migrationSchema('native-stages').sql)
 w=await nativeWorld({capBps:5000})
 const {roles}=w,profile=JSON.parse(w.state.profile.json),owner=roles.creator,wallet=w.walletKey('creator')
 await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,$3,'general-launcher',$4,clock_timestamp()+interval '30 minutes')",
  [createHash('sha256').update(token).digest('hex'),owner,ORIGIN,profile.genesisHash])
 const native=nativeTradeResolver({...w.bindings,connections:w.connections(),limits:{...LIMITS,nowMs:Date.now()}})
 let beforeSend=async()=>{}
 const sender={send:async({signedTransactionBase64})=>{await beforeSend();return (await w.submit(signedTransactionBase64)).signature}}
 // Lifecycles exactly as the trade runtime wires them (app/lib/hooklab-inclusive-trade-runtime.mjs), native open or not.
 const lifecycleWith=settings=>nativeSigningLifecycle(pool,{enabled:true,origin:ORIGIN,custodyAdapter:null,sender,...settings})
 const on=lifecycleWith(tradeLifecycleSettings({trade:{},funding:{},native,nativeOpen:true}))
 // The minimum received a panel would send (its estimate less 3%).
 const intent=async(side,amountIn)=>({side,creatorFeeBps:100,capBps:5000,mint:roles.mint,selectedConfig:roles.config,amountIn:String(amountIn),
  minAmountOut:await w.minimumOut(side,amountIn,owner),maxInput:String(amountIn),maxPriceImpactBps:1000,graduate:false})
 async function submitted(side,amount){
  const id=randomUUID();await on.createReview(token,id,{custodyOperationId:id,stage:`native-${side}`,intent:await intent(side,amount)})
  const request=await on.walletRequest(token,id),tx=VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64,'base64'));tx.sign([wallet])
  await on.retainWalletSignature(token,id,Buffer.from(tx.serialize()).toString('base64'))
  assert.equal((await on.submitOnce(token,id)).status,'submitted');return id
 }

 await t.test('F1 end to end: a first buy whose holding appears before it lands executes and settles',async()=>{
  // The holding appears after submitOnce's last finalized check and before the transaction lands (another tab, a
  // second quick buy, or anyone calling the idempotent create_holding for this wallet).
  beforeSend=async()=>{const r=await w.send(await w.compile(roles.outsider,[createHolding(profile.programs,{payer:roles.outsider,mint:roles.mint,owner})]));assert.equal(r.error,null)}
  const id=await submitted('buy',1000003);beforeSend=async()=>{}
  let op;for(let i=0;i<3;i++)op=await on.reconcile(token,id)
  t.diagnostic(`after 3 reconciles: status ${op.status}, settlement ${JSON.stringify(op.settlement)}`)
  assert.equal(op.status,'finalized-success','the trade executed on chain')
 })

 await t.test('F2: with native trading off, a sent native trade stays readable and settles; new native work is refused',async()=>{
  const id=await submitted('sell',100000000000)
  // The same database, the runtime rebuilt with native trading off (the switch off, or a bundle without the native pins).
  const off=lifecycleWith(tradeLifecycleSettings({trade:{},funding:{},native,nativeOpen:false}))
  let read=null,error=null
  try{read=await off.get(token,id)}catch(e){error=e}
  t.diagnostic(`get with native off: ${error?`${error.code} ${error.message}`:read.status}`)
  assert.equal(error,null,'an existing operation stays readable')
  const settled=await off.reconcile(token,id).catch(e=>({status:`threw ${e.code}`}))
  assert.equal(settled.status,'finalized-success','and a sent trade still settles')
  const fresh=randomUUID()
  await assert.rejects(off.createReview(token,fresh,{custodyOperationId:fresh,stage:'native-buy',intent:await intent('buy',1000)}),'no new native review while off')
  const waiting=randomUUID();await on.createReview(token,waiting,{custodyOperationId:waiting,stage:'native-buy',intent:await intent('buy',2000000)})
  for(const step of [()=>off.walletRequest(token,waiting),()=>off.refreshReview(token,waiting),()=>off.submitOnce(token,waiting)])await assert.rejects(step(),'nothing moves forward while off')
  assert.equal((await off.get(token,waiting)).status,'reviewed')
 })

 await t.test('F2: a sent native trade settles after the current profile changes, only if the profile it was reviewed under is a reviewed one',async()=>{
  const id=await submitted('buy',3000000),reviewedUnder=w.state.profile.expectedSha256
  // Bundle B: the same chain, a new reviewed profile (as bundle 3 will be after bundle 2).
  const b=rebound(w.bindings,json=>({...json,profileId:'next-reviewed-bundle'}))
  assert.notEqual(b.profile.expectedSha256,reviewedUnder)
  const under=reviewedProfiles=>lifecycleWith(tradeLifecycleSettings({trade:{},funding:{},nativeOpen:true,
   native:nativeTradeResolver({...b,connections:w.connections(),limits:{...LIMITS,nowMs:Date.now()},reviewedProfiles})}))
  await assert.rejects(under([b.profile.expectedSha256]).reconcile(token,id),'a profile that is not in the reviewed list never settles')
  assert.equal((await under([b.profile.expectedSha256,reviewedUnder]).reconcile(token,id)).status,'finalized-success')
  assert.equal((await under([b.profile.expectedSha256]).get(token,id)).status,'finalized-success','and reads back')
 })
})
