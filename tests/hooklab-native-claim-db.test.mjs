// A creator fee claim on the real signing table: the native-stages migration is what lets stage native-claim exist, and
// the lifecycle carries one claim from review to a settled receipt, the settlement context read back from Postgres jsonb.
// Synthetic keys, an injected resolver and sender, a disposable database; no RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto'
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { MIGRATIONS, migrationSchema, productionSchema } from '../scripts/hooklab-production-schema.mjs'
import { claimCreatorFeesSol } from '../src/hooklab-native-launch.mjs'
import { CLAIM_COMPUTE_UNITS, CLAIM_OPERATION, CLAIM_STAGE } from '../src/hooklab-native-claim.mjs'
import { MAINNET_GENESIS, PROGRAMS } from '../src/hooklab-owner-driver/pins.mjs'

const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
const seed = createHash('sha256').update('NATIVE CLAIM DB TEST FIXTURE ONLY: creator').digest(), creator = Keypair.fromSeed(seed).publicKey.toBase58()
const signAsCreator = message => sign(null, message, createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }))
const token = Buffer.alloc(32, 41).toString('base64url'), tokenSha256 = createHash('sha256').update(token).digest('hex')
// Wallet sessions belong to the execution network (mainnet here: no local acceptance scope is entered).
const genesis = MAINNET_GENESIS, mint = Keypair.fromSeed(Buffer.alloc(32, 3)).publicKey.toBase58()
const sha = value => createHash('sha256').update(value).digest('hex')

// The claim review as the compiler shapes it: compute budget, then claim_creator_fees_sol; the creator signs alone.
function claimReview() {
  const message = new TransactionMessage({ payerKey: new PublicKey(creator), recentBlockhash: Keypair.fromSeed(Buffer.alloc(32, 5)).publicKey.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: CLAIM_COMPUTE_UNITS }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0n }),
      claimCreatorFeesSol({ launchProgram: PROGRAMS.launch, creator, mint })] }).compileToV0Message()
  const bytes = Buffer.from(message.serialize()), keys = message.getAccountKeys(), now = Date.now()
  return { schema: 'hooklab-message-review/1', operation: CLAIM_OPERATION, genesisHash: genesis, profileSha256: 'c'.repeat(64), policySha256: 'd'.repeat(64), intentSha256: 'e'.repeat(64),
    payer: creator, wallet: creator, messageBase64: bytes.toString('base64'), messageSha256: sha(bytes), requiredSigners: [creator],
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: [], observedSlot: 100, validUntilSlot: 200, observedAtMs: now - 1000, reviewExpiresAtMs: now + 60000, lastValidBlockHeight: 250,
    baseFeeLamports: '5000', maxFeeLamports: '5000', instructionDebitLamports: '0', maxNativeDebitLamports: '5000' }
}

async function withDatabase(migrations, work) {
  const root = new pg.Pool(config), name = `native_claim_${randomUUID().replaceAll('-', '')}`; let pool
  try {
    await root.query(`create database ${name}`); pool = new pg.Pool({ ...config, database: name })
    await pool.query(productionSchema().sql)
    for (const migration of migrations) await pool.query(migrationSchema(migration).sql)
    await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')", [tokenSha256, creator, genesis])
    await work(pool)
  } finally {
    await pool?.end()
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(r => setTimeout(r, 20))) if ((await root.query('select count(*)::int n from pg_stat_activity where datname=$1', [name])).rows[0].n === 0) break
    await root.query(`drop database if exists ${name} with (force)`); await root.end()
  }
}

test('stage native-claim exists only after the native-stages migration, and a claim settles from its jsonb context', async () => {
  const review = claimReview(), configurationSha256 = 'a'.repeat(64)
  // Keys in their construction order; Postgres jsonb hands them back shortest first.
  const settlementContext = { schema: 'repoing/hooklab-native-claim-settlement-context/1', configurationSha256,
    compilationInput: { request: { schema: 'repoing/hooklab-native-claim-request/1', creator, mint }, rent: { launchLamports: '4823280', walletLamports: '890880' } } }
  const resolved = { status: 'operator-pins-and-state-verified', owner: creator, stage: CLAIM_STAGE, profileSha256: review.profileSha256, messageSha256: review.messageSha256,
    configurationSha256, review, request: settlementContext.compilationInput.request, settlementContext }
  let seen = null
  const resolver = { prepare: async () => structuredClone(resolved), revalidate: async () => structuredClone(resolved),
    reconcile: async ({ settlementContext: stored, signature }) => { seen = stored
      return { status: 'finalized-success', executionStatus: 'finalized-executed', signature, messageSha256: review.messageSha256, profileSha256: review.profileSha256, feeLamports: '5000',
        quote: { delivered: '5625000' }, claimedLamports: '5625000', policyReviewRequired: false, reviewBoundsSatisfied: true, reviewSlotBoundExceeded: false } } }
  let sends = 0
  const sender = { send: async ({ signature }) => { sends++; return signature } }
  const lifecycle = pool => nativeSigningLifecycle(pool, { enabled: true, origin: 'https://repo.ing', resolver, sender, stageOperations: { [CLAIM_STAGE]: CLAIM_OPERATION } })
  assert.throws(() => nativeSigningLifecycle(null, { enabled: true, origin: 'https://repo.ing', stageOperations: { [CLAIM_STAGE]: 'hooklab-wallet-withdraw' } }), 'the claim stage carries only the claim operation')

  // Later migrations widen this same constraint too. Reproduce the historical
  // boundary, rather than applying future migrations without their dependency.
  const names = Object.keys(MIGRATIONS)
  const before = names.slice(0, names.indexOf('native-stages'))
  await withDatabase(before, async pool => {
    await assert.rejects(lifecycle(pool).createReview(token, randomUUID(), { custodyOperationId: randomUUID(), stage: CLAIM_STAGE, intent: { mint } }), 'the stage list refuses native-claim before the migration')
  })
  await withDatabase(Object.keys(MIGRATIONS), async pool => {
    const store = lifecycle(pool), id = randomUUID()
    assert.equal((await store.createReview(token, id, { custodyOperationId: id, stage: CLAIM_STAGE, intent: { mint } })).status, 'reviewed')
    const issued = await store.walletRequest(token, id), tx = VersionedTransaction.deserialize(Buffer.from(issued.partialTransactionBase64, 'base64'))
    tx.signatures[0] = signAsCreator(tx.message.serialize())
    assert.equal((await store.retainWalletSignature(token, id, Buffer.from(tx.serialize()).toString('base64'))).status, 'signed')
    assert.equal((await store.submitOnce(token, id)).status, 'submitted'); assert.equal(sends, 1)
    const settled = await store.reconcile(token, id)
    assert.equal(settled.status, 'finalized-success'); assert.equal(settled.settlement.quote.delivered, '5625000', 'the claimed amount reaches the public receipt')
    assert.deepEqual(seen, settlementContext); assert.notEqual(JSON.stringify(seen), JSON.stringify(settlementContext), 'read back from jsonb with its keys reordered')
    await assert.rejects(store.submitOnce(token, id), 'sent at most once')
    assert.equal(sends, 1)
  })
})
