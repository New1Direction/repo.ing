// Open (self-serve) launch records on the production schema with every migration: the creator's own request chooses from
// the chain's menus, many creators may launch at once, the launch binds the price repo.ing fixed, a finalized launch is
// listed, and the owner's delisting (append-only, a placeholder reason) leaves discovery while the coin stays findable for
// selling and claims. A disposable database only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Keypair, PublicKey, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'
import { ownerApprovalStore } from '../src/hooklab-owner-approval.mjs'
import { MIGRATIONS, migrationSchema, productionSchema } from '../scripts/hooklab-production-schema.mjs'
import { launchVirtualQuote } from '../src/hooklab-launch-pricing.mjs'
import { stackProfileFor } from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
import { createLaunchRequestsHandler } from '../app/lib/hooklab-launch-requests.mjs'
import { createNativeLaunchHandler } from '../app/lib/hooklab-native-launch.mjs'
import { executionGenesis } from '../src/hooklab-local-acceptance.mjs'
import sharp from 'sharp'
import { hookCatalogStore, taxHookSetupManifest } from '../src/hooklab-hook-catalog.mjs'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'

const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
const key = label => Keypair.fromSeed(createHash('sha256').update(`OPEN LAUNCH DB TEST ONLY ${label}`).digest()).publicKey.toBase58()
const MENUS = { creatorFeeBps: [50, 100, 200], maxCreatorFeeBps: 200, capBps: [100, 200, 300, 500] }
const IMAGE = 'data:image/png;base64,iVBORw0KGgo='
const profile = { image: IMAGE, description: 'A test coin.', x: '', website: '', telegram: '' }
// Two agreeing sources at $150: the price the server fixes at reserve.
const pricing = (() => { const sources = [{ source: 'coingecko', usdMicros: '150000000' }, { source: 'coinbase', usdMicros: '150000000' }]
  return { solUsdMicros: '150000000', sources, virtualQuote: launchVirtualQuote(150000000n) } })()

async function withDatabase(work, migrations = Object.keys(MIGRATIONS)) {
  const testConfig = process.env.HOOKLAB_REQUEST_TEST_SOCKET ? { host: process.env.HOOKLAB_REQUEST_TEST_SOCKET, port: 5432, user: process.env.USER, database: 'postgres' } : config
  const root = new pg.Pool(testConfig), name = `open_launch_${randomUUID().replaceAll('-', '')}`; let pool
  try {
    await root.query(`create database ${name}`); pool = new pg.Pool({ ...testConfig, database: name })
    await pool.query(productionSchema().sql)
    for (const migration of migrations) await pool.query(migrationSchema(migration).sql)
    if(!(await pool.query("select 1 from information_schema.columns where table_name='hook_lab_launch_requests' and column_name='hook_publication'")).rows.length)
      await pool.query(await readFile(new URL('../src/hooklab-selected-hook-setup-schema.sql',import.meta.url),'utf8'))
    if (!Object.hasOwn(MIGRATIONS, 'hook-catalog')) await pool.query(await readFile(new URL('../src/hooklab-hook-catalog-schema.sql',import.meta.url),'utf8'))
    await work(pool)
  } finally {
    await pool?.end()
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(r => setTimeout(r, 20)))
      if ((await root.query('select count(*)::int n from pg_stat_activity where datname=$1', [name])).rows[0].n === 0) break
    await root.query(`drop database if exists ${name} with (force)`); await root.end()
  }
}
const intent = (id, extra = {}) => ({ id, name: 'Open coin', symbol: 'OPEN', uri: `https://repo.ing/api/hook-lab/coins/${id}/metadata`, creatorFeeBps: 50, capBps: 500, ...extra })
async function publication(pool,selectedHook){
 const p=await hookCatalogStore(pool).publish(key('publisher'),{name:'Synthetic hook',version:randomUUID(),selectedHook,behavior:'Synthetic',fees:'Synthetic',risks:'Synthetic',manifest:taxHookSetupManifest(selectedHook)},{hookPin:{program:selectedHook.program,elfSha256:'b'.repeat(64)},authority:{kind:'immutable'}})
 return {digest:p.digest,manifest:p.manifest,configuration:{feeBps:'100',maxWalletBps:'0',collector:key('collector')}}
}

