import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { chartBlockEvidence, verifyChartBlock, createChartOrdering } from '../src/chart-ordering.mjs'

const encode=(size,n)=>bs58.encode(new Uint8Array(size).fill(n))
const a=encode(64,1),b=encode(64,2)
const block={blockhash:encode(32,1),previousBlockhash:encode(32,2),parentSlot:99,signatures:[b,a]}
const rpc=(endpoint,changes={})=>({rpcEndpoint:endpoint,getGenesisHash:async()=>'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  getBlockSignatures:async(slot,commitment)=>{assert.equal(slot,100);assert.equal(commitment,'finalized');return structuredClone(block)},...changes})

test('two finalized RPCs agree on exact block order, not alphabetical order',async()=>{
  const proof=await verifyChartBlock({connection:rpc('primary'),verification:rpc('secondary'),slot:100,signatures:[a,b]})
  assert.deepEqual(proof.signatures,[b,a]);assert.equal(proof.parentSlot,99)
})
test('wrong network, missing independent verifier, null block and RPC disagreement fail closed',async()=>{
  const input={connection:rpc('primary'),verification:rpc('secondary'),slot:100,signatures:[a,b]}
  await assert.rejects(verifyChartBlock({...input,verification:null}),/VERIFICATION_REQUIRED/)
  await assert.rejects(verifyChartBlock({...input,verification:rpc('primary')}),/VERIFICATION_REQUIRED/)
  await assert.rejects(verifyChartBlock({...input,verification:rpc('secondary',{getGenesisHash:async()=>'devnet'})}),/NETWORK_MISMATCH/)
  await assert.rejects(verifyChartBlock({...input,verification:rpc('secondary',{getBlockSignatures:async()=>null})}),/BLOCK_INVALID/)
  await assert.rejects(verifyChartBlock({...input,verification:rpc('secondary',{getBlockSignatures:async()=>({...block,signatures:[a,b]})})}),/RPC_DISAGREEMENT/)
})
test('reject malformed block identity, duplicate or absent trade signatures',()=>{
  assert.throws(()=>chartBlockEvidence(100,{...block,parentSlot:100},[a]),/INVALID/)
  assert.throws(()=>chartBlockEvidence(100,{...block,blockhash:'bad'},[a]),/INVALID/)
  assert.throws(()=>chartBlockEvidence(100,{...block,signatures:[a,a]},[a]),/DUPLICATE/)
  assert.throws(()=>chartBlockEvidence(100,block,[encode(64,3)]),/MISSING/)
})
test('RPC failures retain a pending slot, back off and recover without recording fabricated evidence',async()=>{
  let clock=0,calls=0,stored=null,released=0,unavailable=true
  const db={query:async(sql,values)=>{
    if(sql.includes('pg_try'))return {rows:[{locked:true}]}
    if(sql.includes('pg_advisory_unlock'))return {rows:[]}
    if(sql.includes('from trade_events'))return {rows:stored?[]:[{slot:'100',signatures:[a,b]}]}
    if(sql.startsWith('insert')){stored={slot:values[0],blockhash:values[1],previous_blockhash:values[2],parent_slot:values[3],signatures:values[4]};return {rows:[]}}
    return {rows:[stored]}
  },release:()=>{released++}}
  const worker=createChartOrdering({pool:{connect:async()=>db},now:()=>clock,connection:rpc('primary',{getBlockSignatures:async()=>{calls++;if(unavailable)throw Error('private RPC URL');return block}}),verification:rpc('secondary')})
  const first=await worker.runOnce();assert.equal(first.pending,1);assert.equal(first.errors[0].code,'CHART_RPC_UNAVAILABLE');assert.equal(stored,null)
  await worker.runOnce();assert.equal(calls,1)
  clock=600001;unavailable=false
  assert.equal((await worker.runOnce()).verified,1);assert.equal(calls,2);assert.equal(released,3)
})

test('real PostgreSQL: a used-up block list is cleared after seven days, and restored when a later trade needs it', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const { default: pg } = await import('pg')
  const { pruneChartBlocks, recordChartBlock } = await import('../src/chart-ordering.mjs')
  const url = new URL(process.env.CHART_TEST_DATABASE_URL)
  assert.equal(url.port, '55441', 'Use the dedicated chart test DB, never the production tunnel')
  const db = new pg.Client({ connectionString: url.href }); await db.connect()
  try {
    await db.query('begin')
    for (const table of ['trade_events', 'damm_trade_events', 'stock_trade_events']) await db.query(`create temporary table ${table}(slot bigint, signature text)`)
    await db.query(`create temporary table finalized_chart_blocks(slot bigint primary key, blockhash text, previous_blockhash text, parent_slot bigint,
      signatures text[] not null, checked_at timestamptz default now() not null)`)
    await db.query('create temporary table finalized_chart_positions(slot bigint, signature text, transaction_index integer, primary key(slot, signature))')
    const sig = n => encode(64, n), hash = n => encode(32, n)
    const others = Array.from({ length: 20 }, (_, i) => sig(100 + i)) // the rest of the block: why a list is worth clearing
    const list100 = [others[0], sig(1), sig(5), ...others.slice(1), sig(2)]
    const block = async (slot, signatures, ageDays) => db.query(`insert into finalized_chart_blocks values($1,$2,$3,$4,$5, now() - make_interval(days => $6))`,
      [slot, hash(slot % 250), hash((slot + 1) % 250), slot - 1, signatures, ageDays])
    const trade = (table, slot, signature) => db.query(`insert into ${table} values($1,$2)`, [slot, signature])
    const position = (slot, signature, index) => db.query('insert into finalized_chart_positions values($1,$2,$3)', [slot, signature, index])
    const stored = async slot => (await db.query('select cardinality(signatures) as n from finalized_chart_blocks where slot=$1', [slot])).rows[0].n
    // 100: old, both indexed trades positioned (a curve swap and a DAMM swap). 200: old, one trade still without a position.
    // 250: positioned but only a day old.
    await block(100, list100, 8); await trade('trade_events', 100, sig(1)); await trade('damm_trade_events', 100, sig(2))
    await position(100, sig(1), 2); await position(100, sig(2), list100.length)
    await block(200, [sig(3), sig(4), ...others], 8); await trade('trade_events', 200, sig(3)); await trade('stock_trade_events', 200, sig(4))
    await position(200, sig(3), 1)
    await block(250, [sig(6), sig(7), ...others], 1); await trade('trade_events', 250, sig(6)); await trade('trade_events', 250, sig(7))
    await position(250, sig(6), 1); await position(250, sig(7), 2)
    assert.equal(await pruneChartBlocks(db), 1)
    assert.deepEqual([await stored(100), await stored(200), await stored(250)], [0, 22, 22])
    assert.equal(await pruneChartBlocks(db), 0, 'already cleared, and the others still need theirs')
    // A limit never lets a block that must keep its list hold up one that can be cleared.
    await db.query("update finalized_chart_blocks set checked_at = now() - interval '8 days' where slot = 250")
    assert.equal(await pruneChartBlocks(db, { limit: 1 }), 1)
    assert.equal(await stored(250), 0)
    // A swap at slot 100 indexed only now: the fresh proof of the same block restores the list and positions it.
    await trade('damm_trade_events', 100, sig(5))
    await recordChartBlock(db, { slot: 100, blockhash: hash(100), previousBlockhash: hash(101), parentSlot: 99, signatures: list100 })
    assert.equal(await stored(100), list100.length)
    assert.equal((await db.query('select transaction_index from finalized_chart_positions where slot=100 and signature=$1', [sig(5)])).rows[0].transaction_index, 3)
    // A different block at that slot is still a conflict, cleared list or not.
    await db.query("update finalized_chart_blocks set signatures = '{}' where slot = 100")
    await assert.rejects(recordChartBlock(db, { slot: 100, blockhash: hash(9), previousBlockhash: hash(101), parentSlot: 99, signatures: list100 }), /CHART_EVIDENCE_CONFLICT/)
  } finally { await db.query('rollback'); await db.end() }
})
