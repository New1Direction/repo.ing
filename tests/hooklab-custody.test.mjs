import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, pbkdf2Sync, createDecipheriv } from 'node:crypto'
import bs58 from 'bs58'
import { createHookLabCustody, unlockHookLabCustody, normalizeHookLabBinding, hookLabCustodyCapabilities } from '../app/lib/hooklab-custody.mjs'
import { openHookLabCustodyStore } from '../app/lib/hooklab-custody-store.mjs'
import { reconcileHookLabStep } from '../app/lib/hooklab-reconciliation.mjs'

// No network, wallets, funds, or chain writes. Every signature uses a fresh disposable test key.
const passphrase = 'disposable test recovery passphrase'
const addr = n => bs58.encode(new Uint8Array(32).fill(n))
const binding = wallet => ({ schemaVersion: 'hooklab-binding/1', wallet, genesisHash: addr(7), recipeDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), programs: [{ address: addr(8), sha256: 'c'.repeat(64) }], configs: [{ address: addr(9), sha256: 'd'.repeat(64) }] })
function memoryStore() {
  const data = new Map()
  return {
    data,
    async load(id) { return data.get(id) ?? null },
    async compareAndSwap(id, expected, next) {
      if ((data.get(id) ?? null) !== expected) return false
      data.set(id, next); return true
    },
  }
}
async function fixture() {
  const wallet = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const walletAddress = bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw', wallet.publicKey)))
  const options = { store: memoryStore(), id: 'test-launch', binding: binding(walletAddress), passphrase }
  const vault = await createHookLabCustody(options)
  const review = { stepId: 'create-config', messageBytes: new Uint8Array([1, 7, 19, 23, 249]), requiredSigners: [walletAddress], expiry: { blockhash: addr(10), lastValidBlockHeight: 120 }, reviewedAtBlockHeight: 100 }
  const sign = async bytes => new Uint8Array(await crypto.subtle.sign('Ed25519', wallet.privateKey, bytes))
  return { options, vault, review, sign, walletAddress }
}

