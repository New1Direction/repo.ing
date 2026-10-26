// Bounded offline Squads v4 codec. Layouts checked against @sqds/multisig 2.1.4
// src/{pda,types,utils}.ts and generated/{accounts,instructions,types}.
// No ALTs, ephemeral signers, batches, config transactions, or spending-limit executes.
import { createHash } from 'node:crypto'
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import bs58 from 'bs58'

export const SQUADS_PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf'
export const CUSTODY_MULTISIG = 'Fib7FBLr2wF4uNS15woRRBHj4bimPiW1871tF2AJqfA4'
export const MULTISIG_VAULT = '3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs'
export const CUSTODY_MEMBERS = Object.freeze(['DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',
  '29PFd4PtThcz1wTK1yRSKAjjZqTjrAzRCx9M6QexxK45', '5rtoi4yqmzDofBqkMx5e89zu9vpVbPFBkB2YWiFDv3Vu'])
const pk = x => new PublicKey(x)
const addr = x => pk(x).toBase58()
export const custodyAssert = (ok) => { if (!ok) throw Error('Custody governance/message evidence mismatch') }
const u = (n, size) => { const b = Buffer.alloc(size); size === 8 ? b.writeBigUInt64LE(BigInt(n)) : b.writeUIntLE(n, 0, size); return b }
const vec = (b, size = 4) => Buffer.concat([u(b.length, size), Buffer.from(b)])
const tag = (namespace, name) => createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8)
const pda = seeds => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(SQUADS_PROGRAM))
const meta = (key, isWritable = false, isSigner = false) => ({ pubkey: pk(key), isWritable, isSigner })
const ix = (name, keys, data = Buffer.alloc(0)) => new TransactionInstruction({ programId: pk(SQUADS_PROGRAM), keys,
  data: Buffer.concat([tag('global', name), data]) })
const hash = b => createHash('sha256').update(b).digest('hex')

export function prepareCustodyMultisig({ instructions, transactionIndex, creator, rentPayer, approvers, executor }) {
  custodyAssert(typeof transactionIndex === 'bigint' && transactionIndex > 0n && transactionIndex <= 0xffffffffffffffffn)
  custodyAssert(Array.isArray(instructions) && instructions.length > 0 && instructions.length <= 255)
  custodyAssert([creator, executor, ...approvers].every(a => CUSTODY_MEMBERS.includes(addr(a))) &&
    approvers.length >= 2 && approvers.length <= 3 && new Set(approvers.map(addr)).size === approvers.length)
  const [multisig] = pda(['multisig', 'multisig', pk(CUSTODY_MEMBERS[0]).toBuffer()])
  const [vault] = pda(['multisig', multisig.toBuffer(), 'vault', u(0, 1)])
  custodyAssert(addr(multisig) === CUSTODY_MULTISIG && addr(vault) === MULTISIG_VAULT)
  const [transaction, transactionBump] = pda(['multisig', multisig.toBuffer(), 'transaction', u(transactionIndex, 8)])
  const [proposal, proposalBump] = pda(['multisig', multisig.toBuffer(), 'transaction', u(transactionIndex, 8), 'proposal'])
  const compiled = new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message()
  const h = compiled.header, keys = compiled.staticAccountKeys
  custodyAssert(keys.length <= 255 && compiled.compiledInstructions.every(i => i.accountKeyIndexes.length <= 255 && i.data.length <= 65535))
  const header = Buffer.from([h.numRequiredSignatures, h.numRequiredSignatures - h.numReadonlySignedAccounts,
    keys.length - h.numRequiredSignatures - h.numReadonlyUnsignedAccounts])
  const messageBytes = Buffer.concat([header, u(keys.length, 1), ...keys.map(k => k.toBuffer()), u(instructions.length, 1),
    ...compiled.compiledInstructions.map(i => Buffer.concat([u(i.programIdIndex, 1), vec(i.accountKeyIndexes, 1), vec(i.data, 2)])), u(0, 1)])
  // On-chain storage uses Borsh u32 lengths, unlike the compact create argument.
  const storedMessageBytes = Buffer.concat([header, u(keys.length, 4), ...keys.map(k => k.toBuffer()), u(instructions.length, 4),
    ...compiled.compiledInstructions.map(i => Buffer.concat([u(i.programIdIndex, 1), vec(i.accountKeyIndexes), vec(i.data)])), u(0, 4)])
  const remaining = keys.map((k, i) => meta(k, compiled.isAccountWritable(i), compiled.isAccountSigner(i) && !k.equals(vault)))
  const createInstruction = ix('vault_transaction_create', [meta(multisig, true), meta(transaction, true), meta(creator, false, true),
    meta(rentPayer, true, true), meta(SystemProgram.programId)], Buffer.concat([u(0, 1), u(0, 1), vec(messageBytes), u(0, 1)]))
  const proposalInstruction = ix('proposal_create', [meta(multisig), meta(proposal, true), meta(creator, false, true),
    meta(rentPayer, true, true), meta(SystemProgram.programId)], Buffer.concat([u(transactionIndex, 8), u(0, 1)]))
  return { instructions, transactionIndex, creator: addr(creator), rentPayer: addr(rentPayer), approvers: approvers.map(addr), executor: addr(executor),
    multisig: addr(multisig), vault: addr(vault), vaultIndex: 0, transaction: addr(transaction), proposal: addr(proposal),
    transactionBump, proposalBump, messageBytes, storedMessageBytes, messageHash: hash(messageBytes),
    createInstruction, proposalInstruction,
    approveInstructions: approvers.map(a => ix('proposal_approve', [meta(multisig), meta(a, true, true), meta(proposal, true)], u(0, 1))),
    executeInstruction: ix('vault_transaction_execute', [meta(multisig), meta(proposal, true), meta(transaction), meta(executor, false, true), ...remaining]),
    beneficiaryPaid: false, signed: false, submitted: false }
}

