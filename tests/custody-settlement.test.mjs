import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'
import { prepareCustodySettlement, validateCustodyReceipt, CUSTODY_VAULT } from '../src/custody-settlement.mjs'
import * as settlement from '../src/custody-settlement.mjs'
import { CUSTODY_MEMBERS, prepareCustodyMultisig } from '../src/custody-multisig.mjs'
import { governanceFixture, dbcBatchFixture } from './custody-evidence-fixture.mjs'

const key = n => new PublicKey(Buffer.alloc(32, n))
async function fixture({ role = 'creator' } = {}) {
  const amm = new CpAmm(new Connection('http://localhost:8899'))
  const plan = await prepareCustodySettlement({ amm, pool: key(1), position: key(2), nftAccount: key(3),
    poolState: { tokenAMint: key(4), tokenBMint: NATIVE_MINT, tokenAVault: key(5), tokenBVault: key(6), collectFeeMode: 1 },
    tokenAProgram: TOKEN_2022_PROGRAM_ID, payer: key(7), createAtas: true,
    attribution: { repoId: '42', role, previousOwner: key(8).toBase58(), migration: 'historical',
      mint: key(4).toBase58(), curve: key(9).toBase58(), position: key(2).toBase58() } })
  const multisigPlan = prepareCustodyMultisig({ instructions: plan.instructions, transactionIndex: 1n,
    creator: CUSTODY_MEMBERS[0], rentPayer: key(7), approvers: CUSTODY_MEMBERS.slice(0, 2), executor: CUSTODY_MEMBERS[1] })
  const outer = multisigPlan.executeInstruction
  const event = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), Buffer.from([198,182,183,52,97,12,49,56]),
    key(1).toBuffer(), key(2).toBuffer(), new PublicKey(CUSTODY_VAULT).toBuffer(), Buffer.alloc(16)])
  event.writeBigUInt64LE(10n, event.length - 8)
  const eventIx = new TransactionInstruction({ programId: CP_AMM_PROGRAM_ID, keys: [], data: event })
  const all = [outer, ...plan.instructions, eventIx]
  const keys = [...new Set(all.flatMap(ix => [ix.programId.toBase58(), ...ix.keys.map(k => k.pubkey.toBase58())]))].map(k => new PublicKey(k))
  if (!keys.some(k => k.toBase58() === plan.destination)) keys.push(new PublicKey(plan.destination))
  const compiled = (ix, stackHeight) => ({ programIdIndex: keys.findIndex(k => k.equals(ix.programId)),
    accounts: ix.keys.map(a => keys.findIndex(k => k.equals(a.pubkey))), data: bs58.encode(ix.data), stackHeight })
  const balance = amount => ({ accountIndex: keys.findIndex(k => k.toBase58() === plan.destination), mint: NATIVE_MINT.toBase58(),
    owner: CUSTODY_VAULT, programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount, decimals: 9 } })
  const tx = { slot: 50, transaction: { signatures: ['public-signature'], message: { accountKeys: keys,
    instructions: [compiled(outer)] } }, meta: { err: null, innerInstructions: [{ index: 0,
      instructions: [...plan.instructions.map(i => compiled(i, 2)), compiled(eventIx, 3)] }], preTokenBalances: [balance('5')], postTokenBalances: [balance('15')] } }
  const review = { top: [outer], inner: [{ index: 0, instructions: [ ...plan.instructions.map(instruction => ({ instruction, stackHeight: 2 })), { instruction: eventIx, stackHeight: 3 }] }] }
  return { plan, tx, review, multisigPlan, governanceProof: governanceFixture(multisigPlan), finality: { confirmationStatus: 'finalized', err: null, slot: 50, signature: 'public-signature' } }
}
const verify = f => validateCustodyReceipt(f)
test('raw preparation retains original NFT and emits only ATA creates plus claim; receipt is not payout', async () => {
  const f = await fixture()
  assert.equal(f.plan.claimInstruction.keys[9].pubkey.toBase58(), key(3).toBase58())
  assert.equal(f.plan.claimInstruction.keys[10].pubkey.toBase58(), CUSTODY_VAULT)
  assert.equal(f.plan.instructions.length, 3)
  const receipt = verify(f)
  assert.equal(receipt.amount, 10n)
  assert.equal(receipt.beneficiaryPaid, false)
  assert.equal(receipt.vaultControlVerified, true)
  assert.equal(receipt.attribution.previousOwner, key(8).toBase58())
})
for (const [name, mutate] of Object.entries({
  owner: f => { f.tx.meta.postTokenBalances[0].owner = key(8).toBase58() },
  mint: f => { f.tx.meta.postTokenBalances[0].mint = key(8).toBase58() },
  destination: f => { f.tx.meta.postTokenBalances[0].accountIndex = 0 },
  position: f => { const i = f.tx.meta.innerInstructions[0].instructions[2]; i.accounts[2] = 0 },
  changedInstruction: f => { f.tx.transaction.message.instructions[0].data = bs58.encode(Buffer.from([2])) },
  duplicateClaim: f => { const a = f.tx.meta.innerInstructions[0].instructions; a.push(a[0]) },
  unrelatedLamports: f => { f.tx.meta.postTokenBalances[0].uiTokenAmount.amount = '5'; f.tx.meta.postBalances = [100000] },
  missingData: f => { delete f.tx.meta.preTokenBalances },
  failed: f => { f.tx.meta.err = 'failed' },
  unfinalized: f => { f.finality.confirmationStatus = 'confirmed' },
  alt: f => { f.tx.transaction.message.addressTableLookups = [{}] },
  missingGovernance: f => { delete f.governanceProof },
  crossPositionAttribution: f => { f.plan.attribution = { ...f.plan.attribution, position: key(9).toBase58() } },
  crossMintAttribution: f => { f.plan.attribution = { ...f.plan.attribution, mint: key(9).toBase58() } },
  eventOwner: f => { const i = f.tx.meta.innerInstructions[0].instructions[3]; const b = Buffer.from(bs58.decode(i.data)); key(8).toBuffer().copy(b, 80); i.data = bs58.encode(b) },
})) test(`rejects ${name}`, async () => { const f = await fixture(); mutate(f); assert.throws(() => verify(f)) })
test('top-level PDA claim simulation cannot establish vault control', async () => {
  const f = await fixture()
  f.tx.transaction.message.instructions = [f.tx.meta.innerInstructions[0].instructions[2]]
  f.review.top = [f.plan.claimInstruction]
  assert.throws(() => verify(f))
})
test('even an otherwise reviewed extra claim is rejected', async () => {
  const f = await fixture()
  f.tx.meta.innerInstructions[0].instructions.push(f.tx.meta.innerInstructions[0].instructions[2])
  f.review.inner[0].instructions.push(f.review.inner[0].instructions[2])
  assert.throws(() => verify(f))
})
test('review cannot substitute a different recipient for the prepared claim', async () => {
  const f = await fixture()
  const original = f.plan.claimInstruction
  const wrong = new TransactionInstruction({ programId: original.programId, data: original.data,
    keys: original.keys.map((k, i) => i === 4 ? { ...k, pubkey: key(1) } : k) })
  const ix = f.tx.meta.innerInstructions[0].instructions[2]
  ix.accounts[4] = ix.accounts[1]
  f.review.inner[0].instructions[2].instruction = wrong
  assert.throws(() => verify(f))
})
test('event semantic checks remain mandatory even when the transcript was reviewed', async () => {
  for (const offset of [16, 48, 80]) {
    const f = await fixture()
    const event = f.review.inner[0].instructions[3].instruction
    key(8).toBuffer().copy(event.data, offset)
    f.tx.meta.innerInstructions[0].instructions[3].data = bs58.encode(event.data)
    assert.throws(() => verify(f))
  }
})

