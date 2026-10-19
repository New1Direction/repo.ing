// The website's own launch runtime on our own stack, end to end: a disposable PostgreSQL with the production schema and
// every migration, the real runtime (custody with the sealed mint key, the signing lifecycle, the collectors, the sender)
// under our stack's production bundle, and an isolated SBF bank as the chain (tests/fixtures/hooklab-own-stack-world.mjs).
// Fresh wallets each sign in, reserve, and run the one guided step: preparation, then launch, each signed in the wallet
// and co-signed only by the custody keys (the mint and the selected config). No owner agent, no admin key, no invite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'
import { createNativeLaunchRuntime } from '../src/hooklab-native-launch-runtime.mjs'
import { readHookCoinMarket } from '../src/hooklab-coin-market.mjs'
import { MIGRATIONS, migrationSchema, productionSchema } from '../scripts/hooklab-production-schema.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { ownStackWorld, PREP_LIMITS, launchLimitsFor, CREATION_FEE_LAMPORTS } from './fixtures/hooklab-own-stack-world.mjs'
import { OWN_STACK_SKIP } from './fixtures/hooklab-own-stack.mjs'

const skip = process.env.HOOK_SKIP_DB === 'true' ? 'database tests skipped' : OWN_STACK_SKIP
  || (process.env.HOOKLAB_CANARY_REQUIRED !== 'true' && !process.env.HOOKLAB_CANARY_PYTHONPATH && 'the isolated SVM runner (HOOKLAB_CANARY_PYTHONPATH) is not available')
const sha = value => createHash('sha256').update(value).digest('hex')
const PG = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }

test('fresh wallets launch on our own stack through the website\'s launch runtime: reserve, one guided step, live', { skip, timeout: 600000 }, async t => {
  const w = await ownStackWorld(), admin = new pg.Pool(PG), database = `own_stack_${randomUUID().replaceAll('-', '')}`, oldFetch = globalThis.fetch
  let pool
  t.after(async () => { globalThis.fetch = oldFetch; await pool?.end(); await dropTestDatabase(admin, database); await admin.end(); w.close() })
  await admin.query(`create database ${database}`); pool = new pg.Pool({ ...PG, database })
  await pool.query(productionSchema().sql)
  for (const migration of Object.keys(MIGRATIONS)) await pool.query(migrationSchema(migration).sql)
  // The sender's one sendTransaction goes to the bank, exactly as signed.
  const sends = []
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.method, 'sendTransaction'); assert.equal(url, w.connections()[0].connection.rpcEndpoint)
    const sent = await w.submit(body.params[0]); sends.push(sent)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: sent.signature }), { status: 200 })
  }
  // The local acceptance scope the world entered fixes the site origin (as production fixes https://repo.ing).
  const profile = JSON.parse(w.bindings.profile.json), now = Date.now(), origin = process.env.HOOK_WALLET_IDENTITY_ORIGIN
  const timing = { nowMs: now, maxAgeMs: 60000, validUntilSlot: 196, reviewExpiresAtMs: now + 60000 }
  const runtime = createNativeLaunchRuntime(pool, { enabled: true, origin, ownerCustodyApproved: true, operatorDeploymentApproved: true, economicsApproved: true,
    ...w.bindings, connections: w.connections(), keyRing: { test: Buffer.alloc(32, 61) }, activeKeyId: 'test', openLaunches: true, nativeLaunches: true,
    expiryObserver: async () => ({ slot: 1, blockHeight: 1 }), reviewTiming: async () => ({ nowMs: Date.now(), validUntilSlot: 196, reviewExpiresAtMs: Date.now() + 60000 }),
    preparationLimits: { ...PREP_LIMITS, ...timing }, launchLimits: { ...await launchLimitsFor(w), ...timing } })
  assert.equal(runtime.openLaunches, true)
  const chain = await runtime.openCreation()
  assert.equal(chain.open, true); assert.equal(chain.launchFeeLamports, String(CREATION_FEE_LAMPORTS))

  for (const [i, [creatorFeeBps, capBps]] of [[50, 100], [100, 200], [200, 300], [100, 500]].entries()) {
    const wallet = Keypair.generate(), owner = wallet.publicKey.toBase58(), token = Buffer.alloc(32, 70 + i).toString('base64url')
    await w.fund(owner, '1000000000')
    await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,$3,'general-launcher',$4,clock_timestamp()+interval '30 minutes')",
      [sha(token), owner, origin, profile.genesisHash])
    const operationId = randomUUID()
    const reserved = await runtime.reserve({ sessionToken: token, owner, input: { operationId, capBps, label: `own${i + 1}`, name: `Own runtime ${i + 1}`, symbol: `OWNR${i + 1}`, uri: '',
      virtualQuote: '53251917070', creatorFeeBps } })
    assert.equal(reserved.request.schema, 'repoing/open-launch-request/1'); assert.equal(reserved.request.reviewer, undefined, 'no reviewer, no invite')
    for (const stage of ['preparation', 'launch']) {
      const id = randomUUID(), review = await runtime.lifecycle.createReview(token, id, { custodyOperationId: operationId, stage })
      assert.equal(review.status, 'reviewed')
      const request = await runtime.lifecycle.walletRequest(token, id), tx = VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64, 'base64'))
      tx.sign([wallet]); await runtime.lifecycle.retainWalletSignature(token, id, Buffer.from(tx.serialize()).toString('base64'))
      // The custody co-signs with the sealed keys it holds (the mint; the selected config at preparation): never an admin.
      const others = request.review.requiredSigners.filter(k => k !== owner)
      assert.ok(others.every(k => [reserved.mint, reserved.selectedConfig].includes(k)), `only custody keys co-sign ${stage}`)
      for (const signer of others) await runtime.lifecycle.coSignNext(token, id, signer)
      assert.equal((await runtime.lifecycle.submitOnce(token, id)).status, 'submitted')
      assert.equal(sends.at(-1).error, null, (sends.at(-1).logs ?? []).slice(-6).join('\n'))
      assert.equal((await runtime.lifecycle.reconcile(token, id)).status, 'finalized-success', `${stage} ${i + 1} settles`)
    }
    const { rows: [custody] } = await pool.query('select stage, mint from hook_lab_native_signer_custody where operation_id=$1', [operationId])
    assert.deepEqual(custody, { stage: 'launch-finalized', mint: reserved.mint })
    const { market } = await readHookCoinMarket({ connection: w.connections()[0].connection, mint: reserved.mint, profile })
    assert.equal(market.native, true); assert.equal(market.creator, owner); assert.equal(market.creatorFeeBps, creatorFeeBps); assert.equal(market.capBps, capBps)
  }
  assert.equal(sends.length, 8, 'two sends per launch, nothing else')
})