// Squads v4 config transaction that swaps members (AddMember = 0, RemoveMember = 1; idl/squads_multisig_program.json in
// @sqds/multisig 2.1.4). Threshold stays 2 and the member count stays 3. Approvers and executor are CURRENT members;
// the execute pays any multisig realloc from rentPayer.
export function prepareCustodyMemberChange({ add, remove, transactionIndex, creator, rentPayer, approvers, executor, members = CUSTODY_MEMBERS }) {
  custodyAssert(typeof transactionIndex === 'bigint' && transactionIndex > 0n && transactionIndex <= 0xffffffffffffffffn)
  const current = members.map(addr), added = add.map(addr), removed = remove.map(addr)
  custodyAssert(added.length > 0 && new Set(added).size === added.length && added.every(k => !current.includes(k) && k !== MULTISIG_VAULT))
  custodyAssert(new Set(removed).size === removed.length && removed.every(k => current.includes(k)))
  const membersAfter = [...current.filter(k => !removed.includes(k)), ...added]
  custodyAssert(membersAfter.length === 3)
  custodyAssert([creator, executor, ...approvers].every(a => current.includes(addr(a))) && approvers.length >= 2 &&
    new Set(approvers.map(addr)).size === approvers.length)
  const [multisig] = pda(['multisig', 'multisig', pk(current[0]).toBuffer()])
  custodyAssert(addr(multisig) === CUSTODY_MULTISIG)
  const [transaction] = pda(['multisig', multisig.toBuffer(), 'transaction', u(transactionIndex, 8)])
  const [proposal] = pda(['multisig', multisig.toBuffer(), 'transaction', u(transactionIndex, 8), 'proposal'])
  const actions = [...added.map(k => Buffer.concat([u(0, 1), pk(k).toBuffer(), u(7, 1)])), ...removed.map(k => Buffer.concat([u(1, 1), pk(k).toBuffer()]))]
  const createInstruction = ix('config_transaction_create', [meta(multisig, true), meta(transaction, true), meta(creator, false, true),
    meta(rentPayer, true, true), meta(SystemProgram.programId)], Buffer.concat([u(actions.length, 4), ...actions, u(0, 1)]))
  const proposalInstruction = ix('proposal_create', [meta(multisig), meta(proposal, true), meta(creator, false, true),
    meta(rentPayer, true, true), meta(SystemProgram.programId)], Buffer.concat([u(transactionIndex, 8), u(0, 1)]))
  return { transactionIndex, multisig: addr(multisig), transaction: addr(transaction), proposal: addr(proposal), membersBefore: current, membersAfter,
    createInstruction, proposalInstruction,
    approveInstructions: approvers.map(a => ix('proposal_approve', [meta(multisig), meta(a, true, true), meta(proposal, true)], u(0, 1))),
    executeInstruction: ix('config_transaction_execute', [meta(multisig, true), meta(executor, false, true), meta(proposal, true),
      meta(transaction), meta(rentPayer, true, true), meta(SystemProgram.programId)]) }
}