test('hook setup exact-message journal resumes after restart, refreshes only unsigned bytes and never sends twice',()=>withDatabase(async pool=>{
 // Synthetic server resolver only; real setup settlement is tested independently with both readers.
 const signer=Keypair.fromSeed(Buffer.alloc(32,71)),owner=signer.publicKey.toBase58(),operationId=randomUUID(),id=randomUUID(),now=Date.now()
 const token=Buffer.alloc(32,72).toString('base64url'),genesisHash=executionGenesis()
 await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[createHash('sha256').update(token).digest('hex'),owner,genesisHash])
 const request={schema:'synthetic-test-only',creator:owner,mint:key('setup-mint')},hash=value=>createHash('sha256').update(value).digest('hex')
 function review(blockhash){
  const message=new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),new TransactionInstruction({programId:new PublicKey(key('setup-program')),keys:[{pubkey:signer.publicKey,isWritable:true,isSigner:true}],data:Buffer.from([1])})]}).compileToV0Message()
  return {schema:'hooklab-message-review/1',operation:'selected-hook-setup',genesisHash,profileSha256:'a'.repeat(64),policySha256:'b'.repeat(64),intentSha256:hash(JSON.stringify(request)),payer:owner,wallet:owner,messageBase64:Buffer.from(message.serialize()).toString('base64'),messageSha256:hash(message.serialize()),requiredSigners:[owner],accounts:message.staticAccountKeys.map((k,i)=>({address:k.toBase58(),signer:message.isAccountSigner(i),writable:message.isAccountWritable(i)})),lookupTables:[],observedSlot:40,validUntilSlot:90,observedAtMs:now,reviewExpiresAtMs:now+60000,lastValidBlockHeight:150,baseFeeLamports:'5000',maxFeeLamports:'5000',instructionDebitLamports:'10000',maxNativeDebitLamports:'15000'}
 }
 let currentReview=review(key('setup-blockhash')),sends=0
 const result=()=>({status:'operator-pins-and-state-verified',owner,stage:'hook-setup',profileSha256:'a'.repeat(64),messageSha256:currentReview.messageSha256,configurationSha256:'c'.repeat(64),request,review:currentReview,settlementContext:{schema:'synthetic-test-only'}})
 const settings={enabled:true,origin:'https://repo.ing',stageOperations:{'hook-setup':'selected-hook-setup'},resolver:{prepare:async()=>result(),revalidate:async()=>result(),reconcile:async input=>({status:'finalized-success',signature:input.signature,messageSha256:input.review.messageSha256,profileSha256:input.review.profileSha256})},sender:{send:async input=>{sends++;return input.signature}}}
 let store=nativeSigningLifecycle(pool,settings)
 const original=await store.createReview(token,id,{custodyOperationId:operationId,stage:'hook-setup'})
 assert.deepEqual(await nativeSigningLifecycle(pool,settings).createReview(token,id,{custodyOperationId:operationId,stage:'hook-setup'}),original)
 currentReview=review(key('setup-next-blockhash'))
 const refreshed=await store.refreshReview(token,id);assert.notEqual(refreshed.messageSha256,original.messageSha256)
 const walletRequest=await store.walletRequest(token,id),tx=VersionedTransaction.deserialize(Buffer.from(walletRequest.partialTransactionBase64,'base64'));tx.sign([signer])
 await store.retainWalletSignature(token,id,Buffer.from(tx.serialize()).toString('base64'))
 await assert.rejects(store.refreshReview(token,id))
 store=nativeSigningLifecycle(pool,settings)
 assert.equal((await store.get(token,id)).status,'signed')
 await assert.rejects(store.createReview(token,randomUUID(),{custodyOperationId:operationId,stage:'hook-setup'}))
 assert.equal((await store.submitOnce(token,id)).status,'submitted')
 await assert.rejects(store.submitOnce(token,id));assert.equal(sends,1)
 assert.equal((await nativeSigningLifecycle(pool,settings).reconcile(token,id)).status,'finalized-success')
}))

