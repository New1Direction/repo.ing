import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { VersionedTransaction, PublicKey } from '@solana/web3.js'
import { deriveCustomPreparationRecord, verifyCustomPreparationEvidence, collectCustomPreparationEvidence,
  collectAndRetainCustomPreparation } from '../src/hooklab-custom-preparation-receipts.mjs'
import { customPreparationReceiptFixture, customPreparationRpcProviders } from './fixtures/hooklab-custom-preparation-receipts.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const disabled = result => {
  for (const key of ['canSign', 'canSubmit', 'canRetry', 'adoption', 'deploymentAdopted', 'artifactAdopted',
    'policyApproved', 'executionAuthorized', 'preparationReceiptAccepted', 'productionPreparationReceiptAccepted',
    'chainVerified', 'historicalStateVerified', 'rentCapEnforcedOnchain']) assert.equal(result[key], false, key)
  assert.equal(result.launchPlan, null); assert.equal(result.productionPreparationReceipt, null)
}
const verify = fixture => { const result = verifyCustomPreparationEvidence(fixture); disabled(result); return result }
const both = (f, callback) => f.observations.forEach(callback)
function failure(f) {
  both(f, o => {
    o.transaction.err = { InstructionError: [2, { Custom: 1 }] }
    o.transaction.postBalances = [...o.transaction.preBalances]
    o.transaction.postBalances[0] = String(BigInt(o.transaction.postBalances[0]) - BigInt(o.transaction.feeLamports))
    o.snapshot = null
  })
  return f
}
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value

test('synthetic exact signed preparation and canonical immutable bytes match with separate or same payer and v0 ALTs', () => {
  for (const samePayer of [false, true]) for (const lookupTable of [false, true]) {
    const f = customPreparationReceiptFixture({ samePayer, lookupTable }), result = verify(f)
    assert.equal(result.status, 'candidate-preparation-matched')
    assert.equal(result.rentLamports, '6000'); assert.equal(result.feePayerNetworkFeeLamports, samePayer ? '15000' : '20000')
    assert.equal(result.nativeDeltasVerified, true); assert.equal(result.currentImmutableStateMatched, true)
    assert.deepEqual(result.providers, ['fixture-a', 'fixture-b']); assert.equal(result.evidenceMode, 'synthetic-fixture')
    assert.equal(result.snapshotSemantics, 'current-immutable-preparation-state-only')
    assert.ok(result.snapshotSlots.every(s => s.relation === 'later-state'))
    assert.equal(result.selectedConfigCreatedAt, '1700000001')
    assert.notEqual(Number(result.selectedConfigCreatedAt), f.observations[0].block.blockTime)
    assert.match(result.selectedConfigCreationTimeProvenance, /not-historical-clock-proof/)
  }
})

test('independent server profile pin and explicit policy ABI cannot be replaced by caller-supplied bytes or accepted flags', () => {
  const f = customPreparationReceiptFixture(), record = deriveCustomPreparationRecord(f.preparationInput, f.expectedProfileSha256)
  disabled(record)
  assert.equal(record.policyKind, 'immutable-canonical-single-blocked-owner')
  assert.equal(record.expectedAccounts.policy.size, 72); assert.equal(record.expectedAccounts.registry.size, 47)
  assert.equal(record.expectedAccounts.selectedConfig.size, 176)
  assert.equal(record.expectedAccounts.selectedConfig.dataBase64, null)
  assert.deepEqual(record.expectedAccounts.selectedConfig.dynamicFields, ['created_at'])
  assert.throws(() => deriveCustomPreparationRecord(f.preparationInput, 'f'.repeat(64)), /PIN/)
  for (const change of [g => { g.preparationInput.expectedAccounts = record.expectedAccounts },
    g => { g.preparationInput.accepted = true }, g => { g.preparationInput.profile.idls.gate = Buffer.from('{}').toString('base64') },
    g => { const p = JSON.parse(g.preparationInput.profile.json); p.capability.kind = 'max-wallet';
      g.preparationInput.profile.json = JSON.stringify(p); g.expectedProfileSha256 = g.preparationInput.profile.expectedSha256 = sha(g.preparationInput.profile.json) },
    g => { delete g.evidenceMode }, g => { g.evidenceMode = 'production-finalized' }]) {
    const g = structuredClone(f); change(g); assert.equal(verify(g).status, 'unresolved')
  }
})

