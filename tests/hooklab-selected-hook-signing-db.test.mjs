// Disposable PostgreSQL and synthetic keys; no chain or owner credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'
import { nativeSignerCustodyStore } from '../src/hooklab-native-signer-custody-store.mjs'
import { nativeCustodySigningAdapter } from '../src/hooklab-native-custody-signing.mjs'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { planSelectedHookPreparation } from '../src/hooklab-selected-hook-preparation.mjs'
import { fixture } from './fixtures/selected-hook-preparation.mjs'
import { executionGenesis } from '../src/hooklab-local-acceptance.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

test('selected config-only consent survives restart, rejects changed review, and never signs with mint', async () => {
  const url = new URL(process.env.HOOKS_E2E_POSTGRES_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/postgres')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  const admin = new pg.Pool({ connectionString: url.href }), database = `selected_signing_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`); url.pathname = `/${database}`; pool = new pg.Pool({ connectionString: url.href })
    for (const file of ['hooklab-wallet-principal-schema.sql', 'hooklab-native-signer-custody-schema.sql', 'hooklab-new-mint-preparation-schema.sql',
      'hooklab-native-signing-schema.sql', 'hooklab-native-signing-attempt-schema.sql', 'hooklab-native-signing-context-schema.sql',
      'hooklab-native-signing-refresh-schema.sql', 'hooklab-native-signing-wallet-request-schema.sql'])
      await pool.query(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
    const f = fixture(), now = Date.now(), owner = f.request.creator, token = Buffer.alloc(32, 73).toString('base64url')
    f.observations.forEach(o => { o.observedAtMs = now }); f.recentBlockhash.observedAtMs = now
    Object.assign(f.limits, { nowMs: now, maxAgeMs: 60000, reviewExpiresAtMs: now + 60000 })
    const review = planSelectedHookPreparation(f).review
    await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",
      [createHash('sha256').update(token).digest('hex'), owner, executionGenesis()])
    const settings = { enabled: true, origin: 'https://repo.ing', keyRing: { synthetic: Buffer.alloc(32, 74) }, activeKeyId: 'synthetic',
      signerFactory: () => ({ mint: Keypair.fromSeed(Buffer.alloc(32, 32)), selectedConfig: Keypair.fromSeed(Buffer.alloc(32, 33)) }) }
    const custody = nativeSignerCustodyStore(pool, settings), operationId = randomUUID(), signingId = randomUUID()
    const reserved = await custody.reserveNewCandidate(token, operationId, f.profile.expectedSha256)
    await custody.retainPreparationReview(token, operationId, { expectedRevision: reserved.revision, request: f.request, evidenceSha256: 'b'.repeat(64) })
    const result = { status: 'operator-pins-and-state-verified', owner, stage: 'preparation', request: f.request, review,
      profileSha256: review.profileSha256, messageSha256: review.messageSha256, configurationSha256: 'c'.repeat(64), settlementContext: { synthetic: true } }
    let changed = false
    const resolver = { prepare: async () => result, revalidate: async () => ({ ...result, configurationSha256: changed ? 'd'.repeat(64) : result.configurationSha256 }) }
    const make = () => nativeSigningLifecycle(pool, { ...settings, resolver, custodyAdapter: nativeCustodySigningAdapter({ ...settings, openLaunches: true }),
      stageOperations: { preparation: ['inclusive-max-wallet-preparation', 'selected-hook-preparation'], launch: 'open-launch' } })
    let lifecycle = make()
    assert.equal((await lifecycle.createReview(token, signingId, { custodyOperationId: operationId, stage: 'preparation' })).status, 'reviewed')
    changed = true; await assert.rejects(lifecycle.walletRequest(token, signingId)); changed = false
    const issued = await lifecycle.walletRequest(token, signingId), tx = VersionedTransaction.deserialize(Buffer.from(issued.partialTransactionBase64, 'base64'))
    tx.sign([Keypair.fromSeed(Buffer.alloc(32, 31))])
    const mutated = VersionedTransaction.deserialize(tx.serialize()); mutated.message.recentBlockhash = f.request.mint
    await assert.rejects(lifecycle.retainWalletSignature(token, signingId, Buffer.from(mutated.serialize()).toString('base64')))
    assert.equal((await lifecycle.retainWalletSignature(token, signingId, Buffer.from(tx.serialize()).toString('base64'))).status, 'partial')
    await pool.end(); pool = new pg.Pool({ connectionString: url.href }); lifecycle = make()
    assert.equal((await lifecycle.get(token, signingId)).messageSha256, review.messageSha256)
    await assert.rejects(lifecycle.coSignNext(token, signingId, f.request.mint))
    const signed = await lifecycle.coSignNext(token, signingId, f.request.selectedConfig)
    assert.equal(signed.status, 'signed'); assert.deepEqual(new Set(signed.signedBy), new Set([owner, f.request.selectedConfig]))
    assert.equal((await nativeSignerCustodyStore(pool, settings).get(token, operationId)).stage, 'preparation-signed')
  } finally { await pool?.end(); await dropTestDatabase(admin, database); await admin.end() }
})