test('selected hook coin survives HTTP handler restart with immutable intent and refuses reserve before signing', () => withDatabase(async pool => {
  const creator = key('selected-owner'), selectedHook = { program: key('selected-hook'), flags: 129 }, id = randomUUID()
  const hookPublication=await publication(pool,selectedHook)
  const token = Buffer.alloc(32, 61).toString('base64url'), genesisHash = executionGenesis()
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')", [createHash('sha256').update(token).digest('hex'), creator, genesisHash])
  const image = `data:image/png;base64,${(await sharp({ create: { width: 512, height: 512, channels: 3, background: '#81e6ad' } }).png().toBuffer()).toString('base64')}`
  const env = { HOOK_OPEN_LAUNCHES: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_NATIVE_LAUNCH_ENABLED: 'true' }
  const options = { env, configuration: () => ({ origin: 'https://repo.ing', audience: 'general-launcher', genesisHash }),
    database: () => ({ query: (...a) => pool.query(...a), connect: () => pool.connect(), end: async () => {} }),
    openCreation: async () => ({ native: true, open: true, paused: false, ...MENUS }), launchPriceEstimate: async () => null }
  const request = (body, path = 'launch-requests', cookie = token) => new Request(`https://repo.ing/api/hook-lab/${path}`, { method: 'POST',
    headers: { origin: 'https://repo.ing', 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${cookie}` }, body: JSON.stringify(body) })
  const economics = { quoteCut: { maxBuyBps: 80, maxSellBps: 40 }, authorShareBps: 1000, rules: { burnBuyBps: 20, burnSellBps: 30 } }
  const coin = { action: 'create', requestId: id, name: 'Custom coin', symbol: 'CSTM', image, description: '', x: '', website: '', telegram: '', creatorFeeBps: 0, capBps: 0, selectedHook,hookPublication,...economics }
  const first = await createLaunchRequestsHandler(options)(request(coin))
  assert.equal(first.status, 200, await first.clone().text())
  const stored = (await first.json()).request
  assert.deepEqual(stored.selectedHook, selectedHook); assert.equal(stored.capBps, 0); assert.equal(stored.status, 'queued')
  assert.equal(stored.creatorFeeBps, 0)
  assert.deepEqual(stored.hookPublication,hookPublication)
  for (const key of Object.keys(economics)) assert.deepEqual(stored[key], economics[key])
  assert.equal(stored.custodyOperationId, null)
  const recovered = await createLaunchRequestsHandler(options)(request({ action: 'get' }))
  assert.deepEqual((await recovered.json()).request, stored, 'fresh handler recovers the exact recorded coin')
  assert.equal((await createLaunchRequestsHandler(options)(request({ action: 'get' }, 'launch-requests', Buffer.alloc(32, 62).toString('base64url')))).status, 401)
  for (const change of [{ capBps: 100 }, { selectedHook: { ...selectedHook, flags: 256 } }, { selectedHook: undefined }, { quoteCut: { maxBuyBps: 0, maxSellBps: 40 } }, { authorShareBps: 5001 }, { rules: { burnBuyBps: -1, burnSellBps: 0 } }, { author: creator }]) {
    const response = await createLaunchRequestsHandler(options)(request({ ...coin, ...change, requestId: randomUUID() }))
    assert.equal(response.status, 400)
  }
  await assert.rejects(pool.query("update hook_lab_launch_requests set selected_hook=$2 where id=$1", [id, { ...selectedHook, flags: 1 }]), /immutable/i)
  await assert.rejects(pool.query("update hook_lab_launch_requests set hook_publication=$2 where id=$1", [id, {...hookPublication,configuration:{...hookPublication.configuration,feeBps:'101'}}]), /immutable/i)
  await assert.rejects(pool.query("update hook_lab_launch_requests set name='Other' where id=$1", [id]), /immutable/i)
  await assert.rejects(pool.query('update hook_lab_launch_requests set selected_economics=$2 where id=$1', [id, { ...economics, authorShareBps: 0 }]), /immutable/i)
  await assert.rejects(pool.query('update hook_lab_launch_requests set selected_economics=null where id=$1', [id]), /immutable/i)
  let reserved = 0
  const native = createNativeLaunchHandler({ ...options, runtime: () => ({ reserve: async () => { reserved++; throw Error('must not reserve') }, lifecycle: {} }) })
  const blocked = await native(request({ action: 'reserve', operationId: randomUUID(), capBps: 0, selectedHook, creatorFeeBps: 0,
    label: 'CSTM', name: stored.name, symbol: stored.symbol, uri: stored.uri, virtualQuote: '1000000000' }, 'native-launch'))
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).blockers[0].code, 'SELECTED_HOOK_REVIEW_UNAVAILABLE'); assert.equal(reserved, 0)
  assert.equal((await pool.query('select count(*)::int n from hook_lab_native_signer_custody')).rows[0].n, 0)
  assert.equal((await createLaunchRequestsHandler(options)(request({ action: 'cancel', requestId: id }))).status, 200)
  assert.equal((await ownerApprovalStore(pool, { openLaunches: true, usdPricing: true }).requestFor(creator)).status, 'cancelled')
}))

test('selected zero-fee migration preserves existing rows and every other database protection', () => withDatabase(async pool => {
  const selectedHook = { program: key('zero-fee-hook'), flags: 3 }
  const insert = (fee, extra = {}) => {
    const row = { id: randomUUID(), creator: key(randomUUID()), hook: selectedHook, cap: 0, source: 'open', status: 'queued', ...extra }
    return pool.query(`insert into hook_lab_launch_requests(id,creator_wallet,name,symbol,uri,creator_fee_bps,cap_bps,source,status,selected_hook)
      values($1,$2,'Fee test','FEE','',$3,$4,$5,$6,$7) returning *`, [row.id, row.creator, fee, row.cap, row.source, row.status, row.hook])
  }
  const feeConstraint = 'hook_lab_launch_requests_creator_fee_bps_check'
  const rejectedFee = { code: '23514', constraint: feeConstraint }
  await assert.rejects(insert(0), rejectedFee, 'the deployed schema rejects a selected zero fee')
  const existing = (await insert(100)).rows[0]
  const protections = async () => ({
    constraints: (await pool.query(`select conname,convalidated,pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid='hook_lab_launch_requests'::regclass and conname<>$1 order by conname`, [feeConstraint])).rows,
    columns: (await pool.query("select column_name,is_nullable from information_schema.columns where table_schema='public' and table_name='hook_lab_launch_requests' order by column_name")).rows,
    indexes: (await pool.query("select indexname,indexdef from pg_indexes where schemaname='public' and tablename='hook_lab_launch_requests' order by indexname")).rows,
    triggers: (await pool.query("select tgname,pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid='hook_lab_launch_requests'::regclass and not tgisinternal order by tgname")).rows,
  })
  const before = await protections(), migration = migrationSchema('selected-hook-zero-creator-fee')
  await pool.query(migration.sql)
  assert.deepEqual(await protections(), before)
  assert.deepEqual((await pool.query('select * from hook_lab_launch_requests where id=$1', [existing.id])).rows[0], existing)
  assert.equal((await pool.query(migration.inspect)).rows[0].convalidated, true)
  for (const fee of [0, 1, 9999]) assert.equal((await insert(fee)).rows[0].creator_fee_bps, fee)
  for (const fee of [-1, 10000]) await assert.rejects(insert(fee), rejectedFee)
  for (const source of ['open', 'owner-invite']) {
    const plain = { hook: null, cap: 100, source }
    for (const fee of [1, 9999]) assert.equal((await insert(fee, plain)).rows[0].creator_fee_bps, fee)
    for (const fee of [-1, 0, 10000]) await assert.rejects(insert(fee, plain), rejectedFee)
  }
  for (const hook of [selectedHook, null]) await assert.rejects(insert(null, { hook, cap: hook ? 0 : 100 }), { code: '23502', column: 'creator_fee_bps' })
  for (const extra of [{ cap: 1 }, { source: 'owner-invite' }, { hook: { ...selectedHook, flags: 256 } }, { hook: {} }, { hook: 'null' }])
    await assert.rejects(insert(0, extra), { code: '23514', constraint: 'hook_lab_launch_requests_hook_config_check' })
  await assert.rejects(insert(0, { status: 'declined' }), { code: '23514', constraint: 'hook_lab_launch_requests_selected_execution' })
  const zero = (await insert(0)).rows[0]
  await assert.rejects(pool.query('update hook_lab_launch_requests set creator_fee_bps=1 where id=$1', [zero.id]), /intent is immutable/)
  await assert.rejects(pool.query('update hook_lab_launch_requests set selected_hook=null,cap_bps=100 where id=$1', [zero.id]), /intent is immutable/)
  await pool.query("update hook_lab_launch_requests set status='cancelled' where id=$1", [zero.id])
  assert.equal((await pool.query('select creator_fee_bps from hook_lab_launch_requests where id=$1', [zero.id])).rows[0].creator_fee_bps, 0)
  await pool.query(migration.sql)
  assert.deepEqual(await protections(), before, 'reapplying the migration preserves the same protections')
  await assert.rejects(pool.query(`alter table hook_lab_launch_requests
    drop constraint hook_lab_launch_requests_creator_fee_bps_check,
    add constraint hook_lab_launch_requests_creator_fee_bps_check check (creator_fee_bps between 1 and 9999)`),
  rejectedFee, 'restoring the old check is unsafe once zero-fee requests exist, including cancelled requests')
  assert.equal((await insert(0)).rows[0].creator_fee_bps, 0, 'failed rollback leaves the valid new constraint intact')
  assert.equal((await pool.query(migration.inspect)).rows[0].convalidated, true)
}, Object.keys(MIGRATIONS).filter(name => !['selected-hook-zero-creator-fee', 'open-launch-burn'].includes(name))))   // the burn migration follows it

async function bind(pool, store, creator, operationId, { id, ...value }) {   // the request id is not part of what binds
  const db = await pool.connect()
  try { await db.query('begin'); const bound = await store.bindOpenLaunch(db, creator, operationId, value); await db.query('commit'); return bound }
  catch (error) { await db.query('rollback'); throw error } finally { db.release() }
}
// The finalized launch operation the signing lifecycle leaves behind (only the columns the listing reads matter).
async function launched(pool, store, operationId, creator, mint) {
  await pool.query(`insert into hook_lab_native_signing_operations(id,owner_wallet,custody_operation_id,stage,profile_sha256,review,message_sha256,partial_transaction,status,configuration_sha256,settlement_context,resolved_request)
    values($1,$2,$3,'launch','p','{}',$4,'','finalized-success',$5,'{}',$6)`, [randomUUID(), creator, operationId, 'b'.repeat(64), 'c'.repeat(64), JSON.stringify({ mint })])
  return store.markLaunched(operationId)
}

test('selected launch binds exact hook and retains its original price after interrupted preparation', () => withDatabase(async pool => {
  const creator=key('selected-binding'), id=randomUUID(), operationId=randomUUID(), selectedHook={program:key('selected-binding-hook'),flags:3}
  const hookPublication=await publication(pool,selectedHook)
  const economics={quoteCut:{maxBuyBps:80,maxSellBps:40},authorShareBps:1000,rules:{burnBuyBps:20,burnSellBps:30}}
  const value=intent(id,{creatorFeeBps:137,capBps:0,selectedHook,hookPublication,...economics}), settings={openLaunches:true,usdPricing:true,selectedHooksEnabled:true}
  let store=ownerApprovalStore(pool,settings)
  await store.createRequest(creator,value,profile,{source:'open',menus:MENUS})
  const bound=await bind(pool,store,creator,operationId,{...value,virtualQuote:pricing.virtualQuote,pricing})
  assert.equal(bound.status,'launching'); assert.deepEqual(bound.selectedHook,selectedHook)
  assert.equal(bound.creatorFeeBps,137)
  for (const key of Object.keys(economics)) assert.deepEqual(bound[key], economics[key])
  store=ownerApprovalStore(pool,settings)
  const nextPrice={solUsdMicros:'151000000',sources:pricing.sources.map(v=>({...v,usdMicros:'151000000'})),virtualQuote:launchVirtualQuote(151000000n)}
  const recovered=await bind(pool,store,creator,operationId,{...value,virtualQuote:nextPrice.virtualQuote,pricing:nextPrice})
  assert.equal(recovered.pricing.virtualQuote,pricing.virtualQuote)
  assert.equal(recovered.pricing.solUsdMicros,pricing.solUsdMicros)
  for (const key of Object.keys(economics)) assert.deepEqual(recovered[key], economics[key])
  for (const patch of [{quoteCut:undefined},{authorShareBps:0},{rules:'none'},{quoteCut:{maxBuyBps:81,maxSellBps:40}}])
    await assert.rejects(bind(pool,store,creator,operationId,{...value,...patch,virtualQuote:pricing.virtualQuote,pricing}), /economics differ/)
  for(const patch of [{selectedHook:{...selectedHook,flags:1}},{selectedHook:undefined},{capBps:100,selectedHook:undefined}])
    await assert.rejects(bind(pool,store,creator,operationId,{...value,...patch,virtualQuote:pricing.virtualQuote,pricing}))
  await assert.rejects(bind(pool,store,creator,operationId,{...value,hookPublication:{...hookPublication,configuration:{...hookPublication.configuration,feeBps:'102'}},virtualQuote:pricing.virtualQuote,pricing}))
  await assert.rejects(bind(pool,store,creator,randomUUID(),{...value,virtualQuote:pricing.virtualQuote,pricing}))
  assert.equal((await store.requestFor(creator)).custodyOperationId,operationId)
  // Exercise the strict reserve HTTP schema and its handoff to both the original
  // request binder and the runtime, with no signing or chain access.
  let reserves=0
  const handler=()=>createNativeLaunchHandler({env:{HOOK_OPEN_LAUNCHES:'true',HOOK_NATIVE_LAUNCH_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true'},
    configuration:()=>({origin:'https://repo.ing'}),database:()=>({connect:()=>pool.connect(),end:async()=>{}}),
    principalStore:()=>({resolve:async()=>({wallet:creator})}),quota:async()=>true,launchPrice:async()=>pricing,
    runtime:()=>({openLaunches:true,selectedHooksEnabled:true,openCreation:async()=>({native:true,open:true,paused:false,...MENUS,minVirtualQuote:'1',maxVirtualQuote:'18446744073709551615'}),
      reserve:async({input,owner})=>{reserves++;for(const key of Object.keys(economics))assert.deepEqual(input[key],economics[key]);return {owner,operationId,request:input}}})})
  const {id:_,...reserveValue}=value
  const reserve=patch=>handler()(new Request('https://repo.ing/api/hook-lab/native-launch',{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${Buffer.alloc(32,17).toString('base64url')}`},body:JSON.stringify({action:'reserve',operationId,label:'OPEN',...reserveValue,virtualQuote:pricing.virtualQuote,...patch})}))
  assert.equal((await reserve({})).status,200)
  assert.equal((await reserve({})).status,200,'handler restart retries the identical economics')
  for(const patch of [{quoteCut:undefined},{authorShareBps:0},{rules:'none'}])assert.equal((await reserve(patch)).status,409)
  for(const patch of [{quoteCut:{maxBuyBps:1001,maxSellBps:0}},{authorShareBps:5001},{rules:{burnBuyBps:0,burnSellBps:10001}},{configAuthor:key('other-author')}])assert.equal((await reserve(patch)).status,400)
  assert.equal(reserves,2,'changed intent never reaches runtime reservation')
}))