test('identities survive encrypted retention; server projection contains only public identity and binding', async () => {
  const { options, vault, review } = await fixture()
  await vault.recordReview(review)
  const before = vault.snapshot(), publicIdentity = vault.publicIdentity()
  assert.notEqual(before.identities.mint, before.identities.config)
  assert.deepEqual(hookLabCustodyCapabilities, { execution: false, signing: false, sending: false })
  assert.equal(vault.sign, undefined); assert.equal(vault.send, undefined)
  assert.equal(before.executionEnabled, false)
  assert.deepEqual(Object.keys(publicIdentity), ['schemaVersion', 'id', 'binding', 'mint', 'config'])
  assert.doesNotMatch(JSON.stringify(publicIdentity), /privateKey|signature|messageBase64|passphrase/)
  const stored = await options.store.load(options.id), envelope = JSON.parse(stored)
  assert.doesNotMatch(stored, /privateKey|create-config|messageBase64|disposable/)
  assert.equal(stored.includes(before.identities.mint), false)
  // Independently recover PKCS#8 with Node crypto, proving retained private keys match both public identities.
  const key = pbkdf2Sync(passphrase, Buffer.from(envelope.salt, 'base64'), 600000, 32, 'sha256')
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAAD(Buffer.from(`hooklab-custody/1:${options.id}`)); decipher.setAuthTag(ciphertext.subarray(-16))
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
  const retained = JSON.parse(plaintext)
  for (const role of ['mint', 'config']) {
    const privateKey = createPrivateKey({ key: Buffer.from(retained.identities[role].privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' })
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' })
    assert.equal(bs58.encode(Buffer.from(jwk.x, 'base64url')), before.identities[role])
  }
  plaintext.fill(0); key.fill(0)
  vault.lock()
  assert.throws(() => vault.snapshot(), /locked/)
  const reopened = await unlockHookLabCustody(options)
  assert.deepEqual(reopened.snapshot(), before)
  assert.throws(() => { reopened.snapshot().events[0].expiry.lastValidBlockHeight = 999 }, TypeError)
  await assert.rejects(createHookLabCustody(options), /already exists/)
  assert.equal(await options.store.load(options.id), stored)
})

test('wrong passphrase, modified ciphertext and cross-record replay fail without generating replacements', async () => {
  const { options, vault } = await fixture()
  vault.lock()
  const stored = await options.store.load(options.id)
  await assert.rejects(unlockHookLabCustody({ ...options, passphrase: 'incorrect recovery passphrase' }), /Unable to unlock/)
  options.store.data.set('other-launch', stored)
  await assert.rejects(unlockHookLabCustody({ ...options, id: 'other-launch' }), /Unable to unlock/)
  const envelope = JSON.parse(stored), ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  ciphertext[35] ^= 1; envelope.ciphertext = ciphertext.toString('base64')
  options.store.data.set(options.id, JSON.stringify(envelope))
  await assert.rejects(unlockHookLabCustody(options), /Unable to unlock/)
  assert.equal(await options.store.load(options.id), JSON.stringify(envelope))
  await assert.rejects(unlockHookLabCustody({ ...options, id: 'missing' }), /not found/)
  await assert.rejects(openHookLabCustodyStore({ indexedDB: null }), /no volatile fallback/)
})

test('review bytes, signer order and expiry are immutable; signatures must verify those exact bytes', async () => {
  const { options, vault, review, sign, walletAddress } = await fixture()
  const originalBytes = review.messageBytes.slice()
  const write = vault.recordReview(review)
  review.messageBytes[0] = 99; review.expiry.lastValidBlockHeight = 900
  const reviewed = (await write).events[0]
  assert.equal(reviewed.messageBase64, Buffer.from(originalBytes).toString('base64'))
  assert.equal(reviewed.messageSha256, createHash('sha256').update(originalBytes).digest('hex'))
  assert.equal(reviewed.expiry.lastValidBlockHeight, 120)
  await assert.rejects(vault.recordReview(review), /immutable/)
  const input = { stepId: review.stepId, signer: walletAddress, observedBlockHeight: 121, signatureBytes: await sign(review.messageBytes) }
  await assert.rejects(vault.recordSignature(input), /immutable reviewed bytes/)
  await assert.rejects(vault.recordSignature({ ...input, signer: addr(13) }), /not reviewed/)
  input.signatureBytes = await sign(originalBytes)
  // Expiry and invalidation prohibit new reviews, not retention of already-existing recovery evidence.
  await vault.checkBinding(null)
  const signature = bs58.encode(input.signatureBytes)
  const signatureWrite = vault.recordSignature(input); input.signatureBytes.fill(0)
  assert.equal((await signatureWrite).events.at(-1).signature, signature)
  await assert.rejects(vault.recordSignature(input), /immutable/)
  await assert.rejects(vault.recordSubmissionObservation({ stepId: review.stepId, signature: 'wrong' }), /fee payer/)
  await vault.recordSubmissionObservation({ stepId: review.stepId, signature })
  const reopened = await unlockHookLabCustody(options)
  assert.deepEqual(reopened.snapshot(), vault.snapshot())
  assert.deepEqual(reopened.snapshot().events.map(event => event.sequence), [1, 2, 3, 4])
  await assert.rejects(reopened.recordReview({ ...review, stepId: 'second-step' }), /invalidated/)
})

test('wallet, network, recipe and all pin changes permanently invalidate reviews, including across reload', async () => {
  const { options, vault, review } = await fixture()
  const programs = [...options.binding.programs, { address: addr(19), sha256: 'e'.repeat(64) }]
  assert.deepEqual(normalizeHookLabBinding({ ...options.binding, programs }), normalizeHookLabBinding({ ...options.binding, programs: [...programs].reverse(), privateKey: 'must-not-survive' }))
  await vault.recordReview(review)
  const original = await options.store.load(options.id)
  const mutations = [null, {}, { wallet: addr(2) }, { genesisHash: addr(3) }, { recipeDigest: 'e'.repeat(64) }, { manifestDigest: 'f'.repeat(64) }, { programs: [{ address: addr(4), sha256: 'c'.repeat(64) }] }, { configs: [{ address: addr(9), sha256: 'e'.repeat(64) }] }]
  for (const change of mutations) {
    const store = memoryStore(); store.data.set(options.id, original)
    const opened = await unlockHookLabCustody({ ...options, store })
    await opened.checkBinding(change === null ? null : Object.keys(change).length ? { ...options.binding, ...change } : {})
    await opened.checkBinding(options.binding)
    await assert.rejects(opened.recordReview({ ...review, stepId: 'second-step' }), /invalidated/)
    const reloaded = await unlockHookLabCustody({ ...options, store })
    assert.equal(reloaded.snapshot().events.at(-1).type, 'binding-invalidated')
    assert.deepEqual(reloaded.snapshot().identities, vault.snapshot().identities)
  }
  const changedOnUnlock = await unlockHookLabCustody({ ...options, binding: { ...options.binding, wallet: addr(3) } })
  await assert.rejects(changedOnUnlock.recordReview({ ...review, stepId: 'second-step' }), /invalidated/)
  const recoveryStore = memoryStore(); recoveryStore.data.set(options.id, original)
  const offline = await unlockHookLabCustody({ ...options, store: recoveryStore, binding: null })
  assert.deepEqual(offline.publicIdentity(), vault.publicIdentity())
  await assert.rejects(offline.recordReview({ ...review, stepId: 'offline-attempt' }), /invalidated/)
  assert.equal((await unlockHookLabCustody({ ...options, store: recoveryStore })).snapshot().events.at(-1).type, 'binding-invalidated')
  assert.throws(() => normalizeHookLabBinding({ ...options.binding, schemaVersion: 'unknown' }), /version/)
  assert.throws(() => normalizeHookLabBinding({ ...options.binding, programs: [] }), /pins/)
})

test('concurrent creation and stale tabs cannot replace identities or lose committed steps', async () => {
  const { options, vault, review } = await fixture()
  const other = await unlockHookLabCustody(options)
  await vault.recordReview(review)
  await assert.rejects(other.recordReview({ ...review, stepId: 'other-step' }), /another session/)
  assert.throws(() => other.snapshot(), /locked/)
  assert.deepEqual((await unlockHookLabCustody(options)).snapshot(), vault.snapshot())
  const store = memoryStore()
  const created = await Promise.allSettled([createHookLabCustody({ ...options, store }), createHookLabCustody({ ...options, store })])
  assert.equal(created.filter(result => result.status === 'fulfilled').length, 1)
  const winner = created.find(result => result.status === 'fulfilled').value
  assert.deepEqual((await unlockHookLabCustody({ ...options, store })).snapshot().identities, winner.snapshot().identities)
})

test('storage failure, disconnect and locking during writes preserve recoverable journal outcomes', async () => {
  const { options, vault, review } = await fixture()
  const stored = await options.store.load(options.id), write = options.store.compareAndSwap
  options.store.compareAndSwap = async () => { throw Error('quota exceeded') }
  await assert.rejects(vault.recordReview(review), /quota/)
  assert.equal(vault.snapshot().revision, 0); assert.equal(await options.store.load(options.id), stored)
  await assert.rejects(vault.checkBinding(null), /quota/)
  await assert.rejects(vault.recordReview(review), /invalidated/)
  options.store.compareAndSwap = write
  await vault.checkBinding(null)
  assert.equal(vault.snapshot().events[0].type, 'binding-invalidated')

  const fresh = await fixture()
  const pending = fresh.vault.recordReview(fresh.review), invalidation = fresh.vault.checkBinding(null)
  await assert.rejects(pending, /invalidated/); await invalidation
  assert.deepEqual(fresh.vault.snapshot().events.map(event => event.type), ['binding-invalidated'])

  const locked = await fixture(), originalWrite = locked.options.store.compareAndSwap
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  locked.options.store.compareAndSwap = async (...args) => {
    entered.resolve(); await release.promise
    return originalWrite(...args)
  }
  const inFlight = locked.vault.recordReview(locked.review)
  await entered.promise; locked.vault.lock(); release.resolve()
  await assert.rejects(inFlight, /locked during write/)
  assert.throws(() => locked.vault.snapshot(), /locked/)
  assert.equal((await unlockHookLabCustody(locked.options)).snapshot().events[0].stepId, locked.review.stepId)
})

test('finality reconciliation is pure, network/signature bound, and never turns missing or nonfinal evidence into retry permission', async () => {
  const { vault, options, review, sign, walletAddress } = await fixture()
  assert.equal(reconcileHookLabStep(vault.snapshot(), review.stepId).state, 'unreviewed')
  await vault.recordReview(review)
  const evidence = { genesisHash: options.binding.genesisHash, finalizedBlockHeight: 120 }
  assert.equal(reconcileHookLabStep(vault.snapshot(), review.stepId, evidence).state, 'reviewed')
  assert.equal(reconcileHookLabStep(vault.snapshot(), review.stepId, { ...evidence, finalizedBlockHeight: 121 }).state, 'expired-unproven')
  const signatureBytes = await sign(review.messageBytes)
  await vault.recordSignature({ stepId: review.stepId, signer: walletAddress, signatureBytes, observedBlockHeight: 120 })
  await vault.checkBinding(null) // Finality remains inspectable even after consent is gone.
  const snapshot = vault.snapshot(), stored = await options.store.load(options.id)
  const signedEvidence = { ...evidence, signature: bs58.encode(signatureBytes), finalizedBlockHeight: 500, historySearched: true }
  const cases = [
    [undefined, 'ambiguous'],
    [{ ...signedEvidence, status: null }, 'ambiguous'],
    [{ ...signedEvidence, genesisHash: addr(5), status: { slot: 40, err: null, confirmationStatus: 'finalized' } }, 'ambiguous'],
    [{ ...signedEvidence, signature: 'wrong', status: { slot: 40, err: null, confirmationStatus: 'finalized' } }, 'ambiguous'],
    ...['processed', 'confirmed'].flatMap(confirmationStatus => [null, { InstructionError: [1, 'failure'] }].map(err => [{ ...signedEvidence, status: { slot: 40, err, confirmationStatus } }, 'pending-finality'])),
    [{ ...signedEvidence, status: { slot: 40, err: null, confirmationStatus: 'finalized' } }, 'finalized-success'],
    [{ ...signedEvidence, status: { slot: 40, err: { InstructionError: [1, 'failure'] }, confirmationStatus: 'finalized' } }, 'finalized-failure'],
    [{ ...signedEvidence, status: { slot: 40, confirmationStatus: 'finalized' } }, 'ambiguous'],
  ]
  for (const [input, state] of cases) {
    const result = reconcileHookLabStep(snapshot, review.stepId, input)
    assert.equal(result.state, state)
    assert.equal(result.canRetry, false); assert.equal(result.executionEnabled, false); assert.equal(result.launchReady, false)
  }
  assert.equal(await options.store.load(options.id), stored)
  assert.deepEqual(vault.snapshot(), snapshot)
})
