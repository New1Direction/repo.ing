// Client for repo.ing's Bundle launch program (programs/bundle-vault, docs/BUNDLE_LAUNCH.md): its addresses, instructions,
// accounts, errors, and the program's own math (fee routing, backer claims, vault policy) for pages and tests. The program id
// is the declare_id! of programs/bundle-vault/src/lib.rs. Nothing here checks the feature flag: src/bundle-launch.mjs does.
import { createHash } from 'node:crypto'
import BN from 'bn.js'
import { ComputeBudgetProgram, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'

export const BUNDLE_VAULT_PROGRAM_ID = new PublicKey('5feqSRaVwGcAdR6Fzf73K8sxunV8cTC9pjEBhfbRxHCw')
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

// Meteora's programs and their fixed accounts (the program checks the same addresses).
export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
export const DBC_EVENT_AUTHORITY = new PublicKey('8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF')
export const DAMM_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
export const DAMM_POOL_AUTHORITY = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC')
export const DAMM_EVENT_AUTHORITY = new PublicKey('3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet')

// The program's own constants (lib.rs).
export const BPS = 10_000
export const ACC_SCALE = 1_000_000_000_000_000_000n
export const MIN_LAUNCH_COOLDOWN_SECS = 180
export const MIN_LAUNCH_GRACE_SECS = 60
export const MAX_OPS_BPS = 2_000
export const MIN_TARGET = 1_000_000_000n
export const MAX_TARGET = 10_000_000_000_000n
export const MIN_DEPOSIT_FLOOR = 1_000_000n
export const MAX_RAISE_SECS = 30 * 86_400
export const MAX_FLOOR_BPS = 50_000
export const MAX_OPERATORS = 4
export const STATUS = Object.freeze({ RAISING: 0, LAUNCHED: 1, FAILED: 2 })

// Anchor error numbers, in the order of BundleError.
const ERROR_NAMES = ['NotUpgradeAuthority', 'NotAdmin', 'NotLaunchSigner', 'NotOperator', 'NotBacker', 'BadKey', 'BadSettings', 'BadPolicy',
  'PolicyTooLoose', 'BadRaise', 'NotRaising', 'RaiseClosed', 'RaiseOpen', 'RaiseNotFull', 'OverTarget', 'BelowMinimum', 'NotFailed', 'NoSettle',
  'NotReleased', 'BadPool', 'BadVaultAccount', 'TooFewTokens', 'NotLaunched', 'AlreadyOpen', 'VaultNotOpen', 'Paused', 'LaunchCooldown', 'TooSoon',
  'TradeTooLarge', 'DailyLimit', 'BelowFloor', 'NoOutput', 'Graduated', 'NotGraduated', 'NotMigrated', 'BadPosition', 'BadRouterAccount',
  'NothingToClaim', 'BadDestination', 'NotTokenAccount', 'MathOverflow', 'NotSpent', 'TokensElsewhere', 'NotTopLevel', 'NotAlone', 'RentFloor']
export const BUNDLE_ERRORS = Object.freeze(Object.fromEntries(ERROR_NAMES.map((name, index) => [6000 + index, name])))

const anchorDiscriminator = name => createHash('sha256').update(name).digest().subarray(0, 8)
const PLATFORM_DISCRIMINATOR = anchorDiscriminator('account:Platform')
const BUNDLE_DISCRIMINATOR = anchorDiscriminator('account:Bundle')
const BACKER_DISCRIMINATOR = anchorDiscriminator('account:Backer')

const key = value => new PublicKey(value)
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, key(programId))[0]
const writable = (pubkey, isSigner = false) => ({ pubkey: key(pubkey), isSigner, isWritable: true })
const readonly = (pubkey, isSigner = false) => ({ pubkey: key(pubkey), isSigner, isWritable: false })
const u8 = value => Buffer.from([value])
const u16 = value => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer }
const u32 = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer }
const u64 = value => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer }
const i64 = value => { const buffer = Buffer.alloc(8); buffer.writeBigInt64LE(BigInt(value)); return buffer }
const bool = value => u8(value ? 1 : 0)
const instruction = (programId, name, keys, args = []) =>
  new TransactionInstruction({ programId: key(programId), keys, data: Buffer.concat([anchorDiscriminator(`global:${name}`), ...args]) })