test('open requests: chain menus, no invite, many creators at once, the fixed price bound with the launch', { skip: process.env.HOOK_SKIP_DB === 'true' && 'database tests skipped' }, () => withDatabase(async pool => {
  const store = ownerApprovalStore(pool, { openLaunches: true, usdPricing: true }), [a, b] = [key('a'), key('b')]
  const ra = randomUUID(), rb = randomUUID()
  await assert.rejects(store.createRequest(a, intent(ra, { creatorFeeBps: 75 }), profile, { source: 'open', menus: MENUS }), /from the current list/)
  await assert.rejects(store.createRequest(a, intent(ra), profile, { source: 'open', menus: null }), /not open/)
  assert.equal((await store.createRequest(a, intent(ra), profile, { source: 'open', menus: MENUS })).status, 'queued')
  await store.createRequest(b, intent(rb, { creatorFeeBps: 200, capBps: 100 }), profile, { source: 'open', menus: MENUS })
  await assert.rejects(store.createRequest(a, intent(randomUUID()), profile, { source: 'open', menus: MENUS }), /already have an open launch request/)
  // Both creators launch at once (the one-at-a-time rule is for owner invites only).
  const [oa, ob] = [randomUUID(), randomUUID()]
  const bound = await bind(pool, store, a, oa, { ...intent(ra), virtualQuote: pricing.virtualQuote, pricing })
  assert.deepEqual([bound.status, bound.custodyOperationId, bound.pricing.virtualQuote], ['launching', oa, pricing.virtualQuote])
  assert.equal((await bind(pool, store, b, ob, { ...intent(rb, { creatorFeeBps: 200, capBps: 100 }), virtualQuote: pricing.virtualQuote, pricing })).status, 'launching')
  assert.equal((await bind(pool, store, a, oa, { ...intent(ra), virtualQuote: pricing.virtualQuote, pricing })).custodyOperationId, oa, 'the same launch binds again')
  await assert.rejects(bind(pool, store, a, randomUUID(), { ...intent(ra), virtualQuote: pricing.virtualQuote, pricing }), /already launching/)
  await assert.rejects(bind(pool, store, a, oa, { ...intent(ra, { name: 'Changed' }), virtualQuote: pricing.virtualQuote, pricing }), /differ/)
  await assert.rejects(bind(pool, store, a, oa, { ...intent(ra), virtualQuote: '1', pricing }), /opening price differs/)
  const stored = (await pool.query('select * from hook_lab_launch_request_prices where request_id=$1', [ra])).rows[0]
  assert.equal(String(stored.virtual_quote), pricing.virtualQuote, 'the price is stored with the launch')
  // An owner-invited request still keeps one invite at a time.
  assert.equal((await pool.query("select source from hook_lab_launch_requests where id=$1", [ra])).rows[0].source, 'open')
}))