test('new vault ATA can start at zero only with exact approved ATA creation and zero pre-lamports', async () => {
  const f = await fixture()
  f.tx.meta.preTokenBalances = []
  f.tx.meta.postTokenBalances[0].uiTokenAmount.amount = '10'
  f.tx.meta.preBalances = f.tx.transaction.message.accountKeys.map(() => 0)
  f.tx.meta.postBalances = f.tx.transaction.message.accountKeys.map(() => 1488440)
  assert.equal(verify(f).amount, 10n)
  f.tx.meta.preBalances[f.tx.meta.postTokenBalances[0].accountIndex] = 1488440
  assert.throws(() => verify(f))
})

test('even a self-consistent reviewed proposal cannot collect to an unapproved noncanonical vault recipient', async () => {
  const f = await fixture()
  const old = f.plan.destination
  f.plan.destination = key(9).toBase58()
  for (const i of f.plan.instructions) for (const k of i.keys) if (k.pubkey.toBase58() === old) k.pubkey = key(9)
  f.tx.transaction.message.accountKeys = f.tx.transaction.message.accountKeys.map(k => k.toBase58() === old ? key(9) : k)
  f.multisigPlan = prepareCustodyMultisig({ ...f.multisigPlan, instructions: f.plan.instructions })
  f.governanceProof = governanceFixture(f.multisigPlan)
  // Rebuild outer indices using the existing set of account addresses.
  const outer = f.multisigPlan.executeInstruction
  f.tx.transaction.message.instructions[0] = { programIdIndex: f.tx.transaction.message.accountKeys.findIndex(k => k.equals(outer.programId)),
    accounts: outer.keys.map(a => f.tx.transaction.message.accountKeys.findIndex(k => k.equals(a.pubkey))), data: bs58.encode(outer.data) }
  f.review.top = [outer]
  assert.throws(() => verify(f))
})

