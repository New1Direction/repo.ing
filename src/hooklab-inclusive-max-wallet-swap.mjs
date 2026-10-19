// Explicit inclusive mode-2 max-wallet swap planner for local synthetic SBF review only.
// No signing, submission, connection, new holding creation or production route.
// The ordinary SwapArgs ABI enforces exact input/minimum output; TTL remains offchain.
import { approvedCreatorFees } from './hooklab-launch-menus.mjs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { z } from 'zod'
import { hookAddress as key, hookDigest as digest, hookRawAmount as u64 } from './hooklab-execution-contract.mjs'
import { parseInclusiveMaxWalletProfile } from './hooklab-inclusive-max-wallet-profile.mjs'
import { modelInclusiveCreatorQuote } from './hooklab-inclusive-fee-quote.mjs'
import { readInclusiveFeePolicy } from './hooklab-inclusive-fee-abi.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { canaryGateMatches, canarySwapTransition } from './hooklab-canary-policy.mjs'

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
    && (canary ? canaryGateMatches(role, config, s) : !s.gates.creation && !s.gates.trading) && s.pending_admin === null
    && new Set(roles).size === 4 && !roles.includes(zero), 'Governance identity, roles or gates differ')
  check(gov.bump === bump(program, 'governance'), 'Governance bump differs')
  const economics = hash(`hook-lab/${role}-governed-economics/1\0`, kb(program), binding.coder.types.encode('ConfigArgs', {
    ...config, admin: pk(zero), treasury: pk(zero), paused: false }))
  check(economics.equals(Buffer.from(s.config_digest)), 'Governance economics digest differs')
  return hash('hook-lab/governance-state/1\0', binding.coder.types.encode('State', s))
}
const positive = u64.refine(v => BigInt(v) > 0n)
export const inclusiveMaxWalletSwapRequestSchema = z.object({ schema: z.literal('repoing/inclusive-max-wallet-swap-request/1'),
  policyKind: z.literal('max-wallet'), policyVersion: z.literal(2), creatorFeeBps: number.max(9999), feeModel: z.literal(2), protocolShareBps: z.literal(2500), capBps: number.min(1).max(9999),
  side: z.enum(['buy', 'sell']), trader: key, recipient: key, feePayer: key, mint: key, selectedConfig: key,
  amountIn: positive, minAmountOut: positive, maxInput: positive, maxPriceImpactBps: number.max(1000),
}).strict()
const accountSchema = z.object({ address: key, owner: key, executable: z.boolean(), dataBase64: z.string().max(14000000), lamports: u64 }).strict()
const inputSchema = z.object({ profile: z.object({ json: z.string().max(16384), expectedSha256: digest,
  idls: z.object({ launch: z.string().max(1500000), swap: z.string().max(1500000), gate: z.string().max(1500000) }).strict(),
  elfLengths: z.object({ launch: number.positive().max(10485760), swap: number.positive().max(10485760), gate: number.positive().max(10485760) }).strict(),
  providers: z.array(provider).length(2).refine(v => new Set(v).size === 2) }).strict(), request: inclusiveMaxWalletSwapRequestSchema,
  provenance: z.enum(['disposable-litesvm-synthetic-fixture-not-rpc-evidence', 'server-collected-finalized-state-not-execution-authorization']),
  observations: z.array(z.object({ provider, genesisHash: key, commitment: z.literal('finalized'), slot: number, observedAtMs: number,
    accounts: z.array(z.object({ address: key, account: accountSchema.nullable() }).strict()).min(20).max(64) }).strict()).length(2),
  recentBlockhash: z.object({ blockhash: key, genesisHash: key, providers: z.array(provider).length(2), observedAtMs: number,
    currentBlockHeight: number, blockhashValid: z.literal(true), lastValidBlockHeight: number.positive(), observedSlot: number,
    networkFeeLamports: u64, lamportsPerSignature: u64.refine(v => BigInt(v) > 0n) }).strict(),
  lookupTable: z.object({ address: key, owner: z.literal(lookupOwner), dataBase64: z.string().max(22000), sha256: digest }).strict().nullable(),
  limits: z.object({ nowMs: number, maxAgeMs: number.positive().max(60000), maxSlotLag: number.max(150), validUntilSlot: number,
    reviewExpiresAtMs: number, maxNetworkFeeLamports: u64, maxTotalDebitLamports: u64,
    computeUnitLimit: number.positive().max(1400000), computeUnitPriceMicroLamports: u64 }).strict(),
}).strict()