test('a finalized open launch is listed; the owner delists it with a reason (append-only), and it stays findable for sell and claim', { skip: process.env.HOOK_SKIP_DB === 'true' && 'database tests skipped' }, () => withDatabase(async pool => {
  const store = ownerApprovalStore(pool, { openLaunches: true, usdPricing: true }), creator = key('creator'), mint = key('mint'), request = randomUUID(), operation = randomUUID()
  await store.createRequest(creator, intent(request), profile, { source: 'open', menus: MENUS })
  await bind(pool, store, creator, operation, { ...intent(request), virtualQuote: pricing.virtualQuote, pricing })
  assert.deepEqual(await store.launchedCoins(), [])
  assert.equal((await launched(pool, store, operation, creator, mint)).status, 'launched')
  assert.deepEqual((await store.launchedCoins()).map(c => c.mint), [mint], 'listed automatically once the launch finalized')
  // The listed records (what the coin page and the trade runtime are given) read under our own stack's profile, never the legacy one.
  const profiles = { legacy: { id: 'legacy' }, own: { id: 'own' } }
  assert.equal(stackProfileFor(profiles, await store.coinByMint(mint)), profiles.own, 'the coin page and its market read')
  assert.equal(stackProfileFor(profiles, (await store.launchedCoins())[0]), profiles.own, 'the discovery list')
  await assert.rejects(store.moderate({ mint, action: 'delist', reason: 'made-up', actor: 'owner' }), /delisting reasons/)
  await assert.rejects(store.moderate({ mint: key('nobody'), action: 'delist', reason: 'impersonation', actor: 'owner' }), /No coin launched/)
  const state = await store.moderate({ mint, action: 'delist', reason: 'impersonation', actor: 'owner' })
  assert.equal(state.delisted, true); assert.match(state.notice, /It pretends to be a person, project or brand/)
  await assert.rejects(store.moderate({ mint, action: 'delist', reason: 'impersonation', actor: 'owner' }), /already delisted/)
  assert.deepEqual(await store.launchedCoins(), [], 'gone from discovery')
  const coin = await store.coinByMint(mint)
  assert.equal(coin.moderation.delisted, true, 'the coin page still finds it, with the notice, so holders can sell and the creator can claim')
  assert.equal((await store.moderationByMint(mint)).delisted, true)
  await assert.rejects(pool.query("update hook_lab_coin_moderation set reason='other'"), /append-only/)
  assert.equal((await store.moderate({ mint, action: 'relist', actor: 'owner' })).delisted, false)
  assert.deepEqual((await store.launchedCoins()).map(c => c.mint), [mint])
  assert.equal((await pool.query('select count(*)::int n from hook_lab_coin_moderation')).rows[0].n, 2)
}))

