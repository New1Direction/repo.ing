import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { deriveCustomPreparationRecord, verifyCustomPreparationEvidence, collectCustomPreparationEvidence,
  collectAndRetainCustomPreparation } from '../src/hooklab-custom-preparation-receipts.mjs'
import { maxWalletPreparationReceiptFixture, maxWalletPreparationRpcProviders } from './fixtures/hooklab-max-wallet-preparation-receipts.mjs'
import { customPreparationReceiptFixture } from './fixtures/hooklab-custom-preparation-receipts.mjs'
const sha = v => createHash('sha256').update(v).digest('hex')
const pk = a => new PublicKey(a)
const both = (f, edit) => f.observations.forEach(edit)
const disabled = result => {
  for (const name of ['canSign', 'canSubmit', 'canRetry', 'adoption', 'artifactAdopted', 'deploymentAdopted', 'policyApproved',
    'executionAuthorized', 'preparationReceiptAccepted', 'productionPreparationReceiptAccepted', 'chainVerified', 'historicalStateVerified', 'rentCapEnforcedOnchain']) assert.equal(result[name], false, name)
  assert.equal(result.launchPlan, null); assert.equal(result.productionPreparationReceipt, null)
}
const verify = f => { const result = verifyCustomPreparationEvidence(f); disabled(result); return result }
const mutateAccount = (f, index, edit) => both(f, o => {
  const account = o.snapshot.accounts[index], bytes = Buffer.from(account.dataBase64, 'base64')
  const replacement = edit(bytes) ?? bytes; account.dataBase64 = replacement.toString('base64')
})
function changeRetainedConfig(f, change) {
  const coder = new BorshCoder(JSON.parse(Buffer.from(f.preparationInput.profile.idls.launch, 'base64')))
  for (const observation of f.preparationInput.observations) {
    const account = observation.accounts[4].account, original = Buffer.from(account.dataBase64, 'base64')
    const config = coder.accounts.decode('Config', original); change(config)
    const bytes = Buffer.alloc(250); original.subarray(0, 8).copy(bytes); coder.types.encode('Config', config).copy(bytes, 8)
    account.dataBase64 = bytes.toString('base64')
  }
}
const reorder = v => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).reverse().map(([k, value]) => [k, reorder(value)])) : v

test('frozen max-wallet v1 dispatch matches signed fixtures across payer and v0 lookup variants', () => {
  for (const samePayer of [false, true]) for (const lookupTable of [false, true]) {
    const f = maxWalletPreparationReceiptFixture({ samePayer, lookupTable }), r = verify(f)
    assert.equal(r.status, 'candidate-preparation-matched'); assert.equal(r.policyKind, 'max-wallet'); assert.equal(r.policyVersion, 1)
    assert.equal(r.profileSha256, 'f366d222e7257e86ac23d8350741b3c20c08ea084a4445c7b0d2d913593b5ea0')
    assert.equal(r.currentPrelaunchEligible, true); assert.equal(r.canonicalLaunchAbsenceHistorical, false)
    assert.equal(r.absenceEvidenceSemantics, 'current-prelaunch-eligibility-only')
    assert.deepEqual(r.currentAbsentAccounts, [f.observations[0].absenceSnapshot.accounts[0].address])
    assert.equal(r.rentLamports, f.preparationInput.limits.maxRentLamports)
    assert.equal(r.feePayerNetworkFeeLamports, samePayer ? '15000' : '20000')
    assert.equal(r.selectedConfigCreatedAt, '1700000001'); assert.notEqual(Number(r.selectedConfigCreatedAt), f.observations[0].block.blockTime)
    assert.equal(r.currentPinnedProgramBytesMatched, true); assert.equal(r.tokenDependencyProvenanceVerified, false)
    assert.ok(r.snapshotSlots.every(s => s.relation === 'later-state'))
  }
})