export function buildInclusiveMaxWalletSwapReview() {
  const error = Error('Production max-wallet swap adapter is unavailable; synthetic state cannot authorize trading')
  error.code = 'INCLUSIVE_MAX_WALLET_SWAP_PROOF_UNAVAILABLE'; throw error
}
const KIT = 'AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'
function deriveAddresses(profile, r) {
  const { launch: L, swap: S, gate: G, token: T } = profile.programs, mint = r.mint, quote = profile.quoteMint
  const launch = pda(L, 'launch', kb(mint)), pool = pda(S, 'pool', kb(mint), kb(quote), enc(0, 2), kb(L)), lpMint = pda(S, 'lp', kb(pool))
  const holding = (mint, owner) => pda(T, 'holding', kb(mint), kb(owner)), kitConfig = pda(KIT, 'kit', kb(mint))
  return { launchConfig: pda(L, 'config'), swapConfig: pda(S, 'config'), launchGovernance: pda(L, 'governance'), swapGovernance: pda(S, 'governance'),
    inclusiveFeePolicy: pda(S, 'inclusive-fee-policy', kb(pool)), policy: pda(G, 'policy-v2', kb(mint)), registry: pda(G, 'bordrless-hook-accounts', kb(mint)), launch, pool, lpMint,
    launchReserve: holding(mint, launch), launchQuote: holding(quote, launch), launchLp: holding(lpMint, launch),
    baseVault: holding(mint, pool), quoteVault: holding(quote, pool), poolRegistry: pda(L, 'bordrless-hook-accounts', kb(pool)),
    traderBase: holding(mint, r.side === 'buy' ? r.recipient : r.trader), traderQuote: holding(quote, r.side === 'buy' ? r.trader : r.recipient),
    kitConfig, holderVault: holding(quote, kitConfig), gateHookSigner: pda(T, 'hook-authority', kb(G)), swapHookSigner: pda(S, 'hook-authority', kb(L)),
    tokenEventAuthority: pda(T, '__event_authority'), swapEventAuthority: pda(S, '__event_authority'),
    launchProgramData: pda(loader, kb(L)), swapProgramData: pda(loader, kb(S)), gateProgramData: pda(loader, kb(G)) }
}
// A coin's shared accounts (launch, pool, policy, vaults...), as every swap derives them; no trader accounts.
export function hookCoinAddresses(profile, mint) {
  const { traderBase, traderQuote, ...shared } = deriveAddresses(profile, { mint, side: 'buy', trader: mint, recipient: mint })
  return shared
}
function metasFor(profile, r, a, swap) {
  const { launch: L, swap: S, gate: G, token: T } = profile.programs, meta = (address, writable = false, signer = false) => ({ pubkey: pk(address), isWritable: writable, isSigner: signer })
  const keys = [meta(r.trader, false, true), meta(a.swapConfig), meta(a.pool, true), meta(r.mint), meta(profile.quoteMint),
    meta(a.baseVault, true), meta(a.quoteVault, true), meta(a.traderBase, true), meta(a.traderQuote, true), meta(L), meta(a.swapHookSigner),
    meta(T), meta(a.tokenEventAuthority), meta(a.swapEventAuthority), meta(S),
    meta(G), meta(a.gateHookSigner), meta(a.policy), meta(a.launch),
    meta(a.launch, true), meta(a.launchQuote, true), meta(a.holderVault, true), meta(a.kitConfig), meta(a.inclusiveFeePolicy)]
  const names = ['trader', 'config', 'pool', 'base_mint', 'quote_mint', 'base_vault', 'quote_vault', 'trader_base', 'trader_quote',
    'hook_program', 'hook_signer', 'token_program', 'token_event_authority', 'event_authority', 'program']
  const abi = swap.idl.instructions.find(i => i.name === 'swap')
  check(abi && isDeepStrictEqual(abi.accounts.map(a => a.name), names) && Buffer.from(abi.discriminator).equals(hash('global:swap').subarray(0, 8)), 'Swap ABI differs')
  for (let i = 0; i < names.length; i++) check(!!abi.accounts[i].signer === keys[i].isSigner && !!abi.accounts[i].writable === keys[i].isWritable
    && (!abi.accounts[i].address || abi.accounts[i].address === str(keys[i].pubkey)), 'Swap declared privileges differ')
  return keys
}
/** Full deterministic read inventory; callers must provide exactly these rows, including absences. */
export function inclusiveMaxWalletSwapInventory(profileInput, requestInput) {
  const profile = parseInclusiveMaxWalletProfile(profileInput), r = inclusiveMaxWalletSwapRequestSchema.parse(requestInput), a = deriveAddresses(profile, r)
  const addresses = [profile.programs.launch, profile.programs.swap, profile.programs.gate, profile.programs.token,
    r.trader, r.recipient, r.feePayer, r.mint, profile.quoteMint, r.selectedConfig, ...Object.values(a)]
  return [...new Set(addresses)].sort()
}
// Token Mint options may shrink during authority revocation. Anchor retains bytes beyond the
// serialized prefix; those bytes are not fields. Bound allocation and canonical active prefix,
// and validate active reserved fields below instead of inventing a zeroed historical suffix.
function typed(binding, name, bytes) {
  const value = binding.coder.types.decode(name, bytes.subarray(8)), encoded = binding.coder.types.encode(name, value)
  check(bytes.subarray(0, 8).equals(hash(`account:${name}`).subarray(0, 8)) && bytes.subarray(8, 8 + encoded.length).equals(encoded), 'Noncanonical token mint encoding')
  return value
}
function readHolding(accounts, address, token, mint, owner) {
  const bytes = owned(accounts, address, token, 204)
  // None delegate, no delegated amount/freeze/hook data; exact version1 serialized fields and zero allocation tail.
  check(bytes.subarray(0, 8).equals(hash('account:Holding').subarray(0, 8)) && bytes[8] === 1
    && bytes[9] === bump(token, 'holding', kb(mint), kb(owner)) && bytes.subarray(10, 42).equals(kb(mint))
    && bytes.subarray(42, 74).equals(kb(owner)) && bytes.subarray(82).every(v => v === 0), 'Canonical holding, delegation or freeze differs')
  return bytes.readBigUInt64LE(74)
}

