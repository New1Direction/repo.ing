// A trade review that was never sent closes as `expired` once its blockhash can no longer land, proven on both providers
// (src/hooklab-blockhash-proof.mjs provenFinalizedProgress, the F4 helper), through the real signing lifecycle wired as the
// trade runtime wires it (tradeLifecycleSettings) and PostgreSQL (127.0.0.1:55432, a scratch database), on the reviewed
// native ELFs. A sent trade never expires. Nothing is spent either way.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { nativeTradeResolver } from '../src/hooklab-native-trade-resolver.mjs'
import { tradeLifecycleSettings } from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
import { productionSchema, migrationSchema } from '../scripts/hooklab-production-schema.mjs'
import { nativeWorld, NATIVE_SKIP } from './fixtures/hooklab-native-world.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

const LIMITS = { maxAgeMs: 60000, maxSlotLag: 5, validUntilSlot: 0, reviewExpiresAtMs: 0, maxNetworkFeeLamports: '10000', maxTotalDebitLamports: '10000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' }
const ORIGIN = 'https://repo.ing', token = Buffer.alloc(32, 47).toString('base64url')

test('a never-sent trade review expires only once both providers prove its blockhash can no longer land; a sent one never does', { skip: NATIVE_SKIP, timeout: 300000 }, async t => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }, admin = new pg.Pool(config), database = `native_expire_${randomUUID().replaceAll('-', '')}`
  let pool, w
  t.after(async () => { await pool?.end().catch(() => {}); await dropTestDatabase(admin, database).catch(() => {}); await admin.end(); w?.close() })
  await admin.query(`create database ${database}`); pool = new pg.Pool({ ...config, database })
  await pool.query(productionSchema().sql); await pool.query(migrationSchema('wallet-funding').sql); await pool.query(migrationSchema('native-stages').sql)
  w = await nativeWorld({ capBps: 5000 })
  const { roles } = w, owner = roles.creator, wallet = w.walletKey('creator')
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,$3,'general-launcher',$4,clock_timestamp()+interval '30 minutes')",
    [createHash('sha256').update(token).digest('hex'), owner, ORIGIN, JSON.parse(w.state.profile.json).genesisHash])
  const native = nativeTradeResolver({ ...w.bindings, connections: w.connections(), limits: { ...LIMITS, nowMs: Date.now() } })
  // The chain as both providers report it for the expiry proof: the first names its latest finalized blockhash and
  // lifetime, the second its block at that slot (agree: false makes the second answer with another block).
  const chain = { slot: 100, height: 100, agree: true }
  const progress = w.connections().map((c, i) => ({ ...c, connection: { ...c.connection,
    getLatestBlockhashAndContext: async () => ({ context: { slot: chain.slot }, value: { blockhash: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', lastValidBlockHeight: chain.height + 150 } }),
    getBlock: async slot => slot !== chain.slot ? null : { blockhash: chain.agree || i === 0 ? '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' : 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', blockHeight: chain.height } } }))
  const lifecycle = nativeSigningLifecycle(pool, { enabled: true, origin: ORIGIN, custodyAdapter: null,
    sender: { send: async ({ signedTransactionBase64 }) => (await w.submit(signedTransactionBase64)).signature },
    ...tradeLifecycleSettings({ trade: {}, funding: {}, native, nativeOpen: true, connections: progress }) })
  const intent = async amount => ({ side: 'buy', creatorFeeBps: 100, capBps: 5000, mint: roles.mint, selectedConfig: roles.config, amountIn: String(amount),
    minAmountOut: await w.minimumOut('buy', amount, owner), maxInput: String(amount), maxPriceImpactBps: 1000, graduate: false })
  async function signed(amount) {
    const id = randomUUID(); await lifecycle.createReview(token, id, { custodyOperationId: id, stage: 'native-buy', intent: await intent(amount) })
    const request = await lifecycle.walletRequest(token, id), tx = VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64, 'base64')); tx.sign([wallet])
    assert.equal((await lifecycle.retainWalletSignature(token, id, Buffer.from(tx.serialize()).toString('base64'))).status, 'signed')
    return id
  }
  const past = op => { chain.slot = op.review.validUntilSlot + 1; chain.height = op.review.lastValidBlockHeight + 1 }
  const row = async id => (await pool.query('select status,signature,expired_evidence from hook_lab_native_signing_operations where id=$1', [id])).rows[0]

  await t.test('a signed, never-sent review: refused while its blockhash can still land, or when the second provider disagrees; then expired', async () => {
    const id = await signed(1000003), op = await lifecycle.get(token, id)
    await assert.rejects(lifecycle.expire(token, id), 'the chain has not passed its lifetime')
    chain.slot = op.review.validUntilSlot + 1; chain.height = op.review.lastValidBlockHeight
    await assert.rejects(lifecycle.expire(token, id), 'the last valid height itself is not past')
    past(op); chain.agree = false
    await assert.rejects(lifecycle.expire(token, id), 'one provider alone proves nothing')
    assert.equal((await row(id)).status, 'signed')
    chain.agree = true
    const expired = await lifecycle.expire(token, id)
    assert.equal(expired.status, 'expired'); assert.equal(expired.signature, null)
    const stored = await row(id)
    assert.equal(stored.status, 'expired'); assert.equal(stored.expired_evidence.blockHeight, op.review.lastValidBlockHeight + 1); assert.equal(stored.expired_evidence.lastValidBlockHeight, op.review.lastValidBlockHeight)
    await assert.rejects(lifecycle.submitOnce(token, id), 'an expired operation is never sent')
  })
  await t.test('a reviewed, never-signed review expires the same way', async () => {
    const id = randomUUID(); await lifecycle.createReview(token, id, { custodyOperationId: id, stage: 'native-buy', intent: await intent(2000003) })
    chain.slot = 100; chain.height = 100
    await assert.rejects(lifecycle.expire(token, id))
    past(await lifecycle.get(token, id)); assert.equal((await lifecycle.expire(token, id)).status, 'expired')
  })
  await t.test('a sent trade never expires, even with the chain past its lifetime', async () => {
    chain.slot = 100; chain.height = 100
    const id = await signed(3000003)
    assert.equal((await lifecycle.submitOnce(token, id)).status, 'submitted')
    past(await lifecycle.get(token, id))
    await assert.rejects(lifecycle.expire(token, id))
    assert.equal((await row(id)).status, 'submitted'); assert.notEqual((await row(id)).signature, null)
    assert.equal((await lifecycle.reconcile(token, id)).status, 'finalized-success', 'and it settles')
  })
})
