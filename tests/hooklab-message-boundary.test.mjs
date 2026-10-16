import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { inspectHookLabMessage, checkHookLabReviewFreshness, checkHookLabSimulation,
  verifyHookLabSignedMessage, reconcileHookLabReceipts } from '../src/hooklab-message-boundary.mjs'

const sha = b => createHash('sha256').update(b).digest('hex')
const providers = ['fixture-a', 'fixture-b']
// Disposable keys and synthetic transfers only. No RPC, wallet or network submission.
function fixture({ alt = false, extraBudget = false } = {}) {
  const payer = Keypair.generate(), wallet = Keypair.generate(), recipient = Keypair.generate().publicKey
  const raw = Buffer.alloc(88)
  raw.writeUInt32LE(1); raw.writeBigUInt64LE(0xffffffffffffffffn, 4); raw.writeBigUInt64LE(98n, 12)
  recipient.toBuffer().copy(raw, 56)
  const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey,
    state: AddressLookupTableAccount.deserialize(raw) })
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600001 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1001 })]
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [...budget, SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 327 }),
      ...(extraBudget ? [budget[0]] : [])] }).compileToV0Message(alt ? [table] : [])
  const keys = message.getAccountKeys({ addressLookupTableAccounts: alt ? [table] : [] })
  const review = { schema: 'hooklab-message-review/1', operation: 'fixture',
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', profileSha256: 'a'.repeat(64), policySha256: 'b'.repeat(64), intentSha256: 'c'.repeat(64),
    payer: payer.publicKey.toBase58(), wallet: wallet.publicKey.toBase58(),
    messageBase64: Buffer.from(message.serialize()).toString('base64'), messageSha256: sha(message.serialize()),
    requiredSigners: [payer.publicKey.toBase58(), wallet.publicKey.toBase58()],
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: alt ? [{ address: table.key.toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: raw.toString('base64'), sha256: sha(raw) }] : [],
    observedSlot: 100, validUntilSlot: 120, observedAtMs: 1000, reviewExpiresAtMs: 2000, lastValidBlockHeight: 110,
    baseFeeLamports: '10000', maxFeeLamports: '10601', instructionDebitLamports: '327', maxNativeDebitLamports: '10928' }
  const current = { genesisHash: review.genesisHash, wallet: review.wallet, profileSha256: review.profileSha256, policySha256: review.policySha256,
    slot: 120, blockHeight: 110, nowMs: 1999, blockhashValid: true, feeLamports: '10601',
    lookupTableHashes: review.lookupTables.map(({ address, sha256 }) => ({ address, sha256 })) }
  const tx = new VersionedTransaction(message)
  tx.sign([payer, wallet])
  return { review, current, tx, signed: Buffer.from(tx.serialize()).toString('base64') }
}

