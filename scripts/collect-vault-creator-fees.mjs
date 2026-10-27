// Operator CLI for DBC creator trading fees on pools whose creator is the custody vault. Collection moves the fees into
// the vault's own WSOL account through the 2-of-3 Squads multisig; it pays no one.
//   plan PLAN_FILE     read-only: picks vault-owned pools at or above the floor, simulates every claim, measures every
//                      transaction and writes the plan with its cost ceiling. No signer, no sends.
//   collect PLAN_FILE  needs APPROVED_PLAN_SHA256 (the plan file's sha256). Creates the missing vault base-token accounts,
//                      then per batch of two pools: vault transaction, proposal with two approvals, execute. Each batch is
//                      proven (governance + finalized receipt) and recorded in the custody ledger before the next starts.
//                      Stops on the first failure; a rerun resumes from chain state and never repeats a landed step.
//   sweep JOURNAL_FILE one approved move of SWEEP_LAMPORTS of vault WSOL to SWEEP_RECIPIENT's WSOL account, payer spend
//                      capped by SWEEP_CAP_LAMPORTS. Same signers and resume rules as collect.
//   fund-vault JOURNAL_FILE  FUND_LAMPORTS from the payer to the vault (payer key only), capped by FUND_CAP_LAMPORTS.
//   send-sol JOURNAL_FILE    SEND_LAMPORTS of native SOL from the vault to SEND_RECIPIENT through the multisig.
//   hook-admin-accept JOURNAL_FILE  the vault accepts the Hook admin role (HOOK_ACCEPT_FILE, approved by HOOK_ACCEPT_SHA256):
//                      only AcceptAdmin instructions the vault signs alone (src/hooklab-admin-handover.mjs); payer spend
//                      capped by HOOK_ACCEPT_CAP_LAMPORTS. Moves no funds.
//   hook-config-change JOURNAL_FILE  a governed Hook Config change by the vault (HOOK_CONFIG_FILE, approved by
//                      HOOK_CONFIG_SHA256): only governed_set_config the vault signs alone; capped by HOOK_CONFIG_CAP_LAMPORTS.
// Env: CUSTODY_RECORDER_DATABASE_URL (restricted recorder role), SOLANA_RPC_URL, GRADUATION_VERIFICATION_RPC_URL;
// collect also needs PAYER_KEY and ADMIN_KEY (key pipe paths) and MEMBER_KIT (the second approver's recovery kit, whose
// passphrase is typed in a hidden dialog). Secrets are never printed.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID as DBC, deriveDbcPoolAuthority, deriveDbcEventAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, unpackAccount } from '@solana/spl-token'
import { CUSTODY_MEMBERS, CUSTODY_MULTISIG, MULTISIG_VAULT, SQUADS_PROGRAM, prepareCustodyMultisig, collectCustodyGovernance } from '../src/custody-multisig.mjs'
import { recordValidatedDbcCustodyBatchCollection, validateDbcCustodyBatchReceipt } from '../src/custody-settlement.mjs'
import { agreedFinalizedTransaction } from '../src/graduation-state.mjs'
import { loadSigners, parseKeyArgs, wipe } from '../src/hooklab-owner-driver/keys.mjs'
import { openKit } from './hooklab-recovery-kit.mjs'
import { assertHookAdminAccept, assertHookGovernedConfig } from '../src/hooklab-admin-handover.mjs'

const PAYER = '3eCFwDiKetHe9pg1zNEkTohUECu2vtsZDRMZ3jeR4g5o', ADMIN = CUSTODY_MEMBERS[0], APPROVER = CUSTODY_MEMBERS[1]
// Below this a pool's fees barely cover its share of a batch (two Squads accounts, a base account, seven signatures).
const MIN_CLAIM_LAMPORTS = 10_000_000n
// Kept out: 1250482335's ledger-bound wallet differs from its launcher; the other two are paused and stay unpaid.
const HELD_REPOS = new Set(['1250482335', '1250276806', '1332056763'])
const BATCH_SIZE = 2, ATAS_PER_TX = 8, MAX_TX_BYTES = 1232, FEE_PER_SIGNATURE = 5000
const PROPOSAL_BYTES = 358, CEILING_MARGIN_LAMPORTS = 10_000_000n, PLAN_MAX_AGE_MS = 24 * 3600_000
const FINALITY_TIMEOUT_MS = 150_000, POLL_MS = 2000
// The public RPC allows about one full block read per 1.5 s; 300 blocks covers two minutes after execution.
const PROOF_MAX_BLOCKS = 300, PROOF_BLOCK_DELAY_MS = 1500
const CREATOR_EVENT = Buffer.from('e445a52e51cb9a1d9ae4d7ca859bd68a', 'hex')
const PROPOSAL_STATUS = { 0: 'draft', 1: 'active', 2: 'rejected', 3: 'approved', 4: 'executing', 5: 'executed', 6: 'cancelled' }

const check = (ok, message) => { if (!ok) throw Error(message) }
const pk = v => new PublicKey(v)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v)
  : v?.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data).toString('base64') : v, 1)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const writeAtomic = (path, text) => { writeFileSync(`${path}.tmp`, text, { mode: 0o600 }); renameSync(`${path}.tmp`, path) }