// ---------------------------------------------------------------- addresses

export const platformAddress = (programId = BUNDLE_VAULT_PROGRAM_ID) => pda([Buffer.from('platform')], programId)
export const programDataAddress = (programId = BUNDLE_VAULT_PROGRAM_ID) => pda([key(programId).toBuffer()], UPGRADEABLE_LOADER)
export const bundleAddress = (id, programId = BUNDLE_VAULT_PROGRAM_ID) => pda([Buffer.from('bundle'), u64(id)], programId)
export const backerAddress = (bundle, wallet, programId = BUNDLE_VAULT_PROGRAM_ID) =>
  pda([Buffer.from('backer'), key(bundle).toBuffer(), key(wallet).toBuffer()], programId)
export const vaultAddress = (bundle, programId = BUNDLE_VAULT_PROGRAM_ID) => pda([Buffer.from('vault'), key(bundle).toBuffer()], programId)
// The router: the bundle config's fee claimer, owner of the partner LP positions after graduation.
export const routerAddress = (programId = BUNDLE_VAULT_PROGRAM_ID) => pda([Buffer.from('router')], programId)
export const tokenAccountOf = (owner, mint) => getAssociatedTokenAddressSync(key(mint), key(owner), true)
// DBC's base vault of a pool: ["token_vault", mint, pool].
export const dbcBaseVault = (mint, pool) => pda([Buffer.from('token_vault'), key(mint).toBuffer(), key(pool).toBuffer()], DBC_PROGRAM_ID)