test('separate payout preparation is WSOL only and binds one collection and explicit beneficiary policy', () => {
  assert.equal(typeof settlement.prepareCustodyPayout, 'function')
  const base = { amount: 10n, collectionSignature: 'collection', beneficiary: key(8), payer: key(7), createAta: true,
    beneficiaryBoundAt: '2026-10-22T00:00:00.000Z', attribution: { repoId: '42', role: 'creator' } }
  const payout = settlement.prepareCustodyPayout(base)
  assert.equal(payout.amount, 10n)
  assert.equal(payout.collectionSignature, 'collection')
  assert.equal(payout.instructions.length, 2)
  assert.equal(payout.beneficiary, key(8).toBase58())
  assert.equal(payout.beneficiaryPaid, false)
  assert.throws(() => settlement.prepareCustodyPayout({ ...base, beneficiaryBoundAt: undefined }))
  assert.throws(() => settlement.prepareCustodyPayout({ ...base, amount: 0n }))
  assert.throws(() => settlement.prepareCustodyPayout({ ...base, attribution: { repoId: '42', role: 'partner' } }))
})

function payoutFixture({ createAta = false, role = 'creator' } = {}) {
  const plan = settlement.prepareCustodyPayout({ amount: 10n, collectionSignature: 'public-signature', beneficiary: key(8), payer: key(7), createAta,
    ...(role === 'creator' ? { beneficiaryBoundAt: '2026-10-22T00:00:00.000Z' } : {
      partnerRecipientPolicy: { id: 'reviewed-partner-policy', repoId: '42', recipient: key(8).toBase58() } }),
    attribution: { repoId: '42', role, previousOwner: key(8).toBase58(), migration: 'historical',
      mint: key(4).toBase58(), curve: key(9).toBase58(), position: key(2).toBase58() } })
  const multisigPlan = prepareCustodyMultisig({ instructions: plan.instructions, transactionIndex: 2n, creator: CUSTODY_MEMBERS[0],
    rentPayer: key(7), approvers: CUSTODY_MEMBERS.slice(0, 2), executor: CUSTODY_MEMBERS[1] })
  const outer = multisigPlan.executeInstruction
  const keys = [...new Set([outer, ...plan.instructions].flatMap(ix => [ix.programId.toBase58(), ...ix.keys.map(k => k.pubkey.toBase58())]))]
  const compiled = (ix, stackHeight) => ({ programIdIndex: keys.indexOf(ix.programId.toBase58()),
    accounts: ix.keys.map(k => keys.indexOf(k.pubkey.toBase58())), data: bs58.encode(ix.data), stackHeight })
  const balance = (account, owner, amount) => ({ accountIndex: keys.indexOf(account), mint: NATIVE_MINT.toBase58(), owner,
    programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount, decimals: 9 } })
  const tx = { slot: 51, transaction: { signatures: ['payout-signature'], message: { accountKeys: keys.map(k => new PublicKey(k)), instructions: [compiled(outer)] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: plan.instructions.map(i => compiled(i, 2)) }],
      preTokenBalances: [balance(plan.source, CUSTODY_VAULT, '15'), ...(createAta ? [] : [balance(plan.destination, plan.beneficiary, '2')])],
      postTokenBalances: [balance(plan.source, CUSTODY_VAULT, '5'), balance(plan.destination, plan.beneficiary, createAta ? '10' : '12')],
      preBalances: keys.map(() => 0), postBalances: keys.map(() => 1488440) } }
  return { plan, tx, multisigPlan, governanceProof: governanceFixture(multisigPlan, 51),
    finality: { confirmationStatus: 'finalized', err: null, slot: 51, signature: 'payout-signature' },
    review: { top: [outer], inner: [{ index: 0, instructions: plan.instructions.map(instruction => ({ instruction, stackHeight: 2 })) }] } }
}