const [mode, file] = process.argv.slice(2)
const MODES = ['plan', 'collect', 'sweep', 'fund-vault', 'send-sol', 'hook-admin-accept', 'hook-config-change']
check(MODES.includes(mode) && file, 'Usage: collect-vault-creator-fees.mjs plan|collect PLAN_FILE | sweep|fund-vault|send-sol|hook-admin-accept|hook-config-change JOURNAL_FILE')
for (const name of ['CUSTODY_RECORDER_DATABASE_URL', 'SOLANA_RPC_URL', 'GRADUATION_VERIFICATION_RPC_URL',
  ...(mode !== 'plan' ? ['PAYER_KEY'] : []), ...(!['plan', 'fund-vault'].includes(mode) ? ['ADMIN_KEY', 'MEMBER_KIT'] : []),
  ...(mode === 'collect' ? ['APPROVED_PLAN_SHA256'] : []),
  ...(mode === 'sweep' ? ['SWEEP_RECIPIENT', 'SWEEP_LAMPORTS', 'SWEEP_CAP_LAMPORTS'] : []),
  ...(mode === 'fund-vault' ? ['FUND_LAMPORTS', 'FUND_CAP_LAMPORTS'] : []),
  ...(mode === 'send-sol' ? ['SEND_RECIPIENT', 'SEND_LAMPORTS', 'SEND_CAP_LAMPORTS'] : []),
  ...(mode === 'hook-admin-accept' ? ['HOOK_ACCEPT_FILE', 'HOOK_ACCEPT_SHA256', 'HOOK_ACCEPT_CAP_LAMPORTS'] : []),
  ...(mode === 'hook-config-change' ? ['HOOK_CONFIG_FILE', 'HOOK_CONFIG_SHA256', 'HOOK_CONFIG_CAP_LAMPORTS'] : [])]) check(process.env[name], `${name} required`)
const rpc = url => new Connection(url, { commitment: 'finalized', httpHeaders: { 'user-agent': 'repoing-custody-collector/1' } })
const primary = rpc(process.env.SOLANA_RPC_URL), verification = rpc(process.env.GRADUATION_VERIFICATION_RPC_URL)
check(new URL(primary.rpcEndpoint).hostname !== new URL(verification.rpcEndpoint).hostname, 'Two independently operated RPC providers are required')
const program = new DynamicBondingCurveClient(primary, 'finalized').state.getProgram(), coder = program.coder.accounts
const DESTINATION = getAssociatedTokenAddressSync(NATIVE_MINT, pk(MULTISIG_VAULT), true)
const poolAuthority = deriveDbcPoolAuthority(), eventAuthority = deriveDbcEventAuthority()

// Reads in chunks; returns the accounts and the lowest context slot they were read at.
async function readAccounts(connection, keys, size, minContextSlot) {
  const accounts = []; let slot = Infinity
  for (let i = 0; i < keys.length; i += size) {
    const { context, value } = await connection.getMultipleAccountsInfoAndContext(keys.slice(i, i + size), { commitment: 'finalized', minContextSlot })
    accounts.push(...value); slot = Math.min(slot, context.slot)
    if (i + size < keys.length) await sleep(1200)
  }
  return { accounts, slot }
}
const readBoth = (keys, minContextSlot) => Promise.all([readAccounts(primary, keys, 100, minContextSlot), readAccounts(verification, keys, 10, minContextSlot)])
const raw = (address, info) => ({ address, owner: info.owner.toBase58(), executable: info.executable, data: Buffer.from(info.data) })

// The pool fields the receipt validator binds; none can change without the vault signing.
function poolFacts(info) {
  check(info?.owner.equals(DBC), 'pool account is not owned by the DBC program')
  const decoded = coder.decode('virtualPool', info.data), s = decoded.poolState ?? decoded
  return { config: s.config.toBase58(), creator: s.creator.toBase58(), baseMint: s.baseMint.toBase58(), baseVault: s.baseVault.toBase58(),
    quoteVault: s.quoteVault.toBase58(), poolType: s.poolType, fee: BigInt(s.creatorQuoteFee.toString()) }
}
const sameFacts = (a, b) => ['config', 'creator', 'baseMint', 'baseVault', 'quoteVault', 'poolType'].every(k => a[k] === b[k])

async function selectPools(db) {
  const { rows } = await db.query(`select github_repo_id::text as "repoId", mint, pool, creator_wallet as "creatorWallet",
    launcher_wallet as "launcherWallet" from markets where status='confirmed' and quote_asset_id is null order by github_repo_id`)
  const [a, b] = await readBoth(rows.map(r => pk(r.pool)))
  const pools = []
  rows.forEach((m, i) => {
    if (!a.accounts[i] || !b.accounts[i] || HELD_REPOS.has(m.repoId)) return
    const x = poolFacts(a.accounts[i]), y = poolFacts(b.accounts[i])
    if (x.creator !== MULTISIG_VAULT) return
    check(sameFacts(x, y) && x.baseMint === m.mint, `providers or ledger disagree on pool of repo ${m.repoId}`)
    const fee = x.fee < y.fee ? x.fee : y.fee
    const previousOwner = [m.creatorWallet, m.launcherWallet].find(w => w && w !== MULTISIG_VAULT)
    if (fee >= MIN_CLAIM_LAMPORTS) pools.push({ repoId: m.repoId, pool: m.pool, mint: m.mint, previousOwner, ...x, fee })
  })
  const configs = [...new Set(pools.map(p => p.config))]
  const [c, d] = await readBoth(configs.map(pk))
  const tokenTypes = new Map(configs.map((key, i) => {
    check(c.accounts[i] && d.accounts[i] && c.accounts[i].data.equals(d.accounts[i].data) && c.accounts[i].owner.equals(DBC), `config ${key} unreadable or disputed`)
    const config = coder.decode('poolConfig', c.accounts[i].data)
    check(config.quoteMint.equals(NATIVE_MINT) && config.quoteTokenFlag === 0 && config.collectFeeMode === 0 && [0, 1].includes(config.tokenType),
      `config ${key} is not a SOL-quoted classic fee layout`)
    return [key, config.tokenType]
  }))
  for (const p of pools) {
    check(p.previousOwner && tokenTypes.get(p.config) === p.poolType, `repo ${p.repoId} has no previous owner or a token type mismatch`)
    p.baseProgram = (p.poolType === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID).toBase58()
    p.baseAccount = getAssociatedTokenAddressSync(pk(p.mint), pk(MULTISIG_VAULT), true, pk(p.baseProgram)).toBase58()
  }
  return pools.sort((x, y) => (y.fee > x.fee ? 1 : y.fee < x.fee ? -1 : 0))
}