// Burn (owner design 2026-10-27): one total fee split between the creator and a token burn. The chain's bounds as
// readOpenCreation reports them: creator at most 5%, burn and the combined fee at most 10%, Holders Earn not live.
const BURN_MENUS = { creatorFeeBps: [], continuousCreatorFee: true, maxCreatorFeeBps: 500, capBps: [100, 200, 300, 500], maxBurnBps: 1000, maxRulesFeeBps: 1000, maxHolderFeeBps: 1000 }
const burn = bps => ({ rules: { burnBuyBps: bps, burnSellBps: bps } })
test('a token burn: an open gate coin keeps its burn for good, within the chain bounds and only with Burn on; the launch binds the same burn', { skip: process.env.HOOK_SKIP_DB === 'true' && 'database tests skipped' }, () => withDatabase(async pool => {
  const off = ownerApprovalStore(pool, { openLaunches: true, usdPricing: true }), store = ownerApprovalStore(pool, { openLaunches: true, usdPricing: true, burnEnabled: true })
  const [a, b, c] = [key('burn-a'), key('burn-b'), key('burn-c')], [ra, rb, rc] = [randomUUID(), randomUUID(), randomUUID()]
  await assert.rejects(off.createRequest(a, intent(ra, { creatorFeeBps: 500, ...burn(500) }), profile, { source: 'open', menus: BURN_MENUS }), /Burn is not available/)
  await assert.rejects(store.createRequest(a, intent(ra, { creatorFeeBps: 600, ...burn(400) }), profile, { source: 'open', menus: BURN_MENUS }), /creator fee/)   // over the creator ceiling
  await assert.rejects(store.createRequest(a, intent(ra, { creatorFeeBps: 100, ...burn(700) }), profile, { source: 'open', menus: { ...BURN_MENUS, maxBurnBps: 500 } }), /burn can be at most 5%/)
  await assert.rejects(store.createRequest(a, intent(ra, { creatorFeeBps: 500, ...burn(500) }), profile, { source: 'open', menus: { ...BURN_MENUS, maxRulesFeeBps: 900 } }), /total fee can be at most 9%/)
  await assert.rejects(store.createRequest(a, intent(ra, { creatorFeeBps: 500, rules: { burnBuyBps: 500, burnSellBps: 400 } }), profile, { source: 'open', menus: BURN_MENUS }), /fee/)
  const created = await store.createRequest(a, intent(ra, { creatorFeeBps: 500, ...burn(500) }), profile, { source: 'open', menus: BURN_MENUS })
  assert.deepEqual([created.creatorFeeBps, created.rules], [500, { burnBuyBps: 500, burnSellBps: 500 }])
  // All burn and no creator fee, and a 0% total, are coins too.
  assert.equal((await store.createRequest(b, intent(rb, { creatorFeeBps: 0, ...burn(1000) }), profile, { source: 'open', menus: BURN_MENUS })).creatorFeeBps, 0)
  assert.equal((await store.createRequest(c, intent(rc, { creatorFeeBps: 0 }), profile, { source: 'open', menus: BURN_MENUS })).rules, undefined)
  assert.deepEqual((await store.requestFor(a)).rules, { burnBuyBps: 500, burnSellBps: 500 })
  // The burn is fixed: the database refuses any change, and a burn only on an open gate coin.
  await assert.rejects(pool.query('update hook_lab_launch_requests set burn_bps=100 where id=$1', [ra]), /burn is immutable/i)
  await assert.rejects(pool.query("update hook_lab_launch_requests set source='owner-invite' where id=$1", [rb]), { code: '23514' })
  // The launch must carry exactly the stored burn.
  const op = randomUUID(), value = { ...intent(ra, { creatorFeeBps: 500, ...burn(500) }), virtualQuote: pricing.virtualQuote, pricing }
  await assert.rejects(bind(pool, store, a, op, { ...value, ...burn(300) }), /differ/)
  await assert.rejects(bind(pool, store, a, op, { ...value, rules: undefined }), /differ/)
  await assert.rejects(bind(pool, off, a, op, value), /Burn is not available/)
  assert.equal((await bind(pool, store, a, op, value)).status, 'launching')
}))