test('all required Ed25519 signatures and exact retained wire are verified, with no silent rebuild', () => {
  const f = customPreparationReceiptFixture()
  const tx = VersionedTransaction.deserialize(Buffer.from(f.signedTransactionBase64, 'base64'))
  for (let i = 0; i < tx.signatures.length; i++) {
    const mutated = VersionedTransaction.deserialize(Buffer.from(f.signedTransactionBase64, 'base64'))
    mutated.signatures[i][0] ^= 1
    assert.equal(verify({ ...f, signedTransactionBase64: Buffer.from(mutated.serialize()).toString('base64') }).status, 'unresolved')
  }
  const changed = VersionedTransaction.deserialize(Buffer.from(f.signedTransactionBase64, 'base64'))
  changed.message.recentBlockhash = new PublicKey(Buffer.alloc(32, 211)).toBase58()
  assert.equal(verify({ ...f, signedTransactionBase64: Buffer.from(changed.serialize()).toString('base64') }).status, 'unresolved')
  assert.equal(verify({ ...f, signedTransactionBase64: f.signedTransactionBase64 + '=' }).status, 'unresolved')
  const g = structuredClone(f); both(g, o => { o.transaction.signedTransactionBase64 = Buffer.from(changed.serialize()).toString('base64') })
  assert.equal(verify(g).reasonCode, 'IDENTITY_MISMATCH')
})

test('canonical digests and normalized result survive PostgreSQL JSONB-like key reordering', () => {
  const f = customPreparationReceiptFixture({ lookupTable: true }), initial = verify(f)
  assert.deepEqual(deriveCustomPreparationRecord(reorder(f.preparationInput), f.expectedProfileSha256), deriveCustomPreparationRecord(f.preparationInput, f.expectedProfileSha256))
  assert.deepEqual(verify(reorder(f)), initial)
  assert.deepEqual(verify({ ...f, observations: initial.observations }), initial)
})

test('missing, duplicate, unknown and swapped configured provider identities cannot become authority', () => {
  const f = customPreparationReceiptFixture()
  for (const change of [g => { g.observations = [] }, g => { g.observations.pop() },
    g => { g.observations[1].provider = g.observations[0].provider }, g => { g.expectedProviders = ['fixture-a', 'fixture-a'] },
    g => { g.expectedProviders.reverse() }, g => { g.observations[1].provider = 'attacker' },
    g => { g.observations[0].transaction = null; g.observations[0].block = null; g.observations[0].snapshot = null },
    g => { g.observations[0].errorCode = 'READ_UNAVAILABLE' }]) {
    const g = structuredClone(f); change(g); assert.equal(verify(g).status, 'unresolved')
  }
  const reverse = structuredClone(f); reverse.observations.reverse()
  assert.equal(verify(reverse).status, 'candidate-preparation-matched')
})

test('caller finality/acceptance claims and unknown fields are rejected; pending commitments remain pending', () => {
  const f = customPreparationReceiptFixture()
  for (const change of [o => { o.accepted = true }, o => { o.finalized = true }, o => { o.transaction.accepted = true },
    o => { o.snapshot.accounts[0].expectedDataBase64 = o.snapshot.accounts[0].dataBase64 },
    o => { o.snapshot.accepted = true }]) {
    const g = structuredClone(f); both(g, change); assert.equal(verify(g).reasonCode, 'INVALID_EVIDENCE')
  }
  for (const change of [o => { o.transactionCommitment = 'confirmed' }, o => { o.blockCommitment = 'processed' }, o => { o.snapshot.commitment = 'confirmed' }]) {
    const g = structuredClone(f); both(g, change); assert.equal(verify(g).status, 'pending-finality')
  }
})