const claimInstruction = (p, maxQuote) => program.methods.claimCreatorTradingFee(new BN(0), new BN(String(maxQuote))).accountsStrict({
  poolAuthority, pool: pk(p.pool), tokenAAccount: pk(p.baseAccount), tokenBAccount: DESTINATION, baseVault: pk(p.baseVault),
  quoteVault: pk(p.quoteVault), baseMint: pk(p.mint), quoteMint: NATIVE_MINT, creator: pk(MULTISIG_VAULT),
  tokenBaseProgram: pk(p.baseProgram), tokenQuoteProgram: TOKEN_PROGRAM_ID, eventAuthority, program: DBC }).instruction()
const createBase = p => createAssociatedTokenAccountIdempotentInstruction(pk(PAYER), pk(p.baseAccount), pk(MULTISIG_VAULT), pk(p.mint), pk(p.baseProgram))
const squadsPlan = (instructions, transactionIndex) => prepareCustodyMultisig({ instructions, transactionIndex, creator: ADMIN,
  rentPayer: PAYER, approvers: [ADMIN, APPROVER], executor: ADMIN })
const vaultTransactionBytes = plan => 8 + 32 + 32 + 8 + 1 + 1 + 1 + 4 + plan.storedMessageBytes.length
// Stage shapes: create alone, proposal with both approvals, execute alone. Each is a legacy transaction with no ALTs.
const stages = plan => [
  { name: 'create', instructions: [plan.createInstruction], signers: [PAYER, ADMIN] },
  { name: 'propose', instructions: [plan.proposalInstruction, ...plan.approveInstructions], signers: [PAYER, ADMIN, APPROVER] },
  { name: 'execute', instructions: [plan.executeInstruction], signers: [PAYER, ADMIN] }]
const wireBytes = (instructions, signerCount) => 1 + 64 * signerCount +
  new Transaction({ feePayer: pk(PAYER), recentBlockhash: PublicKey.default.toBase58() }).add(...instructions).compileMessage().serialize().length

// Event amounts per claim from a simulation or receipt's inner instructions (compiled or RPC-parsed form).
function claimedAmounts(groups, keys) {
  const amounts = []
  for (const g of groups ?? []) for (const ix of g.instructions) {
    const programId = ix.programId?.toString() ?? keys[ix.programIdIndex]
    if (programId !== DBC.toBase58() || typeof ix.data !== 'string') continue
    const data = Buffer.from(bs58.decode(ix.data))
    if (data.length === 64 && data.subarray(0, 16).equals(CREATOR_EVENT)) amounts.push({ pool: pk(data.subarray(16, 48)).toBase58(), base: data.readBigUInt64LE(48), quote: data.readBigUInt64LE(56) })
  }
  return amounts
}

async function simulateUnsigned(instructions) {
  const message = new TransactionMessage({ payerKey: pk(PAYER), recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message()
  const { value } = await primary.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true,
    innerInstructions: true, commitment: 'finalized' })
  return { message, value }
}

async function simulateClaims(batch) {
  const { message, value } = await simulateUnsigned([...batch.map(createBase), ...await Promise.all(batch.map(p => claimInstruction(p, p.fee)))])
  const amounts = claimedAmounts(value.innerInstructions, message.staticAccountKeys.map(k => k.toBase58()))
  return { ok: value.err === null && batch.every(p => amounts.some(a => a.pool === p.pool && a.base === 0n && a.quote === p.fee)),
    err: value.err, unitsConsumed: value.unitsConsumed, amounts }
}

async function multisigIndex() {
  const info = await primary.getAccountInfo(pk(CUSTODY_MULTISIG), 'finalized')
  check(info?.owner.equals(pk(SQUADS_PROGRAM)), 'multisig account missing')
  return info.data.readBigUInt64LE(78)
}