test('wire review resolves ALT privileges and rounds requested-CU fees; never grants execution', () => {
  for (const alt of [false, true]) {
    const { review } = fixture({ alt })
    const result = inspectHookLabMessage(review)
    assert.equal(result.priorityFeeLamports, '601')
    assert.equal(result.totalFeeLamports, '10601')
    assert.equal(result.instructions.at(-1).program, SystemProgram.programId.toBase58())
    assert.equal(result.canSign, false); assert.equal(result.canSubmit, false); assert.equal(result.policyVerified, false)
    for (const change of [r => { r.maxNativeDebitLamports = '10927' }, r => { r.maxFeeLamports = '10600' },
      r => { r.genesisHash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
      r => { r.accounts[0].writable = false }, r => { r.requiredSigners.reverse() }, r => { r.messageSha256 = 'f'.repeat(64) },
      r => { r.wallet = new PublicKey(Buffer.alloc(32, 19)).toBase58() }, r => { r.messageBase64 += '=' }]) {
      const invalid = structuredClone(review); change(invalid); assert.throws(() => inspectHookLabMessage(invalid))
    }
    if (alt) {
      const invalid = structuredClone(review), raw = Buffer.from(invalid.lookupTables[0].dataBase64, 'base64')
      raw.writeBigUInt64LE(100n, 12) // Same-slot ALT extension must not be usable.
      invalid.lookupTables[0].dataBase64 = raw.toString('base64'); invalid.lookupTables[0].sha256 = sha(raw)
      assert.throws(() => inspectHookLabMessage(invalid), /warmed/)
    }
  }
  assert.throws(() => inspectHookLabMessage(fixture({ extraBudget: true }).review), /budget/)
})

test('review and simulation refuse wallet/network/policy/ALT drift and each expiry boundary', () => {
  const { review, current } = fixture({ alt: true })
  assert.equal(checkHookLabReviewFreshness(review, current).canSign, false)
  for (const patch of [{ slot: 121 }, { slot: 99 }, { nowMs: 2000 }, { nowMs: 999 }, { blockHeight: 111 },
    { blockhashValid: false }, { feeLamports: '10602' }, { lookupTableHashes: [] }, { policySha256: 'e'.repeat(64) },
    { profileSha256: 'e'.repeat(64) }, { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }, { wallet: review.payer }]) {
    assert.throws(() => checkHookLabReviewFreshness(review, { ...current, ...patch }))
  }
  const sim = { messageSha256: review.messageSha256, context: { slot: 119 }, value: { err: null, unitsConsumed: 234567 } }
  assert.equal(checkHookLabSimulation(review, current, sim).postconditionsVerified, false)
  for (const change of [s => { s.messageSha256 = 'd'.repeat(64) }, s => { s.context.slot = 121 },
    s => { s.value.err = { InstructionError: [2, 'Custom'] } }, s => { s.value.unitsConsumed = 600002 },
    s => { s.value.replacementBlockhash = { blockhash: 'replacement' } }]) {
    const invalid = structuredClone(sim); change(invalid); assert.throws(() => checkHookLabSimulation(review, current, invalid))
  }
})

test('retained signatures survive reload/expiry but changed messages or missing signatures fail', () => {
  const { review, signed, tx } = fixture()
  const result = verifyHookLabSignedMessage(JSON.parse(JSON.stringify(review)), signed)
  assert.equal(result.messageSha256, review.messageSha256); assert.equal(result.canSubmit, false)
  tx.signatures[1].fill(0)
  assert.throws(() => verifyHookLabSignedMessage(review, Buffer.from(tx.serialize()).toString('base64')), /signature/)
  const changed = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'))
  changed.message.recentBlockhash = Keypair.generate().publicKey.toBase58()
  assert.throws(() => verifyHookLabSignedMessage(review, Buffer.from(changed.serialize()).toString('base64')), /changed/)
})

test('two-provider recovery retains uncertainty and distinguishes transaction finality from operation success', () => {
  const { review, signed } = fixture(), verified = verifyHookLabSignedMessage(review, signed)
  const receipt = { genesisHash: review.genesisHash, signature: verified.signature, messageSha256: review.messageSha256,
    signedTransactionBase64: signed, slot: 115, error: null, confirmationStatus: 'finalized', feeLamports: '10601' }
  const observations = providers.map(provider => ({ provider, receipt: structuredClone(receipt) }))
  const reconcile = (obs, bindings = providers) => reconcileHookLabReceipts(review, signed, obs, bindings)
  assert.equal(reconcile(observations).status, 'finalized-transaction-only')
  assert.equal(reconcile(observations).postconditionsVerified, false)
  assert.equal(reconcile(observations).canRetry, false)
  assert.equal(reconcile([observations[0], observations[0]]).status, 'unresolved')
  assert.equal(reconcile(observations, ['fixture-a', 'fixture-a']).status, 'unresolved')
  assert.equal(reconcile([]).status, 'unresolved')
  const divergent = structuredClone(observations); divergent[1].receipt.slot++
  assert.equal(reconcile(divergent).status, 'unresolved')
  for (const [patch, status] of [[{ signedTransactionBase64: '' }, 'unresolved'], [{ feeLamports: '10600' }, 'unresolved'],
    [{ confirmationStatus: 'confirmed' }, 'pending-finality'], [{ error: { InstructionError: [2, 'failure'] } }, 'finalized-failure']]) {
    assert.equal(reconcile(observations.map(o => ({ ...o, receipt: { ...o.receipt, ...patch } }))).status, status)
  }
})