class Reader {
  constructor(data) { custodyAssert(Buffer.isBuffer(data)); this.b = data; this.o = 0 }
  take(n) { custodyAssert(Number.isSafeInteger(n) && n >= 0 && this.o + n <= this.b.length); const b = this.b.subarray(this.o, this.o += n); return b }
  n(size) { const b = this.take(size); return size === 8 ? b.readBigUInt64LE() : b.readUIntLE(0, size) }
  key() { return addr(this.take(32)) }
  keys() { const n = this.n(4); custodyAssert(n <= 3); return Array.from({ length: n }, () => this.key()) }
  done() { custodyAssert(this.b.subarray(this.o).every(b => b === 0)) }
}
const account = (proof, expected, name) => {
  custodyAssert(proof && addr(proof.address) === expected && addr(proof.owner) === SQUADS_PROGRAM && proof.executable === false)
  const r = new Reader(proof.data); custodyAssert(r.take(8).equals(tag('account', name))); return r
}

// TRUST BOUNDARY: supply independently fetched finalized raw account bytes, from
// the execution boundary: multisig/transaction immediately BEFORE execution, proposal
// immediately AFTER. Caller must establish this boundary, not relabel later RPC state.
// NOT decoded request JSON or simulations. spendingLimits
// is a COMPLETE owner/discriminator/multisig-filtered program scan, not a paginated subset.
// This checks the supplied proof; it does not perform RPC, attest RPC provenance, or
// establish present-day control. The caller must archive the trusted readback evidence.
// Alternatively, collectCustodyGovernance proves a later snapshot unchanged through
// complete finalized blocks, retaining its real context slots instead of relabeling them.
export function validateCustodyGovernance({ plan, proof, slot, signature }) {
  custodyAssert(Number.isSafeInteger(slot) && slot > 0 && proof?.slot === slot && proof.commitment === 'finalized' &&
    proof.spendingLimitsComplete === true && Array.isArray(proof.spendingLimits) && proof.spendingLimits.length === 0)
  if (proof.snapshot) validateSnapshotBoundary(plan, proof, signature, slot)
  const expected = prepareCustodyMultisig(plan)
  custodyAssert(plan.messageHash === expected.messageHash && plan.transaction === expected.transaction && plan.proposal === expected.proposal)
  const m = account(proof.multisig, CUSTODY_MULTISIG, 'Multisig')
  custodyAssert(m.key() === CUSTODY_MEMBERS[0] && m.key() === PublicKey.default.toBase58() && m.n(2) === 2 && m.n(4) === 0)
  const current = m.n(8), stale = m.n(8)
  custodyAssert(current >= plan.transactionIndex && stale < plan.transactionIndex && m.n(1) === 1 && m.key() === MULTISIG_VAULT)
  const [, bump] = pda(['multisig', 'multisig', pk(CUSTODY_MEMBERS[0]).toBuffer()])
  custodyAssert(m.n(1) === bump && m.n(4) === 3)
  const members = Array.from({ length: 3 }, () => { const key = m.key(); custodyAssert(m.n(1) === 7); return key })
  custodyAssert(new Set(members).size === 3 && members.every(k => CUSTODY_MEMBERS.includes(k))); m.done()
  const t = account(proof.transaction, expected.transaction, 'VaultTransaction')
  custodyAssert(t.key() === CUSTODY_MULTISIG && t.key() === expected.creator && t.n(8) === plan.transactionIndex &&
    t.n(1) === expected.transactionBump && t.n(1) === 0)
  const [, vaultBump] = pda(['multisig', pk(CUSTODY_MULTISIG).toBuffer(), 'vault', u(0, 1)])
  custodyAssert(t.n(1) === vaultBump && t.n(4) === 0 && t.take(expected.storedMessageBytes.length).equals(expected.storedMessageBytes)); t.done()
  const p = account(proof.proposal, expected.proposal, 'Proposal')
  custodyAssert(p.key() === CUSTODY_MULTISIG && p.n(8) === plan.transactionIndex && p.n(1) === 5)
  p.take(8) // Executed timestamp; status alone is not receipt finality.
  custodyAssert(p.n(1) === expected.proposalBump)
  const approved = p.keys(), rejected = p.keys(), cancelled = p.keys(); p.done()
  custodyAssert(approved.length >= 2 && new Set(approved).size === approved.length && approved.every(k => CUSTODY_MEMBERS.includes(k)) &&
    rejected.length === 0 && cancelled.length === 0)
  return Object.freeze({ multisig: CUSTODY_MULTISIG, vault: MULTISIG_VAULT, vaultIndex: 0, transaction: expected.transaction,
    proposal: expected.proposal, transactionIndex: plan.transactionIndex, messageHash: expected.messageHash, approved: Object.freeze(approved),
    slot, vaultControlVerified: true, scope: 'supplied-finalized-execution-slot-proof-not-current-control' })
}