async function makePlan(db) {
  const pools = await selectPools(db)
  check(pools.length > 0, 'nothing to collect')
  const baseInfo = await primary.getMultipleAccountsInfo(pools.map(p => pk(p.baseAccount)), 'finalized')
  const missing = pools.filter((_, i) => !baseInfo[i])
  const batches = []
  for (let i = 0; i < pools.length; i += BATCH_SIZE) batches.push(pools.slice(i, i + BATCH_SIZE))
  const next = await multisigIndex() + 1n
  const rent = async bytes => BigInt(await primary.getMinimumBalanceForRentExemption(bytes, 'finalized'))
  const ataRent = { [TOKEN_PROGRAM_ID.toBase58()]: await rent(165), [TOKEN_2022_PROGRAM_ID.toBase58()]: await rent(170) }
  const proposalRent = await rent(PROPOSAL_BYTES)
  let cost = missing.reduce((sum, p) => sum + ataRent[p.baseProgram], 0n) + BigInt(Math.ceil(missing.length / ATAS_PER_TX) * FEE_PER_SIGNATURE)
  const measured = []
  for (const [k, batch] of batches.entries()) {
    const simulation = await simulateClaims(batch)
    check(simulation.ok, `claim simulation failed for batch ${k}: ${JSON.stringify(simulation.err)}`)
    const plan = squadsPlan(await Promise.all(batch.map(p => claimInstruction(p, p.fee))), next + BigInt(k))
    const shapes = stages(plan).map(s => ({ name: s.name, bytes: wireBytes(s.instructions, s.signers.length), signatures: s.signers.length }))
    check(shapes.every(s => s.bytes <= MAX_TX_BYTES), `batch ${k} transaction too large: ${JSON.stringify(shapes)}`)
    // Only the next index can be created, so Squads' acceptance of the message is simulated for the first batch.
    if (k === 0) {
      const { value } = await simulateUnsigned(stages(plan)[0].instructions)
      check(value.err === null, `Squads rejected the first vault transaction: ${JSON.stringify(value.err)} ${value.logs?.slice(-3).join(' | ')}`)
    }
    const batchCost = await rent(vaultTransactionBytes(plan)) + proposalRent + BigInt(shapes.reduce((n, s) => n + s.signatures, 0) * FEE_PER_SIGNATURE)
    cost += batchCost
    measured.push({ repoIds: batch.map(p => p.repoId), feeLamports: batch.reduce((n, p) => n + p.fee, 0n), costLamports: batchCost,
      unitsConsumed: simulation.unitsConsumed, shapes })
    await sleep(500)
  }
  return { kind: 'repoing-vault-creator-fee-collection/1', createdAt: new Date().toISOString(), multisig: CUSTODY_MULTISIG,
    vault: MULTISIG_VAULT, destination: DESTINATION.toBase58(), payer: PAYER, admin: ADMIN, approver: APPROVER,
    floorLamports: MIN_CLAIM_LAMPORTS, heldRepos: [...HELD_REPOS], pools, missingBaseAccounts: missing.map(p => p.baseAccount), batches: measured,
    totals: { pools: pools.length, batches: batches.length, feesLamports: pools.reduce((n, p) => n + p.fee, 0n), exactCostLamports: cost,
      ceilingLamports: cost + CEILING_MARGIN_LAMPORTS } }
}

// ---- collect ----

// The dialog runs without blocking the event loop; a blocked loop leaves dead keep-alive sockets for the next RPC call.
async function memberFromKit(path) {
  const { stdout } = await promisify(execFile)('osascript', ['-e', 'text returned of (display dialog "Passphrase for the multisig member kit ' +
    '(repo.ing creator fee collection)" default answer "" with hidden answer with title "repo.ing custody")'],
  { encoding: 'utf8' })
  const passphrase = stdout.replace(/\n$/, '')
  let entries
  try { entries = openKit({ kit: JSON.parse(readFileSync(path, 'utf8')), passphrase }) }
  catch (error) { throw Error(`${error.message} (typed ${[...passphrase.normalize('NFKC')].length} characters)`) }
  let member = null
  for (const { keypair } of entries) {
    const candidate = Keypair.fromSecretKey(Uint8Array.from(keypair)); keypair.fill(0)
    if (candidate.publicKey.toBase58() === APPROVER) member = candidate; else wipe([candidate])
  }
  check(member, 'the kit does not hold the planned approver')
  return member
}

async function confirmFinalized(signature, lastValidBlockHeight) {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const [{ value: [a] }, { value: [b] }] = await Promise.all([primary, verification].map(c => c.getSignatureStatuses([signature], { searchTransactionHistory: true })))
    if (a?.err || b?.err) throw Error(`transaction failed on chain: ${signature}`)
    if (a?.confirmationStatus === 'finalized' && b?.confirmationStatus === 'finalized') return 'finalized'
    if (!a && !b && await primary.getBlockHeight('confirmed') > lastValidBlockHeight) return 'expired'
    await sleep(POLL_MS)
  }
  throw Error(`finality timeout: ${signature}`)
}

// Simulates with signatures first; never sends a transaction that fails simulation. One resend only if the first expired unseen.
async function send(stage, keys, journal, label, preflight = () => true) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { blockhash, lastValidBlockHeight } = await primary.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: pk(PAYER), blockhash, lastValidBlockHeight }).add(...stage.instructions)
    tx.sign(...stage.signers.map(a => keys.get(a)))
    const bytes = tx.serialize()
    check(bytes.length <= MAX_TX_BYTES, `${label} is ${bytes.length} bytes`)
    const sim = await primary.simulateTransaction(VersionedTransaction.deserialize(bytes), { sigVerify: true, innerInstructions: true, commitment: 'confirmed' })
    check(sim.value.err === null, `${label} simulation failed: ${JSON.stringify(sim.value.err)}`)
    check(preflight(sim.value), `${label} simulation did not match the reviewed transcript`)
    const signature = bs58.encode(tx.signature)
    journal.save({ [label]: { signature, sentAt: new Date().toISOString() } })
    await primary.sendRawTransaction(bytes, { skipPreflight: true, maxRetries: 10 })
    if (await confirmFinalized(signature, lastValidBlockHeight) === 'finalized') return signature
  }
  throw Error(`${label} expired twice without landing`)
}