test('complete local collection then separate creator/partner payout proofs, including new ATA', async () => {
  for (const role of ['creator', 'partner']) for (const createAta of [false, true]) {
    const collection = verify(await fixture({ role }))
    const f = payoutFixture({ createAta, role })
    const paid = settlement.validateCustodyPayoutReceipt(f)
    assert.equal(paid.amount, collection.amount)
    assert.equal(paid.collectionSignature, collection.signature)
    assert.equal(paid.beneficiary, key(8).toBase58())
    assert.equal(paid.beneficiaryPaid, true)
    assert.equal(paid.attribution.role, role)
    assert.deepEqual(paid.attribution, collection.attribution)
    assert.equal(collection.beneficiaryPaid, false)
    assert.equal(paid.vaultControlVerified, true)
    assert.throws(() => validateCustodyReceipt(f))
  }
})

test('raw v0 getTransaction message without ALTs validates like legacy RPC message', async () => {
  const f = await fixture(), old = f.tx.transaction.message
  f.tx.transaction.message = { staticAccountKeys: old.accountKeys, addressTableLookups: [], compiledInstructions: old.instructions.map(i => ({
    programIdIndex: i.programIdIndex, accountKeyIndexes: i.accounts, data: bs58.decode(i.data) })) }
  assert.equal(verify(f).amount, 10n)
})