test('the open-launch-burn migration adds a fixed burn column, keeps every row, and refuses a burn on any other coin', { skip: process.env.HOOK_SKIP_DB === 'true' && 'database tests skipped' }, () => withDatabase(async pool => {
  const insert = (fee, burnBps, source = 'open') => pool.query(`insert into hook_lab_launch_requests(id,creator_wallet,name,symbol,uri,creator_fee_bps,cap_bps,status,source,burn_bps)
    values($1,$2,'Coin','C','',$3,100,'queued',$4,$5) returning *`, [randomUUID(), key(randomUUID()), fee, source, burnBps])
  const old = (await pool.query(`insert into hook_lab_launch_requests(id,creator_wallet,name,symbol,uri,creator_fee_bps,cap_bps,status,source)
    values($1,$2,'Old','O','',100,100,'queued','open') returning *`, [randomUUID(), key('old')])).rows[0]
  await pool.query(migrationSchema('open-launch-burn').sql)
  assert.equal((await pool.query('select burn_bps from hook_lab_launch_requests where id=$1', [old.id])).rows[0].burn_bps, 0, 'an existing row keeps no burn')
  assert.equal((await insert(100, 300)).rows[0].burn_bps, 300)
  await assert.rejects(insert(100, 300, 'owner-invite'), { code: '23514' })
  await assert.rejects(insert(100, 1001), { code: '23514' })
  await assert.rejects(insert(500, 501), { code: '23514' }, 'creator 5% + burn 5.01% is over 10%')
  await assert.rejects(insert(0, 0, 'owner-invite'), { code: '23514' }, 'an invited coin still needs a creator fee')
  assert.ok((await pool.query(migrationSchema('open-launch-burn').inspect)).rows.length >= 2)
}, Object.keys(MIGRATIONS).filter(name => name !== 'open-launch-burn')))