async function proposalStatus(plan) {
  const [tx, proposal] = await primary.getMultipleAccountsInfo([pk(plan.transaction), pk(plan.proposal)], 'finalized')
  return { created: Boolean(tx), status: proposal ? PROPOSAL_STATUS[proposal.data[48]] : null }
}

function expectedReview(plan, batch, maxQuotes) {
  return { top: [plan.executeInstruction], inner: [{ index: 0, instructions: batch.flatMap((p, i) => {
    const event = Buffer.concat([CREATOR_EVENT, pk(p.pool).toBuffer(), Buffer.alloc(16)]); event.writeBigUInt64LE(maxQuotes[i], 56)
    return [{ instruction: plan.instructions[i], stackHeight: 2 },
      { instruction: createTransferCheckedInstruction(pk(p.quoteVault), NATIVE_MINT, DESTINATION, poolAuthority, maxQuotes[i], 9), stackHeight: 3 },
      { instruction: { programId: DBC, keys: [{ pubkey: eventAuthority, isSigner: true, isWritable: false }], data: event }, stackHeight: 3 }]
  }) }] }
}

async function collectBatch(k, planned, plan0, keys, journal, db, spent) {
  const state = journal.batches[k] ?? {}
  if (state.recorded) return state
  const batch = planned.repoIds.map(id => plan0.pools.find(p => p.repoId === id))
  const [a, b] = await readBoth(batch.map(p => pk(p.pool)))
  const before = batch.map((p, i) => { const x = poolFacts(a.accounts[i]), y = poolFacts(b.accounts[i])
    check(sameFacts(x, p) && sameFacts(y, p), `pool of repo ${p.repoId} changed since the plan`); return x.fee < y.fee ? x.fee : y.fee })
  if (state.index === undefined) {
    check(before.every((fee, i) => fee >= batch[i].fee), `batch ${k}: fees fell since the plan; something else claimed them`)
    journal.saveBatch(k, { index: String(await multisigIndex() + 1n), maxQuotes: before.map(String), preSlot: a.slot })
  }
  const s = journal.batches[k], index = BigInt(s.index), maxQuotes = s.maxQuotes.map(BigInt)
  const instructions = await Promise.all(batch.map((p, i) => claimInstruction(p, maxQuotes[i])))
  const plan = squadsPlan(instructions, index), [create, propose, execute] = stages(plan)
  let status = await proposalStatus(plan)
  if (!status.created) {
    check(await multisigIndex() === index - 1n, `batch ${k}: multisig index moved; another proposal exists`)
    await spent(create); await send(create, keys, journal, `batch-${k}-create`); status = await proposalStatus(plan)
  }
  if (!status.status) { await spent(propose); await send(propose, keys, journal, `batch-${k}-propose`); status = await proposalStatus(plan) }
  const review = expectedReview(plan, batch, maxQuotes)
  if (status.status === 'approved') {
    await spent(execute)
    const matches = sim => { const amounts = claimedAmounts(sim.innerInstructions, [])
      return amounts.length === batch.length && batch.every((p, i) => amounts.some(x => x.pool === p.pool && x.base === 0n && x.quote === maxQuotes[i])) }
    journal.saveBatch(k, { executeSignature: await send(execute, keys, journal, `batch-${k}-execute`, matches) })
    status = await proposalStatus(plan)
  }
  check(status.status === 'executed' && journal.batches[k].executeSignature, `batch ${k}: proposal is ${status.status}`)
  const signature = journal.batches[k].executeSignature
  const { governanceProof, finality } = await collectCustodyGovernance({ connection: primary, plan, signature, maxBlocks: PROOF_MAX_BLOCKS, blockDelayMs: PROOF_BLOCK_DELAY_MS })
  const tx = await agreedFinalizedTransaction(primary, verification, signature)
  const keysAfter = batch.flatMap(p => [pk(p.pool), pk(p.config)])
  const { value: after, context } = await primary.getMultipleAccountsInfoAndContext(keysAfter, { commitment: 'finalized', minContextSlot: tx.slot })
  const claims = batch.map((p, i) => {
    check(sameFacts(poolFacts(after[2 * i]), p), `pool of repo ${p.repoId} changed across execution`)
    return { attribution: { repoId: p.repoId, role: 'creator', phase: 'DBC', curve: p.pool, config: p.config, mint: p.mint, previousOwner: p.previousOwner },
      maxQuoteAmount: maxQuotes[i], poolAccount: raw(p.pool, after[2 * i]), configAccount: raw(p.config, after[2 * i + 1]) }
  })
  // Observation is bracketed: pre-read at preSlot, post-read at context.slot; the bound fields are equal on both sides.
  const evidence = { plan: { role: 'creator', payer: PAYER, authority: MULTISIG_VAULT, instructions, claims,
    observation: { slot: tx.slot, commitment: 'finalized', bracket: { before: s.preSlot, after: context.slot } } },
  tx, finality, review, multisigPlan: plan, governanceProof }
  const receipt = validateDbcCustodyBatchReceipt(evidence)
  writeAtomic(`${file}.evidence-${k}.json`, json({ receipt, evidence: { ...evidence, governanceProof: { ...governanceProof, snapshot: {
    ...governanceProof.snapshot, blocks: governanceProof.snapshot.blocks.map(x => ({ slot: x.slot, blockhash: x.block.blockhash, parentSlot: x.block.parentSlot })) } } } }))
  const result = await recordValidatedDbcCustodyBatchCollection(db, evidence)
  journal.saveBatch(k, { recorded: true, inserted: result.inserted, amount: String(receipt.amount), slot: receipt.slot })
  return journal.batches[k]
}

