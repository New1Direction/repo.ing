// Offline stage-one byte planner. No RPC, key generation, signatures, sends or adoption.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import BN from 'bn.js'
import { BorshCoder } from '@anchor-lang/core'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { z } from 'zod'
import { HOOK_MAINNET_GENESIS, hookAddress as key, hookDigest as hash, hookRawAmount as u64 } from './hooklab-execution-contract.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { otherPrograms, profileRolesDistinct, stackProfileFieldSchema } from './hooklab-stack.mjs'
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
// Legacy profiles (bundle 2) name the bridge; a stack profile (src/hooklab-stack.mjs) has none and names its stack.
const roles = z.union([z.object({ launch: key, swap: key, gate: key, token: key, bridge: key }).strict(), z.object({ launch: key, swap: key, gate: key, token: key }).strict()])
const artifactHashes = z.object({ launch: hash, swap: hash, gate: hash }).strict()
export const maxWalletProfileSchema = z.object({ schema: z.literal('hook-lab/offline-max-wallet-builder-profile/1'),
  profileId: z.string().min(1).max(128), status: z.literal('offline-candidate-not-adopted'),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourcePatchSha256: hash,
  buildFeature: z.literal('max-wallet-reuse-candidate'),
  genesisHash: z.literal(HOOK_MAINNET_GENESIS), programs: roles, quoteMint: key, stack: stackProfileFieldSchema.optional(),
  idlSha256: artifactHashes, elfSha256: artifactHashes,
  dependencyObservation: z.object({ tokenElfSha256: hash, sourceProvenanceVerified: z.literal(false), ownerAcceptanceVerified: z.literal(false) }).strict(),
  capability: z.object({ kind: z.literal('immutable-initial-supply-owner-cap-until-authenticated-graduation'), beforeTransferOnly: z.literal(true),
    creatorFeeBps: z.literal(0), rules: z.literal('none'), atomicPrepareAndLaunch: z.literal(false),
    prepareMintSignerRequired: z.literal(true), launchAdminCosignerRequired: z.literal(true) }).strict(),
  artifactAdopted: z.literal(false), ownerApprovalVerified: z.literal(false), executionAuthorized: z.literal(false),
  publicExecutionEnabled: z.literal(false), canSign: z.literal(false), canSubmit: z.literal(false),
}).strict()
export const maxWalletPreparationRequestSchema = z.object({ schema: z.literal('repoing/max-wallet-preparation-request/1'),
  policyKind: z.literal('max-wallet'), policyVersion: z.literal(1),
  creator: key, feePayer: key, mint: key, selectedConfig: key, capBps: z.number().int().min(1).max(9999),
  label: z.string().min(1).refine(v => Buffer.byteLength(v) <= 32),
  creatorFeeBps: z.literal(0), rules: z.literal('none'), hookFlags: z.literal(1),
}).strict()
const account = z.object({ address: key, owner: key, executable: z.boolean(), dataBase64: z.string().max(14000000), lamports: u64 }).strict()
const presentOrAbsent = z.object({ address: key, account: account.nullable() }).strict()
const observationSchema = z.object({ provider: role, genesisHash: key, commitment: z.literal('finalized'),
  slot: integer, observedAtMs: integer, accounts: z.array(presentOrAbsent).length(12),
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
  request: maxWalletPreparationRequestSchema, observations: z.array(observationSchema).length(2),
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
export function planMaxWalletPreparation(input) {
  const { profile: envelope, request: r, observations: obs, recentBlockhash: bh, lookupTable, limits: l } = inputSchema.parse(input)
  check(sha(envelope.json) === envelope.expectedSha256, 'Reviewed profile digest differs')
  const profile = maxWalletProfileSchema.parse(JSON.parse(envelope.json))
  check(profileRolesDistinct(profile), 'Profile program roles alias')
  const artifact = role => ({ program: profile.programs[role], idlBase64: envelope.idls[role], idlSha256: profile.idlSha256[role],
    elfSha256: profile.elfSha256[role], elfLength: envelope.elfLengths[role] })
  const launchArtifact = artifact('launch'), gateArtifact = artifact('gate'), launch = binding(launchArtifact), gate = binding(gateArtifact)
  check(launch.idl.instructions.some(ix => ix.name === 'create_launch_custom_mainnet'), 'Plain-only ABI cannot prepare a custom candidate')
  const addresses = { launch: profile.programs.launch, gate: profile.programs.gate,
    launchConfig: pda(profile.programs.launch, 'config'), eventAuthority: pda(profile.programs.launch, '__event_authority'),
    launchProgramData: pda(loader, pk(profile.programs.launch).toBuffer()), gateProgramData: pda(loader, pk(profile.programs.gate).toBuffer()),
    policy: pda(profile.programs.gate, 'policy', pk(r.mint).toBuffer()),
    registry: pda(profile.programs.gate, 'bordrless-hook-accounts', pk(r.mint).toBuffer()),
    canonicalLaunch: pda(profile.programs.launch, 'launch', pk(r.mint).toBuffer()) }
  // A fee payer may equal the creator. All other transaction roles must stay distinct.
  const distinct = [...Object.values(addresses), ...otherPrograms(profile), profile.quoteMint, r.creator, r.mint, r.selectedConfig, zero, ComputeBudgetProgram.programId.toBase58()]
  check(new Set(distinct).size === distinct.length && (r.feePayer === r.creator || !distinct.includes(r.feePayer)), 'Preparation roles alias')
  check(!lookupTable || ![...distinct, r.feePayer, ...Object.values(profile.programs)].includes(lookupTable.address), 'Lookup table aliases a preparation role')
  check(PublicKey.isOnCurve(pk(r.creator).toBytes()) && PublicKey.isOnCurve(pk(r.feePayer).toBytes())
    && PublicKey.isOnCurve(pk(r.mint).toBytes()) && PublicKey.isOnCurve(pk(r.selectedConfig).toBytes()), 'Required signer cannot be a PDA')
  check(new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => envelope.providers.includes(o.provider)), 'Provider binding differs')
  check(Math.abs(obs[0].slot - obs[1].slot) <= l.maxSlotLag && isDeepStrictEqual(obs[0].accounts, obs[1].accounts)
    && isDeepStrictEqual(obs[0].rentExemptionLamports, obs[1].rentExemptionLamports), 'Preparation observations disagree')
  const expected = [addresses.launch, addresses.gate, addresses.launchProgramData, addresses.gateProgramData,
    addresses.launchConfig, addresses.policy, addresses.registry, r.mint, r.selectedConfig, r.creator, r.feePayer, addresses.canonicalLaunch]
  // The inventory is explicit and ordered; same-payer creator is represented twice with equal bytes.
  check(obs.every(o => isDeepStrictEqual(o.accounts.map(a => a.address), expected)), 'Incomplete preparation inventory')
  let observedConfig
  for (const o of obs) {
    check(o.genesisHash === profile.genesisHash && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale or wrong-chain preparation observation')
    check(r.creator !== r.feePayer || isDeepStrictEqual(o.accounts[9], o.accounts[10]), 'Repeated payer evidence differs')
    const accounts = new Map(o.accounts.map(a => { check(a.account === null || a.account.address === a.address, 'Account identity differs'); return [a.address, a.account] }))
    programEvidence(accounts, launchArtifact, o.slot, false); programEvidence(accounts, gateArtifact, o.slot, true)
    for (const address of [addresses.policy, addresses.registry, r.selectedConfig, addresses.canonicalLaunch]) check(accounts.get(address) === null, 'Preparation account already exists; do not retry')
    for (const address of [r.creator, r.feePayer, r.mint]) {
      const a = accounts.get(address)
      check((address === r.mint && a === null) || a && a.owner === zero && !a.executable && raw(a.dataBase64, 0).length === 0, 'Signer account is not an uninitialized system account')
    }
    const config = accounts.get(addresses.launchConfig)
    check(config && config.owner === addresses.launch && !config.executable, 'Launch configuration owner differs')
    observedConfig = readLaunchConfig(launch, profile, r, config)
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
    registry: addresses.registry, system_program: zero }, { initial_supply: observedConfig.supply, cap_bps: r.capBps, quote_mint: observedConfig.quote_mint, lp_fee_bps: observedConfig.lp_fee_bps },
  [['payer', true, true], ['mint', false, true], ['policy', true, false], ['registry', true, false], ['system_program', false, false]])
  const config = instruction(launch, 'create_config', { creator: r.creator, config: addresses.launchConfig,
    launch_config: r.selectedConfig, hook_program: addresses.gate, system_program: zero, event_authority: addresses.eventAuthority, program: addresses.launch },
  { args: { rules, creator_fee_bps: r.creatorFeeBps, custom_hook: pk(addresses.gate), custom_hook_flags: r.hookFlags, label: r.label } },
  [['creator', true, true], ['config', false, false], ['launch_config', true, true], ['hook_program', false, false],
    ['system_program', false, false], ['event_authority', false, false], ['program', false, false]])
  // Rust create_config client appends this remaining account; it is absent from the declared IDL list.
  config.keys.push({ pubkey: pk(addresses.gateProgramData), isSigner: false, isWritable: false })
  const tables = lookupTable ? [new AddressLookupTableAccount({ key: pk(lookupTable.address), state: AddressLookupTableAccount.deserialize(raw(lookupTable.dataBase64, 16384)) })] : []
  if (lookupTable) {
    const b = raw(lookupTable.dataBase64, 16384), state = tables[0].state
    check(sha(b) === lookupTable.sha256 && b.length >= 56 && b.length <= 8248 && state.addresses.length <= 256 && (b.length - 56) % 32 === 0 && b.readUInt32LE() === 1 && [0, 1].includes(b[21])
      && (b[21] === 1 ? b.subarray(54, 56).every(v => v === 0) : b.subarray(22, 56).every(v => v === 0))
      && state.lastExtendedSlotStartIndex <= state.addresses.length && new Set(state.addresses.map(k => k.toBase58())).size === state.addresses.length, 'Lookup table hash, canonical state or addresses differ')
  }
  const message = new TransactionMessage({ payerKey: pk(r.feePayer), recentBlockhash: bh.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: l.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) }), prepare, config,
  ] }).compileToV0Message(tables)
  check(!lookupTable || message.addressTableLookups.length === 1, 'Unused lookup table')
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables }), bytes = message.serialize()
  const priority = (BigInt(l.computeUnitLimit) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(BigInt(bh.networkFeeLamports) === BigInt(message.header.numRequiredSignatures) * BigInt(bh.lamportsPerSignature) + priority, 'Network fee quote differs from explicit signature fee basis')
  const review = { schema: 'hooklab-message-review/1', operation: 'max-wallet-preparation', genesisHash: profile.genesisHash,
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
  return { schema: 'repoing/max-wallet-preparation-plan/1', status: 'offline-unverified-preparation', sourceCommit: profile.sourceCommit,
    releaseProfileSha256: envelope.expectedSha256, sourcePatchSha256: profile.sourcePatchSha256, request: r, addresses, review, instructions: inspected.instructions,
    policyKind: 'max-wallet', policyVersion: 1,
    policy: { initialSupply: observedConfig.supply.toString(10), capBps: r.capBps, capRaw: String(BigInt(observedConfig.supply.toString(10)) * BigInt(r.capBps) / 10000n),
      quoteMint: observedConfig.quote_mint.toBase58(), lpFeeBps: observedConfig.lp_fee_bps, endsAt: 'authenticated-graduation', poolExemption: 'canonical-pool-only' },
    rentAccountSizes: { policy: 85, registry: 81, selectedConfig: 176 }, rentQuoteLamports: String(rent),
    preparationReceiptAccepted: false, launchPlan: null, artifactAdopted: false, deploymentAdopted: false, policyApproved: false,
    executionAuthorized: false, publicExecutionEnabled: false, ownerApprovalVerified: false,
    rentCapEnforcedOnchain: false, feeEvidenceAuthenticated: false, canSign: false, canSubmit: false, canRetry: false }
}


function canonicalAccount(binding, name, value, size) {
  const encoded = binding.coder.types.encode(name, value)
  const discriminator = binding.idl.accounts.find(a => a.name === name)?.discriminator
  check(discriminator?.length === 8 && encoded.length + 8 <= size, 'Account encoding exceeds canonical allocation')
  const bytes = Buffer.alloc(size)
  Buffer.from(discriminator).copy(bytes); encoded.copy(bytes, 8)
  return bytes
}
function readLaunchConfig(launch, profile, request, account) {
  check(account.address === pda(profile.programs.launch, 'config') && account.owner === profile.programs.launch && !account.executable, 'Launch configuration identity differs')
  const bytes = raw(account.dataBase64, 250), c = launch.coder.accounts.decode('Config', bytes)
  check(bytes.length === 250 && bytes.equals(canonicalAccount(launch, 'Config', c, 250))
    && c.version === 1 && c.bump === PublicKey.findProgramAddressSync([Buffer.from('config')], pk(profile.programs.launch))[1]
    && c.reserved.every(v => v === 0), 'Launch configuration layout differs')
  check(c.quote_mint.toBase58() === profile.quoteMint && profile.quoteMint !== request.mint
    && c.lp_fee_bps < 10000 && BigInt(c.supply.toString(10)) > 0n
    && BigInt(c.supply.toString(10)) * BigInt(request.capBps) / 10000n > 0n, 'Max-wallet launch economics or rounded cap invalid')
  return c
}
/** Pure expected-byte reconstruction for a future receipt verifier. The timestamp must be
 * explicitly parsed from agreeing observed selectedConfig bytes. RPC blockTime does not
 * authenticate historical Clock state; this helper does not verify those observations.
 * This returns no receipt, authorization, signing capability or production launch message.
 */
export function deriveMaxWalletPreparedAccounts(input) {
  const i64 = z.string().regex(/^(0|-?[1-9]\d{0,18})$/).refine(v => BigInt(v) >= -(1n << 63n) && BigInt(v) < (1n << 63n))
  const value = z.object({ profile: z.object({ json: z.string().max(16384), expectedSha256: hash,
    idls: z.object({ launch: z.string().max(1500000), gate: z.string().max(1500000) }).strict() }).strict(),
    request: maxWalletPreparationRequestSchema, launchConfig: account, observedCreatedAtUnixSeconds: i64 }).strict().parse(input)
  const { profile: envelope, request: r, launchConfig, observedCreatedAtUnixSeconds } = value
  check(sha(envelope.json) === envelope.expectedSha256, 'Reviewed profile digest differs')
  const profile = maxWalletProfileSchema.parse(JSON.parse(envelope.json)), L = profile.programs.launch, G = profile.programs.gate
  check(profileRolesDistinct(profile), 'Profile program roles alias')
  const bind = role => binding({ idlBase64: envelope.idls[role], idlSha256: profile.idlSha256[role], program: profile.programs[role] })
  const launch = bind('launch'), gate = bind('gate'), c = readLaunchConfig(launch, profile, r, launchConfig)
  const policyAddress = pda(G, 'policy', pk(r.mint).toBuffer()), registryAddress = pda(G, 'bordrless-hook-accounts', pk(r.mint).toBuffer())
  const canonicalLaunch = pda(L, 'launch', pk(r.mint).toBuffer())
  const policy = canonicalAccount(gate, 'Policy', { version: 1, mint: pk(r.mint), initial_supply: c.supply,
    cap_bps: r.capBps, quote_mint: c.quote_mint, lp_fee_bps: c.lp_fee_bps }, 85)
  const registry = Buffer.concat([Buffer.from('02daf6662c38c0cd01020000000000', 'hex'), pk(policyAddress).toBuffer(), Buffer.from([0, 0]), pk(canonicalLaunch).toBuffer()])
  const selected = canonicalAccount(launch, 'LaunchConfig', { version: 1, creator: pk(r.creator), rules,
    creator_fee_bps: 0, custom_hook: pk(G), custom_hook_flags: 1, label: r.label, created_at: new BN(observedCreatedAtUnixSeconds, 10),
    author_share_bps: 0, reserved: Array(30).fill(0) }, 176)
  const expected = (address, owner, bytes) => ({ address, owner, executable: false, dataBase64: bytes.toString('base64'), sha256: sha(bytes), size: bytes.length })
  return { schema: 'repoing/max-wallet-expected-prepared-accounts/1', policyKind: 'max-wallet', policyVersion: 1,
    accounts: { policy: expected(policyAddress, G, policy), registry: expected(registryAddress, G, registry), selectedConfig: expected(r.selectedConfig, L, selected) },
    expectedAbsent: [canonicalLaunch], historicalStateVerified: false, timestampAuthenticated: false, preparationReceiptAccepted: false, canSign: false, canSubmit: false }
}