test('expected max-wallet Policy85 and two-literal Registry81 derive exactly from original reviewed config and explicit cap', () => {
  const f = maxWalletPreparationReceiptFixture(), record = deriveCustomPreparationRecord(f.preparationInput, f.expectedProfileSha256)
  disabled(record)
  const { initialSupply, capBps, capRaw, quoteMint, lpFeeBps } = record.policyEconomics
  assert.equal(capBps, 100); assert.equal(capRaw, String(BigInt(initialSupply) * 100n / 10000n))
  const expected = Buffer.alloc(85); Buffer.from(sha('account:Policy'), 'hex').subarray(0, 8).copy(expected)
  expected[8] = 1; pk(f.preparationInput.request.mint).toBuffer().copy(expected, 9); expected.writeBigUInt64LE(BigInt(initialSupply), 41)
  expected.writeUInt16LE(capBps, 49); pk(quoteMint).toBuffer().copy(expected, 51); expected.writeUInt16LE(lpFeeBps, 83)
  assert.equal(record.expectedAccounts.policy.size, 85); assert.equal(record.expectedAccounts.policy.dataBase64, expected.toString('base64'))
  const registry = Buffer.concat([Buffer.from('02daf6662c38c0cd01020000000000', 'hex'), pk(record.plan.addresses.policy).toBuffer(), Buffer.from([0, 0]), pk(record.plan.addresses.canonicalLaunch).toBuffer()])
  assert.equal(record.expectedAccounts.registry.size, 81); assert.equal(record.expectedAccounts.registry.dataBase64, registry.toString('base64'))
  assert.equal(record.expectedAccounts.selectedConfig.size, 176); assert.equal(record.expectedAccounts.selectedConfig.dataBase64, null)
  assert.deepEqual(record.expectedAccounts.selectedConfig.dynamicFields, ['created_at'])
  assert.deepEqual(record.expectedAbsent, [record.plan.addresses.canonicalLaunch])
  for (const cap of [1, 9999]) {
    const changed = maxWalletPreparationReceiptFixture({ capBps: cap }), result = verify(changed)
    assert.equal(result.status, 'candidate-preparation-matched')
    assert.notEqual(result.messageSha256, verify(f).messageSha256)
  }
})

test('missing or widened cap, policy discriminant/version, profile and caller economics never select a generic adapter', () => {
  const f = maxWalletPreparationReceiptFixture()
  const edits = [g => { delete g.preparationInput.request.capBps }, g => { g.preparationInput.request.capBps = 0 },
    g => { g.preparationInput.request.capBps = 10000 }, g => { g.preparationInput.request.capBps = '100' },
    g => { g.preparationInput.request.capBps = 100.5 }, g => { delete g.preparationInput.request.policyKind },
    g => { g.preparationInput.request.policyKind = 'blocked-owner' }, g => { g.preparationInput.request.policyVersion = 2 },
    g => { g.preparationInput.request.initialSupply = '99' }, g => { g.preparationInput.request.quoteMint = g.preparationInput.request.creator },
    g => { g.preparationInput.request.lpFeeBps = 30 }, g => { g.preparationInput.request.blockedOwner = g.preparationInput.request.creator },
    g => { g.preparationInput.request.creatorFeeBps = 1 }, g => { g.preparationInput.request.hookFlags = 3 },
    g => { g.preparationInput.expectedAccounts = g.observations[0].snapshot.accounts },
    g => { g.preparationInput.adapter = 'accept-any-bytes' }, g => { g.expectedProfileSha256 = 'a'.repeat(64) },
    g => { const p = JSON.parse(g.preparationInput.profile.json); p.profileId += '-changed'; g.preparationInput.profile.json = JSON.stringify(p);
      g.expectedProfileSha256 = g.preparationInput.profile.expectedSha256 = sha(g.preparationInput.profile.json) },
    g => { g.preparationInput.profile.idls.gate = customPreparationReceiptFixture().preparationInput.profile.idls.gate }]
  for (const edit of edits) { const g = structuredClone(f); edit(g); assert.equal(verify(g).status, 'unresolved') }
})