// Journal, payer spend guard and the three signers. The caller must wipe keys when done.
// Each stage may carry `reserve`: the rent it creates; without one the collect plan's flat margin applies.
async function openSession(journalPath, ceiling, { members = true } = {}) {
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : { steps: {}, batches: {} }
  journal.save = entry => { Object.assign(journal.steps, entry); writeAtomic(journalPath, json({ steps: journal.steps, batches: journal.batches, start: journal.start })) }
  journal.saveBatch = (k, entry) => { journal.batches[k] = { ...journal.batches[k], ...entry }; journal.save({}) }
  journal.start ??= String(await primary.getBalance(pk(PAYER), 'finalized')); journal.save({})
  const spent = async stage => {
    const used = BigInt(journal.start) - BigInt(await primary.getBalance(pk(PAYER), 'finalized'))
    check(used + BigInt(stage.signers.length * FEE_PER_SIGNATURE) + (stage.reserve ?? CEILING_MARGIN_LAMPORTS) <= ceiling,
      `payer spend ${used} would pass the approved ceiling ${ceiling}`)
  }
  if (!members) {
    const [payer] = loadSigners(parseKeyArgs([`payer=${process.env.PAYER_KEY}`]), { payer: PAYER }, [PAYER])
    return { journal, spent, keys: new Map([[PAYER, payer]]) }
  }
  const [payer, admin] = loadSigners(parseKeyArgs([`payer=${process.env.PAYER_KEY}`, `admin=${process.env.ADMIN_KEY}`]),
    { payer: PAYER, admin: ADMIN }, [PAYER, ADMIN])
  const keys = new Map([[PAYER, payer], [ADMIN, admin]])
  try { keys.set(APPROVER, await memberFromKit(process.env.MEMBER_KIT)) } catch (error) { wipe([...keys.values()]); throw error }
  return { journal, spent, keys }
}

// One vault transaction at journal.batches[name].index: create, propose with two approvals, execute. Resumes from
// chain state, so a rerun never repeats a landed stage. Returns the execute signature.
async function runVaultTransaction(name, instructions, keys, journal, spent) {
  const index = BigInt(journal.batches[name].index)
  const rent = async bytes => BigInt(await primary.getMinimumBalanceForRentExemption(bytes, 'finalized'))
  const plan = squadsPlan(instructions, index)
  const [create, propose, execute] = stages(plan)
  create.reserve = await rent(vaultTransactionBytes(plan)); propose.reserve = await rent(PROPOSAL_BYTES); execute.reserve = 0n
  let status = await proposalStatus(plan)
  if (!status.created) {
    check(await multisigIndex() === index - 1n, 'multisig index moved; another proposal exists')
    await spent(create); await send(create, keys, journal, `${name}-create`); status = await proposalStatus(plan)
  }
  if (!status.status) { await spent(propose); await send(propose, keys, journal, `${name}-propose`); status = await proposalStatus(plan) }
  if (status.status === 'approved') {
    await spent(execute)
    journal.saveBatch(name, { executeSignature: await send(execute, keys, journal, `${name}-execute`) }); status = await proposalStatus(plan)
  }
  check(status.status === 'executed' && journal.batches[name].executeSignature, `${name} proposal is ${status.status}`)
  return journal.batches[name].executeSignature
}

// Native lamports of `address` on both providers; they must agree.
async function lamportsOf(address) {
  const [a, b] = await Promise.all([primary, verification].map(c => c.getMultipleAccountsInfo([pk(address)], 'finalized')))
  const values = [a[0], b[0]].map(info => BigInt(info?.lamports ?? 0))
  check(values[0] === values[1], `providers disagree on the balance of ${address}`)
  return values[0]
}

// Lamport change of `address` in a finalized transaction both providers agree on.
async function lamportDelta(signature, address) {
  const tx = await agreedFinalizedTransaction(primary, verification, signature)
  const keys = (tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys).map(k => k.toBase58())
  const i = keys.indexOf(address)
  check(i >= 0, `${address} is not in ${signature}`)
  return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i])
}