test('validated collection writer owns commit/rollback and never accepts bare receipt JSON', async () => {
  assert.equal(typeof settlement.recordValidatedCustodyCollection, 'function')
  const f = await fixture(), queries = []
  const db = { connect: () => { throw Error('A connected pg.Client must not be reconnected') }, query: async (sql) => {
    queries.push(sql)
    if (sql.startsWith('select mint,pool')) return { rows: [{ mint: f.plan.attribution.mint, pool: f.plan.attribution.curve }] }
    if (sql.startsWith('select creator_position')) return { rows: [{ creator_position: f.plan.attribution.position }] }
    if (sql.includes(' as n')) return { rows: [{ n: '0' }] }
    return { rows: [] }
  } }
  await settlement.recordValidatedCustodyCollection(db, f)
  assert.equal(queries[0], 'BEGIN')
  assert.equal(queries.at(-1), 'COMMIT')
  assert(queries.some(s => s.startsWith('insert into custody_fee_collections')))
  queries.length = 0
  await assert.rejects(() => settlement.recordValidatedCustodyCollection(db, { receipt: verify(f) }))
  assert.equal(queries.length, 0)
  const failing = { query: async sql => { queries.push(sql); if (sql.startsWith('select mint')) throw Error('database unavailable'); return { rows: [] } } }
  await assert.rejects(() => settlement.recordValidatedCustodyCollection(failing, f), /database unavailable/)
  assert.equal(queries.at(-1), 'ROLLBACK')
})

test('payout integration wrapper validates before acquiring pool client and releases after commit', async () => {
  assert.equal(typeof settlement.recordValidatedCustodyPayout, 'function')
  const f = payoutFixture(), receipt = settlement.validateCustodyPayoutReceipt(f), calls = []
  const json = JSON.parse(JSON.stringify(receipt, (_k, v) => typeof v === 'bigint' ? String(v) : v))
  const pool = { totalCount: 0, connect: async () => { calls.push('connect'); return { release: () => calls.push('release'), query: async sql => {
    calls.push(sql)
    if (sql.startsWith('select mint,pool')) return { rows: [{ mint: f.plan.attribution.mint, pool: f.plan.attribution.curve }] }
    if (sql.startsWith('select creator_position')) return { rows: [{ creator_position: f.plan.attribution.position }] }
    if (sql.startsWith('select receipt')) return { rows: [{ receipt: json }] }
    return { rows: [] }
  } } } }
  assert.equal((await settlement.recordValidatedCustodyPayout(pool, f)).receipt.kind, 'vault-wsol-beneficiary-payment')
  assert.deepEqual(calls.slice(-2), ['COMMIT', 'release'])
  calls.length = 0
  await assert.rejects(() => settlement.recordValidatedCustodyPayout(pool, { ...f, governanceProof: null }))
  assert.deepEqual(calls, [])
})

for (const [name, mutate] of Object.entries({
  recipient: f => { f.tx.meta.postTokenBalances[1].owner = key(9).toBase58() },
  wrongDelta: f => { f.tx.meta.postTokenBalances[1].uiTokenAmount.amount = '11' },
  wrongDebit: f => { f.tx.meta.postTokenBalances[0].uiTokenAmount.amount = '6' },
  duplicateBalance: f => { f.tx.meta.postTokenBalances.push(f.tx.meta.postTokenBalances[1]) },
  missingSource: f => { f.tx.meta.preTokenBalances.shift() },
  sameSignature: f => { f.finality.signature = f.plan.collectionSignature; f.tx.transaction.signatures[0] = f.plan.collectionSignature },
  governance: f => { f.governanceProof.proposal.data[48] = 3 },
  missingGovernance: f => { delete f.governanceProof },
  duplicateTransfer: f => { f.tx.meta.innerInstructions[0].instructions.push(f.tx.meta.innerInstructions[0].instructions[0]); f.review.inner[0].instructions.push(f.review.inner[0].instructions[0]) },
  reviewedRecipientChange: f => { f.plan.beneficiary = key(9).toBase58() },
  hiddenTopInstruction: f => { f.tx.transaction.message.instructions.push(f.tx.transaction.message.instructions[0]) },
  missingPreExistingAtaBalance: f => { f.tx.meta.preTokenBalances.pop() },
})) test(`payout rejects ${name}`, () => {
  const f = payoutFixture(); mutate(f); assert.throws(() => settlement.validateCustodyPayoutReceipt(f))
})

