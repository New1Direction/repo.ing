// Synthetic keys and a disposable database only. No RPC, no real admin key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash,randomUUID,sign as edSign,createPrivateKey } from 'node:crypto'
import { Keypair,PublicKey } from '@solana/web3.js'
import pg from 'pg'
import { ownerApprovalStore,remoteAdminSigner,verifyEd25519 } from '../src/hooklab-owner-approval.mjs'
import { MIGRATIONS,migrationSchema,productionSchema } from '../scripts/hooklab-production-schema.mjs'
import { STANDARD_VIRTUAL_QUOTE } from '../src/hooklab-launch-pricing.mjs'

const seed=label=>createHash('sha256').update(`OWNER APPROVAL TEST FIXTURE ONLY: ${label}`).digest()
const keypair=label=>Keypair.fromSeed(seed(label))
const signWith=(label,message)=>edSign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed(label)]),format:'der',type:'pkcs8'}))
const admin=keypair('admin').publicKey.toBase58(),creatorA=keypair('creator-a').publicKey.toBase58(),creatorB=keypair('creator-b').publicKey.toBase58()
const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'}

async function withDatabase(work){
 const root=new pg.Pool(config),name=`owner_approval_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await root.query(`create database ${name}`);pool=new pg.Pool({...config,database:name})
  // Exactly the production schema: the reviewed bootstrap, then every named migration.
  await pool.query(productionSchema().sql)
  for(const name of Object.keys(MIGRATIONS))await pool.query(migrationSchema(name).sql)
  await work(pool)
 }finally{await pool?.end();await closed(root,name);await root.query(`drop database if exists ${name} with (force)`);await root.end()}
}
// pool.end() resolves before Postgres sees the sockets close; a forced drop racing those exits makes the pool emit
// "terminating connection due to administrator command" with no listener. Wait until the backends are gone.
async function closed(root,name){
 for(const deadline=Date.now()+5_000;Date.now()<deadline;await new Promise(r=>setTimeout(r,20))){
  if((await root.query('select count(*)::int n from pg_stat_activity where datname=$1',[name])).rows[0].n===0)return
 }
 throw Error(`connections to ${name} are still open after the pool ended`)
}
function reviewFor(message,{validUntilSlot=1_000,lastValidBlockHeight=2_000,reviewExpiresAtMs=Date.now()+60_000}={}){
 const bytes=Buffer.from(message)
 return {operation:'max-wallet-launch',messageBase64:bytes.toString('base64'),messageSha256:createHash('sha256').update(bytes).digest('hex'),
  requiredSigners:[creatorA,admin],validUntilSlot,lastValidBlockHeight,reviewExpiresAtMs}
}
const intent={name:'Canary Coin',symbol:'CNRY',uri:'',creatorFeeBps:100,capBps:200}
// What the native launcher binds on reserve: the invited coin plus the opening price it compiles.
const launch=(over={})=>({...intent,virtualQuote:STANDARD_VIRTUAL_QUOTE,...over})
const price={solUsdMicros:'105630000',virtualQuote:'53251917070',
 sources:[{source:'coingecko',usdMicros:'105620000'},{source:'jupiter',usdMicros:'105630000'},{source:'coinbase',usdMicros:'105640000'}]}

test('presence, queue, single invite and exact-detail binding',async()=>withDatabase(async pool=>{
 const store=ownerApprovalStore(pool,{adminAddress:admin})
 assert.equal((await store.availability()).online,false)
 await assert.rejects(store.heartbeat({accepting:true,agentAddress:creatorA}),/configured admin/)
 await store.heartbeat({accepting:true,agentAddress:admin})
 assert.equal((await store.availability()).online,true)
 await pool.query("update hook_lab_owner_presence set last_seen_at=clock_timestamp()-interval '1 minute'")
 assert.equal((await store.availability()).online,false,'stale heartbeat reads as offline')
 await store.heartbeat({accepting:false,agentAddress:admin})
 assert.equal((await store.availability()).online,false,'paused agent reads as offline')

 const a=await store.createRequest(creatorA,{id:randomUUID(),...intent})
 await assert.rejects(store.createRequest(creatorA,{id:randomUUID(),...intent}),/already have an open/)
 for(const off of [{creatorFeeBps:75},{capBps:250},{creatorFeeBps:0}])await assert.rejects(store.createRequest(creatorB,{id:randomUUID(),...intent,...off}),/approved creator fee/)
 const b=await store.createRequest(creatorB,{id:randomUUID(),...intent,symbol:'BBB'})
 await assert.rejects(store.invite(a.id,{inviteMs:30_000}),/1-60 minutes/)
 assert.equal((await store.invite(a.id,{inviteMs:600_000})).status,'invited')
 await assert.rejects(store.invite(b.id,{inviteMs:600_000}),/Another creator is already invited/)

 const op=randomUUID(),db=await pool.connect()
 try{
  await assert.rejects(store.bindLaunch(db,creatorB,op,launch({symbol:'BBB'})),/Wait for repo.ing/)
  await assert.rejects(store.bindLaunch(db,creatorA,op,launch({name:'Other'})),/differ from the approved/)
  await assert.rejects(store.bindLaunch(db,creatorA,op,launch({capBps:500})),/differ from the approved/,'cap is bound to the invite')
  await assert.rejects(store.bindLaunch(db,creatorA,op,launch({creatorFeeBps:200})),/differ from the approved/,'fee is bound to the invite')
  for(const virtualQuote of ['53251917070','999999999',undefined])
   await assert.rejects(store.bindLaunch(db,creatorA,op,launch({virtualQuote})),/opening price differs/,'pricing off: only the standard 1 SOL quote launches')
  assert.equal((await store.bindLaunch(db,creatorA,op,launch())).status,'launching')
  assert.equal((await store.bindLaunch(db,creatorA,op,launch())).custodyOperationId,op,'same operation is idempotent')
  await assert.rejects(store.bindLaunch(db,creatorA,randomUUID(),launch()),/bound to another launch/)
 }finally{db.release()}
 await assert.rejects(store.invite(b.id,{inviteMs:600_000}),/Another creator is already invited/,'launching still blocks a second creator')
 assert.equal((await store.markLaunched(op)).status,'launched')
 assert.equal((await store.invite(b.id,{inviteMs:600_000})).status,'invited','next creator after the launch lands')
 await pool.query("update hook_lab_launch_requests set invite_expires_at=clock_timestamp()-interval '1 second' where id=$1",[b.id])
 assert.equal((await store.requestFor(creatorB)).status,'invite-expired')
 const again=await store.createRequest(creatorB,{id:randomUUID(),...intent})
 assert.equal((await store.decline(again.id)).status,'declined')
}))

test('USD pricing: the invite fixes one immutable price, and only that opening price can launch',async()=>withDatabase(async pool=>{
 const store=ownerApprovalStore(pool,{adminAddress:admin,usdPricing:true})
 const a=await store.createRequest(creatorA,{id:randomUUID(),...intent})
 assert.equal((await store.requestFor(creatorA)).pricing,null,'queued: no price is fixed yet')
 await assert.rejects(store.invite(a.id,{inviteMs:600_000}),/Launch price is missing/,'pricing on: an invite needs a price')
 await assert.rejects(store.invite(a.id,{inviteMs:600_000,price:{...price,virtualQuote:'112500000000'}}),/does not follow from its SOL price/)
 await assert.rejects(store.invite(a.id,{inviteMs:600_000,price:{...price,sources:price.sources.slice(0,1)}}),/at least two must agree/)
 await assert.rejects(store.invite(a.id,{inviteMs:600_000,price:{...price,solUsdMicros:'40000000',sources:price.sources.map(s=>({...s,usdMicros:'40000000'}))}}),/outside the launch config/)
 assert.equal((await store.requestFor(creatorA)).status,'queued','a refused price leaves the request queued')
 assert.equal((await pool.query('select count(*)::int n from hook_lab_launch_request_prices')).rows[0].n,0)

 const invited=await store.invite(a.id,{inviteMs:600_000,price})
 assert.equal(invited.status,'invited')
 const {pricedAt,...fixed}=invited.pricing
 assert.deepEqual(fixed,price);assert.ok(Date.parse(pricedAt)>0)
 assert.deepEqual((await store.requestFor(creatorA)).pricing,invited.pricing,'the creator sees the fixed price')
 assert.deepEqual((await store.heartbeat({accepting:true,agentAddress:admin})).requests[0].pricing,invited.pricing,'the agent sees what it approves')
 const op=randomUUID(),db=await pool.connect()
 try{
  for(const virtualQuote of [STANDARD_VIRTUAL_QUOTE,'53251917071',undefined])
   await assert.rejects(store.bindLaunch(db,creatorA,op,launch({virtualQuote})),/opening price differs/,`refused: ${virtualQuote}`)
  assert.equal((await store.bindLaunch(db,creatorA,op,launch({virtualQuote:price.virtualQuote}))).status,'launching')
  await assert.rejects(store.bindLaunch(db,creatorA,op,launch()),/opening price differs/,'a bound launch keeps its price')
 }finally{db.release()}
 await assert.rejects(pool.query('update hook_lab_launch_request_prices set virtual_quote=1000000000'),/immutable/)
 await assert.rejects(pool.query('delete from hook_lab_launch_request_prices'),/immutable/)

 // Flag off on the same database: no pricing in any answer, and launches compile the standard 1 SOL quote again.
 const off=ownerApprovalStore(pool,{adminAddress:admin})
 assert.equal('pricing' in (await off.requestFor(creatorA)),false)
 await off.markLaunched(op)
 const b=await off.createRequest(creatorB,{id:randomUUID(),...intent})
 const plain=await off.invite(b.id,{inviteMs:600_000,price})
 assert.equal('pricing' in plain,false,'a price passed while off is ignored, never stored')
 assert.equal((await pool.query('select count(*)::int n from hook_lab_launch_request_prices where request_id=$1',[b.id])).rows[0].n,0)
 assert.equal((await off.bindLaunch(pool,creatorB,randomUUID(),launch())).status,'launching')
}))

test('remote admin signer returns only a verified owner signature before the real deadline',async()=>withDatabase(async pool=>{
 const store=ownerApprovalStore(pool,{adminAddress:admin}),message=Buffer.from('synthetic launch message 1')
 let slot=900,signedOnce=0
 const observe=async()=>({slot,blockHeight:1_900,nowMs:Date.now()})
 const sleep=async()=>{
  const {rows:[pending]}=await pool.query("select id from hook_lab_owner_sign_requests where status='pending'")
  if(pending&&!signedOnce++){
   await assert.rejects(store.submitSignature(pending.id,signWith('creator-a',message).toString('base64')),/does not verify/,'wrong key rejected')
   await store.submitSignature(pending.id,signWith('admin',message).toString('base64'))
  }
 }
 const signer=remoteAdminSigner(pool,{address:admin,observe,sleep})
 await assert.rejects(signer.sign(message,{review:reviewFor('different bytes')}),/differs from its review/)
 const signature=await signer.sign(message,{review:reviewFor(message),owner:creatorA})
 assert.ok(verifyEd25519(admin,message,signature))
 const repeat=await signer.sign(message,{review:reviewFor(message)})
 assert.deepEqual(Buffer.from(repeat),Buffer.from(signature),'same message never produces a second request')
 assert.equal((await pool.query('select count(*)::int as n from hook_lab_owner_sign_requests')).rows[0].n,1)

 // Deadline is the earliest of slot, block height and review expiry, minus margins.
 for(const [label,limits,observed] of [
  ['deadline slot',{validUntilSlot:1_000},{slot:990,blockHeight:1_000}],
  ['blockhash height',{lastValidBlockHeight:2_000},{slot:100,blockHeight:1_990}],
  ['review expiry',{reviewExpiresAtMs:Date.now()+2_000},{slot:100,blockHeight:1_000}],
 ]){
  const m=Buffer.from(`expiring message: ${label}`)
  const late=remoteAdminSigner(pool,{address:admin,observe:async()=>({...observed,nowMs:Date.now()}),sleep:async()=>{}})
  await assert.rejects(late.sign(m,{review:reviewFor(m,limits)}),/window closed/,label)
  const {rows:[row]}=await pool.query('select id,status from hook_lab_owner_sign_requests where message_sha256=$1',[reviewFor(m).messageSha256])
  assert.equal(row.status,'expired',label)
  await assert.rejects(store.submitSignature(row.id,signWith('admin',m).toString('base64')),/no longer pending/,`${label}: late signature refused`)
  await assert.rejects(late.sign(m,{review:reviewFor(m,limits)}),/expired/,`${label}: expired message is never re-requested`)
 }

 // Owner declines.
 const declined=Buffer.from('declined message')
 const signerDecline=remoteAdminSigner(pool,{address:admin,observe,sleep:async()=>{
  const {rows:[p]}=await pool.query("select id from hook_lab_owner_sign_requests where status='pending'");if(p)await store.declineSignRequest(p.id)}})
 await assert.rejects(signerDecline.sign(declined,{review:reviewFor(declined)}),/declined/)

 // Race: the owner's signature lands in the same instant the window closes; it is still returned.
 const raced=Buffer.from('raced message')
 const racer=remoteAdminSigner(pool,{address:admin,observe:async()=>{
  const {rows:[p]}=await pool.query("select id from hook_lab_owner_sign_requests where status='pending'")
  if(p)await store.submitSignature(p.id,signWith('admin',raced).toString('base64'))
  return {slot:999,blockHeight:1_000,nowMs:Date.now()}
 },sleep:async()=>{}})
 assert.ok(verifyEd25519(admin,raced,await racer.sign(raced,{review:reviewFor(raced)})))
}))

test('per-launch lookup table: requested once, created only by the agent claim, verified on chain, issued bytes locked',async()=>withDatabase(async pool=>{
 const {productionArtifacts,productionProfileJson}=await import('../src/hooklab-production-operator-bundle.mjs')
 const {remoteLaunchLookupTable,launchTableInventory,verifyTableRequest}=await import('../src/hooklab-owner-launch-tables.mjs')
 const fixture=JSON.parse(await readFile(new URL('./fixtures/hooklab-mainnet-public-accounts.json',import.meta.url),'utf8'))
 const {base,idls}=productionArtifacts(),envelope={json:productionProfileJson(base),idls:Object.fromEntries(Object.entries(idls).map(([r,b])=>[r,b.toString('base64')]))}
 const configBytes=Buffer.from(fixture.accounts['launch-config'].dataBase64,'base64'),realAdmin='DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5'
 const store=ownerApprovalStore(pool,{adminAddress:admin})
 const request=await store.createRequest(creatorA,{id:randomUUID(),...intent});await store.invite(request.id,{inviteMs:600_000})
 const preparationId=randomUUID();await store.bindLaunch(pool,creatorA,preparationId,launch())
 const launchRequest={schema:'repoing/inclusive-max-wallet-launch-request/1',policyKind:'max-wallet',policyVersion:2,creator:creatorA,feePayer:creatorA,mint:keypair('mint').publicKey.toBase58(),
  selectedConfig:keypair('selected').publicKey.toBase58(),capBps:200,label:'customer',creatorFeeBps:100,rules:'none',hookFlags:1,feeModel:2,protocolShareBps:2500,reviewer:realAdmin,
  name:intent.name,symbol:intent.symbol,uri:intent.uri,virtualQuote:'1000000000'}
 const {inventory}=launchTableInventory(envelope,launchRequest,configBytes),tableAddress=keypair('table').publicKey.toBase58()
 const tableData=(addresses=inventory)=>{const h=Buffer.alloc(56);h.writeUInt32LE(1,0);h.writeBigUInt64LE(0xffffffffffffffffn,4);h.writeBigUInt64LE(100n,12);h[21]=1;new PublicKey(realAdmin).toBuffer().copy(h,22)
  return Buffer.concat([h,...addresses.map(a=>new PublicKey(a).toBuffer())])}
 let onChain=tableData()
 const configAddress=PublicKey.findProgramAddressSync([Buffer.from('config')],new PublicKey(JSON.parse(envelope.json).programs.launch))[0].toBase58()
 const connection={getSlot:async()=>200,async getAccountInfo(k){const a=k.toBase58()
  if(a===configAddress)return {owner:new PublicKey(JSON.parse(envelope.json).programs.launch),data:configBytes}
  if(a===tableAddress)return {owner:new PublicKey('AddressLookupTab1e1111111111111111111111111'),data:onChain};return null}}
 const readLaunch=async id=>id===preparationId?{owner_wallet:creatorA,launch_request:launchRequest,launch_request_id:request.id}:undefined
 let agentRan=0
 // The owner agent's part: it sees the request in its heartbeat, re-derives it, and reports the table.
 const sleep=async()=>{if(agentRan++)return
  const {requests,tableRequests}=await store.heartbeat({accepting:true,agentAddress:admin})
  assert.equal(tableRequests.length,1)
  verifyTableRequest({tableRequest:tableRequests[0],invited:requests.find(r=>r.id===tableRequests[0].launchRequestId),envelope,launchConfigBytes:configBytes,adminAddress:realAdmin})
  await store.submitTable(preparationId,tableAddress)}
 const provider=remoteLaunchLookupTable(pool,{envelope,connections:[{connection},{connection}],adminAddress:realAdmin,readLaunch,sleep,pollMs:1,timeoutMs:5_000})
 await store.heartbeat({accepting:true,agentAddress:admin})
 const pin=await provider({preparationId,allowCreate:true})
 assert.equal(pin.address,tableAddress);assert.equal(pin.sha256,createHash('sha256').update(onChain).digest('hex'))
 assert.deepEqual(await provider({preparationId,allowCreate:false}),pin,'later signing stages reuse the issued table')
 await assert.rejects(store.submitTable(preparationId,keypair('other-table').publicKey.toBase58()),/no longer pending/)
 await assert.rejects(provider({preparationId:randomUUID(),allowCreate:false}),/not bound/)
 onChain=tableData([...inventory].reverse())
 assert.deepEqual(await provider({preparationId,allowCreate:false}),pin,'settlement and reconcile keep the issued pin even after the table is reclaimed')
 await assert.rejects(provider({preparationId,allowCreate:true}),/addresses differ/,'a fresh review re-verifies the table on chain')
 await assert.rejects(pool.query("update hook_lab_owner_table_requests set inventory='[]'::jsonb"),/immutable/)
 await assert.rejects(pool.query("update hook_lab_owner_table_requests set issued_table_sha256=repeat('0',64)"),/immutable/)
 // A request the agent never answers fails clearly instead of hanging; without allowCreate nothing is requested.
 const second=await store.createRequest(creatorB,{id:randomUUID(),...intent});await store.cancelRequest(creatorA,request.id).catch(()=>{})
 await pool.query("update hook_lab_launch_requests set status='launched' where id=$1",[request.id])
 await store.invite(second.id,{inviteMs:600_000});const prep2=randomUUID();await store.bindLaunch(pool,creatorB,prep2,launch())
 const lr2={...launchRequest,creator:creatorB,feePayer:creatorB,mint:keypair('mint-2').publicKey.toBase58()}
 const silent=remoteLaunchLookupTable(pool,{envelope,connections:[{connection},{connection}],adminAddress:realAdmin,sleep:async()=>{},pollMs:1,timeoutMs:20,
  readLaunch:async()=>({owner_wallet:creatorB,launch_request:lr2,launch_request_id:second.id})})
 await assert.rejects(silent({preparationId:prep2,allowCreate:false}),/missing/)
 await pool.query("update hook_lab_owner_presence set last_seen_at=clock_timestamp()-interval '1 minute'")
 await assert.rejects(silent({preparationId:prep2,allowCreate:true}),/offline/,'an offline approver fails fast instead of holding the request')
 await store.heartbeat({accepting:true,agentAddress:admin})
 await assert.rejects(silent({preparationId:prep2,allowCreate:true}),/still preparing/)
 await store.declineTable(prep2)
 await assert.rejects(silent({preparationId:prep2,allowCreate:true}),/declined/)
}))

test('coin profile: written with its request, shown to the creator and agent, public only while the coin can launch',async()=>withDatabase(async pool=>{
 const store=ownerApprovalStore(pool,{adminAddress:admin}),image='data:image/png;base64,iVBORw0KGgo='
 const profile={image,description:'The cat that ships.',x:'@repocat',website:'repo.ing',telegram:''}
 const id=randomUUID(),created=await store.createRequest(creatorA,{id,...intent},profile)
 assert.deepEqual(created.profile,{description:'The cat that ships.',x:'repocat',website:'https://repo.ing/',telegram:null})
 assert.deepEqual((await store.requestFor(creatorA)).profile,created.profile)
 assert.deepEqual((await store.heartbeat({accepting:true,agentAddress:admin})).requests[0].profile,created.profile,'the agent sees what it approves')
 const coin=await store.coinFor(id)
 assert.deepEqual(coin.request,{id,name:'Canary Coin',symbol:'CNRY',status:'queued'});assert.equal(coin.image,image);assert.equal(coin.profile.x,'repocat')
 assert.equal(await store.coinFor('not-a-uuid'),null);assert.equal(await store.coinFor(randomUUID()),null)

 await assert.rejects(store.createRequest(creatorA,{id:randomUUID(),...intent},profile),/already have an open/)
 assert.equal((await pool.query('select count(*)::int n from hook_lab_coin_profiles')).rows[0].n,1,'a refused request leaves no profile behind')
 await assert.rejects(store.createRequest(creatorB,{id:randomUUID(),...intent},{...profile,x:'not a handle'}),/X account/)
 await assert.rejects(store.createRequest(creatorB,{id:randomUUID(),...intent},{...profile,image:'data:image/jpeg;base64,AAAA'}),/coin image/)

 await store.decline(id)
 assert.equal(await store.coinFor(id),null,'a declined coin is no longer served')
 await assert.rejects(pool.query("update hook_lab_coin_profiles set description='changed' where request_id=$1",[id]),/immutable/,'a reviewed profile cannot change')
 await assert.rejects(pool.query('delete from hook_lab_coin_profiles where request_id=$1',[id]),/immutable/)
 await assert.rejects(store.createRequest(creatorB,{id:randomUUID(),...intent,name:'Fake\n 2. queued'}),/approved creator fee|name/,'control characters in a name are refused')
 assert.deepEqual(await store.launchedCoins(),[],'no launch operation yet, so no listed coin')
 assert.equal(await store.coinByMint(creatorA),null)
 assert.equal((await store.requestFor(creatorA)).mint,undefined,'mint appears only once launched')
 const legacy=await store.createRequest(creatorB,{id:randomUUID(),...intent})
 assert.equal(legacy.profile,null);assert.equal((await store.requestFor(creatorB)).profile,null);assert.equal(await store.coinFor(legacy.id),null)
}))

test('one wallet can attach at most five coin images a day',async()=>withDatabase(async pool=>{
 const store=ownerApprovalStore(pool,{adminAddress:admin}),profile={image:'data:image/png;base64,iVBORw0KGgo=',description:'',x:'',website:'',telegram:''}
 for(let i=0;i<5;i++){const r=await store.createRequest(creatorA,{id:randomUUID(),...intent},profile);await store.cancelRequest(creatorA,r.id)}
 await assert.rejects(store.createRequest(creatorA,{id:randomUUID(),...intent},profile),/several launch requests today/)
 assert.equal((await store.createRequest(creatorB,{id:randomUUID(),...intent},profile)).status,'queued','other wallets are unaffected')
}))
