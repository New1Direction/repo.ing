// Open (self-serve) launch records on the production schema with every migration: the creator's own request chooses from
// the chain's menus, many creators may launch at once, the launch binds the price repo.ing fixed, a finalized launch is
// listed, and the owner's delisting (append-only, a placeholder reason) leaves discovery while the coin stays findable for
// selling and claims. A disposable database only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { ownerApprovalStore } from '../src/hooklab-owner-approval.mjs'
import { MIGRATIONS, migrationSchema, productionSchema } from '../scripts/hooklab-production-schema.mjs'
import { launchVirtualQuote } from '../src/hooklab-launch-pricing.mjs'
import { stackProfileFor } from '../app/lib/hooklab-inclusive-trade-runtime.mjs'

const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
const key = label => Keypair.fromSeed(createHash('sha256').update(`OPEN LAUNCH DB TEST ONLY ${label}`).digest()).publicKey.toBase58()
const MENUS = { creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }
const IMAGE = 'data:image/png;base64,iVBORw0KGgo='
const profile = { image: IMAGE, description: 'A test coin.', x: '', website: '', telegram: '' }
// Two agreeing sources at $150: the price the server fixes at reserve.
const pricing = (() => { const sources = [{ source: 'coingecko', usdMicros: '150000000' }, { source: 'coinbase', usdMicros: '150000000' }]
  return { solUsdMicros: '150000000', sources, virtualQuote: launchVirtualQuote(150000000n) } })()

async function withDatabase(work) {
  const root = new pg.Pool(config), name = `open_launch_${randomUUID().replaceAll('-', '')}`; let pool
  try {
    await root.query(`create database ${name}`); pool = new pg.Pool({ ...config, database: name })
    await pool.query(productionSchema().sql)
    for (const migration of Object.keys(MIGRATIONS)) await pool.query(migrationSchema(migration).sql)
    await work(pool)
  } finally {
    await pool?.end()
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(r => setTimeout(r, 20)))
      if ((await root.query('select count(*)::int n from pg_stat_activity where datname=$1', [name])).rows[0].n === 0) break
    await root.query(`drop database if exists ${name} with (force)`); await root.end()
  }
}
const intent = (id, extra = {}) => ({ id, name: 'Open coin', symbol: 'OPEN', uri: `https://repo.ing/api/hook-lab/coins/${id}/metadata`, creatorFeeBps: 50, capBps: 500, ...extra })
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
  await assert.rejects(store.moderate({ mint: key('nobody'), action: 'delist', reason: 'placeholder-content-rules', actor: 'owner' }), /No coin launched/)
  const state = await store.moderate({ mint, action: 'delist', reason: 'placeholder-content-rules', actor: 'owner' })
  assert.equal(state.delisted, true); assert.match(state.notice, /PLACEHOLDER/)
  await assert.rejects(store.moderate({ mint, action: 'delist', reason: 'placeholder-content-rules', actor: 'owner' }), /already delisted/)
  assert.deepEqual(await store.launchedCoins(), [], 'gone from discovery')
  const coin = await store.coinByMint(mint)
  assert.equal(coin.moderation.delisted, true, 'the coin page still finds it, with the notice, so holders can sell and the creator can claim')
  assert.equal((await store.moderationByMint(mint)).delisted, true)
  await assert.rejects(pool.query("update hook_lab_coin_moderation set reason='other'"), /append-only/)
  assert.equal((await store.moderate({ mint, action: 'relist', actor: 'owner' })).delisted, false)
  assert.deepEqual((await store.launchedCoins()).map(c => c.mint), [mint])
  assert.equal((await pool.query('select count(*)::int n from hook_lab_coin_moderation')).rows[0].n, 2)
}))
