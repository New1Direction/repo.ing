// Stage-two OFFLINE custom candidate review. No RPC, keys, signing, sends, storage or adoption.
// The public production path is intentionally closed. Synthetic state is usable ONLY through
// buildCustomLaunchReviewForFixture, and never becomes a production preparation receipt.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { z } from 'zod'
import { HOOK_MAINNET_GENESIS, hookAddress as key, hookDigest as digest, hookRawAmount as u64 } from './hooklab-execution-contract.mjs'
import { customPreparationRequestSchema } from './hooklab-custom-preparation.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { allowedTail } from './hooklab-account-tail.mjs'

const check = (value, message) => { if (!value) throw Error(message) }
const sha = value => createHash('sha256').update(value).digest('hex')
const hash = (domain, ...values) => createHash('sha256').update(Buffer.concat([Buffer.from(domain), ...values])).digest()
const pk = value => new PublicKey(value), kb = value => pk(value).toBuffer(), str = value => value.toBase58()
const zero = '11111111111111111111111111111111', loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const lookupOwner = 'AddressLookupTab1e1111111111111111111111111'
const pda = (program, ...seeds) => str(PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[0])
const bump = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[1]
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const provider = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const roleKeys = z.object({ launch: key, swap: key, gate: key, token: key, bridge: key }).strict()
const roleHashes = z.object({ launch: digest, swap: digest, gate: digest }).strict()
const raw = (text, max) => { const b = Buffer.from(text, 'base64'); check(b.length <= max && b.toString('base64') === text, 'Noncanonical or oversized bytes'); return b }
const n = value => BigInt(value.toString(10))
const enc = (value, size, signed = false) => { const b = Buffer.alloc(size); if (size === 8) signed ? b.writeBigInt64LE(n(value)) : b.writeBigUInt64LE(n(value)); else b.writeUIntLE(Number(value), 0, size); return b }
const bn = value => new BN(String(value), 10)
const byteString = max => z.string().refine(s => Buffer.byteLength(s) <= max)
const noRules = { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0, burn_buy_bps: 0, burn_sell_bps: 0,
  max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const profileSchema = z.object({ schema: z.literal('hook-lab/offline-custom-builder-profile/1'), profileId: z.string().min(1).max(128),
  status: z.literal('offline-candidate-not-adopted'), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourcePatchSha256: digest.nullable(),
  buildFeature: z.enum(['custom-hooks-production', 'custom-hooks-reuse-candidate']), genesisHash: z.literal(HOOK_MAINNET_GENESIS),
  programs: roleKeys, quoteMint: key, idlSha256: roleHashes, elfSha256: roleHashes,
  dependencyObservation: z.object({ tokenElfSha256: digest, sourceProvenanceVerified: z.literal(false), ownerAcceptanceVerified: z.literal(false) }).strict(),
  capability: z.object({ kind: z.literal('immutable-canonical-single-blocked-owner'), beforeTransferOnly: z.literal(true), creatorFeeBps: z.literal(0),
    rules: z.literal('none'), atomicPrepareAndLaunch: z.literal(false), prepareMintSignerRequired: z.literal(true), launchAdminCosignerRequired: z.literal(true) }).strict(),
  artifactAdopted: z.literal(false), ownerApprovalVerified: z.literal(false), executionAuthorized: z.literal(false), publicExecutionEnabled: z.literal(false), canSign: z.literal(false), canSubmit: z.literal(false),
}).strict()
export const customLaunchRequestSchema = customPreparationRequestSchema.omit({ schema: true }).extend({
  schema: z.literal('repoing/custom-launch-request/1'), reviewer: key, name: byteString(32).refine(s => s.length > 0),
  symbol: byteString(10).refine(s => s.length > 0), uri: byteString(200), virtualQuote: u64,
}).strict()
const accountSchema = z.object({ address: key, owner: key, executable: z.boolean(), dataBase64: z.string().max(14000000), lamports: u64 }).strict()
const stateHashesSchema = z.object({ launchConfig: digest, swapConfig: digest, launchGovernance: digest, swapGovernance: digest, authorization: digest, quoteMint: digest }).strict()
const syntheticEvidenceSchema = z.object({ schema: z.literal('hooklab/synthetic-prepared-state/1'),
  provenance: z.literal('disposable-litesvm-synthetic-fixture-not-rpc-evidence'), status: z.literal('synthetic-prepared'),
  productionPreparationReceipt: z.null(), profileSha256: digest, preparationIntentSha256: digest, executionSlot: number,
  preparedAccountHashes: z.object({ policy: digest, registry: digest, selectedConfig: digest }).strict(),
}).strict()
const inputSchema = z.object({ profile: z.object({ json: z.string().max(16384), expectedSha256: digest,
  idls: z.object({ launch: z.string().max(1500000), swap: z.string().max(1500000), gate: z.string().max(1500000) }).strict(),
  elfLengths: z.object({ launch: number.positive().max(10485760), swap: number.positive().max(10485760), gate: number.positive().max(10485760) }).strict(),
  providers: z.array(provider).length(2).refine(v => new Set(v).size === 2),
}).strict(), request: customLaunchRequestSchema, preparationEvidence: syntheticEvidenceSchema, reviewedStateHashes: stateHashesSchema,
  observations: z.array(z.object({ provider, genesisHash: key, commitment: z.literal('finalized'), slot: number, observedAtMs: number,
    accounts: z.array(z.object({ address: key, account: accountSchema.nullable() }).strict()).min(30).max(64),
  }).strict()).length(2),
  recentBlockhash: z.object({ blockhash: key, genesisHash: key, providers: z.array(provider).length(2), observedAtMs: number,
    currentBlockHeight: number.positive(), blockhashValid: z.literal(true), lastValidBlockHeight: number.positive(), observedSlot: number,
    networkFeeLamports: u64, lamportsPerSignature: u64.refine(v => BigInt(v) > 0n) }).strict(),
  lookupTable: z.object({ address: key, owner: z.literal(lookupOwner), dataBase64: z.string().max(22000), sha256: digest }).strict().nullable(),
  limits: z.object({ nowMs: number, maxAgeMs: number.positive().max(60000), maxSlotLag: number.max(150), validUntilSlot: number,
    reviewExpiresAtMs: number, maxLaunchFeeLamports: u64, maxPoolCreationFeeLamports: u64, maxRentLamports: u64,
    maxInstructionDebitLamports: u64, maxNetworkFeeLamports: u64, maxTotalDebitLamports: u64,
    computeUnitLimit: number.positive().max(1400000), computeUnitPriceMicroLamports: u64 }).strict(),
}).strict()

/** Deliberately no resolver implementation, caller callback, or "finalized" JSON bypass.
 * A future production adapter must resolve an authenticated durable server record and reconcile
 * exact signed preparation wire, inclusion and post-state. This export never produces a message.
 */
export function buildCustomLaunchReview(input) {
  const status = input?.preparationEvidence?.status
  const error = Error(status === 'preparation-outcome-unknown' || status === 'pending' || status === 'reconcile-required'
    ? 'Preparation outcome is unresolved; reconciliation required, no retry or launch'
    : 'Trusted durable preparation record resolver is unavailable; caller and synthetic evidence cannot authorize a launch')
  error.code = 'CUSTOM_PREPARATION_PROOF_UNAVAILABLE'
  throw error
}

function binding(envelope, profile, role) {
  const bytes = raw(envelope.idls[role], 1100000)
  check(sha(bytes) === profile.idlSha256[role], 'IDL digest differs')
  const idl = JSON.parse(bytes)
  check(idl.address === profile.programs[role], 'IDL identity differs')
  return { idl, coder: new BorshCoder(idl) }
}
function owned(accounts, address, owner, length) {
  const account = accounts.get(address)
  check(account && account.address === address && account.owner === owner && !account.executable, 'Account ownership or identity differs')
  const bytes = raw(account.dataBase64, length)
  check(bytes.length === length, 'Account allocation differs')
  return bytes
}
function decoded(binding, name, bytes) {
  const result = binding.coder.accounts.decode(name, bytes), encoded = binding.coder.types.encode(name, result)
  const disc = binding.idl.accounts.find(a => a.name === name)?.discriminator
  check(disc && bytes.subarray(0, 8).equals(Buffer.from(disc)) && bytes.subarray(8, 8 + encoded.length).equals(encoded)
    && allowedTail(name, result, bytes.subarray(8 + encoded.length)), 'Noncanonical account encoding')
  return result
}
function programEvidence(accounts, program, expected, length, slot, immutable) {
  const dataAddress = pda(loader, kb(program)), programAccount = accounts.get(program), dataAccount = accounts.get(dataAddress)
  check(programAccount && programAccount.owner === loader && programAccount.executable && dataAccount && dataAccount.owner === loader && !dataAccount.executable, 'Program ownership differs')
  const pb = raw(programAccount.dataBase64, 36), db = raw(dataAccount.dataBase64, 10485760 + 45)
  check(pb.length === 36 && pb.readUInt32LE() === 2 && pb.subarray(4).equals(kb(dataAddress)), 'ProgramData linkage differs')
  check(db.length >= length + 45 && db.readUInt32LE() === 3 && db.readBigUInt64LE(4) <= BigInt(slot)
    && (immutable ? db[12] === 0 : db[12] === 0 || db[12] === 1), 'ProgramData state or immutable gate differs')
  const elf = db.subarray(45, 45 + length)
  check(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && sha(elf) === expected
    && db.subarray(45 + length).every(b => b === 0), 'Program ELF differs')
}
function governance(binding, role, program, configAddress, config, gov, genesis) {
  const s = gov.state, roles = Object.values(s.roles).map(str)
  check(str(s.program) === program && str(s.config) === configAddress && Buffer.from(s.genesis).equals(kb(genesis))
    && str(s.roles.admin) === str(config.admin) && str(s.roles.treasury) === str(config.treasury)
    && !s.gates.creation && !s.gates.trading && s.pending_admin === null
    && (role !== 'swap' || str(config.fee_collector) === str(config.treasury))
    && new Set(roles).size === 4 && !roles.includes(zero), 'Governance identity, roles or gates differ')
  check(gov.bump === bump(program, 'governance'), 'Governance bump differs')
  const economics = hash(`hook-lab/${role}-governed-economics/1\0`, kb(program), binding.coder.types.encode('ConfigArgs', {
    ...config, admin: pk(zero), treasury: pk(zero), paused: false }))
  check(economics.equals(Buffer.from(s.config_digest)), 'Governance economics digest differs')
  return hash('hook-lab/governance-state/1\0', binding.coder.types.encode('State', s))
}
function addressesFor(profile, request, config) {
  const { launch: L, swap: S, gate: G, token: T } = profile.programs, mint = request.mint, quote = profile.quoteMint
  const launch = pda(L, 'launch', kb(mint)), pool = pda(S, 'pool', kb(mint), kb(quote), enc(config.lp_fee_bps, 2), kb(L)), lp = pda(S, 'lp', kb(pool))
  const holding = (mint, owner) => pda(T, 'holding', kb(mint), kb(owner))
  return { launchConfig: pda(L, 'config'), swapConfig: pda(S, 'config'), launchGovernance: pda(L, 'governance'), swapGovernance: pda(S, 'governance'),
    authorization: pda(L, 'creator-authorization', kb(request.creator)), policy: pda(G, 'policy', kb(mint)), registry: pda(G, 'bordrless-hook-accounts', kb(mint)),
    launchProgramData: pda(loader, kb(L)), swapProgramData: pda(loader, kb(S)), gateProgramData: pda(loader, kb(G)),
    launch, pool, lpMint: lp, launchReserve: holding(mint, launch), launchQuote: holding(quote, launch),
    poolRegistry: pda(L, 'bordrless-hook-accounts', kb(pool)), baseVault: holding(mint, pool), quoteVault: holding(quote, pool), launchLp: holding(lp, launch),
    launchHookSigner: pda(L, 'hook-authority'), swapHookSigner: pda(S, 'hook-authority', kb(L)), swapEventAuthority: pda(S, '__event_authority'),
    tokenEventAuthority: pda(T, '__event_authority'), eventAuthority: pda(L, '__event_authority'), gateHookSigner: pda(T, 'hook-authority', kb(G)) }
}
function exactMetas(profile, r, c, a, binding) {
  const { launch: L, swap: S, gate: G, token: T } = profile.programs
  const abi = binding.idl.instructions.find(i => i.name === 'create_launch_custom_mainnet')
  const names = ['creator', 'config', 'treasury', 'mint', 'launch', 'launch_reserve', 'launch_quote', 'quote_mint', 'registry', 'dex_config', 'pool', 'lp_mint', 'base_vault', 'quote_vault', 'launch_lp', 'hook_signer', 'dex_hook_signer', 'dex_event_authority', 'swap_program', 'token_program', 'token_hook_signer', 'token_event_authority', 'system_program', 'kit_program', 'kit_config', 'kit_registry', 'reward_vault', 'kit_caller', 'kit_event_authority', 'launch_config', 'event_authority', 'program']
  check(abi && isDeepStrictEqual(abi.accounts.map(x => x.name), names) && Buffer.from(abi.discriminator).equals(hash('global:create_launch_custom_mainnet').subarray(0, 8)), 'Custom launch ABI differs')
  const placeholder = abi.accounts[20].address
  key.parse(placeholder)
  const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey: pk(pubkey), isWritable, isSigner })
  const keys = [meta(r.creator, true, true), meta(a.launchConfig, true), meta(str(c.treasury), true), meta(r.mint, true, true), meta(a.launch, true),
    meta(a.launchReserve, true), meta(a.launchQuote, true), meta(profile.quoteMint), meta(a.poolRegistry, true), meta(a.swapConfig, true), meta(a.pool, true),
    meta(a.lpMint, true), meta(a.baseVault, true), meta(a.quoteVault, true), meta(a.launchLp, true), meta(a.launchHookSigner), meta(a.swapHookSigner),
    meta(a.swapEventAuthority), meta(S), meta(T), meta(placeholder), meta(a.tokenEventAuthority), meta(zero), ...Array.from({ length: 6 }, () => meta(L)),
    meta(r.selectedConfig), meta(a.eventAuthority), meta(L), meta(a.launchGovernance), meta(a.authorization, true), meta(r.reviewer, false, true),
    meta(a.gateProgramData), meta(G), meta(a.gateHookSigner), meta(a.registry), meta(a.policy)]
  for (let i = 0; i < 32; i++) {
    const declared = abi.accounts[i], actual = keys[i], optionalAbsent = i >= 23 && i <= 28
    check(!!declared.signer === actual.isSigner && (!!declared.writable && !optionalAbsent) === actual.isWritable
      && (!declared.address || declared.address === str(actual.pubkey)), 'Instruction account ABI privilege or fixed address differs')
  }
  return keys
}