test('original reviewed supply, quote and LP fee cannot be silently replaced after signing', () => {
  const f = maxWalletPreparationReceiptFixture()
  for (const edit of [c => { c.supply = new BN(c.supply.toString(10)).addn(1) }, c => { c.lp_fee_bps += 1 },
    c => { c.quote_mint = pk(f.preparationInput.request.creator) }]) {
    const g = structuredClone(f); changeRetainedConfig(g, edit); assert.equal(verify(g).reasonCode, 'INVALID_INPUT')
  }
  const cap = structuredClone(f); cap.preparationInput.request.capBps += 1
  assert.equal(verify(cap).reasonCode, 'INVALID_INPUT')
})

test('every max-wallet policy byte field and both readonly registry entries are checked exactly', () => {
  const f = maxWalletPreparationReceiptFixture()
  for (const offset of [0, 8, 9, 41, 49, 51, 83]) {
    const g = structuredClone(f); mutateAccount(g, 0, b => { b[offset] ^= 1 }); assert.equal(verify(g).reasonCode, 'STATE_MISMATCH')
  }
  for (const offset of [0, 8, 9, 13, 14, 15, 47, 48, 49]) {
    const g = structuredClone(f); mutateAccount(g, 1, b => { b[offset] ^= 1 }); assert.equal(verify(g).reasonCode, 'STATE_MISMATCH')
  }
  for (const index of [0, 1, 2]) for (const edit of [a => { a.owner = f.preparationInput.request.creator },
    a => { a.address = f.preparationInput.request.mint }, a => { a.executable = true }]) {
    const g = structuredClone(f); both(g, o => edit(o.snapshot.accounts[index])); assert.equal(verify(g).reasonCode, 'STATE_MISMATCH')
  }
  const trailing = structuredClone(f); mutateAccount(trailing, 2, b => { b[b.length - 1] = 1 })
  assert.equal(verify(trailing).reasonCode, 'STATE_MISMATCH')
  const incompatible = structuredClone(f), blocked = customPreparationReceiptFixture()
  both(incompatible, o => { o.snapshot.accounts[0].dataBase64 = blocked.observations[0].snapshot.accounts[0].dataBase64 })
  assert.equal(verify(incompatible).reasonCode, 'STATE_MISMATCH')
})

test('canonical Launch absence is current eligibility only; legitimate later presence is unresolved, not immutable corruption', () => {
  const f = maxWalletPreparationReceiptFixture()
  for (const mutate of [o => { delete o.absenceSnapshot }, o => { o.absenceSnapshot = null },
    o => { o.absenceSnapshot.slot++ }, o => { o.absenceSnapshot.commitment = 'confirmed' },
    o => { o.absenceSnapshot.accounts[0].address = f.preparationInput.request.creator }]) {
    const g = structuredClone(f); both(g, mutate); const result = verify(g)
    assert.equal(result.status, 'unresolved'); assert.equal(result.reasonCode, 'CURRENT_LAUNCH_UNRESOLVED')
    assert.equal(result.currentPrelaunchEligible, false)
  }
  for (const count of [1, 2]) {
    const g = structuredClone(f); for (let i = 0; i < count; i++) g.observations[i].absenceSnapshot.accounts[0].exists = true
    const result = verify(g)
    assert.equal(result.status, 'unresolved'); assert.equal(result.reasonCode, 'CURRENT_LAUNCH_PRESENT')
    assert.equal(result.currentPrelaunchEligible, false); assert.equal(result.canonicalLaunchAbsenceHistorical, false)
    assert.match(result.reason, /earlier immutable preparation evidence remains retainable/)
    // Actual immutable corruption is still diagnosed before current eligibility checks.
    mutateAccount(g, 0, b => { b[49] ^= 1 }); assert.equal(verify(g).reasonCode, 'STATE_MISMATCH')
  }
})