test('finalized inclusion binds slot, block identity, signature uniqueness and reviewed lifetime', () => {
  const f = customPreparationReceiptFixture()
  for (const change of [o => { o.genesisHash = new PublicKey(Buffer.alloc(32, 120)).toBase58() },
    o => { o.block.slot++ }, o => { o.block.parentSlot = o.block.slot }, o => { o.block.previousBlockhash = o.block.blockhash },
    o => { o.block.blockHeight = 251 }, o => { o.block.blockHeight = null }, o => { o.block.blockTime++ },
    o => { o.block.signatures.push(o.block.signatures[0]) }, o => { o.block.signatures = [] },
    o => { o.transaction.slot = o.block.slot = 99 }, o => { o.transaction.slot = o.block.slot = 151 },
    o => { o.block.signatures = [o.block.signatures[0].split('').reverse().join('')] }]) {
    const g = structuredClone(f); both(g, change); assert.equal(verify(g).status, 'unresolved')
  }
  const disagreement = structuredClone(f); disagreement.observations[1].block.blockhash = new PublicKey(Buffer.alloc(32, 162)).toBase58()
  assert.equal(verify(disagreement).reasonCode, 'EVIDENCE_DISAGREEMENT')
})

test('v0 resolved loaded-address inventory and privileges must match the retained lookup table', () => {
  const f = customPreparationReceiptFixture({ lookupTable: true })
  for (const change of [o => { o.transaction.loadedAddresses.readonly.reverse() },
    o => { o.transaction.loadedAddresses.writable[0] = o.transaction.loadedAddresses.readonly[0] },
    o => { o.transaction.loadedAddresses.readonly.push(o.transaction.loadedAddresses.readonly[0]) },
    o => { o.transaction.loadedAddresses.writable.pop() }, o => { o.transaction.preBalances.pop() }]) {
    const g = structuredClone(f); both(g, change); assert.equal(verify(g).status, 'unresolved')
  }
  const plain = customPreparationReceiptFixture(); both(plain, o => { o.transaction.loadedAddresses.readonly.push(plain.preparationInput.request.creator) })
  assert.equal(verify(plain).status, 'unresolved')
})

test('strict owners, exact allocations, all policy/registry/config bytes and nonexecutable state are required', () => {
  const f = customPreparationReceiptFixture()
  for (let i = 0; i < 3; i++) for (const mutate of [a => { a.owner = f.preparationInput.request.creator },
    a => { a.address = f.preparationInput.request.mint }, a => { a.executable = true },
    a => { a.dataBase64 += '=' }, a => { a.dataBase64 = Buffer.concat([Buffer.from(a.dataBase64, 'base64'), Buffer.from([0])]).toString('base64') },
    a => { const b = Buffer.from(a.dataBase64, 'base64'); b[0] ^= 1; a.dataBase64 = b.toString('base64') },
    a => { const b = Buffer.from(a.dataBase64, 'base64'); b[b.length - 1] ^= 1; a.dataBase64 = b.toString('base64') }]) {
    const g = structuredClone(f); both(g, o => mutate(o.snapshot.accounts[i])); assert.equal(verify(g).status, 'unresolved')
  }
  for (const mutate of [o => { o.snapshot.slot = 111 }, o => { o.snapshot.accounts.reverse() }, o => { o.snapshot.accounts.pop() }]) {
    const g = structuredClone(f); both(g, mutate); assert.equal(verify(g).status, 'unresolved')
  }
  const g = structuredClone(f); g.observations[1].snapshot.accounts[0].dataBase64 = g.observations[1].snapshot.accounts[1].dataBase64
  assert.equal(verify(g).reasonCode, 'EVIDENCE_DISAGREEMENT')
})

test('later snapshot balances are never substituted for historical rent/debit deltas', () => {
  const f = customPreparationReceiptFixture()
  f.observations[0].snapshot.accounts[0].lamports = '500000'
  f.observations[1].snapshot.accounts[0].lamports = '700000'
  const result = verify(f)
  assert.equal(result.status, 'candidate-preparation-matched'); assert.equal(result.rentLamports, '6000')
  const g = structuredClone(f)
  both(g, o => { const i = o.transaction.preBalances.findIndex(n => n === '0'); o.transaction.postBalances[i] = '0' })
  assert.equal(verify(g).reasonCode, 'ECONOMIC_MISMATCH')
})