/** Test-only planner. Every observation and fee is an unauthenticated synthetic assertion.
 * expectedSha256 and reviewedStateHashes bind an independently reviewed input snapshot; they
 * are NOT an approval or receipt. No public route imports this export. No default identities.
 */
export function buildCustomLaunchReviewForFixture(input) {
  const { profile: envelope, request: r, observations, preparationEvidence: proof, reviewedStateHashes, recentBlockhash: bh, lookupTable, limits: l } = inputSchema.parse(input)
  check(sha(envelope.json) === envelope.expectedSha256, 'Reviewed profile digest differs')
  const profile = profileSchema.parse(JSON.parse(envelope.json)), { launch: L, swap: S, gate: G, token: T } = profile.programs
  check((profile.buildFeature === 'custom-hooks-reuse-candidate') === (profile.sourcePatchSha256 !== null), 'Source patch binding differs')
  check(new Set([...Object.values(profile.programs), profile.quoteMint, zero]).size === 7, 'Profile program roles alias')
  const launch = binding(envelope, profile, 'launch'), swap = binding(envelope, profile, 'swap'), gate = binding(envelope, profile, 'gate')
  const prep = customPreparationRequestSchema.parse({ schema: 'repoing/custom-preparation-request/1', creator: r.creator, feePayer: r.feePayer,
    mint: r.mint, selectedConfig: r.selectedConfig, blockedOwner: r.blockedOwner, label: r.label, creatorFeeBps: r.creatorFeeBps, rules: r.rules, hookFlags: r.hookFlags })
  check(proof.profileSha256 === envelope.expectedSha256 && proof.preparationIntentSha256 === sha(JSON.stringify(prep)), 'Synthetic preparation intent/profile differs')
  check(new Set(observations.map(o => o.provider)).size === 2 && observations.every(o => envelope.providers.includes(o.provider)), 'Provider binding differs')
  check(Math.abs(observations[0].slot - observations[1].slot) <= l.maxSlotLag && isDeepStrictEqual(observations[0].accounts, observations[1].accounts), 'Prepared state observations disagree')
  for (const o of observations) check(o.genesisHash === profile.genesisHash && o.slot >= proof.executionSlot
    && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale, pre-preparation or wrong-chain observation')
  const accounts = new Map(observations[0].accounts.map(item => { check(!item.account || item.account.address === item.address, 'Account identity differs'); return [item.address, item.account] }))
  check(accounts.size === observations[0].accounts.length, 'Duplicate observation account')
  const c = decoded(launch, 'Config', owned(accounts, pda(L, 'config'), L, 250)), d = decoded(swap, 'Config', owned(accounts, pda(S, 'config'), S, 189))
  check(c.version === 1 && d.version === 1 && c.bump === bump(L, 'config') && d.bump === bump(S, 'config') && !c.paused && !d.paused
    && c.reserved.every(x => x === 0) && d.reserved.every(x => x === 0), 'Config version, reserved state or pause differs')
  check(str(c.quote_mint) === profile.quoteMint && str(c.treasury) === str(d.treasury) && str(c.admin) === r.reviewer, 'Current admin, treasury or quote differs')
  const a = addressesFor(profile, r, c), metas = exactMetas(profile, r, c, a, launch)
  const inventory = [...new Set([...metas.map(m => str(m.pubkey)), a.launchProgramData, a.swapProgramData, a.swapGovernance, r.feePayer])].sort()
  check(isDeepStrictEqual([...accounts.keys()].sort(), inventory), 'Incomplete or extra launch inventory')
  const roles = [...Object.values(a), ...Object.values(profile.programs), profile.quoteMint, zero, r.creator, r.mint, r.selectedConfig, r.reviewer, str(c.treasury)]
  check(new Set(roles).size === roles.length && (r.feePayer === r.creator || !roles.includes(r.feePayer)), 'Launch roles alias')
  check([r.creator, r.feePayer, r.mint, r.selectedConfig, r.reviewer].every(k => PublicKey.isOnCurve(kb(k))), 'Required signer identity cannot be a PDA')
  check(!lookupTable || ![...inventory, ...roles, ComputeBudgetProgram.programId.toBase58()].includes(lookupTable.address), 'Lookup table aliases a launch role')
  for (const o of observations) for (const role of ['launch', 'swap', 'gate']) programEvidence(accounts, profile.programs[role], profile.elfSha256[role], envelope.elfLengths[role], o.slot, role === 'gate')
  const tokenProgram = accounts.get(T), tokenBytes = tokenProgram && raw(tokenProgram.dataBase64, 36)
  check(tokenProgram?.owner === loader && tokenProgram.executable && tokenBytes.length === 36 && tokenBytes.readUInt32LE() === 2
    && tokenBytes.subarray(4).equals(kb(pda(loader, kb(T)))), 'Token ProgramData linkage differs')
  for (const name of ['launch', 'pool', 'lpMint', 'launchReserve', 'launchQuote', 'poolRegistry', 'baseVault', 'quoteVault', 'launchLp']) check(accounts.get(a[name]) === null, 'Launch target already exists; reconcile, do not retry')
  for (const address of new Set([r.creator, r.feePayer, r.reviewer, r.mint, str(c.treasury)])) {
    const account = accounts.get(address)
    check((address === r.mint && account === null) || account && account.owner === zero && !account.executable && raw(account.dataBase64, 0).length === 0, 'Signer, treasury or future mint is not an empty system account')
  }
  const policyBytes = owned(accounts, a.policy, G, 72), registryBytes = owned(accounts, a.registry, G, 47), selectedBytes = owned(accounts, r.selectedConfig, L, 176)
  const policy = decoded(gate, 'Policy', policyBytes), selected = decoded(launch, 'LaunchConfig', selectedBytes)
  check(str(policy.mint) === r.mint && str(policy.blocked_owner) === r.blockedOwner, 'Prepared policy mint or blocked owner differs')
  const canonicalRegistry = Buffer.concat([Buffer.from('02daf6662c38c0cd01010000000000', 'hex'), kb(a.policy)])
  check(registryBytes.equals(canonicalRegistry), 'Registry must contain exactly one literal read-only canonical policy')
  check(selected.version === 1 && str(selected.creator) === r.creator && selected.custom_hook && str(selected.custom_hook) === G
    && selected.creator_fee_bps === 0 && selected.author_share_bps === 0 && selected.custom_hook_flags === 1
    && selected.label === r.label && selected.reserved.every(v => v === 0) && isDeepStrictEqual(selected.rules, noRules), 'Prepared selected configuration differs')
  check(isDeepStrictEqual(proof.preparedAccountHashes, { policy: sha(policyBytes), registry: sha(registryBytes), selectedConfig: sha(selectedBytes) }), 'Prepared state hashes differ')
  const observedHashes = Object.fromEntries(Object.keys(reviewedStateHashes).map(name => [name, sha(raw(accounts.get(name === 'quoteMint' ? profile.quoteMint : a[name])?.dataBase64 ?? '', 8192))]))
  check(isDeepStrictEqual(reviewedStateHashes, observedHashes), 'Reviewed current state hashes differ')
  const lg = decoded(launch, 'Governance', owned(accounts, a.launchGovernance, L, 348)), sg = decoded(swap, 'Governance', owned(accounts, a.swapGovernance, S, 348))
  const launchGov = governance(launch, 'launch', L, a.launchConfig, c, lg, profile.genesisHash), swapGov = governance(swap, 'swap', S, a.swapConfig, d, sg, profile.genesisHash)
  const auth = decoded(launch, 'CreatorAuthorization', owned(accounts, a.authorization, L, 73)), slot = Math.max(...observations.map(o => o.slot))
  check(str(auth.creator) === r.creator && auth.enabled && n(auth.consumed) < n(auth.max_launches) && n(auth.expires_at_slot) > BigInt(l.validUntilSlot), 'Current creator grant, quota or exclusive expiry differs')
  // The quote is a native-token mint. Decode its option fields without borrowing a launch builder.
  const quote = owned(accounts, profile.quoteMint, T, 519)
  check(quote.subarray(0, 8).equals(hash('account:Mint').subarray(0, 8)) && quote[8] === 1, 'Quote mint discriminator or version differs')
  let offset = 26
  for (let i = 0; i < 5; i++) { const option = quote[offset++]; check(option === 0 || option === 1, 'Quote mint option is noncanonical'); if (i === 4) check(option === 0, 'Quote mint must remain unhooked'); if (option) offset += 32 }
  check(quote.readUInt16LE(offset) === 0, 'Quote hook flags differ')
  offset += 2
  for (const maximum of [32, 10, 200]) {
    check(offset + 4 <= quote.length, 'Quote metadata is truncated')
    const length = quote.readUInt32LE(offset); offset += 4
    check(length <= maximum && offset + length <= quote.length, 'Quote metadata bounds differ')
    const text = quote.subarray(offset, offset + length)
    check(Buffer.from(text.toString('utf8')).equals(text), 'Quote metadata is not canonical UTF-8')
    offset += length
  }
  // Remaining fields are created_at(i64), creator(pubkey), hook signer bump and reserved[31].
  check(offset + 72 <= quote.length && quote[offset + 40] === 0 && quote.subarray(offset + 41).every(v => v === 0), 'Quote reserved or trailing state differs')
  check(BigInt(r.virtualQuote) >= n(c.min_virtual_quote) && BigInt(r.virtualQuote) <= n(c.max_virtual_quote)
    && n(c.supply) > 0n && c.curve_bps > 5000 && c.curve_bps < 10000, 'Virtual quote or curve bounds differ')
  const curveTokens = n(c.supply) * BigInt(c.curve_bps) / 10000n, reserveTokens = n(c.supply) - curveTokens
  check(curveTokens > reserveTokens && reserveTokens > 0n
    && curveTokens * reserveTokens / (curveTokens - reserveTokens) <= 0xffffffffffffffffn
    && BigInt(r.virtualQuote) * (curveTokens - reserveTokens) / reserveTokens <= 0xffffffffffffffffn, 'Curve arithmetic exceeds native u64 bounds')
  check(bh.genesisHash === profile.genesisHash && isDeepStrictEqual(bh.providers, envelope.providers) && l.nowMs >= bh.observedAtMs
    && l.nowMs - bh.observedAtMs <= l.maxAgeMs && bh.currentBlockHeight <= bh.lastValidBlockHeight && bh.lastValidBlockHeight - bh.currentBlockHeight <= 150
    && bh.observedSlot >= slot && bh.observedSlot - slot <= l.maxSlotLag && bh.observedSlot <= l.validUntilSlot && l.validUntilSlot - slot <= 150
    && l.reviewExpiresAtMs > l.nowMs && l.reviewExpiresAtMs - l.nowMs <= l.maxAgeMs, 'Review blockhash or deadline lifetime differs')
  check(n(c.launch_fee_lamports) <= BigInt(l.maxLaunchFeeLamports) && n(d.pool_creation_fee_lamports) <= BigInt(l.maxPoolCreationFeeLamports)
    && BigInt(l.maxRentLamports) > 0n && BigInt(l.maxLaunchFeeLamports) + BigInt(l.maxPoolCreationFeeLamports) + BigInt(l.maxRentLamports) <= BigInt(l.maxInstructionDebitLamports)
    && BigInt(l.maxInstructionDebitLamports) + BigInt(bh.networkFeeLamports) <= BigInt(l.maxTotalDebitLamports), 'Guarded fee, rent or debit cap exceeded')
  check(BigInt(accounts.get(r.creator).lamports) >= BigInt(l.maxInstructionDebitLamports) + (r.creator === r.feePayer ? BigInt(bh.networkFeeLamports) : 0n)
    && BigInt(accounts.get(r.feePayer).lamports) >= BigInt(bh.networkFeeLamports), 'Launch payer funds insufficient')
  const launchEconomics = hash('hook-lab:create-launch-economics:v2', kb(L), kb(a.launchConfig), enc(c.version, 1), kb(c.admin), kb(c.treasury), kb(c.quote_mint),
    enc(c.launch_fee_lamports, 8), enc(c.lp_fee_bps, 2), enc(c.max_creator_fee_bps, 2), enc(c.sniper_window_secs, 8, true), enc(c.sniper_start_bps, 2), enc(c.curve_bps, 2),
    enc(c.supply, 8), enc(c.decimals, 1), enc(c.min_virtual_quote, 8), enc(c.max_virtual_quote, 8), launch.coder.types.encode('RuleBounds', c.rule_bounds),
    enc(1, 1), kb(r.selectedConfig), enc(selected.version, 1), kb(selected.creator), launch.coder.types.encode('LaunchRules', selected.rules), enc(0, 2), enc(1, 1), kb(G), enc(1, 2), enc(0, 2), enc(0, 1))
  const poolEconomics = hash('hook-lab:create-pool-economics:v2', kb(S), kb(a.swapConfig), enc(d.version, 1), kb(d.admin), kb(d.treasury), kb(d.fee_collector),
    enc(d.pool_creation_fee_lamports, 8), enc(d.protocol_fee_bps, 2), enc(d.launch_protocol_share_bps, 2))
  const authHash = hash('hook-lab:creator-authorization:v1', kb(L), kb(r.creator), enc(1, 1), enc(auth.expires_at_slot, 8), enc(auth.max_launches, 8), enc(auth.revision, 8))
  const control = hash('hook-lab:mainnet-creation-controls:v1', kb(L), launchGov, authHash)
  const hookAccounts = hash('hook-lab:custom-hook-accounts:v1', kb(G), kb(a.registry), kb(G), enc(registryBytes.length, 4), registryBytes,
    enc(1, 4), kb(a.policy), kb(G), enc(policyBytes.length, 4), policyBytes)
  const guard = { version: 2, deadline_slot: bn(l.validUntilSlot), expected_launch_economics_hash: [...launchEconomics], expected_pool_economics_hash: [...poolEconomics],
    max_launch_fee_lamports: bn(l.maxLaunchFeeLamports), max_pool_creation_fee_lamports: bn(l.maxPoolCreationFeeLamports), max_rent_lamports: bn(l.maxRentLamports), max_total_debit_lamports: bn(l.maxInstructionDebitLamports) }
  const data = launch.coder.instruction.encode('create_launch_custom_mainnet', { args: { name: r.name, symbol: r.symbol, uri: r.uri, creator_fee_bps: 0, virtual_quote: bn(r.virtualQuote), rules: noRules },
    guard, expected_control_hash: [...control], expected_hook_accounts_hash: [...hookAccounts] })
  const instruction = new TransactionInstruction({ programId: pk(L), keys: metas, data })
  const tables = lookupTable ? [new AddressLookupTableAccount({ key: pk(lookupTable.address), state: AddressLookupTableAccount.deserialize(raw(lookupTable.dataBase64, 16384)) })] : []
  if (lookupTable) {
    const b = raw(lookupTable.dataBase64, 16384), state = tables[0].state
    check(sha(b) === lookupTable.sha256 && b.length >= 56 && b.length <= 8248 && state.addresses.length <= 256 && (b.length - 56) % 32 === 0 && b.readUInt32LE() === 1 && [0, 1].includes(b[21])
      && (b[21] === 1 ? b.subarray(54, 56).every(v => v === 0) : b.subarray(22, 56).every(v => v === 0))
      && state.lastExtendedSlotStartIndex <= state.addresses.length && new Set(state.addresses.map(str)).size === state.addresses.length, 'Lookup table hash, canonical state or addresses differ')
  }
  const message = new TransactionMessage({ payerKey: pk(r.feePayer), recentBlockhash: bh.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: l.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) }), instruction] }).compileToV0Message(tables)
  check(!lookupTable || message.addressTableLookups.length === 1, 'Unused lookup table')
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables }), bytes = message.serialize()
  const priority = (BigInt(l.computeUnitLimit) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(BigInt(bh.networkFeeLamports) === BigInt(message.header.numRequiredSignatures) * BigInt(bh.lamportsPerSignature) + priority, 'Network fee quote differs from explicit signature fee basis')
  const review = { schema: 'hooklab-message-review/1', operation: 'custom-launch-fixture', genesisHash: profile.genesisHash, profileSha256: envelope.expectedSha256,
    policySha256: sha(JSON.stringify({ proof, reviewedStateHashes, observations })), intentSha256: sha(JSON.stringify(r)), payer: r.feePayer, wallet: r.creator,
    messageBase64: Buffer.from(bytes).toString('base64'), messageSha256: sha(bytes), requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(str),
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: str(keys.get(i)), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: lookupTable ? [lookupTable] : [], observedSlot: slot, validUntilSlot: l.validUntilSlot, observedAtMs: l.nowMs, reviewExpiresAtMs: l.reviewExpiresAtMs,
    lastValidBlockHeight: bh.lastValidBlockHeight, baseFeeLamports: String(BigInt(bh.networkFeeLamports) - priority), maxFeeLamports: l.maxNetworkFeeLamports,
    instructionDebitLamports: l.maxInstructionDebitLamports, maxNativeDebitLamports: l.maxTotalDebitLamports }
  const inspected = inspectHookLabMessage(review), wantSigners = new Set([r.creator, r.feePayer, r.mint, r.reviewer]), wantWritable = new Set([r.feePayer, ...metas.filter(m => m.isWritable).map(m => str(m.pubkey))])
  check(inspected.instructions.length === 3 && review.accounts.every(a => a.signer === wantSigners.has(a.address) && a.writable === wantWritable.has(a.address)), 'Compiled launch privileges differ')
  const exact = { program: L, dataHex: data.toString('hex'), accounts: metas.map(m => ({ address: str(m.pubkey), signer: m.isSigner, writable: m.isWritable })) }
  check(isDeepStrictEqual(inspected.instructions[2], exact), 'Effective instruction metas differ from canonical launch policy')
  return freeze({ schema: 'repoing/custom-launch-review/1', status: 'offline-synthetic-review-only', provenance: proof.provenance, sourceCommit: profile.sourceCommit,
    sourcePatchSha256: profile.sourcePatchSha256, releaseProfileSha256: envelope.expectedSha256, request: r, addresses: a, review, instructions: inspected.instructions,
    commitments: { launchEconomics: launchEconomics.toString('hex'), poolEconomics: poolEconomics.toString('hex'), launchGovernance: launchGov.toString('hex'),
      swapGovernance: swapGov.toString('hex'), creationControl: control.toString('hex'), hookAccounts: hookAccounts.toString('hex') },
    productionPreparationReceipt: null, preparationReceiptAccepted: false, artifactAdopted: false, deploymentAdopted: false, policyApproved: false,
    executionAuthorized: false, publicExecutionEnabled: false, feeEvidenceAuthenticated: false, dependencyCodeAuthenticated: false,
    canSign: false, canSubmit: false, canRetry: false })
}