test('signed-wire, all signatures, ALT and finalized identity boundaries still apply to max-wallet', () => {
  const f = maxWalletPreparationReceiptFixture({ lookupTable: true }), tx = VersionedTransaction.deserialize(Buffer.from(f.signedTransactionBase64, 'base64'))
  for (let i = 0; i < tx.signatures.length; i++) {
    const changed = VersionedTransaction.deserialize(Buffer.from(f.signedTransactionBase64, 'base64')); changed.signatures[i][0] ^= 1
    assert.equal(verify({ ...f, signedTransactionBase64: Buffer.from(changed.serialize()).toString('base64') }).reasonCode, 'INVALID_INPUT')
  }
  for (const edit of [o => { o.transaction.loadedAddresses.readonly.reverse() }, o => { o.block.parentSlot = o.block.slot },
    o => { o.block.signatures.push(o.block.signatures[0]) }, o => { o.transaction.slot = o.block.slot = f.preparationInput.limits.validUntilSlot + 1 },
    o => { o.block.blockHeight = f.preparationInput.recentBlockhash.lastValidBlockHeight + 1 }, o => { o.genesisHash = f.preparationInput.request.creator }]) {
    const g = structuredClone(f); both(g, edit); assert.equal(verify(g).reasonCode, 'IDENTITY_MISMATCH')
  }
  const pending = structuredClone(f); both(pending, o => { o.transactionCommitment = 'confirmed' })
  assert.equal(verify(pending).status, 'pending-finality')
})

test('max-wallet native deltas are exact transaction evidence; later donations and source contexts cannot replace them', () => {
  const f = maxWalletPreparationReceiptFixture(), result = verify(f)
  for (const edit of [o => { o.transaction.feeLamports = '1' }, o => { o.transaction.postBalances[0] = o.transaction.preBalances[0] },
    o => { const i = o.transaction.preBalances.findIndex(b => b === '0'); o.transaction.preBalances[i] = '1' },
    o => { const i = o.transaction.preBalances.findIndex(b => b === '0'); o.transaction.postBalances[i] = String(BigInt(o.transaction.postBalances[i]) + 1n) }]) {
    const g = structuredClone(f); both(g, edit); assert.equal(verify(g).reasonCode, 'ECONOMIC_MISMATCH')
  }
  const donations = structuredClone(f)
  donations.observations[0].snapshot.accounts[0].lamports = '99999999'; donations.observations[1].snapshot.accounts[0].lamports = '99999998'
  assert.equal(verify(donations).rentLamports, result.rentLamports)
  for (const edit of [o => { o.programSnapshot.slot++ }, o => { const account = o.programSnapshot.accounts[3], bytes = Buffer.from(account.dataBase64, 'base64'); bytes[50] ^= 1; account.dataBase64 = bytes.toString('base64') },
    o => { const account = o.programSnapshot.accounts[3], bytes = Buffer.from(account.dataBase64, 'base64'); bytes.writeBigUInt64LE(BigInt(o.transaction.slot), 4); account.dataBase64 = bytes.toString('base64') }]) {
    const g = structuredClone(f); both(g, edit); assert.equal(verify(g).reasonCode, 'SOURCE_MISMATCH')
  }
})

test('max-wallet evidence and derived records survive JSONB key reordering and never consume caller authority', () => {
  const f = maxWalletPreparationReceiptFixture({ lookupTable: true }), result = verify(f)
  assert.deepEqual(verify(reorder(f)), result)
  assert.deepEqual(deriveCustomPreparationRecord(reorder(f.preparationInput), f.expectedProfileSha256), deriveCustomPreparationRecord(f.preparationInput, f.expectedProfileSha256))
  for (const edit of [o => { o.accepted = true }, o => { o.finalized = true },
    o => { o.absenceSnapshot.accounts[0].accepted = true }, o => { o.transaction.preBalances[0] = '9007199254740992' }]) {
    const g = structuredClone(f); both(g, edit); assert.equal(verify(g).reasonCode, 'INVALID_EVIDENCE')
  }
  const blocked = customPreparationReceiptFixture(); both(blocked, o => { o.absenceSnapshot = structuredClone(f.observations[0].absenceSnapshot) })
  assert.equal(verify(blocked).reasonCode, 'INVALID_EVIDENCE')
})

