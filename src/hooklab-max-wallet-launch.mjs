// Deterministic stage-two compiler. No RPC, keys, signing, sends, storage or adoption.
// The public production path is intentionally closed. Synthetic state is usable ONLY through
// buildMaxWalletLaunchReviewForFixture, and never becomes a production preparation receipt.
import { approvedCreatorFees } from './hooklab-launch-menus.mjs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { z } from 'zod'
import { HOOK_MAINNET_GENESIS, hookAddress as key, hookDigest as digest, hookRawAmount as u64 } from './hooklab-execution-contract.mjs'
import { maxWalletPreparationRequestSchema, maxWalletProfileSchema } from './hooklab-max-wallet-preparation.mjs'
import { inclusiveMaxWalletPreparationRequestSchema, parseMaxWalletProfile, parseMaxWalletPreparationRequest } from './hooklab-inclusive-max-wallet-profile.mjs'
import { inclusiveEconomicsHash, inclusiveHookAccountsHash, inclusiveFeePolicyAddress } from './hooklab-inclusive-fee-abi.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { canaryGateMatches } from './hooklab-canary-policy.mjs'
import { NATIVE_IDL_SHA256 } from './hooklab-native-pins.mjs'
import { QUOTE_FORM_NATIVE, isNativeElfPin, nativeEconomicsHash } from './hooklab-native-launch.mjs'
import { launchConfigReservedValid, parseLaunchConfigReserved } from './hooklab-launch-config-reserved.mjs'

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
const raw = (text, max) => { const b = Buffer.from(text, 'base64'); check(b.length <= max && b.toString('base64') === text, 'Noncanonical or oversized bytes'); return b }
const n = value => BigInt(value.toString(10))
const enc = (value, size, signed = false) => { const b = Buffer.alloc(size); if (size === 8) signed ? b.writeBigInt64LE(n(value)) : b.writeBigUInt64LE(n(value)); else b.writeUIntLE(Number(value), 0, size); return b }
const bn = value => new BN(String(value), 10)
const byteString = max => z.string().refine(s => Buffer.byteLength(s) <= max)
const noRules = { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0, burn_buy_bps: 0, burn_sell_bps: 0,
  max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
export const maxWalletLaunchRequestSchema = maxWalletPreparationRequestSchema.omit({ schema: true }).extend({
  schema: z.literal('repoing/max-wallet-launch-request/1'), reviewer: key, name: byteString(32).refine(s => s.length > 0),
  symbol: byteString(10).refine(s => s.length > 0), uri: byteString(200), virtualQuote: u64,
}).strict()
export const inclusiveMaxWalletLaunchRequestSchema = inclusiveMaxWalletPreparationRequestSchema.omit({schema:true}).extend({
 schema:z.literal('repoing/inclusive-max-wallet-launch-request/1'),reviewer:key,name:byteString(32).refine(s=>s.length>0),
 symbol:byteString(10).refine(s=>s.length>0),uri:byteString(200),virtualQuote:u64,
}).strict()
export const parseMaxWalletLaunchRequest = request => (request?.policyVersion===2?inclusiveMaxWalletLaunchRequestSchema:maxWalletLaunchRequestSchema).parse(request)
// Open (self-serve) launch: the creator's own coin, no reviewer. create_launch_open_v1 (hook-lab feat/open-creation ABI)
// takes v4's arguments and 32 named accounts; its discriminator is sha256("global:create_launch_open_v1")[..8].
export const OPEN_LAUNCH_DISCRIMINATOR = Buffer.from([51, 106, 16, 21, 31, 133, 167, 85])
export const openLaunchRequestSchema = inclusiveMaxWalletPreparationRequestSchema.omit({ schema: true }).extend({
  schema: z.literal('repoing/open-launch-request/1'), name: byteString(32).refine(s => s.length > 0),
  symbol: byteString(10).refine(s => s.length > 0), uri: byteString(200), virtualQuote: u64,
}).strict()
const accountSchema = z.object({ address: key, owner: key, executable: z.boolean(), dataBase64: z.string().max(14000000), lamports: u64 }).strict()
const stateHashesSchema = z.object({ launchConfig: digest, swapConfig: digest, launchGovernance: digest, swapGovernance: digest, authorization: digest, quoteMint: digest }).strict()
const lookupTableSchema = z.object({ address: key, owner: z.literal(lookupOwner), dataBase64: z.string().max(22000), sha256: digest }).strict()
const syntheticEvidenceSchema = z.object({ schema: z.literal('hooklab/max-wallet-synthetic-prepared-state/1'),
  provenance: z.literal('disposable-litesvm-synthetic-fixture-not-rpc-evidence'), status: z.literal('synthetic-prepared'),
  productionPreparationReceipt: z.null(), profileSha256: digest, preparationIntentSha256: digest, executionSlot: number,
  preparedAccountHashes: z.object({ policy: digest, registry: digest, selectedConfig: digest }).strict(),
}).strict()
const inputSchema = z.object({ profile: z.object({ json: z.string().max(16384), expectedSha256: digest,
  idls: z.object({ launch: z.string().max(1500000), swap: z.string().max(1500000), gate: z.string().max(1500000) }).strict(),
  elfLengths: z.object({ launch: number.positive().max(10485760), swap: number.positive().max(10485760), gate: number.positive().max(10485760) }).strict(),
  providers: z.array(provider).length(2).refine(v => new Set(v).size === 2),
}).strict(), request: maxWalletLaunchRequestSchema, preparationEvidence: syntheticEvidenceSchema, reviewedStateHashes: stateHashesSchema,
  observations: z.array(z.object({ provider, genesisHash: key, commitment: z.literal('finalized'), slot: number, observedAtMs: number,
    accounts: z.array(z.object({ address: key, account: accountSchema.nullable() }).strict()).min(30).max(64),
  }).strict()).length(2),
  recentBlockhash: z.object({ blockhash: key, genesisHash: key, providers: z.array(provider).length(2), observedAtMs: number,
    currentBlockHeight: number.positive(), blockhashValid: z.literal(true), lastValidBlockHeight: number.positive(), observedSlot: number,
    networkFeeLamports: u64, lamportsPerSignature: u64.refine(v => BigInt(v) > 0n) }).strict(),
  lookupTable: lookupTableSchema.nullable(),
  limits: z.object({ nowMs: number, maxAgeMs: number.positive().max(60000), maxSlotLag: number.max(150), validUntilSlot: number,
    reviewExpiresAtMs: number, maxLaunchFeeLamports: u64, maxPoolCreationFeeLamports: u64, maxRentLamports: u64,
    maxInstructionDebitLamports: u64, maxNetworkFeeLamports: u64, maxTotalDebitLamports: u64,
    computeUnitLimit: number.positive().max(1400000), computeUnitPriceMicroLamports: u64 }).strict(),
  // Set by a server running with HOOK_NATIVE_LAUNCHES_ENABLED=true; only then may launch Config byte 186 be on.
  nativeLaunches: z.literal(true).optional(),
}).strict()

/** Deliberately no resolver implementation, caller callback, or "finalized" JSON bypass.
 * A future production adapter must resolve an authenticated durable server record and reconcile
 * exact signed preparation wire, inclusion and post-state. This export never produces a message.
 */
export function buildMaxWalletLaunchReview(input) {
  const status = input?.preparationEvidence?.status
  const error = Error(status === 'preparation-outcome-unknown' || status === 'pending' || status === 'reconcile-required'
    ? 'Preparation outcome is unresolved; reconciliation required, no retry or launch'
    : 'Trusted durable preparation record resolver is unavailable; caller and synthetic evidence cannot authorize a launch')
  error.code = 'MAX_WALLET_PREPARATION_PROOF_UNAVAILABLE'
  throw error
}

// This raw compiler is NOT an authorization boundary. Only the server resolver may
// authenticate these facts; direct callers receive an explicitly untrusted review.
const collectedProofSchema = z.object({
  schema: z.literal('repoing/max-wallet-durable-prepared-state/1'),
  profileSha256: digest, preparationIntentSha256: digest, executionSlot: number,
  preparedAccountHashes: z.object({ policy: digest, registry: digest, selectedConfig: digest }).strict(),
}).strict()
const collectedInputSchema = inputSchema.extend({ preparationEvidence: collectedProofSchema, request:z.union([maxWalletLaunchRequestSchema,inclusiveMaxWalletLaunchRequestSchema]) }).strict()
export function compileMaxWalletLaunchReview(input) {
  return compileLaunch(collectedInputSchema.parse(input), false)
}
// Dedicated unsigned canary compiler: creation open, trading closed. No route enables it.
export function compileCanaryMaxWalletLaunchReview(input) {
  const parsed = collectedInputSchema.parse(input)
  check(parsed.request.policyVersion === 2, 'Canary requires the inclusive candidate')
  return compileLaunch(parsed, false, true)
}
// An open launch: native only, open creation on, the fee and cap on the chain's menus, sent through the shared launch table.
const openInputSchema = collectedInputSchema.extend({ request: openLaunchRequestSchema, reviewedStateHashes: stateHashesSchema.omit({ authorization: true }),
  lookupTable: lookupTableSchema, nativeLaunches: z.literal(true) }).strict()
export function compileOpenLaunchReview(input) {
  return compileLaunch(openInputSchema.parse(input), false, false, true)
}
export function openLaunchInventory(envelope, request, launchConfigBytes) {
  const profile = parseMaxWalletProfile(JSON.parse(envelope.json)), r = openLaunchRequestSchema.parse(request), launch = binding(envelope, profile, 'launch')
  const config = decoded(launch, 'Config', Buffer.from(launchConfigBytes)), a = addressesFor(profile, r, config), metas = exactMetas(profile, r, config, a, launch, OPEN)
  return { addresses: a, inventory: [...new Set([...metas.map(m => str(m.pubkey)), a.launchProgramData, a.swapProgramData, a.swapGovernance, r.feePayer])].sort() }
}
// The shared launch table's addresses: every account two unrelated open launches have in common, sorted, less the launch
// program (it is invoked, so the message names it directly). The owner creates and freezes this table once.
export function openLaunchTableAddresses(envelope, launchConfigBytes) {
  const profile = parseMaxWalletProfile(JSON.parse(envelope.json)), launch = binding(envelope, profile, 'launch')
  return openTableFor(profile, decoded(launch, 'Config', Buffer.from(launchConfigBytes)), launch)
}
const OPEN = 'open'
function openTableFor(profile, config, launch) {
  const synthetic = label => str(new PublicKey(createHash('sha256').update(`repo.ing shared launch table derivation ${label}`).digest()))
  const metasFor = label => { const r = { policyVersion: 2, creator: synthetic(`${label} creator`), mint: synthetic(`${label} mint`), selectedConfig: synthetic(`${label} config`) }
    return exactMetas(profile, r, config, addressesFor(profile, r, config), launch, OPEN).map(m => str(m.pubkey)) }
  const other = new Set(metasFor('b'))
  return [...new Set(metasFor('a').filter(address => other.has(address) && address !== profile.programs.launch))].sort()
}
// Derive the exact inventory from pinned ABI/config; this does not trust their semantics.
export function maxWalletLaunchInventory(envelope, request, launchConfigBytes) {
  const profile = parseMaxWalletProfile(JSON.parse(envelope.json))
  const r = parseMaxWalletLaunchRequest(request), launch = binding(envelope, profile, 'launch')
  const config = decoded(launch, 'Config', Buffer.from(launchConfigBytes))
  const a = addressesFor(profile, r, config), metas = exactMetas(profile, r, config, a, launch)
  return { addresses: a, inventory: [...new Set([...metas.map(m => str(m.pubkey)), a.launchProgramData, a.swapProgramData, a.swapGovernance, r.feePayer])].sort() }
}
// The exact account list (address, signer, writable) of an inclusive custom launch for these identities, from the pinned
// envelope and the launch Config bytes alone (its treasury, quote and fees). v3 and v4 share it. For the owner agent,
// which derives what it expects before the admin key co-signs anything.
export function maxWalletLaunchAccounts(envelope, { creator, mint, selectedConfig, reviewer }, launchConfigBytes) {
  const profile = parseMaxWalletProfile(JSON.parse(envelope.json)), launch = binding(envelope, profile, 'launch')
  for (const value of [creator, mint, selectedConfig, reviewer]) key.parse(value)
  const r = { policyVersion: 2, creator, mint, selectedConfig, reviewer }, config = decoded(launch, 'Config', Buffer.from(launchConfigBytes))
  return Object.freeze(exactMetas(profile, r, config, addressesFor(profile, r, config), launch).map(m => Object.freeze({ address: str(m.pubkey), signer: m.isSigner, writable: m.isWritable })))
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
    && bytes.subarray(8 + encoded.length).every(b => b === 0), 'Noncanonical account encoding')
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
function governance(binding, role, program, configAddress, config, gov, genesis, canary) {
  const s = gov.state, roles = Object.values(s.roles).map(str)
  check(str(s.program) === program && str(s.config) === configAddress && Buffer.from(s.genesis).equals(kb(genesis))
    && str(s.roles.admin) === str(config.admin) && str(s.roles.treasury) === str(config.treasury)
    && (canary ? canaryGateMatches(role, config, s, true) : !s.gates.creation && !s.gates.trading) && s.pending_admin === null
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
    authorization: pda(L, 'creator-authorization', kb(request.creator)), policy: pda(G, request.policyVersion===2?'policy-v2':'policy', kb(mint)), registry: pda(G, 'bordrless-hook-accounts', kb(mint)),
    launchProgramData: pda(loader, kb(L)), swapProgramData: pda(loader, kb(S)), gateProgramData: pda(loader, kb(G)),
    launch, pool, lpMint: lp, launchReserve: holding(mint, launch), launchQuote: holding(quote, launch),
    poolRegistry: pda(L, 'bordrless-hook-accounts', kb(pool)), baseVault: holding(mint, pool), quoteVault: holding(quote, pool), launchLp: holding(lp, launch),
    launchHookSigner: pda(L, 'hook-authority'), swapHookSigner: pda(S, 'hook-authority', kb(L)), swapEventAuthority: pda(S, '__event_authority'),
    tokenEventAuthority: pda(T, '__event_authority'), eventAuthority: pda(L, '__event_authority'), gateHookSigner: pda(T, 'hook-authority', kb(G)), ...(request.policyVersion===2?{inclusiveFeePolicy:inclusiveFeePolicyAddress(S,pool)}:{}) }
}
// v4 (native SOL) has exactly v3's accounts; only its data differs. An open launch (OPEN) has v4's 32 named accounts and
// exactly 8 remaining ones: v4's less the creator authorization and the reviewer.
function exactMetas(profile, r, c, a, binding, instructionName = r.policyVersion===2?'create_launch_custom_v3':'create_launch_custom_mainnet') {
  const { launch: L, swap: S, gate: G, token: T } = profile.programs, open = instructionName === OPEN
  if (open) instructionName = 'create_launch_custom_v4'
  const abi = binding.idl.instructions.find(i => i.name === instructionName)
  const own = open && binding.idl.instructions.find(i => i.name === 'create_launch_open_v1'), shape = x => x.accounts.slice(0, 32).map(m => [m.name, !!m.signer, !!m.writable, m.address ?? null])
  check(!own || (abi && Buffer.from(own.discriminator).equals(OPEN_LAUNCH_DISCRIMINATOR) && isDeepStrictEqual(shape(own), shape(abi)) && isDeepStrictEqual(own.args, abi.args)), 'Open launch ABI differs from create_launch_custom_v4')
  const names = ['creator', 'config', 'treasury', 'mint', 'launch', 'launch_reserve', 'launch_quote', 'quote_mint', 'registry', 'dex_config', 'pool', 'lp_mint', 'base_vault', 'quote_vault', 'launch_lp', 'hook_signer', 'dex_hook_signer', 'dex_event_authority', 'swap_program', 'token_program', 'token_hook_signer', 'token_event_authority', 'system_program', 'kit_program', 'kit_config', 'kit_registry', 'reward_vault', 'kit_caller', 'kit_event_authority', 'launch_config', 'event_authority', 'program']
  check(abi && isDeepStrictEqual(abi.accounts.map(x => x.name), names) && Buffer.from(abi.discriminator).equals(hash(`global:${instructionName}`).subarray(0, 8)), 'Custom launch ABI differs')
  const placeholder = abi.accounts[20].address
  key.parse(placeholder)
  const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey: pk(pubkey), isWritable, isSigner })
  const keys = [meta(r.creator, true, true), meta(a.launchConfig, true), meta(str(c.treasury), true), meta(r.mint, true, true), meta(a.launch, true),
    meta(a.launchReserve, true), meta(a.launchQuote, true), meta(profile.quoteMint), meta(a.poolRegistry, true), meta(a.swapConfig, true), meta(a.pool, true),
    meta(a.lpMint, true), meta(a.baseVault, true), meta(a.quoteVault, true), meta(a.launchLp, true), meta(a.launchHookSigner), meta(a.swapHookSigner),
    meta(a.swapEventAuthority), meta(S), meta(T), meta(placeholder), meta(a.tokenEventAuthority), meta(zero), ...Array.from({ length: 6 }, () => meta(L)),
    meta(r.selectedConfig), meta(a.eventAuthority), meta(L), meta(a.launchGovernance), ...(open ? [] : [meta(a.authorization, true), meta(r.reviewer, false, true)]),
    meta(a.gateProgramData), meta(G), meta(a.gateHookSigner), meta(a.registry), meta(a.policy), meta(a.launch), ...(r.policyVersion===2?[meta(a.inclusiveFeePolicy,true)]:[])]
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
export function buildMaxWalletLaunchReviewForFixture(input) {
  return compileLaunch(inputSchema.parse(input), true)
}
function compileLaunch(input, fixture, canary = false, open = false) {
  const { profile: envelope, request: r, observations, preparationEvidence: proof, reviewedStateHashes, recentBlockhash: bh, lookupTable, limits: l, nativeLaunches = false } = input
  check(sha(envelope.json) === envelope.expectedSha256, 'Reviewed profile digest differs')
  const profile = parseMaxWalletProfile(JSON.parse(envelope.json)), { launch: L, swap: S, gate: G, token: T } = profile.programs
  check(new Set([...Object.values(profile.programs), profile.quoteMint, zero]).size === 7, 'Profile program roles alias')
  const launch = binding(envelope, profile, 'launch'), swap = binding(envelope, profile, 'swap'), gate = binding(envelope, profile, 'gate')
  const inclusive=r.policyVersion===2
  // An open launch offers the fees on the chain's menu (checked below); every other launch, the reviewed profile's menu.
  check(inclusive === (profile.buildFeature==='inclusive-fees-candidate') && (!inclusive || open || approvedCreatorFees(profile).includes(r.creatorFeeBps)) && (!open || inclusive), 'Compiler family or explicit fee differs')
  const prep = parseMaxWalletPreparationRequest({ schema: inclusive?'repoing/inclusive-max-wallet-preparation-request/1':'repoing/max-wallet-preparation-request/1', policyKind: r.policyKind, policyVersion: r.policyVersion, creator: r.creator, feePayer: r.feePayer,
    mint: r.mint, selectedConfig: r.selectedConfig, capBps: r.capBps, label: r.label, creatorFeeBps: r.creatorFeeBps, rules: r.rules, hookFlags: r.hookFlags,...(inclusive?{feeModel:2,protocolShareBps:2500}:{}) })
  check(proof.profileSha256 === envelope.expectedSha256 && proof.preparationIntentSha256 === sha(JSON.stringify(prep)), 'Preparation intent/profile differs')
  check(new Set(observations.map(o => o.provider)).size === 2 && observations.every(o => envelope.providers.includes(o.provider)), 'Provider binding differs')
  check(Math.abs(observations[0].slot - observations[1].slot) <= l.maxSlotLag && isDeepStrictEqual(observations[0].accounts, observations[1].accounts), 'Prepared state observations disagree')
  for (const o of observations) check(o.genesisHash === profile.genesisHash && o.slot >= proof.executionSlot
    && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale, pre-preparation or wrong-chain observation')
  const accounts = new Map(observations[0].accounts.map(item => { check(!item.account || item.account.address === item.address, 'Account identity differs'); return [item.address, item.account] }))
  check(accounts.size === observations[0].accounts.length, 'Duplicate observation account')
  const c = decoded(launch, 'Config', owned(accounts, pda(L, 'config'), L, 250)), d = decoded(swap, 'Config', owned(accounts, pda(S, 'config'), S, 189))
  check(c.version === 1 && d.version === 1 && c.bump === bump(L, 'config') && d.bump === bump(S, 'config') && !c.paused && d.paused === canary
    && launchConfigReservedValid(c.reserved) && d.reserved.every(x => x === 0), 'Config version, reserved state or pause differs')
  // Launch Config byte 186, as both providers read it: on, v3 and plain launches are closed and only a native-SOL v4
  // launch can be created. Compiled only on a server that enables it and pins the reviewed native programs and IDLs.
  const native = c.reserved[0] === 1
  if (open) {
    const menus = parseLaunchConfigReserved(Buffer.from(c.reserved))
    check(native, 'Native launches are off on chain; an open launch is native SOL only')
    check(menus.open, 'Open creation is off on chain')
    check(menus.creatorFeeBps.includes(r.creatorFeeBps), 'The creator fee is not on the on-chain menu')
    check(menus.capBps.includes(r.capBps), 'The wallet cap is not on the on-chain menu')
    check(r.feePayer === r.creator, 'An open launch is signed and paid by its creator: the creator pays')
  }
  check(!native || nativeLaunches === true, 'Native launches are on chain; this server is not enabled for them')
  check(!native || (inclusive && !canary && ['launch', 'swap'].every(role => isNativeElfPin(role, profile.elfSha256[role], envelope.elfLengths[role])
    && profile.idlSha256[role] === NATIVE_IDL_SHA256[role])), 'Native launches need the reviewed native-SOL programs and IDLs')
  const instructionName = open ? OPEN : inclusive ? (native ? 'create_launch_custom_v4' : 'create_launch_custom_v3') : 'create_launch_custom_mainnet'
  check(str(c.quote_mint) === profile.quoteMint && str(c.treasury) === str(d.treasury) && (open || str(c.admin) === r.reviewer), 'Current admin, treasury or quote differs')
  if (canary) check(str(c.admin) === str(d.admin), 'Canary requires the existing shared admin role')
  const a = addressesFor(profile, r, c), metas = exactMetas(profile, r, c, a, launch, instructionName)
  const inventory = [...new Set([...metas.map(m => str(m.pubkey)), a.launchProgramData, a.swapProgramData, a.swapGovernance, r.feePayer])].sort()
  check(isDeepStrictEqual([...accounts.keys()].sort(), inventory), 'Incomplete or extra launch inventory')
  const reviewer = open ? [] : [r.reviewer]
  const roles = [...Object.values(a), ...Object.values(profile.programs), profile.quoteMint, zero, r.creator, r.mint, r.selectedConfig, ...reviewer, str(c.treasury)]
  check(new Set(roles).size === roles.length && (r.feePayer === r.creator || !roles.includes(r.feePayer)), 'Launch roles alias')
  check([r.creator, r.feePayer, r.mint, r.selectedConfig, ...reviewer].every(k => PublicKey.isOnCurve(kb(k))), 'Required signer identity cannot be a PDA')
  check(!lookupTable || ![...inventory, ...roles, ComputeBudgetProgram.programId.toBase58()].includes(lookupTable.address), 'Lookup table aliases a launch role')
  for (const o of observations) for (const role of ['launch', 'swap', 'gate']) programEvidence(accounts, profile.programs[role], profile.elfSha256[role], envelope.elfLengths[role], o.slot, role === 'gate')
  const tokenProgram = accounts.get(T), tokenBytes = tokenProgram && raw(tokenProgram.dataBase64, 36)
  check(tokenProgram?.owner === loader && tokenProgram.executable && tokenBytes.length === 36 && tokenBytes.readUInt32LE() === 2
    && tokenBytes.subarray(4).equals(kb(pda(loader, kb(T)))), 'Token ProgramData linkage differs')
  for (const name of ['launch', 'pool', 'lpMint', 'launchReserve', 'launchQuote', 'poolRegistry', 'baseVault', 'quoteVault', 'launchLp',...(inclusive?['inclusiveFeePolicy']:[])]) check(accounts.get(a[name]) === null, 'Launch target already exists; reconcile, do not retry')
  for (const address of new Set([r.creator, r.feePayer, ...reviewer, r.mint, str(c.treasury)])) {
    const account = accounts.get(address)
    check((address === r.mint && account === null) || account && account.owner === zero && !account.executable && raw(account.dataBase64, 0).length === 0, 'Signer, treasury or future mint is not an empty system account')
  }
  const policyBytes = owned(accounts, a.policy, G, inclusive?90:85), registryBytes = owned(accounts, a.registry, G, 81), selectedBytes = owned(accounts, r.selectedConfig, L, 176)
  const policy = decoded(gate, inclusive?'PolicyV2':'Policy', policyBytes), selected = decoded(launch, 'LaunchConfig', selectedBytes)
  check(policy.version === (inclusive?2:1) && str(policy.mint) === r.mint && policy.cap_bps === r.capBps
    && n(policy.initial_supply) === n(c.supply) && str(policy.quote_mint) === profile.quoteMint && policy.lp_fee_bps === c.lp_fee_bps
    && c.lp_fee_bps < 10000 && profile.quoteMint !== r.mint && n(policy.initial_supply) > 0n
    && n(policy.initial_supply) * BigInt(policy.cap_bps) / 10000n > 0n, 'Prepared max-wallet policy or observed launch economics differs')
  const canonicalRegistry = Buffer.concat([Buffer.from('02daf6662c38c0cd01020000000000', 'hex'), kb(a.policy), Buffer.from([0, 0]), kb(a.launch)])
  check(registryBytes.equals(canonicalRegistry), 'Registry must contain exactly two literal read-only canonical policy and launch entries')
  check(selected.version === 1 && str(selected.creator) === r.creator && selected.custom_hook && str(selected.custom_hook) === G
    && selected.creator_fee_bps === r.creatorFeeBps && selected.author_share_bps === 0 && selected.custom_hook_flags === 1
    && selected.label === r.label && selected.reserved.every(v => v === 0) && isDeepStrictEqual(selected.rules, noRules), 'Prepared selected configuration differs')
  if(inclusive)check(policy.fee_model===2 && policy.protocol_share_bps===2500 && policy.creator_fee_bps===r.creatorFeeBps
    && c.lp_fee_bps===0 && n(c.sniper_window_secs)===0n && c.sniper_start_bps===0 && d.protocol_fee_bps===0
    && d.launch_protocol_share_bps===2500 && r.creatorFeeBps<=c.max_creator_fee_bps, 'Inclusive fee policy or economics differs')
  check(isDeepStrictEqual(proof.preparedAccountHashes, { policy: sha(policyBytes), registry: sha(registryBytes), selectedConfig: sha(selectedBytes) }), 'Prepared state hashes differ')
  const observedHashes = Object.fromEntries(Object.keys(reviewedStateHashes).map(name => [name, sha(raw(accounts.get(name === 'quoteMint' ? profile.quoteMint : a[name])?.dataBase64 ?? '', 8192))]))
  check(isDeepStrictEqual(reviewedStateHashes, observedHashes), 'Reviewed current state hashes differ')
  const lg = decoded(launch, 'Governance', owned(accounts, a.launchGovernance, L, 348)), sg = decoded(swap, 'Governance', owned(accounts, a.swapGovernance, S, 348))
  const launchGov = governance(launch, 'launch', L, a.launchConfig, c, lg, profile.genesisHash, canary), swapGov = governance(swap, 'swap', S, a.swapConfig, d, sg, profile.genesisHash, canary)
  const slot = Math.max(...observations.map(o => o.slot))
  // An open launch has no creator grant: anyone may launch while open creation is on and creation is not paused.
  const auth = open ? null : decoded(launch, 'CreatorAuthorization', owned(accounts, a.authorization, L, 73))
  if (!open) check(str(auth.creator) === r.creator && auth.enabled && n(auth.consumed) < n(auth.max_launches) && n(auth.expires_at_slot) > BigInt(l.validUntilSlot), 'Current creator grant, quota or exclusive expiry differs')
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
  let launchEconomics = hash('hook-lab:create-launch-economics:v2', kb(L), kb(a.launchConfig), enc(c.version, 1), kb(c.admin), kb(c.treasury), kb(c.quote_mint),
    enc(c.launch_fee_lamports, 8), enc(c.lp_fee_bps, 2), enc(c.max_creator_fee_bps, 2), enc(c.sniper_window_secs, 8, true), enc(c.sniper_start_bps, 2), enc(c.curve_bps, 2),
    enc(c.supply, 8), enc(c.decimals, 1), enc(c.min_virtual_quote, 8), enc(c.max_virtual_quote, 8), launch.coder.types.encode('RuleBounds', c.rule_bounds),
    enc(1, 1), kb(r.selectedConfig), enc(selected.version, 1), kb(selected.creator), launch.coder.types.encode('LaunchRules', selected.rules), enc(r.creatorFeeBps, 2), enc(1, 1), kb(G), enc(1, 2), enc(0, 2), enc(0, 1))
  let poolEconomics = hash('hook-lab:create-pool-economics:v2', kb(S), kb(a.swapConfig), enc(d.version, 1), kb(d.admin), kb(d.treasury), kb(d.fee_collector),
    enc(d.pool_creation_fee_lamports, 8), enc(d.protocol_fee_bps, 2), enc(d.launch_protocol_share_bps, 2))
  if(inclusive){launchEconomics=inclusiveEconomicsHash('launch',launchEconomics);poolEconomics=inclusiveEconomicsHash('pool',poolEconomics)}
  if(native){launchEconomics=nativeEconomicsHash('launch',launchEconomics);poolEconomics=nativeEconomicsHash('pool',poolEconomics)}
  const control = open ? hash('hook-lab:open-creation-controls:v1', kb(L), launchGov)
    : hash('hook-lab:mainnet-creation-controls:v1', kb(L), launchGov, hash('hook-lab:creator-authorization:v1', kb(L), kb(r.creator), enc(1, 1), enc(auth.expires_at_slot, 8), enc(auth.max_launches, 8), enc(auth.revision, 8)))
  let hookAccounts = hash('hook-lab:max-wallet-accounts:v1', kb(G), kb(a.registry), kb(G), enc(registryBytes.length, 4), registryBytes,
    kb(a.policy), kb(G), enc(policyBytes.length, 4), policyBytes, kb(a.launch), kb(L))
  if(inclusive)hookAccounts=inclusiveHookAccountsHash({program:G,registry:{address:a.registry,owner:G,data:registryBytes},policy:{address:a.policy,owner:G,data:policyBytes},launch:{address:a.launch,owner:L}})
  const guard = { version: 2, deadline_slot: bn(l.validUntilSlot), expected_launch_economics_hash: [...launchEconomics], expected_pool_economics_hash: [...poolEconomics],
    max_launch_fee_lamports: bn(l.maxLaunchFeeLamports), max_pool_creation_fee_lamports: bn(l.maxPoolCreationFeeLamports), max_rent_lamports: bn(l.maxRentLamports), max_total_debit_lamports: bn(l.maxInstructionDebitLamports) }
  const data = launch.coder.instruction.encode(open ? 'create_launch_custom_v4' : instructionName, { args: { name: r.name, symbol: r.symbol, uri: r.uri, creator_fee_bps: r.creatorFeeBps, virtual_quote: bn(r.virtualQuote), rules: noRules },
    guard, ...(inclusive?{fee_model:2}:{}), ...(native?{quote_form:QUOTE_FORM_NATIVE}:{}), expected_control_hash: [...control], expected_hook_accounts_hash: [...hookAccounts] })
  if (open) OPEN_LAUNCH_DISCRIMINATOR.copy(data, 0)   // v4's argument encoding under the open instruction's discriminator
  const instruction = new TransactionInstruction({ programId: pk(L), keys: metas, data })
  const tables = lookupTable ? [new AddressLookupTableAccount({ key: pk(lookupTable.address), state: AddressLookupTableAccount.deserialize(raw(lookupTable.dataBase64, 16384)) })] : []
  if (lookupTable) {
    const b = raw(lookupTable.dataBase64, 16384), state = tables[0].state
    check(sha(b) === lookupTable.sha256 && b.length >= 56 && b.length <= 8248 && state.addresses.length <= 256 && (b.length - 56) % 32 === 0 && b.readUInt32LE() === 1 && [0, 1].includes(b[21])
      && (b[21] === 1 ? b.subarray(54, 56).every(v => v === 0) : b.subarray(22, 56).every(v => v === 0))
      && state.lastExtendedSlotStartIndex <= state.addresses.length && new Set(state.addresses.map(str)).size === state.addresses.length, 'Lookup table hash, canonical state or addresses differ')
    // An open launch uses only the owner's shared launch table: frozen, active, exactly the constant addresses.
    if (open) check(b[21] === 0 && state.deactivationSlot === 0xffffffffffffffffn && isDeepStrictEqual(state.addresses.map(str), openTableFor(profile, c, launch)), 'Lookup table is not the frozen shared launch table')
  }
  const message = new TransactionMessage({ payerKey: pk(r.feePayer), recentBlockhash: bh.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: l.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) }), instruction] }).compileToV0Message(tables)
  check(!lookupTable || message.addressTableLookups.length === 1, 'Unused lookup table')
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables }), bytes = message.serialize()
  if (open) check(1 + 64 * message.header.numRequiredSignatures + bytes.length <= 1232, 'Launch transaction exceeds the 1232-byte packet limit; shorten the coin URI')
  const priority = (BigInt(l.computeUnitLimit) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(BigInt(bh.networkFeeLamports) === BigInt(message.header.numRequiredSignatures) * BigInt(bh.lamportsPerSignature) + priority, 'Network fee quote differs from explicit signature fee basis')
  const review = { schema: 'hooklab-message-review/1', operation: canary ? 'canary-max-wallet-launch' : fixture ? 'max-wallet-launch-fixture' : open ? 'open-launch' : 'max-wallet-launch', genesisHash: profile.genesisHash, profileSha256: envelope.expectedSha256,
    policySha256: sha(JSON.stringify({ proof, reviewedStateHashes, observations })), intentSha256: sha(JSON.stringify(r)), payer: r.feePayer, wallet: r.creator,
    messageBase64: Buffer.from(bytes).toString('base64'), messageSha256: sha(bytes), requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(str),
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: str(keys.get(i)), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: lookupTable ? [lookupTable] : [], observedSlot: slot, validUntilSlot: l.validUntilSlot, observedAtMs: l.nowMs, reviewExpiresAtMs: l.reviewExpiresAtMs,
    lastValidBlockHeight: bh.lastValidBlockHeight, baseFeeLamports: String(BigInt(bh.networkFeeLamports) - priority), maxFeeLamports: l.maxNetworkFeeLamports,
    instructionDebitLamports: l.maxInstructionDebitLamports, maxNativeDebitLamports: l.maxTotalDebitLamports }
  const inspected = inspectHookLabMessage(review), wantSigners = new Set([r.creator, r.feePayer, r.mint, ...reviewer]), wantWritable = new Set([r.feePayer, ...metas.filter(m => m.isWritable).map(m => str(m.pubkey))])
  check(inspected.instructions.length === 3 && review.accounts.every(a => a.signer === wantSigners.has(a.address) && a.writable === wantWritable.has(a.address)), 'Compiled launch privileges differ')
  const canonicalInstruction = { program: L, dataHex: data.toString('hex'), accounts: metas.map(m => ({ address: str(m.pubkey), signer: m.isSigner, writable: m.isWritable })) }
  // Launch appears twice: declared writable as the target and read-only as a registry literal.
  // Solana compiles their privilege union; this is expected and never widens Policy/registry.
  const effective = { ...canonicalInstruction, accounts: canonicalInstruction.accounts.map(m => review.accounts.find(a => a.address === m.address)) }
  check(isDeepStrictEqual(inspected.instructions[2], effective), 'Effective instruction metas differ from canonical max-wallet launch policy')
  return freeze({ schema: canary ? 'repoing/canary-max-wallet-launch-review/1' : open ? 'repoing/open-launch-review/1' : 'repoing/max-wallet-launch-review/1', status: fixture ? 'offline-synthetic-review-only' : 'unauthenticated-deterministic-review-only', provenance: fixture ? proof.provenance : 'compiler-inputs-not-authority', sourceCommit: profile.sourceCommit,
    sourcePatchSha256: profile.sourcePatchSha256, releaseProfileSha256: envelope.expectedSha256, request: r, addresses: a, review, canonicalInstruction, instructions: inspected.instructions,
    policyKind: 'max-wallet', policyVersion: r.policyVersion, ...(inclusive?{feeModel:2,protocolShareBps:2500,creatorFeeBps:r.creatorFeeBps}:{}), ...(native?{quoteForm:QUOTE_FORM_NATIVE}:{}), policy: { initialSupply: n(policy.initial_supply).toString(), capBps: policy.cap_bps,
      capRaw: (n(policy.initial_supply) * BigInt(policy.cap_bps) / 10000n).toString(), endsAt: 'authenticated-graduation', poolExemption: 'canonical-pool-only' },
    commitments: { launchEconomics: launchEconomics.toString('hex'), poolEconomics: poolEconomics.toString('hex'), launchGovernance: launchGov.toString('hex'),
      swapGovernance: swapGov.toString('hex'), creationControl: control.toString('hex'), hookAccounts: hookAccounts.toString('hex') },
    productionPreparationReceipt: null, preparationReceiptAccepted: false, artifactAdopted: false, deploymentAdopted: false, policyApproved: false,
    executionAuthorized: false, publicExecutionEnabled: false, feeEvidenceAuthenticated: false, dependencyCodeAuthenticated: false,
    canSign: false, canSubmit: false, canRetry: false })
}
