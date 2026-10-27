// An open launch request stuck in 'launching' (owner 2026-10-27: two smoke wallets were locked out for good). After its
// day, a request whose launch provably never landed and never can is closed as 'invite-expired', so the creator can start
// another coin; one whose coin exists is marked launched; anything sent, unknown or unproven is left alone.
// Synthetic keys and a disposable database only. No RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { ownerApprovalStore } from '../src/hooklab-owner-approval.mjs'
import { MIGRATIONS, migrationSchema, productionSchema } from '../scripts/hooklab-production-schema.mjs'

const key = label => Keypair.fromSeed(createHash('sha256').update(`STALE LAUNCH DB TEST ONLY ${label}`).digest()).publicKey.toBase58()
const admin = key('admin')
const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
const MENUS = { creatorFeeBps: [50, 100, 200], maxCreatorFeeBps: 200, capBps: [100, 200, 300, 500] }
const intent = id => ({ id, name: 'Open coin', symbol: 'OPEN', uri: `https://repo.ing/api/hook-lab/coins/${id}/metadata`, creatorFeeBps: 50, capBps: 500 })

async function withDatabase(work) {
  const root = new pg.Pool(config), name = `stale_launch_${randomUUID().replaceAll('-', '')}`; let pool
  try {
    await root.query(`create database ${name}`); pool = new pg.Pool({ ...config, database: name })
    await pool.query(productionSchema().sql)
    for (const migration of Object.keys(MIGRATIONS)) await pool.query(migrationSchema(migration).sql)
    await work(pool)
  } finally { await pool?.end(); await closed(root, name); await root.query(`drop database if exists ${name} with (force)`); await root.end() }
}
async function closed(root, name) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 20))) {
    if ((await root.query('select count(*)::int n from pg_stat_activity where datname=$1', [name])).rows[0].n === 0) return
  }
  throw Error(`connections to ${name} are still open after the pool ended`)
}

// A creator whose open request was bound to a launch: the request, its custody (mint) and its signing operations.
async function stuck(pool, label, { expired = true, operations = [] } = {}) {
  const creator = key(label), id = randomUUID(), operation = randomUUID(), mint = key(`${label} mint`)
  await pool.query(`insert into hook_lab_launch_requests(id,creator_wallet,name,symbol,uri,creator_fee_bps,cap_bps,status,source,custody_operation_id,invited_at,invite_expires_at)
    values($1,$2,'Open coin','OPEN',$3,50,500,'launching','open',$4,clock_timestamp()-interval '2 days',clock_timestamp()+($5::text)::interval)`,
  [id, creator, `https://repo.ing/api/hook-lab/coins/${id}/metadata`, operation, expired ? '-1 hour' : '1 hour'])
  await pool.query(`insert into hook_lab_native_signer_custody(operation_id,custody_session_id,owner_wallet,profile_sha256,mint,selected_config,stage,sealed_signers)
    values($1,$2,$3,$4,$5,$6,'launch-reviewed','{"keyId":"test"}')`, [operation, randomUUID(), creator, 'a'.repeat(64), mint, key(`${label} config`)])
  for (const [stage, status, signature = null] of operations) {
    await pool.query(`insert into hook_lab_native_signing_operations(id,owner_wallet,custody_operation_id,stage,profile_sha256,review,message_sha256,partial_transaction,status,signature,configuration_sha256,settlement_context,expired_evidence)
      values($1,$2,$3,$4,$5,$6,$7,'AA==',$8,$9,$10,'{}',$11)`, [randomUUID(), creator, operation, stage, 'a'.repeat(64),
      { validUntilSlot: 1_000, lastValidBlockHeight: 2_000 }, 'b'.repeat(64), status, signature, 'c'.repeat(64),
      status === 'expired' ? { blockHeight: 2_001, slot: 1_001 } : null])
  }
  return { creator, id, mint }
}
const status = async (pool, id) => (await pool.query('select status from hook_lab_launch_requests where id=$1', [id])).rows[0].status
// Both providers' finalized progress past every deadline, and whether each holds the coin's mint.
const chain = (mintExists, { slot = 5_000, blockHeight = 6_000 } = {}) => async () => ({ slot, blockHeight, mintExists })