// Payer → vault, payer key only. The cap covers the amount and the network fee.
async function fundVault() {
  const amount = BigInt(process.env.FUND_LAMPORTS), cap = BigInt(process.env.FUND_CAP_LAMPORTS)
  check(amount > 0n && amount < cap, 'invalid fund amount or cap')
  const { journal, spent, keys } = await openSession(file, cap, { members: false })
  try {
    if (!journal.batches.fund?.signature) {
      const stage = { instructions: [SystemProgram.transfer({ fromPubkey: pk(PAYER), toPubkey: pk(MULTISIG_VAULT), lamports: amount })],
        signers: [PAYER], reserve: amount }
      await spent(stage)
      journal.saveBatch('fund', { signature: await send(stage, keys, journal, 'fund-vault') })
    }
    const signature = journal.batches.fund.signature
    check(await lamportDelta(signature, MULTISIG_VAULT) === amount, 'the vault did not receive exactly the approved amount')
    journal.saveBatch('fund', { done: true })
    return { fundedLamports: amount, signature, vaultLamports: await lamportsOf(MULTISIG_VAULT) }
  } finally { wipe([...keys.values()]) }
}

// Vault → recipient in native SOL through the 2-of-3 multisig.
async function sendSol() {
  const recipient = new PublicKey(process.env.SEND_RECIPIENT).toBase58(), amount = BigInt(process.env.SEND_LAMPORTS)
  const cap = BigInt(process.env.SEND_CAP_LAMPORTS)
  check(amount > 0n && cap > 0n && recipient !== MULTISIG_VAULT && PublicKey.isOnCurve(pk(recipient).toBytes()), 'invalid send amount, cap or recipient')
  const { journal, spent, keys } = await openSession(file, cap)
  try {
    if (!journal.batches.send) {
      // A system account with no data must stay at 0 or at least rent-exempt.
      const vault = await lamportsOf(MULTISIG_VAULT), floor = BigInt(await primary.getMinimumBalanceForRentExemption(0, 'finalized'))
      check(vault === amount || vault >= amount + floor, 'the vault cannot send this amount and stay rent-exempt')
      journal.saveBatch('send', { index: String(await multisigIndex() + 1n) })
    }
    const instruction = SystemProgram.transfer({ fromPubkey: pk(MULTISIG_VAULT), toPubkey: pk(recipient), lamports: amount })
    const signature = await runVaultTransaction('send', [instruction], keys, journal, spent)
    check(await lamportDelta(signature, MULTISIG_VAULT) === -amount && await lamportDelta(signature, recipient) === amount,
      'the execute transaction did not move exactly the approved amount')
    const used = BigInt(journal.start) - BigInt(await primary.getBalance(pk(PAYER), 'finalized'))
    journal.saveBatch('send', { done: true, payerSpent: String(used) })
    return { sentLamports: amount, recipient, signature, vaultLamports: await lamportsOf(MULTISIG_VAULT), payerSpentLamports: used }
  } finally { wipe([...keys.values()]) }
}

