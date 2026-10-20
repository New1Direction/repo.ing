import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, VersionedTransaction, VersionedMessage } from '@solana/web3.js'
import bs58 from 'bs58'
import { fixture, key, pk } from './fixtures/selected-hook-preparation.mjs'
import { deriveCustomPreparationRecord, verifyCustomPreparationEvidence, collectCustomPreparationEvidence } from '../src/hooklab-custom-preparation-receipts.mjs'

test('selected preparation derives config-only settlement, not gate initialization', () => {
  const f = fixture(), r = deriveCustomPreparationRecord(f, f.profile.expectedSha256)
  assert.equal(r.policyKind, 'selected-hook')
  assert.deepEqual(Object.keys(r.expectedAccounts), ['selectedConfig'])
  assert.equal(r.expectedAccounts.selectedConfig.size, 176)
  assert.deepEqual(r.expectedAbsent, [f.request.mint, r.plan.addresses.canonicalLaunch])
  assert.deepEqual(r.plan.review.requiredSigners, [f.request.creator, f.request.selectedConfig])
})

function evidence() {
  const input = fixture(), record = deriveCustomPreparationRecord(input, input.profile.expectedSha256)
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(record.plan.review.messageBase64, 'base64')))
  tx.sign([31, 33].map(n => Keypair.fromSeed(Buffer.alloc(32, n))))
  const signedTransactionBase64 = Buffer.from(tx.serialize()).toString('base64')
  const preBalances = record.plan.review.accounts.map(a => a.address === input.request.selectedConfig ? '0' : '10000000')
  const postBalances = record.plan.review.accounts.map((a, i) => a.address === input.request.selectedConfig ? '2000' : a.address === input.request.creator ? '9988000' : preBalances[i])
  const config = Buffer.from(record.expectedAccounts.selectedConfig.canonicalTemplateBase64, 'base64')
  // Clock is dynamic; all surrounding bytes remain canonical.
  config.writeBigInt64LE(1700000001n, 8 + 1 + 32 + 22 + 2 + 33 + 2 + 4 + Buffer.byteLength(input.request.label))
  const state = (role, e, dataBase64 = e.dataBase64) => ({ role, address: e.address, owner: e.owner, executable: e.executable, dataBase64, lamports: '2000' })
  const observations = input.profile.providers.map(provider => ({ provider, genesisHash: input.recentBlockhash.genesisHash,
    transactionCommitment: 'finalized', blockCommitment: 'finalized', errorCode: null,
    transaction: { slot: 110, blockTime: 1700000000, signedTransactionBase64, loadedAddresses: { writable: [], readonly: [] }, feeLamports: '10000', err: null, preBalances: [...preBalances], postBalances: [...postBalances] },
    block: { slot: 110, blockhash: key(80), previousBlockhash: key(81), parentSlot: 109, blockHeight: 110, blockTime: 1700000000, signatures: [bs58.encode(tx.signatures[0])] },
    snapshot: { slot: 120, commitment: 'finalized', accounts: [state('selectedConfig', record.expectedAccounts.selectedConfig, config.toString('base64')), state('registry', record.committedAccounts.registry)] },
    programSnapshot: { slot: 120, commitment: 'finalized', accounts: ['launch', 'hook', 'launchProgramData', 'hookProgramData'].map(role => {
      const e = input.observations[0].accounts.find(a => a.address === record.plan.addresses[role]).account
      return state(role, e)
    }) }, absenceSnapshot: { slot: 120, commitment: 'finalized', accounts: record.expectedAbsent.map(address => ({ address, exists: false })) } }))
  return { preparationInput: input, expectedProfileSha256: input.profile.expectedSha256, expectedProviders: input.profile.providers,
    evidenceMode: 'synthetic-fixture', signedTransactionBase64, observations }
}
const verify = f => verifyCustomPreparationEvidence(f)
test('canonical selected config fields and loader deployment cannot drift', () => {
  // Discriminator, version, creator, rules, fee, hook option/key, flags, label,
  // author attribution and reserved padding (created_at alone is dynamic).
  for (const offset of [0, 8, 9, 41, 63, 65, 66, 98, 100, 104, 120, 122, 175]) {
    const f = evidence()
    for (const o of f.observations) {
      const a = o.snapshot.accounts[0], b = Buffer.from(a.dataBase64, 'base64')
      b[offset] ^= 1; a.dataBase64 = b.toString('base64')
    }
    assert.equal(verify(f).reasonCode, 'STATE_MISMATCH', `offset ${offset}`)
  }
  for (const i of [2, 3]) {
    const f = evidence()
    for (const o of f.observations) {
      const a = o.programSnapshot.accounts[i], b = Buffer.from(a.dataBase64, 'base64')
      b.writeBigUInt64LE(110n, 4); a.dataBase64 = b.toString('base64')
    }
    assert.equal(verify(f).reasonCode, 'SOURCE_MISMATCH')
  }
  const f = evidence(), tx = VersionedTransaction.deserialize(Buffer.from(f.signedTransactionBase64, 'base64'))
  tx.signatures[1] = new Uint8Array(64)
  f.signedTransactionBase64 = Buffer.from(tx.serialize()).toString('base64')
  assert.equal(verify(f).reasonCode, 'INVALID_INPUT')
})
test('asymmetrically signed exact inclusion and config rent settle with all authority disabled', () => {
  const r = verify(evidence())
  assert.equal(r.reasonCode, 'MATCHED'); assert.equal(r.currentPrelaunchEligible, true)
  assert.equal(r.rentLamports, '2000'); assert.equal(r.totalDebitLamports, '12000')
  for (const k of ['canSign', 'canSubmit', 'canRetry', 'chainVerified', 'preparationReceiptAccepted']) assert.equal(r[k], false)
})
test('changed wire, config, registry, program, fee, rent and unexplained balances fail closed', () => {
  const cases = [
    [o => { o.transaction.signedTransactionBase64 = '' }, 'IDENTITY_MISMATCH'],
    [o => { o.block.signatures = [bs58.encode(Buffer.alloc(64, 1))] }, 'IDENTITY_MISMATCH'],
    ...[0, 1].map(i => [o => { const a = o.snapshot.accounts[i], b = Buffer.from(a.dataBase64, 'base64'); b[b.length - 1] ^= 1; a.dataBase64 = b.toString('base64') }, 'STATE_MISMATCH']),
    ...[0, 1, 2, 3].map(i => [o => { const a = o.programSnapshot.accounts[i], b = Buffer.from(a.dataBase64, 'base64'); b[b.length - 1] ^= 1; a.dataBase64 = b.toString('base64') }, 'SOURCE_MISMATCH']),
    [o => { o.transaction.feeLamports = '9999' }, 'ECONOMIC_MISMATCH'],
    [o => { o.transaction.postBalances[1] = '1999' }, 'ECONOMIC_MISMATCH'],
    [o => { o.transaction.postBalances[2] = '10000001' }, 'ECONOMIC_MISMATCH'],
    [o => { o.absenceSnapshot.accounts[0].exists = true }, 'CURRENT_LAUNCH_PRESENT'],
    [o => { o.absenceSnapshot = null }, 'CURRENT_LAUNCH_UNRESOLVED'],
    [o => { o.transactionCommitment = 'confirmed' }, 'PENDING_FINALITY'],
    [o => { o.transaction = null }, 'READ_UNAVAILABLE'],
  ]
  for (const [edit, code] of cases) { const f = evidence(); f.observations.forEach(edit); const r = verify(f); assert.equal(r.reasonCode, code); assert.equal(r.currentPrelaunchEligible, false) }
  const f = evidence(), b = Buffer.from(f.signedTransactionBase64, 'base64'); b[5] ^= 1; f.signedTransactionBase64 = b.toString('base64')
  assert.equal(verify(f).reasonCode, 'INVALID_INPUT')
})
test('finalized failure proves only network debit and never eligibility', () => {
  const f = evidence()
  for (const o of f.observations) { o.transaction.err = { InstructionError: [2, 'Custom'] }; o.transaction.postBalances = o.transaction.preBalances.map((v, i) => String(BigInt(v) - (i === 0 ? 10000n : 0n))); o.snapshot = null; o.programSnapshot = null }
  assert.equal(verify(f).reasonCode, 'FINALIZED_FAILURE'); assert.equal(verify(f).rentLamports, '0')
})
test('fake read-only transport uses generalized inventory and preserves exact signed transaction', async () => {
  const f = evidence(), o = f.observations[0], tx = VersionedTransaction.deserialize(Buffer.from(f.signedTransactionBase64, 'base64'))
  const providers = f.expectedProviders.map(provider => ({ provider, connection: {
    async getGenesisHash() { return o.genesisHash },
    async getTransaction() { return { slot: 110, blockTime: o.transaction.blockTime, transaction: { message: tx.message, signatures: tx.signatures.map(s => bs58.encode(s)) }, meta: { fee: 10000, err: null, loadedAddresses: { writable: [], readonly: [] }, preBalances: o.transaction.preBalances.map(Number), postBalances: o.transaction.postBalances.map(Number) } } },
    async getBlockSignatures() { return o.block },
    async getMultipleAccountsInfoAndContext(keys) {
      assert.equal(keys.length, 8)
      const accounts = [...o.snapshot.accounts, ...o.programSnapshot.accounts]
      return { context: { slot: 120 }, value: keys.map(k => { const a = accounts.find(a => a.address === k.toBase58()); return a ? { owner: pk(a.owner), executable: a.executable, data: Buffer.from(a.dataBase64, 'base64'), lamports: Number(a.lamports) } : null }) }
    },
  } }))
  const r = await collectCustomPreparationEvidence({ ...f, providers })
  assert.equal(r.result.reasonCode, 'MATCHED')
  providers[0].connection.getTransaction = async () => null
  assert.equal((await collectCustomPreparationEvidence({ ...f, providers })).result.reasonCode, 'READ_UNAVAILABLE')
})
