// Disposable local DB and deterministic synthetic identities only. No RPC or real signing keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { nativeSignerCustodyStore } from '../src/hooklab-native-signer-custody-store.mjs'
import { executionGenesis } from '../src/hooklab-local-acceptance.mjs'
import { reviewNewMintSelectedHookPreparationCandidate } from '../src/hooklab-new-mint-preparation.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { fixture, connections, sha } from './fixtures/selected-hook-preparation.mjs'

test('selected-hook intent survives interruption before registry setup and cannot repurpose its mint or config', async () => {
  const url = new URL(process.env.HOOKS_E2E_POSTGRES_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/postgres')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'disposable loopback DB only')
  const admin = new pg.Pool({ connectionString: url.href }), database = `selected_custody_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`); url.pathname = `/${database}`; pool = new pg.Pool({ connectionString: url.href })
    for (const file of ['hooklab-wallet-principal-schema.sql', 'hooklab-native-signer-custody-schema.sql', 'hooklab-new-mint-preparation-schema.sql', 'hooklab-selected-hook-authority-schema.sql']) {
      await pool.query(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
    }
    const f = fixture(), owner = f.request.creator, token = Buffer.alloc(32, 42).toString('base64url')
    await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",
      [createHash('sha256').update(token).digest('hex'), owner, executionGenesis()])
    let generated = 0
    const settings = { enabled: true, origin: 'https://repo.ing', keyRing: { test_only: Buffer.alloc(32, 43) }, activeKeyId: 'test_only', signerFactory: () => {
      generated++; return { mint: Keypair.fromSeed(Buffer.alloc(32, 32)), selectedConfig: Keypair.fromSeed(Buffer.alloc(32, 33)) }
    } }
    const id = randomUUID(), store = nativeSignerCustodyStore(pool, settings), reserved = await store.reserveNewCandidate(token, id, f.profile.expectedSha256)
    const request = f.request
    const identity = index => {
      const { lamports, ...account } = f.observations[0].accounts[index].account
      return account
    }
    const programAccount = identity(1), programData = identity(3)
    const selectedAuthorityEvidence = { schema: 'repoing/selected-hook-authority-evidence/2',
      genesisHash: JSON.parse(f.profile.json).genesisHash, policySha256: 'a'.repeat(64), hookPin: f.hookPin,
      programAccount, programData, authority: { kind: 'immutable', upgradeAuthority: null },
      programSha256: sha(Buffer.from(programAccount.dataBase64, 'base64')),
      programDataSha256: sha(Buffer.from(programData.dataBase64, 'base64')),
      executableSha256: f.hookPin.elfSha256, observedSlot: 100, providers: f.profile.providers }
    const retained = await store.retainSelectedAuthorityEvidence(token, id, { expectedRevision: reserved.revision, request, selectedAuthorityEvidence })
    assert.equal(retained.stage, 'reserved', 'binding intent is not a completed preparation review')
    const restarted = nativeSignerCustodyStore(pool, { ...settings, signerFactory: () => { throw Error('must not replace reserved keys') } })
    const recovered = await restarted.reserveNewCandidate(token, id, f.profile.expectedSha256)
    assert.deepEqual(recovered.preparedRequest, request); assert.equal(recovered.mint, reserved.mint); assert.equal(generated, 1)
    assert.deepEqual(await restarted.getSelectedAuthorityEvidence(token, id), selectedAuthorityEvidence)
    assert.deepEqual(await restarted.retainPreparationIntent(token, id, { expectedRevision: recovered.revision, request, selectedAuthorityEvidence }), recovered)
    await assert.rejects(restarted.retainSelectedAuthorityEvidence(token, id, { expectedRevision: recovered.revision, request,
      selectedAuthorityEvidence: { ...selectedAuthorityEvidence, authority: { kind: 'changed' } } }))
    await assert.rejects(pool.query('update hook_lab_native_signer_custody set selected_authority_evidence=$2,revision=revision+1 where operation_id=$1', [id, { ...selectedAuthorityEvidence, authority: { kind: 'changed' } }]))
    for (const changed of [{ ...request, label: 'changed' }, { ...request, capBps: 100 }, { ...request, hookFlags: 1 },
      { ...request, selectedHook: { ...request.selectedHook, program: owner } }, { ...request, selectedConfig: owner }]) {
      await assert.rejects(restarted.retainPreparationIntent(token, id, { expectedRevision: recovered.revision, request: changed }))
    }
    await assert.rejects(pool.query('update hook_lab_native_signer_custody set preparation_request=$2,revision=revision+1 where operation_id=$1', [id, { ...request, label: 'sql-change' }]))
    const input = { operationId: id, selectedHook: request.selectedHook, label: request.label, creatorFeeBps: request.creatorFeeBps }
    const args = { custody: restarted, sessionToken: token, input, profile: f.profile, hookPin: f.hookPin, limits: f.limits, clock: () => 1000 }
    const missing = structuredClone(f); missing.observations.forEach(o => { o.accounts[5].account = null })
    await assert.rejects(reviewNewMintSelectedHookPreparationCandidate({ ...args, connections: connections(missing) }), { code: 'SELECTED_HOOK_REGISTRY_REQUIRED' })
    assert.deepEqual(await restarted.get(token, id), recovered, 'a missing registry neither replaces the mint nor advances review')
    const result = await reviewNewMintSelectedHookPreparationCandidate({ ...args, connections: connections(f) }), reviewed = result.custody
    assert.equal(reviewed.stage, 'preparation-reviewed'); assert.deepEqual(reviewed.preparedRequest, request)
    assert.equal(result.canSign, false); assert.equal(result.productionUnsignedMessage, null)
    const foreign = Buffer.alloc(32, 47).toString('base64url')
    await assert.rejects(restarted.get(foreign, id)); assert.deepEqual(await restarted.get(token, id), reviewed)
    assert.ok(!JSON.stringify(reviewed).includes('secretKey')); assert.ok(!JSON.stringify(reviewed).includes('sealed_signers'))
  } finally {
    await pool?.end(); await dropTestDatabase(admin, database); await admin.end()
  }
})