test('an expired open launch that never landed is closed, and its creator can start a new coin', () => withDatabase(async pool => {
  const never = await stuck(pool, 'never', { operations: [['preparation', 'finalized-success', 'sig-prep'], ['launch', 'partial']] })
  const blind = ownerApprovalStore(pool, { adminAddress: admin, openLaunches: true })
  await assert.rejects(blind.createRequest(never.creator, intent(randomUUID()), null, { source: 'open', menus: MENUS }), /already have an open launch request/,
    'without a chain observer nothing is proven, so the request stays')
  // With the chain observer, creating a new coin settles the stale request first.
  const store = ownerApprovalStore(pool, { adminAddress: admin, openLaunches: true, launchObserver: chain([false, false]) })
  const created = await store.createRequest(never.creator, intent(randomUUID()), null, { source: 'open', menus: MENUS })
  assert.equal(created.status, 'queued')
  assert.equal(await status(pool, never.id), 'invite-expired')
}))

test('an expired open launch whose coin exists on both providers is marked launched', () => withDatabase(async pool => {
  const landed = await stuck(pool, 'landed', { operations: [['launch', 'partial']] })
  const store = ownerApprovalStore(pool, { adminAddress: admin, openLaunches: true, launchObserver: chain([true, true]) })
  assert.deepEqual(await store.settleStaleLaunches({ creator: landed.creator }), { expired: 0, launched: 1 })
  assert.equal(await status(pool, landed.id), 'launched')
}))

test('a stale launch is left alone unless every proof holds', () => withDatabase(async pool => {
  const cases = [
    ['fresh', { expired: false }, chain([false, false])],
    ['disagree', {}, chain([true, false])],
    ['unreachable', {}, async () => { throw Error('provider down') }],
    ['submitted', { operations: [['launch', 'submitted', 'sig-1']] }, chain([false, false])],
    ['unknown', { operations: [['launch', 'outcome-unknown', 'sig-2']] }, chain([false, false])],
    ['claimed', { operations: [['launch', 'submission-claimed', 'sig-3']] }, chain([false, false])],
    ['reconcile', { operations: [['launch', 'review-required', 'sig-4']] }, chain([false, false])],
    ['live', { operations: [['launch', 'signed']] }, chain([false, false], { slot: 900, blockHeight: 1_900 })],
  ]
  for (const [label, setup, observer] of cases) {
    const row = await stuck(pool, label, setup)
    const store = ownerApprovalStore(pool, { adminAddress: admin, openLaunches: true, launchObserver: observer })
    assert.deepEqual(await store.settleStaleLaunches({ creator: row.creator }), { expired: 0, launched: 0 }, label)
    assert.equal(await status(pool, row.id), 'launching', label)
  }
}))

test('a finalized launch operation marks the request launched without asking the chain', () => withDatabase(async pool => {
  const done = await stuck(pool, 'done', { operations: [['launch', 'finalized-success', 'sig-5']] })
  const store = ownerApprovalStore(pool, { adminAddress: admin, openLaunches: true, launchObserver: async () => { throw Error('not needed') } })
  assert.deepEqual(await store.settleStaleLaunches(), { expired: 0, launched: 1 })
  assert.equal(await status(pool, done.id), 'launched')
}))

test('a launch reviewed again while the chain is being read keeps the request', () => withDatabase(async pool => {
  const racing = await stuck(pool, 'racing', { operations: [['launch', 'expired']] })
  const { rows: [{ custody_operation_id: operation }] } = await pool.query('select custody_operation_id from hook_lab_launch_requests where id=$1', [racing.id])
  let inserted = false
  const observer = async () => {
    // A fresh launch review, valid well past the progress the observer then reports.
    await pool.query(`insert into hook_lab_native_signing_operations(id,owner_wallet,custody_operation_id,stage,profile_sha256,review,message_sha256,partial_transaction,status,configuration_sha256,settlement_context)
      values($1,$2,$3,'launch',$4,$5,$6,'AA==','partial',$7,'{}')`, [randomUUID(), racing.creator, operation, 'a'.repeat(64),
      { validUntilSlot: 9_000, lastValidBlockHeight: 9_500 }, 'd'.repeat(64), 'c'.repeat(64)])
    inserted = true
    return chain([false, false])()
  }
  const store = ownerApprovalStore(pool, { adminAddress: admin, openLaunches: true, launchObserver: observer })
  assert.deepEqual(await store.settleStaleLaunches({ creator: racing.creator }), { expired: 0, launched: 0 })
  assert.ok(inserted, 'the racing review was really written')
  assert.equal(await status(pool, racing.id), 'launching')
}))
