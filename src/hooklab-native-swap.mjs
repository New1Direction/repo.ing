// Native-SOL swap_v2 compiler for Hooks coins whose pool and launch both carry the native flag (hook-lab feat/native-sol
// e357fdf; docs/native-sol-port-design.md §3.3-3.5 and §4.6). The quote is lamports on the pool PDA, so one approval
// covers a trade: no Add SOL step. Deterministic only: the server's two-provider collector supplies finalized state,
// and the exact review it returns authorizes nothing until the signing lifecycle takes it.
// Inclusive fee, as the bridged path: G = ceil(x*b/1e4), P = floor(G/4) stays in the pool, N = G - P to the launch PDA.
//   buy  T -> L N, T -> pool A - N, curve input A - G     sell  pool -> L N, pool -> R out - G, P held
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
import { approvedCreatorFees } from './hooklab-launch-menus.mjs'
import { hookCoinAddresses, swapAccountEvidence } from './hooklab-inclusive-max-wallet-swap.mjs'
import { NATIVE_ELF, NATIVE_FLAGS, NATIVE_IDL_SHA256, loadNativeArtifacts } from './hooklab-native-pins.mjs'
import { STATUS_GRADUATED, finalFillLamports, isReady } from './hooklab-graduation.mjs'
import { loadArtifacts } from './hooklab-owner-driver/artifacts.mjs'
import { createHolding, graduateHookCoin } from './hooklab-owner-driver/instructions.mjs'

const { raw, owned, decoded, programEvidence, governance, typed, readHolding, KIT, noRules } = swapAccountEvidence
const check = (value, message) => { if (!value) throw Error(message) }
// Refusals about the trader's own trade, in words the signing lifecycle may show them (everything else stays masked).
const refuseUnless = (value, message) => { if (!value) throw Object.assign(Error(message), { code: 'HOOKLAB_USER_REFUSAL' }) }
const CURVE_CHANGED = 'This coin’s curve changed since you picked the amount. Check it and try again.'
const QUOTE_REFUSALS = { MAX_WALLET: 'That would put you over this coin’s max per wallet.', MIN_OUTPUT: 'Price moved too much for this amount.' }
const sha = value => createHash('sha256').update(value).digest('hex')
const hash = (...values) => createHash('sha256').update(Buffer.concat(values.map(v => Buffer.from(v)))).digest()
const pk = value => new PublicKey(value), kb = value => pk(value).toBuffer(), str = value => value.toBase58()
const pda = (program, ...seeds) => str(PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[0])
const bump = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[1]
const n = value => BigInt(value.toString(10)), bn = value => new BN(String(value), 10)
const zero = '11111111111111111111111111111111', loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const lookupOwner = 'AddressLookupTab1e1111111111111111111111111'
export const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111'
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111', HOLDING_LEN = 204, POOL_LEN = 411, LAUNCH_LEN = 565
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const provider = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const positive = u64.refine(v => BigInt(v) > 0n)

// graduate: this buy is the curve's exact final fill and the same transaction graduates the coin.
export const nativeSwapRequestSchema = z.object({ schema: z.literal('repoing/native-swap-request/1'),
  policyKind: z.literal('max-wallet'), policyVersion: z.literal(2), creatorFeeBps: number.max(9999), feeModel: z.literal(2), protocolShareBps: z.literal(2500), capBps: number.min(1).max(9999),
  side: z.enum(['buy', 'sell']), trader: key, mint: key, selectedConfig: key,
  amountIn: positive, minAmountOut: positive, maxInput: positive, maxPriceImpactBps: number.max(1000), graduate: z.boolean(),
}).strict().refine(r => !r.graduate || r.side === 'buy', 'Only a buy graduates a coin')
const accountSchema = z.object({ address: key, owner: key, executable: z.boolean(), dataBase64: z.string().max(14000000), lamports: u64 }).strict()
const inputSchema = z.object({ profile: z.object({ json: z.string().max(16384), expectedSha256: digest,
  idls: z.object({ launch: z.string().max(1500000), swap: z.string().max(1500000), gate: z.string().max(1500000) }).strict(),
  elfLengths: z.object({ launch: number.positive().max(10485760), swap: number.positive().max(10485760), gate: number.positive().max(10485760) }).strict(),
  providers: z.array(provider).length(2).refine(v => new Set(v).size === 2) }).strict(), request: nativeSwapRequestSchema,
  provenance: z.literal('server-collected-finalized-state-not-execution-authorization'),
  observations: z.array(z.object({ provider, genesisHash: key, commitment: z.literal('finalized'), slot: number, observedAtMs: number,
    accounts: z.array(z.object({ address: key, account: accountSchema.nullable() }).strict()).min(20).max(64) }).strict()).length(2),
  recentBlockhash: z.object({ blockhash: key, genesisHash: key, providers: z.array(provider).length(2), observedAtMs: number,
    currentBlockHeight: number, blockhashValid: z.literal(true), lastValidBlockHeight: number.positive(), observedSlot: number,
    networkFeeLamports: u64, lamportsPerSignature: u64.refine(v => BigInt(v) > 0n) }).strict(),
  lookupTable: z.object({ address: key, owner: z.literal(lookupOwner), dataBase64: z.string().max(22000), sha256: digest }).strict().nullable(),
  // maxTotalDebitLamports bounds everything the payer loses: fees, the buy's lamports and a new coin holding's rent.
  limits: z.object({ nowMs: number, maxAgeMs: number.positive().max(60000), maxSlotLag: number.max(150), validUntilSlot: number,
    reviewExpiresAtMs: number, maxNetworkFeeLamports: u64, maxTotalDebitLamports: u64,
    computeUnitLimit: number.positive().max(1400000), computeUnitPriceMicroLamports: u64 }).strict(),
}).strict()