for (const role of ['creator', 'partner']) test(`DBC ${role}: asymmetric two-pool collection stays two items, never beneficiary payment`, async () => {
  const f = await dbcBatchFixture(role)
  assert.equal(typeof settlement.validateDbcCustodyBatchReceipt, 'function')
  const receipt = settlement.validateDbcCustodyBatchReceipt(f)
  assert.equal(receipt.amount, 408n)
  assert.equal(receipt.beneficiaryPaid, false)
  assert.deepEqual(receipt.items.map(i => [i.itemIndex, i.attribution.repoId, i.amount]), [[0, '101', 101n], [1, '102', 307n]])
  assert.deepEqual(receipt.items.map(i => i.instructionPath), role === 'creator' ? [[0, 0], [0, 3]] : [[0], [1]])
  assert.deepEqual(receipt.items.map(i => i.eventPath), role === 'creator' ? [[0, 2], [0, 5]] : [[0, 1], [1, 1]])
  assert.equal(receipt.authorityRisk, role === 'partner' ? 'exposed-partner-authority' : null)
  assert.throws(() => validateCustodyReceipt(f), 'DBC must not be accepted as DAMM')
})

for (const role of ['creator', 'partner']) test(`DBC ${role}: Token-2022 base mint can collect quote-only WSOL without a base transfer`, async () => {
  const f = await dbcBatchFixture(role, { tokenType: 1 })
  assert.equal(settlement.validateDbcCustodyBatchReceipt(f).amount, 408n)
  f.tx.meta.postTokenBalances[0].uiTokenAmount.amount = '1'
  assert.throws(() => settlement.validateDbcCustodyBatchReceipt(f))
})

for (const role of ['creator', 'partner']) test(`DBC ${role}: single-item and v0 receipts retain canonical paths; oversized batches reject`, async () => {
  const single = await dbcBatchFixture(role, { amounts: [101n] })
  assert.equal(settlement.validateDbcCustodyBatchReceipt(single).items.length, 1)
  assert.equal(settlement.validateDbcCustodyBatchReceipt(single).amount, 101n)
  const f = await dbcBatchFixture(role), old = f.tx.transaction.message
  f.tx.transaction.message = { header: old.header, staticAccountKeys: old.accountKeys, addressTableLookups: [],
    compiledInstructions: old.instructions.map(i => ({ programIdIndex: i.programIdIndex,
      accountKeyIndexes: i.accounts, data: bs58.decode(i.data) })) }
  assert.equal(settlement.validateDbcCustodyBatchReceipt(f).amount, 408n)
  f.tx.transaction.message.addressTableLookups.push({})
  assert.throws(() => settlement.validateDbcCustodyBatchReceipt(f))
  assert.throws(() => settlement.validateDbcCustodyBatchReceipt({ ...single, plan: { ...single.plan, claims: [] } }))
  const large = await dbcBatchFixture(role, { amounts: [101n, 307n, 53n] })
  assert.throws(() => settlement.validateDbcCustodyBatchReceipt(large))
})

for (const role of ['creator', 'partner']) for (const [name, offset, value] of [
  ['wrong event pool', 16, 1], ['nonzero base event', 48, 1], ['inflated quote event', 56, 102], ['wrong event discriminator', 8, 0],
]) test(`DBC ${role}: even reviewed ${name} rejects`, async () => {
  const f = await dbcBatchFixture(role), index = role === 'creator' ? 2 : 1
  const event = f.review.inner[0].instructions[index].instruction
  event.data[offset] = value
  f.tx.meta.innerInstructions[0].instructions[index].data = bs58.encode(event.data)
  assert.throws(() => settlement.validateDbcCustodyBatchReceipt(f))
})