function validateSnapshotBoundary(plan, proof, signature, executionSlot) {
  const s = proof.snapshot, controls = [CUSTODY_MULTISIG, plan.transaction, plan.proposal]
  custodyAssert(s.executionSignature === signature && typeof signature === 'string' && signature.length > 0 &&
    Number.isSafeInteger(s.accountsContextSlot) && s.accountsContextSlot >= executionSlot &&
    Number.isSafeInteger(s.limitsContextSlot) && s.limitsContextSlot >= s.accountsContextSlot &&
    Array.isArray(s.blocks) && s.blocks.length > 0)
  let expectedSlot = s.limitsContextSlot, expectedHash = null, execution = null
  for (const [index, { slot, block }] of s.blocks.entries()) {
    custodyAssert(slot === expectedSlot && slot >= executionSlot && block && Array.isArray(block.transactions) &&
      typeof block.blockhash === 'string' && (!expectedHash || block.blockhash === expectedHash) &&
      Number.isSafeInteger(block.parentSlot) && block.parentSlot < slot && typeof block.previousBlockhash === 'string')
    let start = 0
    if (slot === executionSlot) {
      const matches = block.transactions.flatMap((t, i) => t.transaction?.signatures?.[0] === signature ? [i] : [])
      custodyAssert(matches.length === 1 && index === s.blocks.length - 1)
      execution = { ...block.transactions[matches[0]], slot, blockTime: block.blockTime }
      custodyAssert(execution.meta?.err === null)
      start = matches[0] + 1
    }
    for (const t of block.transactions.slice(start)) {
      custodyAssert(t.meta && Object.hasOwn(t.meta, 'err') && ['legacy', 0, 1].includes(t.version))
      const message = t.transaction?.message
      const keys = message?.staticAccountKeys ?? message?.accountKeys
      custodyAssert(Array.isArray(keys))
      const loaded = t.meta.loadedAddresses
      // Version 1 messages have no lookup tables, so every account they reference is in accountKeys.
      if (t.version === 1) custodyAssert(!message.addressTableLookups?.length && !loaded?.writable?.length && !loaded?.readonly?.length)
      custodyAssert(!message.addressTableLookups?.length || (Array.isArray(loaded?.writable) && Array.isArray(loaded?.readonly)))
      const references = [...keys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map(addr)
      custodyAssert(t.meta.err !== null || !references.some(k => controls.includes(k)))
    }
    expectedSlot = block.parentSlot; expectedHash = block.previousBlockhash
  }
  custodyAssert(execution)
  return execution
}

// web3.js 1.x rejects whole blocks that contain version 1 transactions, so blocks are read as raw JSON-RPC
// (through the connection's own transport and headers) and scanned by validateSnapshotBoundary.
async function rawBlock(connection, slot) {
  const response = await connection._rpcRequest('getBlock', [slot, { commitment: 'finalized', encoding: 'json',
    transactionDetails: 'full', maxSupportedTransactionVersion: 1, rewards: false }])
  custodyAssert(!response.error)
  return response.result
}

// Read-only trusted-RPC collector. Address-history indexes may lag finalized state;
// only complete finalized blocks establish absence of intervening control activity.
// Conservative: even an unrelated successful read of a control account needs review.
// The target execute must still pass the exact claim/payout transcript validator.
// blockDelayMs paces block reads for rate-limited public RPCs.
export async function collectCustodyGovernance({ connection, plan, signature, maxBlocks = 128, blockDelayMs = 0 }) {
  custodyAssert(typeof signature === 'string' && signature.length > 0 && Number.isSafeInteger(maxBlocks) && maxBlocks > 0)
  const { value: statuses } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
  const status = statuses?.[0]
  custodyAssert(status?.err === null && status.confirmationStatus === 'finalized' && Number.isSafeInteger(status.slot) && status.slot > 0)
  const addresses = [CUSTODY_MULTISIG, plan.transaction, plan.proposal]
  const accounts = await connection.getMultipleAccountsInfoAndContext(addresses.map(pk), { commitment: 'finalized', minContextSlot: status.slot })
  custodyAssert(Number.isSafeInteger(accounts.context?.slot) && accounts.context.slot >= status.slot && accounts.value?.length === 3 && accounts.value.every(Boolean))
  const limits = await connection.getProgramAccounts(pk(SQUADS_PROGRAM), { commitment: 'finalized', withContext: true,
    minContextSlot: accounts.context.slot, filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(tag('account', 'SpendingLimit')) } },
      { memcmp: { offset: 8, bytes: CUSTODY_MULTISIG } },
    ] })
  custodyAssert(Number.isSafeInteger(limits.context?.slot) && limits.context.slot >= accounts.context.slot &&
    Array.isArray(limits.value) && limits.value.length === 0)
  const blocks = []
  let slot = limits.context.slot
  while (slot >= status.slot && blocks.length < maxBlocks) {
    if (blocks.length && blockDelayMs) await new Promise(resolve => setTimeout(resolve, blockDelayMs))
    const block = await rawBlock(connection, slot)
    custodyAssert(block && Number.isSafeInteger(block.parentSlot) && block.parentSlot < slot)
    blocks.push({ slot, block })
    if (slot === status.slot) break
    slot = block.parentSlot
  }
  const raw = i => ({ address: addresses[i], owner: addr(accounts.value[i].owner), executable: accounts.value[i].executable,
    data: Buffer.from(accounts.value[i].data) })
  const governanceProof = { slot: status.slot, commitment: 'finalized', multisig: raw(0), transaction: raw(1), proposal: raw(2),
    spendingLimitsComplete: true, spendingLimits: [], snapshot: { executionSignature: signature,
      accountsContextSlot: accounts.context.slot, limitsContextSlot: limits.context.slot, blocks } }
  const tx = validateSnapshotBoundary(plan, governanceProof, signature, status.slot)
  validateCustodyGovernance({ plan, proof: governanceProof, slot: status.slot, signature })
  return { tx, governanceProof, finality: { signature, slot: status.slot, confirmationStatus: 'finalized', err: null } }
}
