import { Connection, PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID as DBC, deriveDbcPoolAuthority, deriveDbcEventAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { prepareCustodyMultisig, validateCustodyGovernance, MULTISIG_VAULT } from './custody-multisig.mjs'
import bs58 from 'bs58'

const address = v => new PublicKey(v).toBase58()
const check = v => { if (!v) throw Error('DBC custody receipt mismatch or unsupported evidence; review required') }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const canonical = ix => ({ program: address(ix.programId), accounts: ix.keys.map(k => address(k.pubkey)), data: Buffer.from(ix.data).toString('hex') })
const poolAuthority = deriveDbcPoolAuthority().toBase58(), eventAuthority = deriveDbcEventAuthority().toBase58()
const destination = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(MULTISIG_VAULT), true).toBase58()
// SDK coder only. Constructing a Connection does not perform I/O; no RPC method is used.
const coder = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:8899'), 'finalized').state.getProgram().coder.accounts
const u64 = v => typeof v === 'bigint' && v > 0n && v <= 0xffffffffffffffffn

// INTERNAL trusted-evidence boundary, never a JSON/request endpoint. Caller obtains tx,
// finality and execution-boundary raw pool/config observations independently and retains
// the approved plan/transcript BEFORE execution. Slot equality is not provenance proof.
// Only existing ATAs, classic-SPL WSOL, zero base transfers, legacy/v0 without ALTs. No setup,
// unwrap, close, compute-budget additions, fee splitting, signing or network operations.
export function validateDbcCustodyBatchReceipt({ plan, tx, finality, review, multisigPlan, governanceProof }) {
  check(finality?.confirmationStatus === 'finalized' && finality.err === null && tx?.meta?.err === null &&
    Number.isSafeInteger(tx.slot) && tx.slot > 0 && tx.slot === finality.slot &&
    typeof finality.signature === 'string' && finality.signature.length > 0 && tx.transaction?.signatures?.[0] === finality.signature)
  check(plan && ['creator', 'partner'].includes(plan.role) && plan.observation?.slot === tx.slot && plan.observation.commitment === 'finalized')
  check(Array.isArray(plan.claims) && plan.claims.length > 0 && plan.claims.length <= 2 && plan.instructions?.length === plan.claims.length)
  const creator = plan.role === 'creator', m = tx.transaction.message, keys = (m.staticAccountKeys ?? m.accountKeys).map(address)
  check(new Set(keys).size === keys.length && !m.addressTableLookups?.length && !tx.meta.loadedAddresses?.writable?.length && !tx.meta.loadedAddresses?.readonly?.length)
  const top = m.staticAccountKeys ? m.compiledInstructions.map(i => ({ ...i, accounts: Array.from(i.accountKeyIndexes), data: bs58.encode(i.data) })) : m.instructions
  const decode = ix => {
    check(Number.isInteger(ix.programIdIndex) && keys[ix.programIdIndex] && Array.isArray(ix.accounts) &&
      ix.accounts.every(i => Number.isInteger(i) && keys[i]) && typeof ix.data === 'string')
    return { program: keys[ix.programIdIndex], accounts: ix.accounts.map(i => keys[i]), data: Buffer.from(bs58.decode(ix.data)).toString('hex') }
  }
  check(Array.isArray(top) && Array.isArray(review?.top) && same(top.map(decode), review.top.map(canonical)))
  check(keys[0] === address(plan.payer) && keys[0] !== MULTISIG_VAULT && Number.isInteger(m.header?.numRequiredSignatures) &&
    m.header.numRequiredSignatures > 0 && m.header.numRequiredSignatures <= keys.length)
  const signers = keys.slice(0, m.header.numRequiredSignatures)
  check(!signers.includes(MULTISIG_VAULT) && tx.transaction.signatures.length === signers.length)
  let governance = null
  if (creator) {
    check(plan.authority === MULTISIG_VAULT && multisigPlan && same(multisigPlan.instructions.map(canonical), plan.instructions.map(canonical)))
    governance = validateCustodyGovernance({ plan: multisigPlan, proof: governanceProof, slot: tx.slot, signature: finality.signature })
    const expected = prepareCustodyMultisig(multisigPlan)
    check(same(top.map(decode), [canonical(expected.executeInstruction)]) &&
      same([...new Set([plan.payer, multisigPlan.executor])].sort(), [...signers].sort()))
  } else {
    // A valid signature does NOT make this historically exposed authority safe or its
    // proceeds platform-owned. Require a separately retained risk-aware exact review.
    check(!multisigPlan && !governanceProof && plan.partnerReview?.id && plan.partnerReview.authority === plan.authority &&
      plan.partnerReview.exposedAuthorityAcknowledged === true && plan.authority !== MULTISIG_VAULT &&
      same([...new Set([plan.payer, plan.authority])].sort(), [...signers].sort()) && same(top.map(decode), plan.instructions.map(canonical)))
  }
  const groups = tx.meta.innerInstructions
  check(Array.isArray(groups) && groups.length === (creator ? 1 : plan.claims.length) && review.inner?.length === groups.length)
  groups.forEach((g, i) => {
    check(g.index === i && g.index === review.inner[i].index && g.instructions.length === review.inner[i].instructions.length)
    g.instructions.forEach((ix, n) => check(Number.isInteger(ix.stackHeight) && ix.stackHeight === review.inner[i].instructions[n].stackHeight &&
      same(decode(ix), canonical(review.inner[i].instructions[n].instruction))))
  })
  const read = (account, expected, type) => {
    check(account?.address === expected && address(account.owner) === DBC.toBase58() && account.executable === false && Buffer.isBuffer(account.data))
    return coder.decode(type, account.data)
  }
  const pools = new Set(), sources = new Set(), expectedDeltas = new Map(), items = []
  for (let i = 0; i < plan.claims.length; i++) {
    const c = plan.claims[i], a = c.attribution
    check(a?.phase === 'DBC' && a.role === plan.role && /^[1-9][0-9]*$/.test(a.repoId) &&
      address(a.previousOwner) !== MULTISIG_VAULT && !pools.has(a.curve) && u64(c.maxQuoteAmount))
    pools.add(a.curve)
    const s = read(c.poolAccount, a.curve, 'virtualPool').poolState, config = read(c.configAccount, a.config, 'poolConfig')
    check(address(s.config) === a.config && address(s.baseMint) === a.mint && [0, 1].includes(config.tokenType) && s.poolType === config.tokenType &&
      address(config.quoteMint) === NATIVE_MINT.toBase58() && config.quoteTokenFlag === 0 && config.collectFeeMode === 0 &&
      address(creator ? s.creator : config.feeClaimer) === plan.authority)
    const baseProgram = config.tokenType === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
    const base = getAssociatedTokenAddressSync(new PublicKey(a.mint), new PublicKey(MULTISIG_VAULT), true, baseProgram).toBase58()
    const quoteVault = address(s.quoteVault)
    check(quoteVault !== destination && !sources.has(quoteVault)); sources.add(quoteVault)
    const accounts = [poolAuthority, ...(creator ? [] : [a.config]), a.curve, base, destination,
      address(s.baseVault), quoteVault, a.mint, NATIVE_MINT.toBase58(), plan.authority,
      baseProgram.toBase58(), TOKEN_PROGRAM_ID.toBase58(), eventAuthority, DBC.toBase58()]
    const data = Buffer.alloc(24)
    Buffer.from(creator ? [82,220,250,189,3,85,107,45] : [8,236,89,49,152,125,177,81]).copy(data)
    data.writeBigUInt64LE(c.maxQuoteAmount, 16)
    check(same(canonical(plan.instructions[i]), { program: DBC.toBase58(), accounts, data: data.toString('hex') }))
    const path = creator ? [0, i * 3] : [i], g = groups[creator ? 0 : i], offset = creator ? i * 3 + 1 : 0, depth = creator ? 3 : 2
    check(g.instructions.length === (creator ? plan.claims.length * 3 : 2))
    if (creator) check(g.instructions[i * 3].stackHeight === 2 && same(decode(g.instructions[i * 3]), canonical(plan.instructions[i])))
    const transfer = g.instructions[offset], event = g.instructions[offset + 1], e = decode(event), bytes = Buffer.from(e.data, 'hex')
    check(event.stackHeight === depth && e.program === DBC.toBase58() && same(e.accounts, [eventAuthority]) && bytes.length === 64 &&
      bytes.subarray(0, 16).equals(Buffer.from(creator ? 'e445a52e51cb9a1d9ae4d7ca859bd68a' : 'e445a52e51cb9a1d1a5375f05cca70fe', 'hex')) &&
      address(bytes.subarray(16, 48)) === a.curve && bytes.readBigUInt64LE(48) === 0n)
    const amount = bytes.readBigUInt64LE(56), t = decode(transfer), td = Buffer.from(t.data, 'hex')
    check(u64(amount) && amount <= c.maxQuoteAmount && transfer.stackHeight === depth && t.program === TOKEN_PROGRAM_ID.toBase58() &&
      same(t.accounts, [quoteVault, NATIVE_MINT.toBase58(), destination, poolAuthority]) && td.length === 10 &&
      td[0] === 12 && td[9] === 9 && td.readBigUInt64LE(1) === amount)
    expectedDeltas.set(quoteVault, -amount)
    items.push(Object.freeze({ kind: 'vault-wsol-fee-collection', phase: 'DBC', signature: finality.signature, slot: tx.slot,
      itemIndex: i, instructionPath: Object.freeze(path), eventPath: Object.freeze([creator ? 0 : i, offset + 1]),
      pool: a.curve, owner: MULTISIG_VAULT, destination, mint: NATIVE_MINT.toBase58(), amount,
      attribution: Object.freeze({ ...a }), beneficiaryPaid: false, vaultControlVerified: true }))
  }
  const amount = items.reduce((sum, item) => sum + item.amount, 0n)
  expectedDeltas.set(destination, amount)
  const balances = rows => {
    check(Array.isArray(rows))
    const result = new Map()
    for (const row of rows) {
      check(Number.isInteger(row.accountIndex) && keys[row.accountIndex] && !result.has(keys[row.accountIndex]) &&
        [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(row.programId) && /^(0|[1-9][0-9]*)$/.test(row.uiTokenAmount?.amount))
      result.set(keys[row.accountIndex], row)
    }
    return result
  }
  const pre = balances(tx.meta.preTokenBalances), post = balances(tx.meta.postTokenBalances)
  check(pre.size === post.size)
  for (const [account, before] of pre) {
    const after = post.get(account), delta = expectedDeltas.get(account) ?? 0n
    check(after && before.programId === after.programId && before.mint === after.mint && before.owner === after.owner && before.uiTokenAmount.decimals === after.uiTokenAmount.decimals &&
      BigInt(after.uiTokenAmount.amount) - BigInt(before.uiTokenAmount.amount) === delta)
    if (expectedDeltas.has(account)) check(before.programId === TOKEN_PROGRAM_ID.toBase58() && before.mint === NATIVE_MINT.toBase58() && before.uiTokenAmount.decimals === 9 &&
      before.owner === (account === destination ? MULTISIG_VAULT : poolAuthority))
  }
  for (const account of expectedDeltas.keys()) check(pre.has(account))
  check(Number.isSafeInteger(tx.meta.fee) && tx.meta.fee >= 0 && tx.meta.preBalances?.length === keys.length && tx.meta.postBalances?.length === keys.length)
  keys.forEach((account, i) => {
    check(Number.isSafeInteger(tx.meta.preBalances[i]) && Number.isSafeInteger(tx.meta.postBalances[i]) &&
      tx.meta.preBalances[i] >= 0 && tx.meta.postBalances[i] >= 0 &&
      BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) === (expectedDeltas.get(account) ?? 0n) - (i === 0 ? BigInt(tx.meta.fee) : 0n))
  })
  return Object.freeze({ kind: 'vault-wsol-dbc-collection-batch', signature: finality.signature, slot: tx.slot, amount,
    owner: MULTISIG_VAULT, destination, mint: NATIVE_MINT.toBase58(), items: Object.freeze(items), beneficiaryPaid: false,
    vaultControlVerified: true, governance, authorityRisk: creator ? null : 'exposed-partner-authority',
    partnerReview: creator ? null : Object.freeze({ ...plan.partnerReview }) })
}