// The accounts one bundle trades and routes with.
export function bundleAccounts({ id, mint = null, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const bundle = bundleAddress(id, programId), vault = vaultAddress(bundle, programId), router = routerAddress(programId)
  return {
    bundle, vault, router,
    vaultSol: tokenAccountOf(vault, NATIVE_MINT),
    pot: tokenAccountOf(bundle, NATIVE_MINT),
    routerSol: tokenAccountOf(router, NATIVE_MINT),
    ...mint ? { vaultTokens: tokenAccountOf(vault, mint), routerTokens: tokenAccountOf(router, mint) } : {},
  }
}

// ------------------------------------------------------------------- policy

const policyBytes = p => Buffer.concat([u16(p.maxTradeBps), u16(p.maxDailyBuyBps), u16(p.maxDailySellBps), u16(p.floorBps), u32(p.gapSecs)])

// The program's own checks (validate_policy, tighter_or_equal), for forms and tests.
export function policyValid(p) {
  const fraction = bps => Number.isInteger(bps) && bps >= 0 && bps <= BPS
  return fraction(p.maxTradeBps) && fraction(p.maxDailyBuyBps) && fraction(p.maxDailySellBps) && Number.isInteger(p.floorBps) && p.floorBps >= 0 &&
    p.floorBps <= MAX_FLOOR_BPS && Number.isInteger(p.gapSecs) && p.gapSecs >= 0 && p.gapSecs <= 0xffffffff
}
export const tighterOrEqual = (a, b) => a.maxTradeBps <= b.maxTradeBps && a.maxDailyBuyBps <= b.maxDailyBuyBps &&
  a.maxDailySellBps <= b.maxDailySellBps && a.floorBps >= b.floorBps && a.gapSecs >= b.gapSecs

// ------------------------------------------------------------- instructions

function platformArgs(a) {
  const operators = [...a.operators.map(key)]
  if (!operators.length || operators.length > MAX_OPERATORS) throw Error(`1 to ${MAX_OPERATORS} operators`)
  while (operators.length < MAX_OPERATORS) operators.push(PublicKey.default)
  if (!policyValid(a.limits)) throw Error('Invalid limits policy')
  return [key(a.admin).toBuffer(), key(a.launchSigner).toBuffer(), ...operators.map(o => o.toBuffer()), key(a.opsWallet).toBuffer(),
    key(a.dammConfig).toBuffer(), u16(a.backerBps), u16(a.opsBps), u32(a.launchCooldownSecs), u32(a.launchGraceSecs), policyBytes(a.limits)]
}

// Once, by the program's upgrade authority. treasury: repo.ing's wrapped SOL account; curveConfig: the bundle DBC config
// (its fee claimer must be routerAddress(), quote fees in SOL, SPL Token mints); the router's wrapped SOL account must exist
// first (tokenAccountOf(routerAddress(), NATIVE_MINT)).
export function initPlatformInstruction({ upgradeAuthority, treasury, curveConfig, programId = BUNDLE_VAULT_PROGRAM_ID, ...args }) {
  const router = routerAddress(programId)
  return instruction(programId, 'init_platform', [writable(upgradeAuthority, true), writable(platformAddress(programId)), readonly(programId),
    readonly(programDataAddress(programId)), readonly(treasury), readonly(tokenAccountOf(router, NATIVE_MINT)), readonly(curveConfig), readonly(router),
    readonly(SystemProgram.programId)], platformArgs(args))
}

// The current admin signs; newAdmin (default: the same key) takes over. Changes apply to bundles created afterwards.
export function setPlatformInstruction({ admin, newAdmin = admin, treasury, curveConfig, programId = BUNDLE_VAULT_PROGRAM_ID, ...args }) {
  const router = routerAddress(programId)
  return instruction(programId, 'set_platform', [readonly(admin, true), writable(platformAddress(programId)), readonly(treasury),
    readonly(tokenAccountOf(router, NATIVE_MINT)), readonly(curveConfig), readonly(router)], platformArgs({ ...args, admin: newAdmin }))
}

// The launcher opens a raise and pays its rent; repo.ing's admin co-signs. deadline: unix seconds.
export function createBundleInstruction({ creator, admin, id, repoId, target, minDeposit, deadline, policy, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  if (!policyValid(policy)) throw Error('Invalid vault policy')
  return instruction(programId, 'create_bundle', [writable(creator, true), readonly(admin, true), readonly(platformAddress(programId)),
    writable(bundleAddress(id, programId)), readonly(SystemProgram.programId)],
  [u64(id), u64(repoId), u64(target), u64(minDeposit), i64(deadline), policyBytes(policy)])
}

export function depositInstruction({ wallet, id, lamports, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const bundle = bundleAddress(id, programId)
  return instruction(programId, 'deposit', [writable(wallet, true), writable(bundle), writable(backerAddress(bundle, wallet, programId)),
    readonly(SystemProgram.programId)], [u64(lamports)])
}

const adminBundle = (name, { admin, id, programId = BUNDLE_VAULT_PROGRAM_ID }, args = []) =>
  instruction(programId, name, [readonly(admin, true), readonly(platformAddress(programId)), writable(bundleAddress(id, programId))], args)
export const cancelBundleInstruction = options => adminBundle('cancel_bundle', options)
export const setPolicyInstruction = ({ policy, ...options }) => {
  if (!policyValid(policy)) throw Error('Invalid vault policy')
  return adminBundle('set_policy', options, [policyBytes(policy)])
}
export const setPausedInstruction = ({ paused, ...options }) => adminBundle('set_paused', options, [bool(paused)])

// Anyone: a raise that missed its target, or a full raise not launched within the grace period, fails.
export const failRaiseInstruction = ({ id, programId = BUNDLE_VAULT_PROGRAM_ID }) =>
  instruction(programId, 'fail_raise', [writable(bundleAddress(id, programId))])

export function refundInstruction({ wallet, id, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const bundle = bundleAddress(id, programId)
  return instruction(programId, 'refund', [writable(wallet, true), writable(bundle), writable(backerAddress(bundle, wallet, programId))])
}

export const releaseInstruction = ({ launchSigner, opsWallet, id, programId = BUNDLE_VAULT_PROGRAM_ID }) =>
  instruction(programId, 'release', [writable(launchSigner, true), readonly(platformAddress(programId)), writable(bundleAddress(id, programId)),
    writable(opsWallet), readonly(SYSVAR_INSTRUCTIONS_PUBKEY)])

// The pool's mint and base vault let settle check that every token outside the curve is in the vault.
export function settleInstruction({ launchSigner, id, pool, mint, minTokens, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const bundle = bundleAddress(id, programId), vault = vaultAddress(bundle, programId)
  return instruction(programId, 'settle', [readonly(launchSigner, true), readonly(platformAddress(programId)), writable(bundle), readonly(vault),
    readonly(pool), readonly(tokenAccountOf(vault, mint)), readonly(mint), readonly(dbcBaseVault(mint, pool))], [u64(minTokens)])
}

export function openVaultInstruction({ payer, id, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const { bundle, vault, vaultSol, pot } = bundleAccounts({ id, programId })
  return instruction(programId, 'open_vault', [writable(payer, true), writable(bundle), readonly(vault), writable(vaultSol), writable(pot),
    readonly(NATIVE_MINT), readonly(TOKEN_PROGRAM_ID), readonly(ASSOCIATED_TOKEN_PROGRAM_ID), readonly(SystemProgram.programId)])
}

// An operator trades the vault on the curve. pool / config / baseVault / quoteVault: the DBC pool's (its state names them).
export function vaultSwapCurveInstruction({ operator, id, mint, pool, config, baseVault, quoteVault, buy, amountIn, minimumOut,
  programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const { bundle, vault, vaultSol, vaultTokens } = bundleAccounts({ id, mint, programId })
  return instruction(programId, 'vault_swap_curve', [readonly(operator, true), readonly(platformAddress(programId)), writable(bundle), readonly(vault),
    writable(pool), readonly(config), readonly(DBC_POOL_AUTHORITY), writable(baseVault), writable(quoteVault), readonly(mint), readonly(NATIVE_MINT),
    writable(vaultTokens), writable(vaultSol), readonly(TOKEN_PROGRAM_ID), readonly(DBC_EVENT_AUTHORITY), readonly(DBC_PROGRAM_ID),
    readonly(SYSVAR_INSTRUCTIONS_PUBKEY)], [bool(buy), u64(amountIn), u64(minimumOut)])
}

// The admin binds a graduated bundle to its DAMM v2 pool and the router's partner position (the one the migration created).
export function recordGraduationInstruction({ admin, id, pool, dammPool, position, positionNftAccount, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  return instruction(programId, 'record_graduation', [readonly(admin, true), readonly(platformAddress(programId)), writable(bundleAddress(id, programId)),
    readonly(pool), readonly(dammPool), readonly(position), readonly(positionNftAccount), readonly(routerAddress(programId))])
}

// An operator trades the vault on its DAMM v2 pool. tokenAVault / tokenBVault: the pool's (market token, wrapped SOL).
export function vaultSwapPoolInstruction({ operator, id, mint, dammPool, tokenAVault, tokenBVault, position, buy, amountIn, minimumOut,
  programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const { bundle, vault, vaultSol, vaultTokens } = bundleAccounts({ id, mint, programId })
  return instruction(programId, 'vault_swap_pool', [readonly(operator, true), readonly(platformAddress(programId)), writable(bundle), readonly(vault),
    writable(dammPool), readonly(DAMM_POOL_AUTHORITY), writable(tokenAVault), writable(tokenBVault), readonly(mint), readonly(NATIVE_MINT),
    writable(vaultTokens), writable(vaultSol), readonly(position), readonly(TOKEN_PROGRAM_ID), readonly(DAMM_EVENT_AUTHORITY), readonly(DAMM_PROGRAM_ID),
    readonly(SYSVAR_INSTRUCTIONS_PUBKEY)], [bool(buy), u64(amountIn), u64(minimumOut)])
}

// Anyone (a crank): claims the curve's partner fees and routes them. The router's account for the market token must exist.
export function routeCurveFeesInstruction({ id, mint, pool, config, baseVault, quoteVault, treasury, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const { bundle, router, routerSol, routerTokens, vaultSol, pot } = bundleAccounts({ id, mint, programId })
  return instruction(programId, 'route_curve_fees', [readonly(platformAddress(programId)), writable(bundle), readonly(router), writable(pool),
    readonly(config), readonly(DBC_POOL_AUTHORITY), writable(baseVault), writable(quoteVault), readonly(mint), readonly(NATIVE_MINT),
    writable(routerTokens), writable(routerSol), writable(vaultSol), writable(pot), writable(treasury), readonly(TOKEN_PROGRAM_ID),
    readonly(DBC_EVENT_AUTHORITY), readonly(DBC_PROGRAM_ID)])
}

export function routePoolFeesInstruction({ id, mint, dammPool, position, positionNftAccount, tokenAVault, tokenBVault, treasury,
  programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const { bundle, router, routerSol, routerTokens, vaultSol, pot } = bundleAccounts({ id, mint, programId })
  return instruction(programId, 'route_pool_fees', [readonly(platformAddress(programId)), writable(bundle), readonly(router), readonly(dammPool),
    writable(position), readonly(positionNftAccount), readonly(DAMM_POOL_AUTHORITY), writable(tokenAVault), writable(tokenBVault), readonly(mint),
    readonly(NATIVE_MINT), writable(routerTokens), writable(routerSol), writable(vaultSol), writable(pot), writable(treasury),
    readonly(TOKEN_PROGRAM_ID), readonly(DAMM_EVENT_AUTHORITY), readonly(DAMM_PROGRAM_ID)])
}

// A backer's routed fees, as wrapped SOL into `destination` (by default its own wrapped SOL account, which must exist).
export function claimBackerFeesInstruction({ wallet, id, destination = tokenAccountOf(wallet, NATIVE_MINT), programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const { bundle, pot } = bundleAccounts({ id, programId })
  return instruction(programId, 'claim_backer_fees', [readonly(wallet, true), writable(bundle), writable(backerAddress(bundle, wallet, programId)),
    writable(pot), writable(destination), readonly(TOKEN_PROGRAM_ID)])
}

// The launch transaction's instructions: release → DBC pool + the launch signer's top-level first swap of the released SOL,
// with the vault as receiver (the only way the swap gets DBC's minimum fee) → settle with the quoted output as the minimum.
// `created`: the DBC SDK's createPoolWithFirstBuy transaction for { buyer: launchSigner, receiver: vaultAddress(bundle),
// buyAmount: buy lamports, minimumAmountOut: minimumTokens }.
export function bundleLaunchInstructions({ launchSigner, opsWallet, id, pool, mint, minimumTokens, created, computeUnits = 400_000,
  programId = BUNDLE_VAULT_PROGRAM_ID }) {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), releaseInstruction({ launchSigner, opsWallet, id, programId }),
    ...created.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId)),
    settleInstruction({ launchSigner, id, pool, mint, minTokens: minimumTokens, programId })]
}

// The first swap's output at DBC's minimum fee for `lamports` (what the launch buys and settle requires).
export function bundleBuyQuote(dbc, config, lamports) {
  return BigInt(dbc.pool.getQuoteFromInputAmount({ config, swapBaseForQuote: false, amountIn: new BN(String(lamports)), slippageBps: 0,
    hasReferral: false, eligibleForFirstSwapWithMinFee: true }).outputAmount.toString())
}

// --------------------------------------------------------------------- math

// What the launch pays: the operations share and the first swap (release()).
export function launchAmounts(raised, opsBps) {
  const ops = BigInt(raised) * BigInt(opsBps) / BigInt(BPS)
  return { ops, buy: BigInt(raised) - ops }
}

// One routed claim (route()): the vault's own partner fees back to it first, then backerBps of the rest to the backers and
// the remainder (rounding included) to the treasury; and the per-share income the backers' part adds.
export function splitClaim(claimed, vaultFeeOwed, backerBps, shares) {
  const total = BigInt(claimed), owed = BigInt(vaultFeeOwed)
  const rebate = total < owed ? total : owed, rest = total - rebate
  const toBackers = rest * BigInt(backerBps) / BigInt(BPS)
  return { rebate, toBackers, toTreasury: rest - toBackers, accIncrement: toBackers * ACC_SCALE / BigInt(shares) }
}

// What a backer can claim now (pending()).
export function pendingBackerFees(bundle, backer) {
  const earned = BigInt(backer.shares) * BigInt(bundle.accPerShare) / ACC_SCALE
  return earned > BigInt(backer.paid) ? earned - BigInt(backer.paid) : 0n
}

// A backer's share of the raise, in basis points of all shares.
export const backerShareBps = (bundle, backer) => Number(BigInt(backer.shares) * BigInt(BPS) / BigInt(bundle.raised || 1))

// ----------------------------------------------------------------- accounts

class Reader {
  constructor(buffer, offset = 8) { this.buffer = buffer; this.offset = offset }
  take(size) { const start = this.offset; this.offset += size; if (this.offset > this.buffer.length) throw Error('Account data too short'); return start }
  key() { const at = this.take(32); return new PublicKey(this.buffer.subarray(at, at + 32)) }
  u8() { return this.buffer[this.take(1)] }
  bool() { return this.u8() === 1 }
  u16() { return this.buffer.readUInt16LE(this.take(2)) }
  u32() { return this.buffer.readUInt32LE(this.take(4)) }
  u64() { return this.buffer.readBigUInt64LE(this.take(8)) }
  i64() { return Number(this.buffer.readBigInt64LE(this.take(8))) }
  u128() { const at = this.take(16); return this.buffer.readBigUInt64LE(at) + (this.buffer.readBigUInt64LE(at + 8) << 64n) }
  policy() { return { maxTradeBps: this.u16(), maxDailyBuyBps: this.u16(), maxDailySellBps: this.u16(), floorBps: this.u16(), gapSecs: this.u32() } }
}

function reader(data, discriminator, what) {
  const buffer = Buffer.from(data)
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(discriminator)) throw Error(`Not a bundle ${what} account`)
  return new Reader(buffer)
}

export function decodePlatform(data) {
  const r = reader(data, PLATFORM_DISCRIMINATOR, 'platform')
  return { admin: r.key(), launchSigner: r.key(), operators: [r.key(), r.key(), r.key(), r.key()].filter(o => !o.equals(PublicKey.default)),
    opsWallet: r.key(), treasury: r.key(), routerSol: r.key(), curveConfig: r.key(), dammConfig: r.key(), backerBps: r.u16(), opsBps: r.u16(),
    launchCooldownSecs: r.u32(), launchGraceSecs: r.u32(), limits: r.policy(), bump: r.u8() }
}

export function decodeBundle(data) {
  const r = reader(data, BUNDLE_DISCRIMINATOR, 'bundle')
  return { id: r.u64(), repoId: r.u64(), creator: r.key(), status: r.u8(), graduated: r.bool(), paused: r.bool(), bump: r.u8(), vaultBump: r.u8(),
    target: r.u64(), minDeposit: r.u64(), deadline: r.i64(), curveConfig: r.key(), dammConfig: r.key(), backerBps: r.u16(), opsBps: r.u16(), launchCooldownSecs: r.u32(),
    launchGraceSecs: r.u32(), raised: r.u64(), refunded: r.u64(), released: r.u64(), opsPaid: r.u64(),
    mint: r.key(), pool: r.key(), dammPool: r.key(), routerPosition: r.key(), routerPositionNft: r.key(), vaultTokens: r.key(), vaultSol: r.key(),
    pot: r.key(), launchedAt: r.i64(), tradingOpensAt: r.i64(), policy: r.policy(), costLamports: r.u64(), costTokens: r.u64(), day: r.i64(),
    dayBought: r.u64(), daySold: r.u64(), lastBuyAt: r.i64(), lastSellAt: r.i64(), vaultVolume: r.u64(),
    vaultFeeGenerated: r.u64(), vaultFeeOwed: r.u64(), vaultRebated: r.u64(), backerIncome: r.u64(), backerPaid: r.u64(), treasuryIncome: r.u64(),
    accPerShare: r.u128() }
}

export function decodeBacker(data) {
  const r = reader(data, BACKER_DISCRIMINATOR, 'backer')
  return { bundle: r.key(), wallet: r.key(), shares: r.u64(), paid: r.u64(), bump: r.u8() }
}

// The program's error name when the failure started in this program, else null. A failed CPI (DBC, DAMM v2, SPL Token)
// ends the same way for this program with the inner program's number, so only the first failing program counts.
export function bundleErrorName(text, programId = BUNDLE_VAULT_PROGRAM_ID) {
  const first = String(text ?? '').match(/Program (\w+) failed: custom program error: (0x[0-9a-f]+)/i)
  return first && first[1] === key(programId).toBase58() ? BUNDLE_ERRORS[Number(first[2])] ?? null : null
}
