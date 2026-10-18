// Offline stage-one byte planner. No RPC, key generation, signatures, sends or adoption.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BorshCoder } from '@anchor-lang/core'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { z } from 'zod'
import { HOOK_MAINNET_GENESIS, hookAddress as key, hookDigest as hash, hookRawAmount as u64 } from './hooklab-execution-contract.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const check = (ok, message) => { if (!ok) throw Error(message) }
const sha = value => createHash('sha256').update(value).digest('hex')
const pk = value => new PublicKey(value)
const zero = '11111111111111111111111111111111', loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[0].toBase58()
const raw = (text, maximum) => {
  const bytes = Buffer.from(text, 'base64')
  check(bytes.length <= maximum && bytes.toString('base64') === text, 'Noncanonical or oversized bytes')
  return bytes
}
const role = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const roles = z.object({ launch: key, swap: key, gate: key, token: key, bridge: key }).strict()
const artifactHashes = z.object({ launch: hash, swap: hash, gate: hash }).strict()
const profileSchema = z.object({ schema: z.literal('hook-lab/offline-custom-builder-profile/1'),
  profileId: z.string().min(1).max(128), status: z.literal('offline-candidate-not-adopted'),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourcePatchSha256: hash.nullable(),
  buildFeature: z.enum(['custom-hooks-production', 'custom-hooks-reuse-candidate']),
  genesisHash: z.literal(HOOK_MAINNET_GENESIS), programs: roles, quoteMint: key,
  idlSha256: artifactHashes, elfSha256: artifactHashes,
  dependencyObservation: z.object({ tokenElfSha256: hash, sourceProvenanceVerified: z.literal(false), ownerAcceptanceVerified: z.literal(false) }).strict(),
  capability: z.object({ kind: z.literal('immutable-canonical-single-blocked-owner'), beforeTransferOnly: z.literal(true),
    creatorFeeBps: z.literal(0), rules: z.literal('none'), atomicPrepareAndLaunch: z.literal(false),
    prepareMintSignerRequired: z.literal(true), launchAdminCosignerRequired: z.literal(true) }).strict(),
  artifactAdopted: z.literal(false), ownerApprovalVerified: z.literal(false), executionAuthorized: z.literal(false),
  publicExecutionEnabled: z.literal(false), canSign: z.literal(false), canSubmit: z.literal(false),
}).strict()
export const customPreparationRequestSchema = z.object({ schema: z.literal('repoing/custom-preparation-request/1'),
  creator: key, feePayer: key, mint: key, selectedConfig: key, blockedOwner: key.refine(v => v !== zero),
  label: z.string().min(1).refine(v => Buffer.byteLength(v) <= 32),
  creatorFeeBps: z.literal(0), rules: z.literal('none'), hookFlags: z.literal(1),
}).strict()
const account = z.object({ address: key, owner: key, executable: z.boolean(), dataBase64: z.string().max(14000000), lamports: u64 }).strict()
const presentOrAbsent = z.object({ address: key, account: account.nullable() }).strict()
const observationSchema = z.object({ provider: role, genesisHash: key, commitment: z.literal('finalized'),
  slot: integer, observedAtMs: integer, accounts: z.array(presentOrAbsent).length(11),
  rentExemptionLamports: z.object({ policy: u64, registry: u64, selectedConfig: u64 }).strict(),
}).strict()
const blockhashSchema = z.object({ blockhash: key, genesisHash: key, providers: z.array(role).length(2),
  observedAtMs: integer, currentBlockHeight: integer.positive(), blockhashValid: z.literal(true),
  lastValidBlockHeight: integer.positive(), observedSlot: integer,
  networkFeeLamports: u64, lamportsPerSignature: u64.refine(v => BigInt(v) > 0n) }).strict()
const lookupSchema = z.object({ address: key, owner: z.literal('AddressLookupTab1e1111111111111111111111111'),
  dataBase64: z.string().max(22000), sha256: hash }).strict().nullable()