// A vault transaction carrying only an owner-approved file of Hook governance instructions (sha256-approved, checked by
// `guard`): the admin role's acceptance, or a governed Config change. Moves no funds; the payer pays the Squads
// accounts' rent and the fees.
async function vaultHookInstructions(name, prefix, guard) {
  const text = readFileSync(process.env[`${prefix}_FILE`], 'utf8'), cap = BigInt(process.env[`${prefix}_CAP_LAMPORTS`])
  check(sha256(Buffer.from(text)) === process.env[`${prefix}_SHA256`], `the ${name} file differs from its approved sha256`)
  const instructions = JSON.parse(text).map(ix => new TransactionInstruction({ programId: pk(ix.programId), data: Buffer.from(ix.data, 'base64'),
    keys: ix.keys.map(k => ({ pubkey: pk(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })) }))
  guard(instructions, MULTISIG_VAULT)
  const { journal, spent, keys } = await openSession(file, cap)
  try {
    if (!journal.batches[name]) journal.saveBatch(name, { index: String(await multisigIndex() + 1n) })
    const signature = await runVaultTransaction(name, instructions, keys, journal, spent)
    const used = BigInt(journal.start) - BigInt(await primary.getBalance(pk(PAYER), 'finalized'))
    journal.saveBatch(name, { done: true, payerSpent: String(used) })
    return { executed: instructions.map(ix => ix.programId.toBase58()), signature, payerSpentLamports: used }
  } finally { wipe([...keys.values()]) }
}
const hookAdminAccept = () => vaultHookInstructions('hook-admin-accept', 'HOOK_ACCEPT', assertHookAdminAccept)
const hookConfigChange = () => vaultHookInstructions('hook-config-change', 'HOOK_CONFIG', assertHookGovernedConfig)

async function sweep() {
  const recipient = new PublicKey(process.env.SWEEP_RECIPIENT).toBase58(), amount = BigInt(process.env.SWEEP_LAMPORTS)
  const cap = BigInt(process.env.SWEEP_CAP_LAMPORTS)
  check(amount > 0n && cap > 0n && recipient !== MULTISIG_VAULT && PublicKey.isOnCurve(pk(recipient).toBytes()), 'invalid sweep amount, cap or recipient')
  const target = getAssociatedTokenAddressSync(NATIVE_MINT, pk(recipient))
  // Raw account reads: the verification RPC refuses getTokenAccountBalance without a personal token.
  const amountOf = (address, info, owner) => {
    if (!info) return null
    const account = unpackAccount(address, info, TOKEN_PROGRAM_ID)
    check(account.mint.equals(NATIVE_MINT) && account.owner.toBase58() === owner && !account.delegate && !account.closeAuthority, 'unexpected WSOL account state')
    return account.amount
  }
  const balances = async () => (await Promise.all([primary, verification].map(c => c.getMultipleAccountsInfo([DESTINATION, target], 'finalized'))))
    .flatMap(([v, t]) => [amountOf(DESTINATION, v, MULTISIG_VAULT), amountOf(target, t, recipient)])
  const [vaultA, targetA, vaultB, targetB] = await balances()
  const { journal, spent, keys } = await openSession(file, cap)
  try {
    const rent = async bytes => BigInt(await primary.getMinimumBalanceForRentExemption(bytes, 'finalized'))
    if (!journal.batches.sweep) {
      check(vaultA === vaultB && targetA === targetB && vaultA >= amount, 'providers disagree or the vault holds less than the approved amount')
      journal.saveBatch('sweep', { index: String(await multisigIndex() + 1n), vaultBefore: String(vaultA), targetBefore: String(targetA ?? 0n) })
    }
    const s = journal.batches.sweep
    const info = await primary.getAccountInfo(target, 'finalized')
    if (!info) {
      const stage = { instructions: [createAssociatedTokenAccountIdempotentInstruction(pk(PAYER), target, pk(recipient), NATIVE_MINT)],
        signers: [PAYER], reserve: await rent(165) }
      await spent(stage); await send(stage, keys, journal, 'sweep-recipient-account')
    } else check(info.owner.equals(TOKEN_PROGRAM_ID), 'recipient WSOL account is not a token account')
    const instruction = createTransferCheckedInstruction(DESTINATION, NATIVE_MINT, target, pk(MULTISIG_VAULT), amount, 9)
    await runVaultTransaction('sweep', [instruction], keys, journal, spent)
    const [vaultC, targetC, vaultD, targetD] = await balances()
    check(vaultC === vaultD && targetC === targetD && BigInt(s.vaultBefore) - vaultC === amount && targetC - BigInt(s.targetBefore) === amount,
      'balances after the sweep do not show exactly the approved amount moving')
    const used = BigInt(journal.start) - BigInt(await primary.getBalance(pk(PAYER), 'finalized'))
    journal.saveBatch('sweep', { done: true, payerSpent: String(used) })
    return { movedLamports: amount, from: DESTINATION.toBase58(), to: target.toBase58(), recipient, signature: journal.batches.sweep.executeSignature,
      vaultWsolLamports: vaultC, recipientWsolLamports: targetC, payerSpentLamports: used }
  } finally { wipe([...keys.values()]) }
}

async function collect(db) {
  const bytes = readFileSync(file)
  check(sha256(bytes) === process.env.APPROVED_PLAN_SHA256, 'plan file is not the approved plan')
  const plan0 = JSON.parse(bytes)
  for (const p of plan0.pools) p.fee = BigInt(p.fee)
  check(Date.now() - Date.parse(plan0.createdAt) < PLAN_MAX_AGE_MS && plan0.vault === MULTISIG_VAULT && plan0.approver === APPROVER, 'plan is stale or for other signers')
  const { journal, spent, keys } = await openSession(`${file}.journal.json`, BigInt(plan0.totals.ceilingLamports))
  try {
    const info = await primary.getMultipleAccountsInfo(plan0.pools.map(p => pk(p.baseAccount)), 'finalized')
    const missing = plan0.pools.filter((_, i) => !info[i])
    for (let i = 0; i < missing.length; i += ATAS_PER_TX) {
      const stage = { instructions: missing.slice(i, i + ATAS_PER_TX).map(createBase), signers: [PAYER] }
      await spent(stage); await send(stage, keys, journal, `base-accounts-${i / ATAS_PER_TX}`)
    }
    const results = []
    for (const [k, planned] of plan0.batches.entries()) {
      const r = await collectBatch(k, planned, plan0, keys, journal, db, spent)
      results.push({ batch: k, repoIds: planned.repoIds, amount: r.amount, slot: r.slot, inserted: r.inserted })
      console.log(JSON.stringify(results.at(-1)))
    }
    const used = BigInt(journal.start) - BigInt(await primary.getBalance(pk(PAYER), 'finalized'))
    const vault = await primary.getTokenAccountBalance(DESTINATION, 'finalized')
    return { collectedLamports: results.reduce((n, r) => n + BigInt(r.amount), 0n), payerSpentLamports: used, vaultWsolLamports: vault.value.amount, batches: results.length }
  } finally { wipe([...keys.values()]) }
}

const db = new pg.Pool({ connectionString: process.env.CUSTODY_RECORDER_DATABASE_URL, max: 1 })
try {
  check((await db.query('select current_user as role')).rows[0].role === 'repoing_custody_recorder', 'restricted custody recorder role required')
  if (mode === 'plan') {
    const plan = await makePlan(db)
    check(!existsSync(file), 'refusing to overwrite an existing plan file')
    const text = json(plan); writeFileSync(file, text, { flag: 'wx', mode: 0o600 })
    console.log(json({ planSha256: sha256(Buffer.from(text)), ...plan.totals, missingBaseAccounts: plan.missingBaseAccounts.length,
      pools: plan.pools.map(p => ({ repoId: p.repoId, sol: Number(p.fee) / 1e9 })) }))
  } else {
    const run = { collect: () => collect(db), sweep, 'fund-vault': fundVault, 'send-sol': sendSol, 'hook-admin-accept': hookAdminAccept, 'hook-config-change': hookConfigChange }[mode]
    console.log(json(await run()))
  }
} finally { await db.end() }