test('max-wallet collector fetches canonical Launch existence in the same eight-account context and only allowlisted reads', async () => {
  const f = maxWalletPreparationReceiptFixture({ lookupTable: true }), { providers, calls } = maxWalletPreparationRpcProviders(f)
  const collected = await collectCustomPreparationEvidence({ ...f, providers, evidenceMode: 'configured-readonly-rpc' })
  disabled(collected); disabled(collected.result)
  assert.equal(collected.result.status, 'candidate-preparation-matched'); assert.equal(calls.length, 8)
  for (const call of calls.filter(c => c.method === 'getMultipleAccountsInfoAndContext')) {
    assert.equal(call.args[0].length, 8)
    assert.equal(call.args[0][7].toBase58(), f.observations[0].absenceSnapshot.accounts[0].address)
    assert.deepEqual(call.args[1], { commitment: 'finalized', minContextSlot: f.observations[0].transaction.slot })
  }
  assert.ok(collected.observations.every(o => o.absenceSnapshot.slot === o.snapshot.slot && !o.absenceSnapshot.accounts[0].exists))
  const present = structuredClone(f); present.observations[1].absenceSnapshot.accounts[0].exists = true
  const later = await collectCustomPreparationEvidence({ ...present, providers: maxWalletPreparationRpcProviders(present).providers })
  assert.equal(later.result.reasonCode, 'CURRENT_LAUNCH_PRESENT'); assert.equal(later.result.currentPrelaunchEligible, false)
})

test('max-wallet collection-to-journal passes only server-collected evidence and preserves fee-only failures', async () => {
  const f = maxWalletPreparationReceiptFixture(), retained = []
  const journal = { async retain(owner, id, value) { retained.push({ owner, id, value }); return { id, result: verifyCustomPreparationEvidence({ ...f, ...value }) } } }
  const options = { journal, owner: '101', id: 'synthetic-max-wallet', preparationInput: f.preparationInput,
    signedTransactionBase64: f.signedTransactionBase64, expectedProfileSha256: f.expectedProfileSha256,
    evidenceMode: 'synthetic-fixture', providers: maxWalletPreparationRpcProviders(f).providers }
  const stored = await collectAndRetainCustomPreparation(options)
  assert.equal(stored.record.result.status, 'candidate-preparation-matched'); assert.equal(retained.length, 1)
  assert.deepEqual(retained[0].value.observations, stored.collection.result.observations)
  await assert.rejects(collectAndRetainCustomPreparation({ ...options, observations: f.observations }), /UNSUPPORTED_COLLECTION_ARGUMENT/)
  const failed = structuredClone(f)
  both(failed, o => {
    o.transaction.err = { InstructionError: [2, { Custom: 1 }] }; o.transaction.postBalances = [...o.transaction.preBalances]
    o.transaction.postBalances[0] = String(BigInt(o.transaction.preBalances[0]) - BigInt(o.transaction.feeLamports))
    o.snapshot = null; o.programSnapshot = null; o.absenceSnapshot = null
  })
  const { providers, calls } = maxWalletPreparationRpcProviders(failed), collected = await collectCustomPreparationEvidence({ ...failed, providers })
  assert.equal(collected.result.status, 'finalized-failure'); assert.equal(collected.result.currentPrelaunchEligible, false)
  assert.equal(calls.length, 6); assert.ok(!calls.some(c => c.method === 'getMultipleAccountsInfoAndContext'))
})

test('unknown or malformed current Launch response never becomes asserted absence or presence', async () => {
  const f = maxWalletPreparationReceiptFixture()
  for (const value of [undefined, {}, { owner: f.preparationInput.request.creator, executable: false, data: Buffer.alloc(0), lamports: Number.MAX_SAFE_INTEGER + 1 }]) {
    const { providers } = maxWalletPreparationRpcProviders(f), read = providers[0].connection.getMultipleAccountsInfoAndContext
    providers[0].connection.getMultipleAccountsInfoAndContext = async (...args) => { const result = await read(...args); result.value[7] = value; return result }
    const result = await collectCustomPreparationEvidence({ ...f, providers })
    assert.equal(result.result.status, 'unresolved'); assert.equal(result.result.currentPrelaunchEligible, false)
    assert.notEqual(result.result.reasonCode, 'CURRENT_LAUNCH_PRESENT')
  }
})