test('the launch-requests API takes a gate coin\'s burn only with HOOK_BURN_ENABLED, and the form reads the chain\'s fee bounds', { skip: process.env.HOOK_SKIP_DB === 'true' && 'database tests skipped' }, () => withDatabase(async pool => {
  const creator = key('burn-http'), token = Buffer.alloc(32, 81).toString('base64url'), genesisHash = executionGenesis()
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')", [createHash('sha256').update(token).digest('hex'), creator, genesisHash])
  const image = `data:image/png;base64,${(await sharp({ create: { width: 512, height: 512, channels: 3, background: '#f97316' } }).png().toBuffer()).toString('base64')}`
  const options = burn => ({ env: { HOOK_OPEN_LAUNCHES: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_NATIVE_LAUNCH_ENABLED: 'true', ...(burn ? { HOOK_BURN_ENABLED: 'true' } : {}) },
    configuration: () => ({ origin: 'https://repo.ing', audience: 'general-launcher', genesisHash }),
    database: () => ({ query: (...a) => pool.query(...a), connect: () => pool.connect(), end: async () => {} }),
    openCreation: async () => ({ native: true, open: true, paused: false, ...BURN_MENUS }), launchPriceEstimate: async () => null })
  const post = (burnOn, body) => createLaunchRequestsHandler(options(burnOn))(new Request('https://repo.ing/api/hook-lab/launch-requests', { method: 'POST',
    headers: { origin: 'https://repo.ing', 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${token}` }, body: JSON.stringify(body) }))
  const coin = { action: 'create', requestId: randomUUID(), name: 'Burn coin', symbol: 'BURN', image, description: '', x: '', website: '', telegram: '', creatorFeeBps: 500, capBps: 200, ...burn(500) }
  const off = await post(false, coin)
  assert.equal(off.status, 409); assert.match((await off.json()).error, /Burn is not available/)
  for (const bad of [{ rules: { burnBuyBps: 500, burnSellBps: 400 } }, { rules: { burnBuyBps: 1001, burnSellBps: 1001 } }, { quoteCut: { maxBuyBps: 80, maxSellBps: 40 } }])
    assert.equal((await post(true, { ...coin, ...bad, requestId: randomUUID() })).status, 400, JSON.stringify(bad))
  const on = await post(true, coin)
  assert.equal(on.status, 200, await on.clone().text())
  assert.deepEqual((await on.json()).request.rules, { burnBuyBps: 500, burnSellBps: 500 })
  // GET: the form learns whether Burn is on and the chain's bounds for one total fee.
  for (const burnOn of [false, true]) {
    const shown = (await (await createLaunchRequestsHandler(options(burnOn))(new Request('https://repo.ing/api/hook-lab/launch-requests'))).json()).openCreation
    assert.deepEqual([shown.burnEnabled, shown.maxBurnBps, shown.maxRulesFeeBps, shown.maxHolderFeeBps], [burnOn, 1000, 1000, 1000])
  }
}))