// The coin's accounts as the bridged compiler derives them, plus the trader's coin holding and graduate's own signers.
function nativeAddresses(profile, r) {
  const { launch: L, token: T } = profile.programs
  return { ...hookCoinAddresses(profile, r.mint), traderBase: pda(T, 'holding', kb(r.mint), kb(r.trader)),
    launchHookSigner: pda(L, 'hook-authority'), tokenKitHookSigner: pda(T, 'hook-authority', kb(KIT)), launchEventAuthority: pda(L, '__event_authority') }
}
/** Every account a native trade reads, including absences and the rent sysvar; callers return exactly these rows. */
export function nativeSwapInventory(profileInput, requestInput) {
  const profile = parseInclusiveMaxWalletProfile(profileInput), r = nativeSwapRequestSchema.parse(requestInput), a = nativeAddresses(profile, r)
  const { launch, swap, gate, token } = profile.programs
  return [...new Set([launch, swap, gate, token, r.trader, r.mint, profile.quoteMint, r.selectedConfig, RENT_SYSVAR, ...Object.values(a)])].sort()
}

// swap_v2 in the reviewed IDL's account order (hook-lab swap.rs SwapV2, client.rs swap_v2): trader_quote is the
// trader on both sides here (a buy pays from the wallet, a sell pays the wallet). Remaining: the base mint's gate slice,
// the launch's pool-hook extras, the InclusiveFeePolicy last (as native_launch.rs builds it).
export function nativeSwapV2Instruction({ programs, quoteMint }, { side, trader, mint, amountIn, minAmountOut }) {
  const { launch: L, swap: S, gate: G, token: T } = programs, a = hookCoinAddresses({ programs, quoteMint }, mint), buy = side === 'buy'
  const { idls, coders } = loadNativeArtifacts(), abi = idls.swap.instructions.find(ix => ix.name === 'swap_v2')
  const meta = (address, writable = false, signer = false) => ({ pubkey: pk(address), isWritable: writable, isSigner: signer })
  const fixed = [meta(trader, true, true), meta(a.swapConfig), meta(a.pool, true), meta(mint), meta(quoteMint), meta(a.baseVault, true),
    meta(pda(T, 'holding', kb(mint), kb(trader)), true), meta(trader, true), meta(L), meta(a.swapHookSigner), meta(T), meta(a.tokenEventAuthority),
    meta(zero), meta(a.swapEventAuthority), meta(S)]
  const names = ['trader', 'config', 'pool', 'base_mint', 'quote_mint', 'base_vault', 'trader_base', 'trader_quote', 'hook_program', 'hook_signer',
    'token_program', 'token_event_authority', 'system_program', 'event_authority', 'program']
  check(abi && isDeepStrictEqual(abi.accounts.map(x => x.name), names) && Buffer.from(abi.discriminator).equals(hash('global:swap_v2').subarray(0, 8))
    && abi.accounts.every((x, i) => !!x.signer === fixed[i].isSigner && !!x.writable === fixed[i].isWritable && (!x.address || x.address === str(fixed[i].pubkey))), 'swap_v2 ABI differs')
  const remaining = [meta(G), meta(a.gateHookSigner), meta(a.policy), meta(a.launch), meta(a.launch, true), meta(a.launchQuote, true), meta(a.holderVault, true), meta(a.kitConfig), meta(a.inclusiveFeePolicy)]
  const data = coders.swap.instruction.encode('swap_v2', { args: { direction: buy ? 1 : 0, amount_in: bn(amountIn), min_amount_out: bn(minAmountOut),
    in_hook_accounts: buy ? 0 : 4, out_hook_accounts: buy ? 4 : 0, hook_data: Buffer.alloc(0) } })
  return new TransactionInstruction({ programId: pk(S), keys: [...fixed, ...remaining], data })
}