test('native fees, rent, creator/payer deltas and all unrelated account deltas obey original bounds', () => {
  for (const samePayer of [false, true]) {
    const f = customPreparationReceiptFixture({ samePayer })
    for (const change of [t => { t.feeLamports = '1' }, t => { t.postBalances[0] = t.preBalances[0] },
      t => { t.postBalances[t.postBalances.length - 1] = String(BigInt(t.postBalances.at(-1)) + 1n) },
      t => { const i = t.preBalances.findIndex(n => n === '0'); t.preBalances[i] = '1' },
      t => { const i = t.preBalances.findIndex(n => n === '0'); t.postBalances[i] = '999' },
      t => { const i = t.preBalances.findIndex(n => n === '0'); t.postBalances[i] = '6001' }]) {
      const g = structuredClone(f); both(g, o => change(o.transaction)); assert.equal(verify(g).reasonCode, 'ECONOMIC_MISMATCH')
    }
  }
})

test('unsafe numbers, noncanonical amounts, unbounded evidence and cycles fail closed', () => {
  const f = customPreparationReceiptFixture()
  for (const value of [9007199254740992, '9007199254740992', '-1', '01', '1e3', '18446744073709551615', null]) {
    const g = structuredClone(f); both(g, o => { o.transaction.preBalances[0] = value }); assert.equal(verify(g).reasonCode, 'INVALID_EVIDENCE')
  }
  const huge = structuredClone(f); huge.observations[0].transaction.err = { error: 'x'.repeat(4 * 1024 * 1024) }
  assert.equal(verify(huge).status, 'unresolved')
  const cycle = structuredClone(f); cycle.observations[0].cycle = cycle.observations
  assert.equal(verify(cycle).reasonCode, 'INVALID_EVIDENCE')
})

test('agreeing finalized failures retain exact fee-only rollback and never enable retry', () => {
  for (const samePayer of [false, true]) {
    const f = failure(customPreparationReceiptFixture({ samePayer })), result = verify(f)
    assert.equal(result.status, 'finalized-failure'); assert.equal(result.rentLamports, '0')
    for (const change of [o => { o.transaction.feeLamports = '1' }, o => { o.transaction.postBalances[1] = '42' },
      o => { o.transaction.postBalances[0] = o.transaction.preBalances[0] }]) {
      const g = structuredClone(f); both(g, change); assert.equal(verify(g).reasonCode, 'ECONOMIC_MISMATCH')
    }
    const g = structuredClone(f); g.observations[1].transaction.err = null
    assert.equal(verify(g).reasonCode, 'EVIDENCE_DISAGREEMENT')
  }
})


test('collector requires independently configured nonalias connections and rejects caller-shaped setup', async () => {
  const f = customPreparationReceiptFixture()
  for (const change of [p => { p[1].provider = p[0].provider }, p => { p[1].connection = p[0].connection },
    p => { p[1].connection.rpcEndpoint = p[0].connection.rpcEndpoint }, p => { p.reverse() }, p => { delete p[1].connection.getBlockSignatures }]) {
    const { providers } = customPreparationRpcProviders(f); change(providers)
    await assert.rejects(collectCustomPreparationEvidence({ ...f, providers }), /PROVIDER_BINDING/)
  }
  const { providers } = customPreparationRpcProviders(f)
  await assert.rejects(collectCustomPreparationEvidence({ ...f, providers, evidenceMode: undefined }))
  await assert.rejects(collectCustomPreparationEvidence({ ...f, providers, limits: { readTimeoutMs: 5001 } }))
})