const limitsSchema = z.object({ nowMs: integer, maxAgeMs: integer.positive().max(60000),
  maxSlotLag: integer.max(150), validUntilSlot: integer, reviewExpiresAtMs: integer,
  maxRentLamports: u64, maxNetworkFeeLamports: u64, maxTotalDebitLamports: u64,
  computeUnitLimit: integer.positive().max(1400000), computeUnitPriceMicroLamports: u64,
}).strict()
const inputSchema = z.object({ profile: z.object({ json: z.string().max(16384), expectedSha256: hash,
  idls: z.object({ launch: z.string().max(1500000), gate: z.string().max(1500000) }).strict(),
  elfLengths: z.object({ launch: integer.positive().max(10485760), gate: integer.positive().max(10485760) }).strict(),
  providers: z.array(role).length(2).refine(v => new Set(v).size === 2),
}).strict(),
  request: customPreparationRequestSchema, observations: z.array(observationSchema).length(2),
  recentBlockhash: blockhashSchema, lookupTable: lookupSchema, limits: limitsSchema,
}).strict()
const rules = { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0, burn_buy_bps: 0, burn_sell_bps: 0,
  max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 }
function binding(artifact) {
  const bytes = raw(artifact.idlBase64, 1048576)
  check(sha(bytes) === artifact.idlSha256, 'IDL digest differs')
  const idl = JSON.parse(bytes)
  check(idl.address === artifact.program, 'IDL identity differs')
  return { idl, coder: new BorshCoder(idl) }
}
function instruction(binding, name, values, args, expected) {
  const ix = binding.idl.instructions.find(i => i.name === name)
  check(ix && isDeepStrictEqual(ix.accounts.map(a => [a.name, !!a.writable, !!a.signer]), expected), 'Instruction account ABI differs')
  return new TransactionInstruction({ programId: pk(binding.idl.address),
    keys: ix.accounts.map(a => {
      check(values[a.name] && (!a.address || values[a.name] === a.address), 'Instruction fixed account differs')
      return { pubkey: pk(values[a.name]), isSigner: !!a.signer, isWritable: !!a.writable }
    }), data: binding.coder.instruction.encode(name, args) })
}
function programEvidence(accounts, artifact, observedSlot, immutable) {
  const pd = pda(loader, pk(artifact.program).toBuffer()), program = accounts.get(artifact.program), data = accounts.get(pd)
  check(program && data && program.owner === loader && program.executable && data.owner === loader && !data.executable, 'Program ownership differs')
  const pb = raw(program.dataBase64, 36), db = raw(data.dataBase64, 10485760 + 45)
  check(pb.length === 36 && pb.readUInt32LE() === 2 && pk(pb.subarray(4)).toBase58() === pd, 'ProgramData linkage differs')
  check(db.length >= 45 + artifact.elfLength && db.readUInt32LE() === 3 && db.readBigUInt64LE(4) <= BigInt(observedSlot)
    && (immutable ? db[12] === 0 : db[12] === 0 || db[12] === 1), 'ProgramData state differs')
  const elf = db.subarray(45, 45 + artifact.elfLength)
  check(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && sha(elf) === artifact.elfSha256
    && db.subarray(45 + artifact.elfLength).every(v => v === 0), 'Program ELF differs')
}

/** profile.expectedSha256 must come from independent review, never a browser request.
 * Supplied observations remain assertions, not authenticated history or execution permission.
 * Stage one has no onchain rent cap/deadline instruction; this is an offline review bound only.
 */