// Whether a profile envelope names the reviewed native builds: their ELFs and the exact vendored IDL bytes. The compiler
// refuses any other, and the trade runtime keeps native trading off without it (before the programs are upgraded).
export function pinsNativeBuilds(envelope) {
  try {
    const profile = JSON.parse(envelope.json)
    return ['swap', 'launch'].every(role => profile.elfSha256?.[role] === NATIVE_ELF[role].sha256 && envelope.elfLengths?.[role] === NATIVE_ELF[role].length
      && profile.idlSha256?.[role] === NATIVE_IDL_SHA256[role] && sha(raw(envelope.idls[role], 1100000)) === NATIVE_IDL_SHA256[role])
  } catch { return false }
}

// Rent::minimum_balance from the observed sysvar, as every program in the transaction computes it.
function rentFrom(account) {
  check(account && account.owner === SYSVAR_OWNER && !account.executable, 'Rent sysvar differs')
  const b = raw(account.dataBase64, 17), perByte = b.readBigUInt64LE(0), threshold = b.readDoubleLE(8)
  check(b.length === 17 && perByte > 0n && perByte < 1000000n && Number.isFinite(threshold) && threshold > 0 && threshold <= 4, 'Rent sysvar differs')
  return length => BigInt(Math.floor(Number(BigInt(128 + length) * perByte) * threshold))
}
const lamportsOf = (accounts, address) => BigInt(accounts.get(address).lamports)

