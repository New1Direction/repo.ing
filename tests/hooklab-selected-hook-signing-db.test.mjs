// Disposable PostgreSQL and synthetic keys; no chain or owner credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { Keypair, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import pg from 'pg'
import { nativeSignerCustodyStore } from '../src/hooklab-native-signer-custody-store.mjs'
import { nativeCustodySigningAdapter } from '../src/hooklab-native-custody-signing.mjs'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { planSelectedHookPreparation } from '../src/hooklab-selected-hook-preparation.mjs'
import { planSelectedHookSetup } from '../src/hooklab-selected-hook-setup.mjs'
import { taxHookSetupManifest, materializeHookSetup } from '../src/hooklab-hook-catalog.mjs'
import { fixture, sha } from './fixtures/selected-hook-preparation.mjs'
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
      'hooklab-native-signing-refresh-schema.sql', 'hooklab-native-signing-wallet-request-schema.sql',
      'hooklab-owner-approval-schema.sql', 'hooklab-native-launch-context-schema.sql',
      'hooklab-selected-hook-authority-schema.sql', 'hooklab-selected-hook-setup-schema.sql'])
      await pool.query(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
    const f = fixture(), now = Date.now(), owner = f.request.creator, token = Buffer.alloc(32, 73).toString('base64url')
    f.observations.forEach(o => { o.observedAtMs = now }); f.recentBlockhash.observedAtMs = now
    Object.assign(f.limits, { nowMs: now, maxAgeMs: 60000, reviewExpiresAtMs: now + 60000 })
    const identity = index => {
      const { lamports, ...account } = f.observations[0].accounts[index].account
      return account
    }
    const programAccount = identity(1), programData = identity(3)
    f.selectedAuthorityEvidence = { schema: 'repoing/selected-hook-authority-evidence/2',
      genesisHash: JSON.parse(f.profile.json).genesisHash, policySha256: 'a'.repeat(64), hookPin: f.hookPin,
      programAccount, programData, authority: { kind: 'immutable', upgradeAuthority: null },
      programSha256: sha(Buffer.from(programAccount.dataBase64, 'base64')),
      programDataSha256: sha(Buffer.from(programData.dataBase64, 'base64')),
      executableSha256: f.hookPin.elfSha256, observedSlot: 100, providers: f.profile.providers }
    const review = planSelectedHookPreparation(f).review
    await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",
      [createHash('sha256').update(token).digest('hex'), owner, executionGenesis()])
    const settings = { enabled: true, origin: 'https://repo.ing', keyRing: { synthetic: Buffer.alloc(32, 74) }, activeKeyId: 'synthetic',
      signerFactory: () => ({ mint: Keypair.fromSeed(Buffer.alloc(32, 32)), selectedConfig: Keypair.fromSeed(Buffer.alloc(32, 33)) }) }
    const custody = nativeSignerCustodyStore(pool, settings), operationId = randomUUID(), signingId = randomUUID()
    const reserved = await custody.reserveNewCandidate(token, operationId, f.profile.expectedSha256)
    const retained = await custody.retainSelectedAuthorityEvidence(token, operationId, {
      expectedRevision: reserved.revision, request: f.request, selectedAuthorityEvidence: f.selectedAuthorityEvidence })
    await custody.retainPreparationReview(token, operationId, { expectedRevision: retained.revision, request: f.request, evidenceSha256: 'b'.repeat(64) })
    const result = { status: 'operator-pins-and-state-verified', owner, stage: 'preparation', request: f.request, review,
      profileSha256: review.profileSha256, messageSha256: review.messageSha256, configurationSha256: 'c'.repeat(64), settlementContext: { synthetic: true } }
    let changed = false
    const resolver = { prepare: async ({ stage }) => stage === 'hook-setup' ? setupResult : result,
      revalidate: async ({ stage }) => stage === 'hook-setup' ? setupResult : ({ ...result, configurationSha256: changed ? 'd'.repeat(64) : result.configurationSha256 }) }
    const make = () => nativeSigningLifecycle(pool, { ...settings, resolver, custodyAdapter: nativeCustodySigningAdapter({ ...settings, openLaunches: true }),
      stageOperations: { 'hook-setup': 'selected-hook-setup', preparation: ['inclusive-max-wallet-preparation', 'selected-hook-preparation'], launch: 'open-launch' } })
    let lifecycle = make()
    const prepare = () => lifecycle.createReview(token, signingId, { custodyOperationId: operationId, stage: 'preparation' })
    await assert.rejects(prepare(), { code: 'NATIVE_SIGNING_UNAVAILABLE' }, 'missing durable setup intent blocks preparation')
    const manifest = taxHookSetupManifest(f.request.selectedHook)
    const hookPublication = { digest: 'e'.repeat(64), manifest,
      configuration: { feeBps: '100', maxWalletBps: '0', collector: Keypair.fromSeed(Buffer.alloc(32, 34)).publicKey.toBase58() } }
    const setupRequest = materializeHookSetup(manifest, hookPublication.configuration, { creator: owner, mint: reserved.mint })
    // Seed the server-bound intent; publication validation is tested in setup-stage tests.
    await pool.query(`insert into hook_lab_selected_hook_setup_intents
      (custody_operation_id,owner_wallet,profile_sha256,mint,selected_config,hook_publication,setup_request)
      values($1,$2,$3,$4,$5,$6,$7)`, [operationId, owner, f.profile.expectedSha256,
      reserved.mint, reserved.selectedConfig, hookPublication, setupRequest])
    await assert.rejects(prepare(), { code: 'NATIVE_SIGNING_UNAVAILABLE' }, 'setup intent without journal finality blocks preparation')
    const inventory = [...new Set([owner, f.request.selectedHook.program, programData.address,
      'ComputeBudget111111111111111111111111111111', ...setupRequest.instructions.flatMap(ix => ix.accounts.map(a => a.address))])]
    const setupPlan = planSelectedHookSetup({ request: setupRequest, programs: JSON.parse(f.profile.json).programs, hookPin: f.hookPin,
      selectedAuthorityEvidence: f.selectedAuthorityEvidence,
      snapshots: inventory.map(address => ({ address, account: address === setupRequest.instructions[0].accounts[4].address ? null
        : f.observations[0].accounts.find(a => a.address === address)?.account ?? null })),
      context: { genesisHash: review.genesisHash, profileSha256: f.profile.expectedSha256, recentBlockhash: f.recentBlockhash.blockhash,
        observedSlot: 100, validUntilSlot: 150, observedAtMs: now, reviewExpiresAtMs: now + 60000, lastValidBlockHeight: 200, baseFeeLamports: '5000' },
      limits: { computeUnits: 200000, maxRentLamports: '10000', maxNetworkFeeLamports: '5000', maxTotalDebitLamports: '15000' } })
    const setupResult = { ...result, stage: 'hook-setup', request: setupRequest, review: setupPlan.review,
      messageSha256: setupPlan.review.messageSha256, configurationSha256: setupPlan.review.policySha256,
      settlementContext: { synthetic: true, plan: setupPlan } }
    const setupId = randomUUID()
    await lifecycle.createReview(token, setupId, { custodyOperationId: operationId, stage: 'hook-setup' })
    await lifecycle.walletRequest(token, setupId)
    const setupTx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(setupPlan.review.messageBase64, 'base64')))
    setupTx.sign([Keypair.fromSeed(Buffer.alloc(32, 31))])
    assert.equal((await lifecycle.retainWalletSignature(token, setupId, Buffer.from(setupTx.serialize()).toString('base64'))).status, 'signed')
    await assert.rejects(prepare(), { code: 'NATIVE_SIGNING_UNAVAILABLE' }, 'signed setup is not finalized setup')
    // Synthetic finalized journal boundary; exact-chain settlement is covered by setup-stage tests.
    await pool.query(`update hook_lab_native_signing_operations set status='finalized-success',
      first_finalized=$2,revision=revision+1 where id=$1`, [setupId, { status: 'finalized-success', messageSha256: setupPlan.review.messageSha256 }])
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