// The same account evidence rules, shared with the native-SOL compiler (src/hooklab-native-swap.mjs).
export const swapAccountEvidence = Object.freeze({ raw, owned, decoded, programEvidence, governance, typed, readHolding, KIT, noRules })

export function buildInclusiveMaxWalletSwapReviewForFixture(input) {
  check(input?.provenance === 'disposable-litesvm-synthetic-fixture-not-rpc-evidence', 'Fixture provenance required')
  return compile(input, true)
}
// Deterministic compiler only. Caller must authenticate real observations and independent pins.
// It grants no execution authority; the server collector is the sole lifecycle integration.
export function compileInclusiveMaxWalletSwapReview(input) {
  check(input?.provenance === 'server-collected-finalized-state-not-execution-authorization', 'Server collection provenance required')
  return compile(input, false)
}
// Separate owner-canary policy. This does not enable a production signing route.
export function compileCanaryInclusiveMaxWalletSwapReview(input) {
  check(input?.provenance === 'server-collected-finalized-state-not-execution-authorization', 'Server collection provenance required')
  return compile(input, false, true)
}
function compile(input, fixture, canary = false) {
  const { profile: envelope, request: r, provenance, observations: obs, recentBlockhash: bh, lookupTable, limits: l } = inputSchema.parse(input)
  check(sha(envelope.json) === envelope.expectedSha256, 'Reviewed profile digest differs')
  const profile = parseInclusiveMaxWalletProfile(JSON.parse(envelope.json)), { launch: L, swap: S, gate: G, token: T } = profile.programs
  check(new Set([...Object.values(profile.programs), profile.quoteMint, zero, KIT]).size === 8, 'Profile program roles alias')
  const launch = binding(envelope, profile, 'launch'), swap = binding(envelope, profile, 'swap'), gate = binding(envelope, profile, 'gate')
  for (const name of ['before_swap_inclusive_v1', 'after_swap_inclusive_v1']) {
    const callback = launch.idl.instructions.find(ix => ix.name === name)
    check(callback && Buffer.from(callback.discriminator).equals(hash(`global:${name}`).subarray(0, 8))
      && callback.args.length === 1 && callback.args[0].name === 'args'
      && callback.args[0].type?.defined?.name === 'PoolHookArgsInclusiveV1', 'Versioned inclusive callback ABI differs')
  }
  const a = deriveAddresses(profile, r), metas = metasFor(profile, r, a, swap), inventory = inclusiveMaxWalletSwapInventory(profile, r)
  check(new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => envelope.providers.includes(o.provider)), 'Provider binding differs')
  check(Math.abs(obs[0].slot - obs[1].slot) <= l.maxSlotLag && isDeepStrictEqual(obs[0].accounts, obs[1].accounts), 'Swap state observations disagree')
  for (const o of obs) check(o.genesisHash === profile.genesisHash && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale or wrong-chain swap observation')
  const accounts = new Map(obs[0].accounts.map(x => { check(!x.account || x.address === x.account.address, 'Account identity differs'); return [x.address, x.account] }))
  check(accounts.size === obs[0].accounts.length && isDeepStrictEqual([...accounts.keys()].sort(), inventory), 'Incomplete, duplicate or extra swap inventory')
  const roles = [...Object.values(a), ...Object.values(profile.programs), profile.quoteMint, r.mint, r.selectedConfig, zero, KIT, ComputeBudgetProgram.programId.toBase58()]
  check(new Set(roles).size === roles.length && [r.trader, r.recipient, r.feePayer].every(k => !roles.includes(k) && PublicKey.isOnCurve(kb(k))), 'Swap role alias or invalid wallet')
  check(!lookupTable || ![...inventory, ...roles].includes(lookupTable.address), 'Lookup table aliases a swap role')
  for (const o of obs) for (const role of ['launch', 'swap', 'gate']) programEvidence(accounts, profile.programs[role], profile.elfSha256[role], envelope.elfLengths[role], o.slot, role === 'gate')
  const token = accounts.get(T), tokenBytes = token && raw(token.dataBase64, 36)
  check(token?.owner === loader && token.executable && tokenBytes.length === 36 && tokenBytes.readUInt32LE() === 2 && tokenBytes.subarray(4).equals(kb(pda(loader, kb(T)))), 'Token ProgramData linkage differs')
  for (const address of new Set([r.trader, r.recipient, r.feePayer])) {
    const wallet = accounts.get(address)
    check(wallet && wallet.owner === zero && !wallet.executable && raw(wallet.dataBase64, 0).length === 0, 'Wallet must be an empty system account')
  }
  for (const name of ['kitConfig', 'holderVault']) check(accounts.get(a[name]) === null, 'No-Kit account unexpectedly initialized')
  const c = decoded(launch, 'Config', owned(accounts, a.launchConfig, L, 250)), d = decoded(swap, 'Config', owned(accounts, a.swapConfig, S, 189))
  // Launch Config.reserved[0] (byte 186) is the native-launches switch of the upgraded launch program: it steers new
  // launches only, so a bridged coin keeps trading with it on.
  check(c.version === 1 && d.version === 1 && c.bump === bump(L, 'config') && d.bump === bump(S, 'config') && d.paused === canary
    && [0, 1].includes(c.reserved[0]) && c.reserved.slice(1).every(v => v === 0) && d.reserved.every(v => v === 0), 'Configuration version, reserved or trading pause differs')
  check(str(c.quote_mint) === profile.quoteMint && str(c.treasury) === str(d.treasury)
    && c.lp_fee_bps === 0 && c.sniper_window_secs.isZero() && c.sniper_start_bps === 0 && d.protocol_fee_bps === 0 && d.launch_protocol_share_bps === 2500, 'Only reviewed inclusive-fee configuration is supported')
  const lg = decoded(launch, 'Governance', owned(accounts, a.launchGovernance, L, 348)), sg = decoded(swap, 'Governance', owned(accounts, a.swapGovernance, S, 348))
  governance(launch, 'launch', L, a.launchConfig, c, lg, profile.genesisHash, canary); governance(swap, 'swap', S, a.swapConfig, d, sg, profile.genesisHash, canary)
  const transition = canary ? canarySwapTransition(swap, sg, a) : null
  if (canary) check(str(c.admin) === transition.admin && str(d.fee_collector) === str(d.treasury)
    && !roles.includes(transition.admin) && transition.admin !== r.trader
    && r.trader === r.recipient && r.trader === r.feePayer, 'Canary admin, payer or recipient binding differs')
  const policyBytes = owned(accounts, a.policy, G, 90), policy = decoded(gate, 'PolicyV2', policyBytes), registry = owned(accounts, a.registry, G, 81)
  check(policy.version === 2 && policy.fee_model === 2 && policy.protocol_share_bps === 2500
    && policy.creator_fee_bps === r.creatorFeeBps && approvedCreatorFees(profile).includes(r.creatorFeeBps) && str(policy.mint) === r.mint && policy.cap_bps === r.capBps && n(policy.initial_supply) > 0n
    && str(policy.quote_mint) === profile.quoteMint && policy.lp_fee_bps === 0, 'Max-wallet policy binding differs')
  const cap = n(policy.initial_supply) * BigInt(r.capBps) / 10000n
  check(cap > 0n && registry.equals(Buffer.concat([Buffer.from('02daf6662c38c0cd01020000000000', 'hex'), kb(a.policy), Buffer.from([0, 0]), kb(a.launch)])), 'Cap or exact max-wallet registry differs')
  const selected = decoded(launch, 'LaunchConfig', owned(accounts, r.selectedConfig, L, 176))
  check(selected.version === 1 && selected.custom_hook && str(selected.custom_hook) === G && selected.creator_fee_bps === r.creatorFeeBps
    && selected.author_share_bps === 0 && Buffer.byteLength(selected.label) <= 32 && selected.custom_hook_flags === 1 && selected.reserved.every(v => v === 0) && isDeepStrictEqual(selected.rules, noRules), 'Selected no-rules policy differs')
  const state = decoded(launch, 'Launch', owned(accounts, a.launch, L, 565)), pool = decoded(swap, 'Pool', owned(accounts, a.pool, S, 411))
  check(state.version === 1 && state.bump === bump(L, 'launch', kb(r.mint)) && str(state.mint) === r.mint && str(state.pool) === a.pool
    && str(state.quote_mint) === profile.quoteMint && str(state.config) === r.selectedConfig && str(state.creator) === str(selected.creator)
    && state.status === 0 && state.graduated_at.isZero() && state.custom_hook && str(state.custom_hook) === G && state.custom_hook_flags === 1
    && state.modules === 0 && state.creator_fee_bps === r.creatorFeeBps && state.author_share_bps === 0 && state.lp_fee_bps === 0 && state.sniper_window_secs.isZero() && state.sniper_start_bps === 0
    && isDeepStrictEqual(state.rules, noRules) && state.reserved.every(v => v === 0) && str(state.kit_config) === a.kitConfig && str(state.holder_vault) === a.holderVault
    && str(state.reserve_holding) === a.launchReserve && str(state.quote_holding) === a.launchQuote && str(state.lp_holding) === a.launchLp
    && n(state.curve_tokens) + n(state.reserve_tokens) === n(policy.initial_supply) && state.kit_caller_bump === 0
    && ['creator_unlock_at', 'early_window_end', 'early_unlock_at', 'graduation_topup', 'graduation_burned', 'holder_fees_accrued', 'burned_on_trades', 'author_fees_paid'].every(k => state[k].isZero()), 'Launch is not the canonical pre-graduation max-wallet candidate')
  if (canary) check(str(state.creator) === r.trader, 'Canary trader must be the launch creator')
  check(pool.version === 1 && pool.bump === bump(S, 'pool', kb(r.mint), kb(profile.quoteMint), enc(0, 2), kb(L)) && pool.lp_mint_bump === bump(S, 'lp', kb(a.pool))
    && str(pool.base_mint) === r.mint && str(pool.quote_mint) === profile.quoteMint && str(pool.lp_mint) === a.lpMint && str(pool.base_vault) === a.baseVault
    && str(pool.quote_vault) === a.quoteVault && pool.hook_program && str(pool.hook_program) === L && pool.hook_flags === 1985
    && pool.hook_signer_bump === bump(S, 'hook-authority', kb(L)) && pool.curve && pool.lp_supply.isZero() && str(pool.creator) === a.launch
    && pool.lp_fee_bps === 0 && pool.protocol_fee_bps === 0 && pool.protocol_share_bps === 2500 && pool.fee_model === 2
    && pool.reserved.every(v => v === 0) && n(pool.virtual_base) === n(state.virtual_base) && n(pool.virtual_quote) === n(state.virtual_quote), 'Pool binding or inclusive-fee curve policy differs')
  if (canary) check(n(pool.swap_count) === (r.side === 'buy' ? 0n : 1n), 'Canary permits only the first buy and its single sell')
  const mint = typed(gate, 'Mint', owned(accounts, r.mint, T, 519)), quote = typed(gate, 'Mint', owned(accounts, profile.quoteMint, T, 519))
  for (const m of [mint, quote]) check(Buffer.byteLength(m.name) <= 32 && Buffer.byteLength(m.symbol) <= 10 && Buffer.byteLength(m.uri) <= 200, 'Mint metadata size differs')
  check(mint.version === 1 && !mint.mint_authority && !mint.freeze_authority && !mint.hook_authority && !mint.metadata_authority
    && mint.hook_program && str(mint.hook_program) === G && mint.hook_flags === 1 && mint.hook_signer_bump === bump(T, 'hook-authority', kb(G))
    && n(mint.max_supply) === n(policy.initial_supply) && n(mint.supply) <= n(policy.initial_supply) && mint.reserved.every(v => v === 0), 'Base mint immutable max-wallet binding differs')
  check(quote.version === 1 && !quote.hook_program && quote.hook_flags === 0 && !quote.freeze_authority && !quote.hook_authority
    && quote.hook_signer_bump === 0 && quote.reserved.every(v => v === 0), 'Quote mint hook or freeze differs')
  const lpMint = typed(gate, 'Mint', owned(accounts, a.lpMint, T, 519))
  check(lpMint.version === 1 && lpMint.supply.isZero() && lpMint.mint_authority && str(lpMint.mint_authority) === a.pool && !lpMint.hook_program
    && lpMint.hook_flags === 0 && !lpMint.freeze_authority && !lpMint.hook_authority && lpMint.hook_signer_bump === 0 && lpMint.reserved.every(v => v === 0), 'LP mint binding differs')
  const holding = {}
  for (const [name, mintKey, owner] of [['baseVault', r.mint, a.pool], ['quoteVault', profile.quoteMint, a.pool], ['launchQuote', profile.quoteMint, a.launch],
    ['launchReserve', r.mint, a.launch], ['launchLp', a.lpMint, a.launch], ['traderBase', r.mint, r.side === 'buy' ? r.recipient : r.trader], ['traderQuote', profile.quoteMint, r.side === 'buy' ? r.trader : r.recipient]]) {
    holding[name] = readHolding(accounts, a[name], T, mintKey, owner)
  }
  check(holding.baseVault === n(pool.base_reserve) && holding.quoteVault === n(pool.quote_reserve) + n(pool.protocol_fees_quote)
    && n(state.creator_fees_accrued) >= n(state.creator_fees_claimed)
    && holding.launchQuote === n(state.creator_fees_accrued) - n(state.creator_fees_claimed)
    && holding.launchReserve === n(state.reserve_tokens) && holding.launchLp === 0n, 'Vault and reserve balances differ')
  const poolRegistry = owned(accounts, a.poolRegistry, L, 186)
  const expectedPoolRegistry = Buffer.concat([Buffer.from('02daf6662c38c0cd01040000000101', 'hex'), kb(L), Buffer.from('0200000000060000006c61756e636801020101', 'hex'), kb(T),
    Buffer.from('030000000007000000686f6c64696e67010301050100', 'hex'), kb(a.holderVault), Buffer.from([0, 0]), kb(a.kitConfig)])
  check(poolRegistry.equals(expectedPoolRegistry), 'Pool registry exact callback bindings differ')
  const feePolicy = readInclusiveFeePolicy({ ...accounts.get(a.inclusiveFeePolicy),
    data: owned(accounts, a.inclusiveFeePolicy, S, 75), signer: false, writable: false }, S, a.pool)
  const amount = BigInt(r.amountIn), buy = r.side === 'buy', maxU64 = (1n << 64n) - 1n, maxU128 = (1n << 128n) - 1n
  check(amount <= holding[buy ? 'traderQuote' : 'traderBase'], 'Input exceeds source holding')
  const quoteResult = modelInclusiveCreatorQuote({ side: r.side, amountIn: amount, minAmountOut: BigInt(r.minAmountOut),
    maxInput: BigInt(r.maxInput), creatorFeeBps: r.creatorFeeBps, feeModel: 2, protocolShareBps: 2500,
    lpFeeBps: 0, flatProtocolFeeBps: 0, sniperWindowSecs: 0, sniperStartBps: 0, quoteHook: 'none', modules: 0,
    authorShareBps: 0, rules: 'none', rewards: false, recipientBaseBalance: holding.traderBase,
    pool: { baseReserve: n(pool.base_reserve), quoteReserve: n(pool.quote_reserve), virtualBase: n(pool.virtual_base),
      virtualQuote: n(pool.virtual_quote), protocolFeesQuote: n(pool.protocol_fees_quote) },
    policy: { version: 2, feeModel: 2, protocolShareBps: 2500, creatorFeeBps: policy.creator_fee_bps,
      lpFeeBps: 0, initialSupply: n(policy.initial_supply), capBps: policy.cap_bps } })
  const delivered = quoteResult.delivered, impact = quoteResult.priceImpactBps
  check(impact <= BigInt(r.maxPriceImpactBps), 'Price impact exceeds explicit bound')
  const after = { ...quoteResult.after, traderBase: holding.traderBase + (buy ? delivered : -amount),
    traderQuote: holding.traderQuote + (buy ? -amount : delivered), swapCount: n(pool.swap_count) + 1n,
    launchQuote: holding.launchQuote + quoteResult.fees.creatorQuote,
    quoteVault: holding.quoteVault + quoteResult.quoteVaultDelta,
    creatorFeesAccrued: n(state.creator_fees_accrued) + quoteResult.fees.creatorQuote }
  check(Object.values(after).every(v => v >= 0n && v <= maxU64)
    && n(pool.base_volume) + (buy ? quoteResult.grossOutput : amount) <= maxU128
    && n(pool.quote_volume) + (buy ? amount - quoteResult.fees.creatorQuote : quoteResult.grossOutput) <= maxU128,
    'Post-swap arithmetic overflow')
  check(n(pool.quote_reserve) < n(state.graduation_quote) && after.quoteReserve < n(state.graduation_quote), 'Graduation boundary is outside this bounded swap adapter')
  const slot = Math.max(...obs.map(o => o.slot))
  check(bh.genesisHash === profile.genesisHash && isDeepStrictEqual(bh.providers, envelope.providers) && l.nowMs >= bh.observedAtMs
    && l.nowMs - bh.observedAtMs <= l.maxAgeMs && bh.currentBlockHeight <= bh.lastValidBlockHeight && bh.lastValidBlockHeight - bh.currentBlockHeight <= 150
    && bh.observedSlot >= slot && bh.observedSlot - slot <= l.maxSlotLag && bh.observedSlot <= l.validUntilSlot && l.validUntilSlot - slot <= 150
    && l.reviewExpiresAtMs > l.nowMs && l.reviewExpiresAtMs - l.nowMs <= l.maxAgeMs, 'Review blockhash or offchain lifetime differs')
  check(BigInt(accounts.get(r.feePayer).lamports) >= BigInt(bh.networkFeeLamports), 'Fee payer funds insufficient')
  const data = swap.coder.instruction.encode('swap', { args: { direction: buy ? 1 : 0, amount_in: bn(amount), min_amount_out: bn(r.minAmountOut),
    in_hook_accounts: buy ? 0 : 4, out_hook_accounts: buy ? 4 : 0, hook_data: Buffer.alloc(0) } })
  const instruction = new TransactionInstruction({ programId: pk(S), keys: metas, data })
  const tables = lookupTable ? [new AddressLookupTableAccount({ key: pk(lookupTable.address), state: AddressLookupTableAccount.deserialize(raw(lookupTable.dataBase64, 8248)) })] : []
  if (lookupTable) {
    const b = raw(lookupTable.dataBase64, 8248), state = tables[0].state
    check(sha(b) === lookupTable.sha256 && b.length >= 56 && (b.length - 56) % 32 === 0 && b.readUInt32LE() === 1 && [0, 1].includes(b[21])
      && (b[21] === 1 ? b.subarray(54, 56).every(v => v === 0) : b.subarray(22, 56).every(v => v === 0))
      && state.lastExtendedSlotStartIndex <= state.addresses.length && new Set(state.addresses.map(str)).size === state.addresses.length, 'Lookup table hash, canonical state or addresses differ')
  }
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: l.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) })]
  const instructions = [...budget, ...(canary ? [transition.open, instruction, transition.close] : [instruction])]
  const message = new TransactionMessage({ payerKey: pk(r.feePayer), recentBlockhash: bh.blockhash, instructions }).compileToV0Message(tables)
  check(!lookupTable || message.addressTableLookups.length === 1, 'Unused lookup table')
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables }), bytes = message.serialize(), priority = (BigInt(l.computeUnitLimit) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(BigInt(bh.networkFeeLamports) === BigInt(message.header.numRequiredSignatures) * BigInt(bh.lamportsPerSignature) + priority, 'Network fee differs from explicit signature fee basis')
  const review = { schema: 'hooklab-message-review/1', operation: `${canary ? 'canary-' : ''}inclusive-max-wallet-${r.side}${fixture ? '-fixture' : ''}`, genesisHash: profile.genesisHash, profileSha256: envelope.expectedSha256,
    policySha256: sha(JSON.stringify(obs)), intentSha256: sha(JSON.stringify(r)), payer: r.feePayer, wallet: r.trader, messageBase64: Buffer.from(bytes).toString('base64'), messageSha256: sha(bytes),
    requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(str), accounts: Array.from({ length: keys.length }, (_, i) => ({ address: str(keys.get(i)), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: lookupTable ? [lookupTable] : [], observedSlot: slot, validUntilSlot: l.validUntilSlot, observedAtMs: l.nowMs, reviewExpiresAtMs: l.reviewExpiresAtMs,
    lastValidBlockHeight: bh.lastValidBlockHeight, baseFeeLamports: String(BigInt(bh.networkFeeLamports) - priority), maxFeeLamports: l.maxNetworkFeeLamports,
    instructionDebitLamports: '0', maxNativeDebitLamports: l.maxTotalDebitLamports }
  const inspected = inspectHookLabMessage(review), signers = new Set([r.trader, r.feePayer, ...(canary ? [transition.admin] : [])])
  const writable = new Set([r.feePayer, ...metas.filter(m => m.isWritable).map(m => str(m.pubkey)), ...(canary ? [a.swapConfig, a.swapGovernance] : [])])
  check(inspected.instructions.length === (canary ? 5 : 3) && review.accounts.every(a => a.signer === signers.has(a.address) && a.writable === writable.has(a.address)), 'Compiled swap privileges differ')
  const canonicalInstruction = { program: S, dataHex: data.toString('hex'), accounts: metas.map(m => ({ address: str(m.pubkey), signer: m.isSigner, writable: m.isWritable })) }
  const canonical = instructions.map(ix => ({ program: str(ix.programId), dataHex: ix.data.toString('hex'), accounts: ix.keys.map(m => review.accounts.find(a => a.address === str(m.pubkey))) }))
  check(isDeepStrictEqual(inspected.instructions, canonical), 'Effective swap envelope metas differ')
  return freeze({ schema: canary ? 'repoing/canary-inclusive-max-wallet-swap-review/1' : 'repoing/inclusive-max-wallet-swap-review/1', status: fixture ? 'offline-synthetic-review-only' : 'deterministic-review-not-authorization', provenance, request: r, releaseProfileSha256: envelope.expectedSha256,
    sourceCommit: profile.sourceCommit, sourcePatchSha256: profile.sourcePatchSha256, addresses: a, review, canonicalInstruction, instructions: inspected.instructions,
    ...(canary ? { canary: transition.evidence } : {}),
    quote: { delivered: String(delivered), minAmountOut: r.minAmountOut, capRaw: String(cap), priceImpactBps: String(impact), lpFee: '0', protocolFee: String(quoteResult.fees.platformQuote),
      grossCreatorFee: String(quoteResult.fees.grossQuote), netCreatorFee: String(quoteResult.fees.creatorQuote),
      feeModel: 2, protocolShareBps: 2500, creatorFeeBps: r.creatorFeeBps, platformCollector: feePolicy.collector,
      after: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, String(v)])) },
    onchainExactInputAndMinimumOutput: true, onchainDeadlineEnforced: false, onchainEconomicsGuard: false, productionReceipt: null,
    artifactAdopted: false, deploymentAdopted: false, policyApproved: false, executionAuthorized: false, publicExecutionEnabled: false,
    feeEvidenceAuthenticated: false, dependencyCodeAuthenticated: false, canSign: false, canSubmit: false, canRetry: false })
}