export function compileNativeSwapReview(input) {
  const { profile: envelope, request: r, provenance, observations: obs, recentBlockhash: bh, lookupTable, limits: l } = inputSchema.parse(input)
  check(sha(envelope.json) === envelope.expectedSha256, 'Reviewed profile digest differs')
  const profile = parseInclusiveMaxWalletProfile(JSON.parse(envelope.json)), { launch: L, swap: S, gate: G, token: T } = profile.programs
  check(new Set([...Object.values(profile.programs), profile.quoteMint, zero, KIT]).size === 8, 'Profile program roles alias')
  check(pinsNativeBuilds(envelope), 'Profile does not pin the reviewed native builds')
  const gateBytes = raw(envelope.idls.gate, 1100000)
  check(sha(gateBytes) === profile.idlSha256.gate, 'IDL digest differs')
  const { idls, coders } = loadNativeArtifacts(), launch = { idl: idls.launch, coder: coders.launch }, swap = { idl: idls.swap, coder: coders.swap }
  const gateIdl = JSON.parse(gateBytes), gate = { idl: gateIdl, coder: new BorshCoder(gateIdl) }
  check(gateIdl.address === G, 'IDL identity differs')
  // graduateHookCoin is pinned to the current launch IDL; the native build keeps graduate byte for byte.
  check(isDeepStrictEqual(idls.launch.instructions.find(ix => ix.name === 'graduate'), loadArtifacts().idls.launch.instructions.find(ix => ix.name === 'graduate')), 'graduate ABI differs')
  for (const name of ['before_swap_inclusive_v1', 'after_swap_inclusive_v1']) {
    const callback = idls.launch.instructions.find(ix => ix.name === name)
    check(callback && Buffer.from(callback.discriminator).equals(hash(`global:${name}`).subarray(0, 8)) && callback.args.length === 1
      && callback.args[0].type?.defined?.name === 'PoolHookArgsInclusiveV1', 'Versioned inclusive callback ABI differs')
  }
  const a = nativeAddresses(profile, r), inventory = nativeSwapInventory(profile, r), buy = r.side === 'buy'
  check(new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => envelope.providers.includes(o.provider)), 'Provider binding differs')
  check(Math.abs(obs[0].slot - obs[1].slot) <= l.maxSlotLag && isDeepStrictEqual(obs[0].accounts, obs[1].accounts), 'Swap state observations disagree')
  for (const o of obs) check(o.genesisHash === profile.genesisHash && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale or wrong-chain swap observation')
  const accounts = new Map(obs[0].accounts.map(x => { check(!x.account || x.address === x.account.address, 'Account identity differs'); return [x.address, x.account] }))
  check(accounts.size === obs[0].accounts.length && isDeepStrictEqual([...accounts.keys()].sort(), inventory), 'Incomplete, duplicate or extra swap inventory')
  const roles = [...Object.values(a), ...Object.values(profile.programs), profile.quoteMint, r.mint, r.selectedConfig, zero, KIT, RENT_SYSVAR, ComputeBudgetProgram.programId.toBase58()]
  check(new Set(roles).size === roles.length && !roles.includes(r.trader) && PublicKey.isOnCurve(kb(r.trader)), 'Swap role alias or invalid wallet')
  check(!lookupTable || ![...inventory, ...roles].includes(lookupTable.address), 'Lookup table aliases a swap role')
  for (const o of obs) for (const role of ['launch', 'swap', 'gate']) programEvidence(accounts, profile.programs[role], profile.elfSha256[role], envelope.elfLengths[role], o.slot, role === 'gate')
  const token = accounts.get(T), tokenBytes = token && raw(token.dataBase64, 36)
  check(token?.owner === loader && token.executable && tokenBytes.length === 36 && tokenBytes.readUInt32LE() === 2 && tokenBytes.subarray(4).equals(kb(pda(loader, kb(T)))), 'Token ProgramData linkage differs')
  const wallet = accounts.get(r.trader)
  check(wallet && wallet.owner === zero && !wallet.executable && raw(wallet.dataBase64, 0).length === 0, 'Wallet must be an empty system account')
  for (const name of ['kitConfig', 'holderVault']) check(accounts.get(a[name]) === null, 'No-Kit account unexpectedly initialized')
  const rent = rentFrom(accounts.get(RENT_SYSVAR))
  const configBytes = owned(accounts, a.launchConfig, L, 250), c = decoded(launch, 'Config', configBytes), d = decoded(swap, 'Config', owned(accounts, a.swapConfig, S, 189))
  // Config.reserved[0] is the native-launches switch (byte 186): either value trades, it only steers new launches.
  check(c.version === 1 && d.version === 1 && c.bump === bump(L, 'config') && d.bump === bump(S, 'config') && !d.paused
    && configBytes[NATIVE_FLAGS.configNativeLaunches] === c.reserved[0] && [0, 1].includes(c.reserved[0]) && c.reserved.slice(1).every(v => v === 0)
    && d.reserved.every(v => v === 0), 'Configuration version, reserved or trading pause differs')
  check(str(c.quote_mint) === profile.quoteMint && str(c.treasury) === str(d.treasury)
    && c.lp_fee_bps === 0 && c.sniper_window_secs.isZero() && c.sniper_start_bps === 0 && d.protocol_fee_bps === 0 && d.launch_protocol_share_bps === 2500, 'Only reviewed inclusive-fee configuration is supported')
  const lg = decoded(launch, 'Governance', owned(accounts, a.launchGovernance, L, 348)), sg = decoded(swap, 'Governance', owned(accounts, a.swapGovernance, S, 348))
  governance(launch, 'launch', L, a.launchConfig, c, lg, profile.genesisHash, false); governance(swap, 'swap', S, a.swapConfig, d, sg, profile.genesisHash, false)
  const policy = decoded(gate, 'PolicyV2', owned(accounts, a.policy, G, 90)), registry = owned(accounts, a.registry, G, 81)
  check(policy.version === 2 && policy.fee_model === 2 && policy.protocol_share_bps === 2500
    && policy.creator_fee_bps === r.creatorFeeBps && approvedCreatorFees(profile).includes(r.creatorFeeBps) && str(policy.mint) === r.mint && policy.cap_bps === r.capBps && n(policy.initial_supply) > 0n
    && str(policy.quote_mint) === profile.quoteMint && policy.lp_fee_bps === 0, 'Max-wallet policy binding differs')
  const cap = n(policy.initial_supply) * BigInt(r.capBps) / 10000n
  check(cap > 0n && registry.equals(Buffer.concat([Buffer.from('02daf6662c38c0cd01020000000000', 'hex'), kb(a.policy), Buffer.from([0, 0]), kb(a.launch)])), 'Cap or exact max-wallet registry differs')
  const selected = decoded(launch, 'LaunchConfig', owned(accounts, r.selectedConfig, L, 176))
  check(selected.version === 1 && selected.custom_hook && str(selected.custom_hook) === G && selected.creator_fee_bps === r.creatorFeeBps
    && selected.author_share_bps === 0 && Buffer.byteLength(selected.label) <= 32 && selected.custom_hook_flags === 1 && selected.reserved.every(v => v === 0) && isDeepStrictEqual(selected.rules, noRules), 'Selected no-rules policy differs')
  const launchBytes = owned(accounts, a.launch, L, LAUNCH_LEN), poolBytes = owned(accounts, a.pool, S, POOL_LEN)
  const state = decoded(launch, 'Launch', launchBytes), pool = decoded(swap, 'Pool', poolBytes), graduated = state.status === STATUS_GRADUATED
  // Both native flags, read from the bytes the programs read (pool 351, launch 560: both carry a custom hook).
  check(poolBytes[NATIVE_FLAGS.pool] === 1 && pool.reserved[0] === 1 && pool.reserved.slice(1).every(v => v === 0)
    && launchBytes[NATIVE_FLAGS.launch] === 1 && state.reserved[17] === 1 && state.reserved.every((v, i) => i === 17 || v === 0), 'Coin is not a native-SOL coin')
  check(state.version === 1 && state.bump === bump(L, 'launch', kb(r.mint)) && str(state.mint) === r.mint && str(state.pool) === a.pool
    && str(state.quote_mint) === profile.quoteMint && str(state.config) === r.selectedConfig && str(state.creator) === str(selected.creator)
    && [0, STATUS_GRADUATED].includes(state.status) && state.graduated_at.isZero() === !graduated && state.custom_hook && str(state.custom_hook) === G && state.custom_hook_flags === 1
    && state.modules === 0 && state.creator_fee_bps === r.creatorFeeBps && state.author_share_bps === 0 && state.lp_fee_bps === 0 && state.sniper_window_secs.isZero() && state.sniper_start_bps === 0
    && isDeepStrictEqual(state.rules, noRules) && str(state.kit_config) === a.kitConfig && str(state.holder_vault) === a.holderVault
    && str(state.reserve_holding) === a.launchReserve && str(state.quote_holding) === a.launchQuote && str(state.lp_holding) === a.launchLp && state.kit_caller_bump === 0
    && ['creator_unlock_at', 'early_window_end', 'early_unlock_at', 'holder_fees_accrued', 'burned_on_trades', 'author_fees_paid'].every(k => state[k].isZero()), 'Launch is not a canonical native max-wallet coin')
  check(pool.version === 1 && pool.bump === bump(S, 'pool', kb(r.mint), kb(profile.quoteMint), Buffer.alloc(2), kb(L)) && pool.lp_mint_bump === bump(S, 'lp', kb(a.pool))
    && str(pool.base_mint) === r.mint && str(pool.quote_mint) === profile.quoteMint && str(pool.lp_mint) === a.lpMint && str(pool.base_vault) === a.baseVault
    && str(pool.quote_vault) === a.quoteVault && pool.hook_program && str(pool.hook_program) === L && pool.hook_flags === 1985
    && pool.hook_signer_bump === bump(S, 'hook-authority', kb(L)) && str(pool.creator) === a.launch
    && pool.lp_fee_bps === 0 && pool.protocol_fee_bps === 0 && pool.protocol_share_bps === 2500 && pool.fee_model === 2, 'Pool binding or inclusive-fee policy differs')
  // finalize_curve counts 1000 LP units that are never minted (the pool's minimum liquidity), so a graduated pool's
  // lp_supply is the minted supply plus 1000, all of it in the launch's LP holding.
  const lpMint = typed(gate, 'Mint', owned(accounts, a.lpMint, T, 519))
  check(lpMint.version === 1 && n(lpMint.supply) === (graduated ? n(pool.lp_supply) - 1000n : 0n) && lpMint.mint_authority && str(lpMint.mint_authority) === a.pool && !lpMint.hook_program
    && lpMint.hook_flags === 0 && !lpMint.freeze_authority && !lpMint.hook_authority && lpMint.hook_signer_bump === 0 && lpMint.reserved.every(v => v === 0), 'LP mint binding differs')
  // On the curve: the launch's virtual offsets and no LP. Graduated: an open pool whose LP the launch holds for good.
  const holding = {}
  for (const [name, mintKey, owner] of [['baseVault', r.mint, a.pool], ['quoteVault', profile.quoteMint, a.pool], ['launchQuote', profile.quoteMint, a.launch],
    ['launchReserve', r.mint, a.launch], ['launchLp', a.lpMint, a.launch]]) holding[name] = readHolding(accounts, a[name], T, mintKey, owner)
  if (graduated) check(!pool.curve && pool.virtual_base.isZero() && pool.virtual_quote.isZero() && n(pool.lp_supply) > 1000n && holding.launchLp === n(lpMint.supply), 'Graduated pool state differs')
  else check(pool.curve && pool.lp_supply.isZero() && holding.launchLp === 0n && n(pool.virtual_base) === n(state.virtual_base) && n(pool.virtual_quote) === n(state.virtual_quote)
    && n(state.curve_tokens) + n(state.reserve_tokens) === n(policy.initial_supply) && holding.launchReserve === n(state.reserve_tokens)
    && state.graduation_topup.isZero() && state.graduation_burned.isZero(), 'Curve pool state differs')
  // The quote vault and the launch's bridged holding are unused on a native coin (whatever a donor sends them stays put).
  check(holding.baseVault === n(pool.base_reserve), 'Vault balance differs')
  const mint = typed(gate, 'Mint', owned(accounts, r.mint, T, 519)), quoteMint = typed(gate, 'Mint', owned(accounts, profile.quoteMint, T, 519))
  for (const m of [mint, quoteMint]) check(Buffer.byteLength(m.name) <= 32 && Buffer.byteLength(m.symbol) <= 10 && Buffer.byteLength(m.uri) <= 200, 'Mint metadata size differs')
  check(mint.version === 1 && !mint.mint_authority && !mint.freeze_authority && !mint.hook_authority && !mint.metadata_authority
    && mint.hook_program && str(mint.hook_program) === G && mint.hook_flags === 1 && mint.hook_signer_bump === bump(T, 'hook-authority', kb(G))
    && n(mint.max_supply) === n(policy.initial_supply) && n(mint.supply) <= n(policy.initial_supply) && mint.reserved.every(v => v === 0), 'Base mint immutable max-wallet binding differs')
  check(quoteMint.version === 1 && !quoteMint.hook_program && quoteMint.hook_flags === 0 && !quoteMint.freeze_authority && !quoteMint.hook_authority
    && quoteMint.hook_signer_bump === 0 && quoteMint.reserved.every(v => v === 0), 'Quote mint hook or freeze differs')
  const poolRegistry = owned(accounts, a.poolRegistry, L, 186)
  check(poolRegistry.equals(Buffer.concat([Buffer.from('02daf6662c38c0cd01040000000101', 'hex'), kb(L), Buffer.from('0200000000060000006c61756e636801020101', 'hex'), kb(T),
    Buffer.from('030000000007000000686f6c64696e67010301050100', 'hex'), kb(a.holderVault), Buffer.from([0, 0]), kb(a.kitConfig)])), 'Pool registry exact callback bindings differ')
  const feePolicy = readInclusiveFeePolicy({ ...accounts.get(a.inclusiveFeePolicy), data: owned(accounts, a.inclusiveFeePolicy, S, 75), signer: false, writable: false }, S, a.pool)
  // The native books: the pool's lamports cover rent and its reserve plus the platform's share (check_native).
  const poolLamports = lamportsOf(accounts, a.pool), launchLamports = lamportsOf(accounts, a.launch), walletLamports = lamportsOf(accounts, r.trader)
  check(poolLamports >= rent(POOL_LEN) + n(pool.quote_reserve) + n(pool.protocol_fees_quote) && launchLamports >= rent(LAUNCH_LEN), 'Native pool books differ from its lamports')
  const traderBaseAccount = accounts.get(a.traderBase), createsHolding = traderBaseAccount === null
  refuseUnless(!createsHolding || buy, 'This wallet holds none of this coin.')
  const traderBase = createsHolding ? 0n : readHolding(accounts, a.traderBase, T, r.mint, r.trader)
  const amount = BigInt(r.amountIn), maxU64 = (1n << 64n) - 1n, maxU128 = (1n << 128n) - 1n
  refuseUnless(buy || amount <= traderBase, 'You’re selling more than this wallet holds.')
  const p = { baseReserve: n(pool.base_reserve), quoteReserve: n(pool.quote_reserve), virtualBase: n(pool.virtual_base), virtualQuote: n(pool.virtual_quote), protocolFeesQuote: n(pool.protocol_fees_quote) }
  // A full curve waiting for graduate still takes sales (the swap allows them), never buys.
  refuseUnless(graduated || !buy || !isReady(p, n(state.graduation_quote)), 'This coin has finished its bonding curve and is graduating. Buying opens again once it moves to its open market.')
  // After graduation the gate reads Launch status 1 and stops capping, so the model lifts the cap only then.
  let q
  try {
    q = modelInclusiveCreatorQuote({ side: r.side, amountIn: amount, minAmountOut: BigInt(r.minAmountOut),
      maxInput: BigInt(r.maxInput), creatorFeeBps: r.creatorFeeBps, feeModel: 2, protocolShareBps: 2500,
      lpFeeBps: 0, flatProtocolFeeBps: 0, sniperWindowSecs: 0, sniperStartBps: 0, quoteHook: 'none', modules: 0,
      authorShareBps: 0, rules: 'none', rewards: false, recipientBaseBalance: traderBase, maxWalletLifted: graduated, pool: p,
      policy: { version: 2, feeModel: 2, protocolShareBps: 2500, creatorFeeBps: policy.creator_fee_bps, lpFeeBps: 0, initialSupply: n(policy.initial_supply), capBps: policy.cap_bps } })
  } catch (error) { refuseUnless(!QUOTE_REFUSALS[error?.message], QUOTE_REFUSALS[error?.message]); throw error }
  refuseUnless(q.priceImpactBps <= BigInt(r.maxPriceImpactBps), `That moves the price more than ${r.maxPriceImpactBps / 100}%. Try a smaller amount.`)
  const { grossQuote: gross, platformQuote: platform, creatorQuote: creator } = q.fees
  // Graduation: only the exact final fill finishes the curve, in the same transaction as graduate (design §4.6).
  const fill = graduated ? null : finalFillLamports({ graduated: false, graduationQuote: String(state.graduation_quote), creatorFeeBps: r.creatorFeeBps, pool: p })
  if (graduated) refuseUnless(!r.graduate, CURVE_CHANGED)
  else refuseUnless(r.graduate ? buy && fill !== null && amount === fill && isReady(q.after, n(state.graduation_quote)) : !buy || !isReady(q.after, n(state.graduation_quote)), CURVE_CHANGED)
  check(n(pool.base_volume) + (buy ? q.grossOutput : amount) <= maxU128 && n(pool.quote_volume) + (buy ? amount - creator : q.grossOutput) <= maxU128
    && q.after.quoteReserve + q.after.protocolFeesQuote <= maxU64, 'Post-swap arithmetic overflow')
  const slot = Math.max(...obs.map(o => o.slot))
  check(bh.genesisHash === profile.genesisHash && isDeepStrictEqual(bh.providers, envelope.providers) && l.nowMs >= bh.observedAtMs
    && l.nowMs - bh.observedAtMs <= l.maxAgeMs && bh.currentBlockHeight <= bh.lastValidBlockHeight && bh.lastValidBlockHeight - bh.currentBlockHeight <= 150
    && bh.observedSlot >= slot && bh.observedSlot - slot <= l.maxSlotLag && bh.observedSlot <= l.validUntilSlot && l.validUntilSlot - slot <= 150
    && l.reviewExpiresAtMs > l.nowMs && l.reviewExpiresAtMs - l.nowMs <= l.maxAgeMs, 'Review blockhash or offchain lifetime differs')
  const holdingRent = createsHolding ? rent(HOLDING_LEN) : 0n, fee = BigInt(bh.networkFeeLamports), debit = (buy ? amount : 0n) + holdingRent
  // The wallet stays rent-exempt: what it pays leaves at least an empty account's minimum, and a sale lands in a funded account.
  refuseUnless(walletLamports >= fee + debit + rent(0), 'You need a little more SOL for this trade, its network fee and your wallet’s minimum balance.')
  check(fee + debit <= BigInt(l.maxTotalDebitLamports), 'Payer debit exceeds its reviewed bound')
  const swapIx = nativeSwapV2Instruction(profile, { side: r.side, trader: r.trader, mint: r.mint, amountIn: amount, minAmountOut: r.minAmountOut })
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: l.computeUnitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) })]
  const instructions = [...budget, ...(createsHolding ? [createHolding(profile.programs, { payer: r.trader, mint: r.mint, owner: r.trader })] : []), swapIx,
    ...(r.graduate ? [graduateHookCoin(profile.programs, profile.quoteMint, { cranker: r.trader, mint: r.mint })] : [])]
  const tables = lookupTable ? [new AddressLookupTableAccount({ key: pk(lookupTable.address), state: AddressLookupTableAccount.deserialize(raw(lookupTable.dataBase64, 8248)) })] : []
  if (lookupTable) {
    const b = raw(lookupTable.dataBase64, 8248), s = tables[0].state
    check(sha(b) === lookupTable.sha256 && b.length >= 56 && (b.length - 56) % 32 === 0 && b.readUInt32LE() === 1 && [0, 1].includes(b[21])
      && (b[21] === 1 ? b.subarray(54, 56).every(v => v === 0) : b.subarray(22, 56).every(v => v === 0))
      && s.lastExtendedSlotStartIndex <= s.addresses.length && new Set(s.addresses.map(str)).size === s.addresses.length, 'Lookup table hash, canonical state or addresses differ')
  }
  const message = new TransactionMessage({ payerKey: pk(r.trader), recentBlockhash: bh.blockhash, instructions }).compileToV0Message(tables)
  check(!lookupTable || message.addressTableLookups.length === 1, 'Unused lookup table')
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables }), bytes = message.serialize()
  const priority = (BigInt(l.computeUnitLimit) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(fee === BigInt(message.header.numRequiredSignatures) * BigInt(bh.lamportsPerSignature) + priority, 'Network fee differs from explicit signature fee basis')
  const review = { schema: 'hooklab-message-review/1', operation: `native-max-wallet-${r.side}`, genesisHash: profile.genesisHash, profileSha256: envelope.expectedSha256,
    policySha256: sha(JSON.stringify(obs)), intentSha256: sha(JSON.stringify(r)), payer: r.trader, wallet: r.trader, messageBase64: Buffer.from(bytes).toString('base64'), messageSha256: sha(bytes),
    requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(str), accounts: Array.from({ length: keys.length }, (_, i) => ({ address: str(keys.get(i)), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: lookupTable ? [lookupTable] : [], observedSlot: slot, validUntilSlot: l.validUntilSlot, observedAtMs: l.nowMs, reviewExpiresAtMs: l.reviewExpiresAtMs,
    lastValidBlockHeight: bh.lastValidBlockHeight, baseFeeLamports: String(fee - priority), maxFeeLamports: l.maxNetworkFeeLamports,
    instructionDebitLamports: String(debit), maxNativeDebitLamports: String(fee + debit) }
  const inspected = inspectHookLabMessage(review)
  check(inspected.totalFeeLamports === String(fee) && review.requiredSigners.length === 1 && review.requiredSigners[0] === r.trader, 'Compiled payer or fee differs')
  const writable = new Set([r.trader, ...instructions.flatMap(ix => ix.keys.filter(m => m.isWritable).map(m => str(m.pubkey)))])
  check(inspected.instructions.length === instructions.length && review.accounts.every(x => x.signer === (x.address === r.trader) && x.writable === writable.has(x.address)), 'Compiled swap privileges differ')
  const canonical = instructions.map(ix => ({ program: str(ix.programId), dataHex: ix.data.toString('hex'), accounts: ix.keys.map(m => review.accounts.find(x => x.address === str(m.pubkey))) }))
  check(isDeepStrictEqual(inspected.instructions, canonical), 'Effective swap envelope metas differ')
  // Exact lamport movement of every account the trade pays or is paid by; nothing else may change.
  const lamportDeltas = { [r.trader]: buy ? -(fee + debit) : q.delivered - fee, [a.launch]: creator, [a.pool]: buy ? amount - creator : -(q.delivered + creator), ...(createsHolding ? { [a.traderBase]: holdingRent } : {}) }
  return freeze({ schema: 'repoing/native-swap-review/1', status: 'deterministic-review-not-authorization', provenance, request: r, releaseProfileSha256: envelope.expectedSha256,
    sourceCommit: profile.sourceCommit, addresses: a, review, instructions: inspected.instructions, graduated, graduates: r.graduate, createsHolding,
    quote: { delivered: String(q.delivered), minAmountOut: r.minAmountOut, capRaw: String(cap), capLifted: graduated, priceImpactBps: String(q.priceImpactBps), lpFee: '0',
      protocolFee: String(platform), grossCreatorFee: String(gross), netCreatorFee: String(creator), feeModel: 2, protocolShareBps: 2500, creatorFeeBps: r.creatorFeeBps,
      platformCollector: feePolicy.collector, holdingRentLamports: String(holdingRent), networkFeeLamports: String(fee), payerDebitLamports: String(fee + debit), graduates: r.graduate,
      after: { baseReserve: String(q.after.baseReserve), quoteReserve: String(q.after.quoteReserve), protocolFeesQuote: String(q.after.protocolFeesQuote), swapCount: String(n(pool.swap_count) + 1n),
        traderBase: String(traderBase + (buy ? q.delivered : -amount)), creatorFeesAccrued: String(n(state.creator_fees_accrued) + creator) } },
    lamportsBefore: Object.fromEntries(Object.keys(lamportDeltas).map(k => [k, String(accounts.get(k)?.lamports ?? 0)])),
    lamportDeltas: Object.fromEntries(Object.entries(lamportDeltas).map(([k, v]) => [k, String(v)])),
    onchainExactInputAndMinimumOutput: true, onchainDeadlineEnforced: false, productionReceipt: null, executionAuthorized: false, canSign: false, canSubmit: false })
}