for (const [name, mutate] of Object.entries({
  wrongRole: f => { f.plan.claims[0].attribution.role = 'partner' },
  wrongConfig: f => { f.plan.claims[0].attribution.config = key(100).toBase58() },
  wrongPool: f => { f.plan.claims[0].attribution.curve = key(100).toBase58() },
  duplicatePool: f => { f.plan.claims[1] = f.plan.claims[0] },
  overCap: f => { f.plan.claims[0].maxQuoteAmount = 100n },
  unknownOutcome: f => { f.finality.confirmationStatus = 'confirmed' },
  missingGovernance: f => { f.governanceProof = null },
  staleObservation: f => { f.plan.observation.slot-- },
  changedTotal: f => { f.tx.meta.postTokenBalances.at(-1).uiTokenAmount.amount = '426' },
  exchangedSourceAmounts: f => { f.tx.meta.postTokenBalances[1].uiTokenAmount.amount = '693'; f.tx.meta.postTokenBalances[3].uiTokenAmount.amount = '899' },
  extraNativeMovement: f => { f.tx.meta.postBalances[1]-- },
  missingExistingAta: f => { f.tx.meta.preTokenBalances.pop() },
  duplicateBalance: f => { f.tx.meta.postTokenBalances.push(f.tx.meta.postTokenBalances[0]) },
  changedTokenProgram: f => { f.tx.meta.postTokenBalances.at(-1).programId = TOKEN_2022_PROGRAM_ID.toBase58() },
  extraBaseMovement: f => { f.tx.meta.postTokenBalances[0].uiTokenAmount.amount = '1' },
  zeroQuote: f => { f.plan.claims[0].maxQuoteAmount = 0n },
  failedExecution: f => { f.tx.meta.err = { InstructionError: [0, 'Custom'] } },
  wrongPoolOwner: f => { f.plan.claims[0].poolAccount.owner = TOKEN_PROGRAM_ID.toBase58() },
  wrongConfigDiscriminator: f => { f.plan.claims[0].configAccount.data[0] ^= 1 },
  reviewedExtraMovement: f => {
    f.tx.meta.innerInstructions[0].instructions.push(f.tx.meta.innerInstructions[0].instructions[1])
    f.review.inner[0].instructions.push(f.review.inner[0].instructions[1])
  },
  reviewedDuplicateEvent: f => {
    f.tx.meta.innerInstructions[0].instructions.push(f.tx.meta.innerInstructions[0].instructions[2])
    f.review.inner[0].instructions.push(f.review.inner[0].instructions[2])
  },
})) test(`DBC rejects ${name}`, async () => {
  const f = await dbcBatchFixture(); mutate(f)
  assert.equal(typeof settlement.validateDbcCustodyBatchReceipt, 'function')
  assert.throws(() => settlement.validateDbcCustodyBatchReceipt(f))
})

test('DBC partner collection requires explicit exposed-authority acknowledgement and actual top-level signer', async () => {
  const f = await dbcBatchFixture('partner')
  assert.equal(typeof settlement.validateDbcCustodyBatchReceipt, 'function')
  delete f.plan.partnerReview
  assert.throws(() => settlement.validateDbcCustodyBatchReceipt(f))
  const g = await dbcBatchFixture('partner')
  g.tx.transaction.message.header.numRequiredSignatures = 1
  assert.throws(() => settlement.validateDbcCustodyBatchReceipt(g))
})

test('DBC payout retains explicit collection item identity; old DAMM has no new required parameter', () => {
  const f = payoutFixture()
  const a = { ...f.plan.attribution, phase: 'DBC' }
  const p = settlement.prepareCustodyPayout({ ...f.plan, attribution: a, collectionItemIndex: 1 })
  assert.equal(p.collectionItemIndex, 1)
  assert.throws(() => settlement.prepareCustodyPayout({ ...f.plan, attribution: a }))
  assert.throws(() => settlement.prepareCustodyPayout({ ...f.plan, attribution: a, collectionItemIndex: -1 }))
  assert.throws(() => settlement.prepareCustodyPayout({ ...f.plan, collectionItemIndex: 1 }))
})