export function planCustomPreparation(input) {
  const { profile: envelope, request: r, observations: obs, recentBlockhash: bh, lookupTable, limits: l } = inputSchema.parse(input)
  check(sha(envelope.json) === envelope.expectedSha256, 'Reviewed profile digest differs')
  const profile = profileSchema.parse(JSON.parse(envelope.json))
  check((profile.buildFeature === 'custom-hooks-reuse-candidate') === (profile.sourcePatchSha256 !== null), 'Candidate source patch binding differs')
  check(new Set(Object.values(profile.programs)).size === 5 && !Object.values(profile.programs).includes(zero), 'Profile program roles alias')
  const artifact = role => ({ program: profile.programs[role], idlBase64: envelope.idls[role], idlSha256: profile.idlSha256[role],
    elfSha256: profile.elfSha256[role], elfLength: envelope.elfLengths[role] })
  const launchArtifact = artifact('launch'), gateArtifact = artifact('gate'), launch = binding(launchArtifact), gate = binding(gateArtifact)
  check(launch.idl.instructions.some(ix => ix.name === 'create_launch_custom_mainnet'), 'Plain-only ABI cannot prepare a custom candidate')
  const addresses = { launch: profile.programs.launch, gate: profile.programs.gate,
    launchConfig: pda(profile.programs.launch, 'config'), eventAuthority: pda(profile.programs.launch, '__event_authority'),
    launchProgramData: pda(loader, pk(profile.programs.launch).toBuffer()), gateProgramData: pda(loader, pk(profile.programs.gate).toBuffer()),
    policy: pda(profile.programs.gate, 'policy', pk(r.mint).toBuffer()),
    registry: pda(profile.programs.gate, 'bordrless-hook-accounts', pk(r.mint).toBuffer()) }
  // A fee payer may equal the creator. All other transaction roles must stay distinct.
  const distinct = [...Object.values(addresses), r.creator, r.mint, r.selectedConfig, zero, ComputeBudgetProgram.programId.toBase58()]
  check(new Set(distinct).size === distinct.length && (r.feePayer === r.creator || !distinct.includes(r.feePayer)), 'Preparation roles alias')
  check(!lookupTable || ![...distinct, r.feePayer, ...Object.values(profile.programs)].includes(lookupTable.address), 'Lookup table aliases a preparation role')
  check(PublicKey.isOnCurve(pk(r.creator).toBytes()) && PublicKey.isOnCurve(pk(r.feePayer).toBytes())
    && PublicKey.isOnCurve(pk(r.mint).toBytes()) && PublicKey.isOnCurve(pk(r.selectedConfig).toBytes()), 'Required signer cannot be a PDA')
  check(new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => envelope.providers.includes(o.provider)), 'Provider binding differs')
  check(Math.abs(obs[0].slot - obs[1].slot) <= l.maxSlotLag && isDeepStrictEqual(obs[0].accounts, obs[1].accounts)
    && isDeepStrictEqual(obs[0].rentExemptionLamports, obs[1].rentExemptionLamports), 'Preparation observations disagree')
  const expected = [addresses.launch, addresses.gate, addresses.launchProgramData, addresses.gateProgramData,
    addresses.launchConfig, addresses.policy, addresses.registry, r.mint, r.selectedConfig, r.creator, r.feePayer]
  // The inventory is explicit and ordered; same-payer creator is represented twice with equal bytes.
  check(obs.every(o => isDeepStrictEqual(o.accounts.map(a => a.address), expected)), 'Incomplete preparation inventory')
  for (const o of obs) {
    check(o.genesisHash === profile.genesisHash && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale or wrong-chain preparation observation')
    check(r.creator !== r.feePayer || isDeepStrictEqual(o.accounts[9], o.accounts[10]), 'Repeated payer evidence differs')
    const accounts = new Map(o.accounts.map(a => { check(a.account === null || a.account.address === a.address, 'Account identity differs'); return [a.address, a.account] }))
    programEvidence(accounts, launchArtifact, o.slot, false); programEvidence(accounts, gateArtifact, o.slot, true)
    for (const address of [addresses.policy, addresses.registry, r.selectedConfig]) check(accounts.get(address) === null, 'Preparation account already exists; do not retry')
    for (const address of [r.creator, r.feePayer, r.mint]) {
      const a = accounts.get(address)
      check((address === r.mint && a === null) || a && a.owner === zero && !a.executable && raw(a.dataBase64, 0).length === 0, 'Signer account is not an uninitialized system account')
    }
    const config = accounts.get(addresses.launchConfig)
    check(config && config.owner === addresses.launch && !config.executable, 'Launch configuration owner differs')
    const cb = raw(config.dataBase64, 250)
    check(cb.length === 250 && cb[8] === 1, 'Launch configuration layout differs')
    launch.coder.accounts.decode('Config', cb)
  }
  const slot = Math.max(...obs.map(o => o.slot))
  check(bh.genesisHash === profile.genesisHash && isDeepStrictEqual(bh.providers, envelope.providers)
    && l.nowMs >= bh.observedAtMs && l.nowMs - bh.observedAtMs <= l.maxAgeMs
    && bh.currentBlockHeight <= bh.lastValidBlockHeight && bh.lastValidBlockHeight - bh.currentBlockHeight <= 150
    && bh.observedSlot >= slot && bh.observedSlot - slot <= l.maxSlotLag && bh.observedSlot <= l.validUntilSlot && l.validUntilSlot - slot <= 150
    && l.reviewExpiresAtMs > l.nowMs && l.reviewExpiresAtMs - l.nowMs <= l.maxAgeMs, 'Review lifetime differs')
  const rent = Object.values(obs[0].rentExemptionLamports).reduce((n, v) => n + BigInt(v), 0n)
  check(Object.values(obs[0].rentExemptionLamports).every(v => BigInt(v) > 0n)
    && rent <= BigInt(l.maxRentLamports) && rent + BigInt(bh.networkFeeLamports) <= BigInt(l.maxTotalDebitLamports), 'Preparation rent/debit cap exceeded')
  const balances = new Map(obs[0].accounts.map(a => [a.address, a.account]))
  check(BigInt(balances.get(r.creator).lamports) >= rent + (r.creator === r.feePayer ? BigInt(bh.networkFeeLamports) : 0n)
    && BigInt(balances.get(r.feePayer).lamports) >= BigInt(bh.networkFeeLamports), 'Preparation payer funds insufficient')
  const prepare = instruction(gate, 'prepare', { payer: r.creator, mint: r.mint, policy: addresses.policy,
    registry: addresses.registry, system_program: zero }, { blocked_owner: pk(r.blockedOwner) },
  [['payer', true, true], ['mint', false, true], ['policy', true, false], ['registry', true, false], ['system_program', false, false]])
  const config = instruction(launch, 'create_config', { creator: r.creator, config: addresses.launchConfig,
    launch_config: r.selectedConfig, hook_program: addresses.gate, system_program: zero, event_authority: addresses.eventAuthority, program: addresses.launch },
  { args: { rules, creator_fee_bps: r.creatorFeeBps, custom_hook: pk(addresses.gate), custom_hook_flags: r.hookFlags, label: r.label } },
  [['creator', true, true], ['config', false, false], ['launch_config', true, true], ['hook_program', false, false],
    ['system_program', false, false], ['event_authority', false, false], ['program', false, false]])
  // Rust create_config client appends this remaining account; it is absent from the declared IDL list.
  config.keys.push({ pubkey: pk(addresses.gateProgramData), isSigner: false, isWritable: false })
  const tables = lookupTable ? [new AddressLookupTableAccount({ key: pk(lookupTable.address), state: AddressLookupTableAccount.deserialize(raw(lookupTable.dataBase64, 16384)) })] : []
  const message = new TransactionMessage({ payerKey: pk(r.feePayer), recentBlockhash: bh.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: l.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) }), prepare, config,
  ] }).compileToV0Message(tables)
  check(!lookupTable || message.addressTableLookups.length === 1, 'Unused lookup table')
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables }), bytes = message.serialize()
  const priority = (BigInt(l.computeUnitLimit) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(BigInt(bh.networkFeeLamports) === BigInt(message.header.numRequiredSignatures) * BigInt(bh.lamportsPerSignature) + priority, 'Network fee quote differs from explicit signature fee basis')
  const review = { schema: 'hooklab-message-review/1', operation: 'custom-preparation', genesisHash: profile.genesisHash,
    profileSha256: envelope.expectedSha256, policySha256: sha(JSON.stringify(obs)), intentSha256: sha(JSON.stringify(r)),
    payer: r.feePayer, wallet: r.creator, messageBase64: Buffer.from(bytes).toString('base64'), messageSha256: sha(bytes),
    requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(k => k.toBase58()),
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: lookupTable ? [lookupTable] : [], observedSlot: slot, validUntilSlot: l.validUntilSlot,
    observedAtMs: l.nowMs, reviewExpiresAtMs: l.reviewExpiresAtMs, lastValidBlockHeight: bh.lastValidBlockHeight,
    baseFeeLamports: String(BigInt(bh.networkFeeLamports) - priority), maxFeeLamports: l.maxNetworkFeeLamports,
    instructionDebitLamports: String(rent), maxNativeDebitLamports: l.maxTotalDebitLamports }
  const inspected = inspectHookLabMessage(review)
  check(inspected.instructions.length === 4, 'Unexpected preparation instruction')
  const wantedWritable = new Set([r.creator, r.feePayer, r.selectedConfig, addresses.policy, addresses.registry])
  const wantedSigners = new Set([r.creator, r.feePayer, r.selectedConfig, r.mint])
  check(review.accounts.every(a => a.writable === wantedWritable.has(a.address) && a.signer === wantedSigners.has(a.address)), 'Compiled preparation privileges differ')
  return { schema: 'repoing/custom-preparation-plan/1', status: 'offline-unverified-preparation', sourceCommit: profile.sourceCommit,
    releaseProfileSha256: envelope.expectedSha256, sourcePatchSha256: profile.sourcePatchSha256, request: r, addresses, review, instructions: inspected.instructions,
    rentAccountSizes: { policy: 72, registry: 47, selectedConfig: 176 }, rentQuoteLamports: String(rent),
    preparationReceiptAccepted: false, launchPlan: null, deploymentAdopted: false, policyApproved: false,
    rentCapEnforcedOnchain: false, feeEvidenceAuthenticated: false, canSign: false, canSubmit: false, canRetry: false }
}