test('collector timeouts, nulls, failed receipts and unsafe typed RPC numbers are bounded and redacted', async () => {
  const f = customPreparationReceiptFixture()
  {
    const { providers, calls } = customPreparationRpcProviders(f)
    providers[0].connection.getGenesisHash = async () => { throw Error('https://secret.invalid?api_key=do-not-leak') }
    const r = await collectCustomPreparationEvidence({ ...f, providers })
    assert.equal(r.result.status, 'unresolved'); assert.doesNotMatch(JSON.stringify(r), /do-not-leak|secret.invalid/)
    assert.equal(calls.filter(c => c.provider === 'fixture-a').length, 0)
  }
  {
    const { providers } = customPreparationRpcProviders(f)
    providers[0].connection.getGenesisHash = async () => new Promise(() => {})
    const begin = Date.now(), r = await collectCustomPreparationEvidence({ ...f, providers, limits: { readTimeoutMs: 20, collectionTimeoutMs: 100 } })
    assert.equal(r.observations[0].errorCode, 'READ_TIMEOUT'); assert.ok(Date.now() - begin < 1000)
  }
  {
    const { providers, calls } = customPreparationRpcProviders(f)
    providers[0].connection.getTransaction = async () => null
    const r = await collectCustomPreparationEvidence({ ...f, providers }); assert.equal(r.result.status, 'unresolved')
  }
  {
    const g = failure(structuredClone(f)), { providers, calls } = customPreparationRpcProviders(g)
    const r = await collectCustomPreparationEvidence({ ...g, providers }); assert.equal(r.result.status, 'finalized-failure')
    assert.equal(calls.length, 6); assert.ok(!calls.some(c => c.method === 'getMultipleAccountsInfoAndContext'))
  }
  {
    const { providers } = customPreparationRpcProviders(f), get = providers[0].connection.getTransaction
    providers[0].connection.getTransaction = async (...args) => { const tx = await get(...args); tx.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1; return tx }
    const r = await collectCustomPreparationEvidence({ ...f, providers }); assert.equal(r.result.status, 'unresolved')
  }
})

test('current program snapshots bind pinned immutable source bytes and pre-transaction loader deployment', () => {
  const f = customPreparationReceiptFixture(), base = verify(f)
  assert.equal(base.currentPinnedProgramBytesMatched, true)
  assert.equal(base.tokenDependencyProvenanceVerified, false)
  assert.match(base.loaderHistoryAssumption, /no-historical-replay/)
  for (const mutate of [o => { o.programSnapshot = null }, o => { o.programSnapshot.slot++ },
    o => { o.programSnapshot.accounts.reverse() }, o => { o.programSnapshot.accounts[0].owner = f.preparationInput.request.creator },
    o => { o.programSnapshot.accounts[0].executable = false }, o => { o.programSnapshot.accounts[2].executable = true },
    o => { o.programSnapshot.accounts[2].address = f.preparationInput.request.creator }]) {
    const g = structuredClone(f); both(g, mutate); assert.equal(verify(g).status, 'unresolved')
  }
  for (const index of [2, 3]) for (const mutate of [b => { b.writeBigUInt64LE(112n, 4); return b },
    b => { b.writeBigUInt64LE(113n, 4); return b }, b => { b[45] ^= 1; return b }, b => Buffer.concat([b, Buffer.from([1])])]) {
    const g = structuredClone(f)
    both(g, o => { const account = o.programSnapshot.accounts[index]; account.dataBase64 = mutate(Buffer.from(account.dataBase64, 'base64')).toString('base64') })
    assert.equal(verify(g).reasonCode, 'SOURCE_MISMATCH')
  }
  for (const offset of [12]) {
    const g = structuredClone(f)
    both(g, o => { const account = o.programSnapshot.accounts[3], bytes = Buffer.from(account.dataBase64, 'base64'); bytes[offset] = 1; account.dataBase64 = bytes.toString('base64') })
    assert.equal(verify(g).reasonCode, 'SOURCE_MISMATCH')
  }
  const oldAuthority = structuredClone(f)
  both(oldAuthority, o => { const account = o.programSnapshot.accounts[3], bytes = Buffer.from(account.dataBase64, 'base64'); bytes[13] = 42; account.dataBase64 = bytes.toString('base64') })
  assert.equal(verify(oldAuthority).status, 'candidate-preparation-matched')
  const link = structuredClone(f)
  both(link, o => { const account = o.programSnapshot.accounts[0], bytes = Buffer.from(account.dataBase64, 'base64'); bytes[4] ^= 1; account.dataBase64 = bytes.toString('base64') })
  assert.equal(verify(link).reasonCode, 'SOURCE_MISMATCH')
  const disagreement = structuredClone(f)
  disagreement.observations[1].programSnapshot.accounts[0].dataBase64 = disagreement.observations[1].programSnapshot.accounts[1].dataBase64
  assert.equal(verify(disagreement).reasonCode, 'SOURCE_MISMATCH')
})

test('seven-account source capture rejects unsafe metadata and mismatched snapshots without extra reads', async () => {
  const f = customPreparationReceiptFixture(), { providers, calls } = customPreparationRpcProviders(f)
  const read = providers[0].connection.getMultipleAccountsInfoAndContext
  providers[0].connection.getMultipleAccountsInfoAndContext = async (...args) => {
    const response = await read(...args); response.value[6].data[12] = 1; return response
  }
  const result = await collectCustomPreparationEvidence({ ...f, providers })
  assert.equal(result.result.reasonCode, 'SOURCE_MISMATCH')
  assert.equal(calls.length, 8)
})

test('server-only orchestration retains collected assertions and refuses caller observations or authority flags', async () => {
  const f = customPreparationReceiptFixture(), { providers } = customPreparationRpcProviders(f), retained = []
  const journal = { async retain(owner, id, payload) { retained.push({ owner, id, payload }); return { id, status: verifyCustomPreparationEvidence({ ...f, ...payload }).status } } }
  const args = { journal, owner: 'fixture-owner', id: 'fixture-record', preparationInput: f.preparationInput,
    signedTransactionBase64: f.signedTransactionBase64, providers, expectedProfileSha256: f.expectedProfileSha256, evidenceMode: 'synthetic-fixture' }
  const result = await collectAndRetainCustomPreparation(args)
  disabled(result)
  assert.equal(retained.length, 1); assert.equal(retained[0].owner, 'fixture-owner')
  assert.deepEqual(retained[0].payload.observations, result.collection.result.observations)
  assert.equal(result.record.status, 'candidate-preparation-matched')
  for (const extra of [{ observations: f.observations }, { accepted: true }, { finalized: true }, { result: result.collection.result }]) {
    await assert.rejects(collectAndRetainCustomPreparation({ ...args, ...extra }), /UNSUPPORTED_COLLECTION_ARGUMENT/)
  }
  assert.equal(retained.length, 1)
})

test('collector bounds typed rows and bytes before retention while unused rounded rentEpoch never supplies evidence', async () => {
  const f = customPreparationReceiptFixture()
  {
    const { providers } = customPreparationRpcProviders(f)
    for (const { connection } of providers) {
      const get = connection.getMultipleAccountsInfoAndContext
      connection.getMultipleAccountsInfoAndContext = async (...args) => {
        const response = await get(...args); response.value.forEach(a => { a.rentEpoch = 18446744073709551615 }); return response
      }
    }
    const result = await collectCustomPreparationEvidence({ ...f, providers })
    assert.equal(result.result.status, 'candidate-preparation-matched')
    assert.ok(result.observations.every(o => o.snapshot.accounts.every(a => !Object.hasOwn(a, 'rentEpoch'))))
  }
  for (const method of ['getTransaction', 'getBlockSignatures', 'getMultipleAccountsInfoAndContext']) {
    const { providers } = customPreparationRpcProviders(f), get = providers[0].connection[method]
    providers[0].connection[method] = async (...args) => {
      const response = await get(...args)
      if (method === 'getTransaction') response.logMessages = ['x'.repeat(4 * 1024 * 1024 + 1)]
      if (method === 'getBlockSignatures') response.signatures = Array(16385).fill(response.signatures[0])
      if (method === 'getMultipleAccountsInfoAndContext') response.value[6].data = Buffer.alloc(4 * 1024 * 1024)
      return response
    }
    const result = await collectCustomPreparationEvidence({ ...f, providers })
    assert.equal(result.result.status, 'unresolved'); assert.equal(result.observations[0].errorCode, 'EVIDENCE_LIMIT')
  }
})
