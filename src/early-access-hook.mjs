// Client for repo.ing's launch-rules transfer hook (programs/early-access-hook, docs/EARLY_ACCESS.md): contributor early
// access, fair ramp and star unlocks. Its addresses, instructions, accounts and errors. The program id is the declare_id! of
// programs/early-access-hook/src/lib.rs.
import { createHash } from 'node:crypto'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

export const EARLY_ACCESS_HOOK_PROGRAM_ID = new PublicKey('Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep')
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')

// The rules a mint turns on at setup (MintConfig.rules bits). Star unlocks needs the fair ramp.
export const RULES = Object.freeze({ EARLY_ACCESS: 1, FAIR_RAMP: 2, STAR_UNLOCKS: 4 })
export const BPS = 10_000

// The program's own limits (lib.rs).
export const MAX_EARLY_ACCESS_SECONDS = 24 * 60 * 60
export const MAX_WALLETS_PER_CALL = 24
export const MAX_ALLOW_LIST = 1024

// Anchor error numbers, in the order of HookError.
const ERROR_NAMES = ['NotUpgradeAuthority', 'NotAdmin', 'NotOracle', 'BadWindow', 'TooManyWallets', 'WindowClosed', 'WindowOpen',
  'BadAllowList', 'BadDestination', 'NotAssociatedAccount', 'NotContributor', 'MathOverflow', 'BadKey', 'WalletLimit', 'BadVault',
  'BadRules', 'BadRamp']
export const HOOK_ERRORS = Object.freeze(Object.fromEntries(ERROR_NAMES.map((name, index) => [6000 + index, name])))

const ALLOW_LIST_DISCRIMINATOR = Buffer.from('ea-allow')
const ALLOW_HEADER = 8 + 32 + 4
const anchorDiscriminator = name => createHash('sha256').update(name).digest().subarray(0, 8)
const MINT_CONFIG_DISCRIMINATOR = anchorDiscriminator('account:MintConfig')
const PLATFORM_DISCRIMINATOR = anchorDiscriminator('account:Platform')

const key = value => new PublicKey(value)
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0]
const writable = (pubkey, isSigner = false) => ({ pubkey: key(pubkey), isSigner, isWritable: true })
const readonly = (pubkey, isSigner = false) => ({ pubkey: key(pubkey), isSigner, isWritable: false })

export const platformAddress = (programId = EARLY_ACCESS_HOOK_PROGRAM_ID) => pda([Buffer.from('platform')], key(programId))
export const programDataAddress = (programId = EARLY_ACCESS_HOOK_PROGRAM_ID) => pda([key(programId).toBuffer()], UPGRADEABLE_LOADER)

// The three accounts each early access mint has under the program.
export function earlyAccessAddresses(mint, programId = EARLY_ACCESS_HOOK_PROGRAM_ID) {
  const mintKey = key(mint).toBuffer(), program = key(programId)
  return {
    config: pda([Buffer.from('config'), mintKey], program),
    allowList: pda([Buffer.from('allow'), mintKey], program),
    extraAccountMetas: pda([Buffer.from('extra-account-metas'), mintKey], program),
  }
}

// The curve's base vault: DBC's ["token_vault", mint, pool]. The fair ramp reads how much it still holds.
export const dbcBaseVault = (mint, pool) => pda([Buffer.from('token_vault'), key(mint).toBuffer(), key(pool).toBuffer()], DBC_PROGRAM_ID)

// The accounts a transfer of the mint needs on top of Token-2022's own, in spl-token's resolution order (the extra
// accounts — config, allow list, base vault — then the hook program and its account list). Meteora DBC takes them as one
// TransferHookBase slice; they depend only on the mint and its vault, so they can be named before the mint exists (the
// launch transaction's first buy).
export function transferHookAccounts(mint, vault, programId = EARLY_ACCESS_HOOK_PROGRAM_ID) {
  const { config, allowList, extraAccountMetas } = earlyAccessAddresses(mint, programId)
  return [readonly(config), readonly(allowList), readonly(vault), readonly(programId), readonly(extraAccountMetas)]
}

const u8 = value => Buffer.from([value])
const u16 = value => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer }
const u32 = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer }
const u64 = value => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer }
const i64 = value => { const buffer = Buffer.alloc(8); buffer.writeBigInt64LE(BigInt(value)); return buffer }
function walletList(wallets) {
  if (!Array.isArray(wallets) || wallets.length > MAX_WALLETS_PER_CALL) throw Error(`At most ${MAX_WALLETS_PER_CALL} wallets per instruction`)
  return Buffer.concat([u32(wallets.length), ...wallets.map(wallet => key(wallet).toBuffer())])
}
function instruction(programId, name, keys, args = []) {
  return new TransactionInstruction({ programId: key(programId), keys, data: Buffer.concat([anchorDiscriminator(`global:${name}`), ...args]) })
}

// One time, from the program's upgrade authority.
export function initPlatformInstruction({ upgradeAuthority, admin, oracle, programId = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  return instruction(programId, 'init_platform', [writable(upgradeAuthority, true), writable(platformAddress(programId)), readonly(programId),
    readonly(programDataAddress(programId)), readonly(SystemProgram.programId)], [key(admin).toBuffer(), key(oracle).toBuffer()])
}

export function setPlatformInstruction({ admin, newAdmin, newOracle, programId = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  return instruction(programId, 'set_platform', [readonly(admin, true), writable(platformAddress(programId))],
    [key(newAdmin).toBuffer(), key(newOracle).toBuffer()])
}

// One mint's rules (RULES bits), set once. Early access: the window end (a unix time in the future) and the first wallets;
// without it, earlyAccessEnd is 0 and there are no wallets. pool: the mint's DBC pool; vault: dbcBaseVault(mint, pool) (the
// program checks it). ramp (fair ramp, star unlocks): { startBps, endCapBps, vaultStart, vaultEnd, starsAtLaunch, starStep,
// starBonusBps, starMaxBonusBps }, sent with the fair ramp only.
// `payer` pays the rent and gets its share back when the allow list is closed.
export function initMintInstruction({ payer, admin, mint, repoId, rules = RULES.EARLY_ACCESS, earlyAccessEnd = 0, wallets = [], pool, vault, ramp = {},
  programId = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  if (!Number.isInteger(rules) || rules <= 0 || rules > 7) throw Error('rules must be a non-empty set of RULES')
  if (rules & RULES.STAR_UNLOCKS && !(rules & RULES.FAIR_RAMP)) throw Error('Star unlocks needs the fair ramp')
  if (rules & RULES.EARLY_ACCESS) {
    if (!Number.isSafeInteger(earlyAccessEnd) || earlyAccessEnd <= 0) throw Error('earlyAccessEnd must be a unix time in seconds')
  } else if (earlyAccessEnd !== 0 || wallets.length) throw Error('Without early access there is no window and no wallets')
  if (!pool || !vault) throw Error('pool and vault are the mint\'s DBC pool and its base vault (dbcBaseVault)')
  const { config, allowList, extraAccountMetas } = earlyAccessAddresses(mint, programId)
  // ramp is Option<RampSettings>: present with the fair ramp only.
  const r = { startBps: 0, endCapBps: 0, vaultStart: 0n, vaultEnd: 0n, starsAtLaunch: 0, starStep: 0, starBonusBps: 0, starMaxBonusBps: 0, ...ramp }
  const settings = rules & RULES.FAIR_RAMP ? [u8(1), u16(r.startBps), u16(r.endCapBps), u64(r.vaultStart), u64(r.vaultEnd), u32(r.starsAtLaunch),
    u32(r.starStep), u16(r.starBonusBps), u16(r.starMaxBonusBps)] : [u8(0)]
  return instruction(programId, 'init_mint', [writable(payer, true), readonly(admin, true), readonly(platformAddress(programId)), readonly(mint),
    readonly(pool), readonly(vault), writable(config), writable(allowList), writable(extraAccountMetas), readonly(SystemProgram.programId)],
  [u64(repoId), u8(rules), i64(earlyAccessEnd), walletList(wallets), ...settings])
}

// Oracle: the repository's star count now (star unlocks only).
export function reportStarsInstruction({ oracle, mint, stars, programId = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  if (!Number.isInteger(stars) || stars < 0 || stars > 0xffffffff) throw Error('stars must be a whole number')
  return instruction(programId, 'report_stars', [readonly(oracle, true), readonly(platformAddress(programId)),
    writable(earlyAccessAddresses(mint, programId).config)], [u32(stars)])
}

// Oracle only, while the window is open; the oracle pays for the larger list and gets that back when it is closed.
export function addWalletsInstruction({ oracle, mint, wallets, programId = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  const { config, allowList } = earlyAccessAddresses(mint, programId)
  return instruction(programId, 'add_wallets', [writable(oracle, true), readonly(platformAddress(programId)), readonly(config), writable(allowList),
    readonly(SystemProgram.programId)], [walletList(wallets)])
}

// Oracle or admin, any time (the launch transaction takes a non-contributor launcher off with the admin's signature).
export function removeWalletsInstruction({ authority, mint, wallets, programId = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  const { config, allowList } = earlyAccessAddresses(mint, programId)
  return instruction(programId, 'remove_wallets', [readonly(authority, true), readonly(platformAddress(programId)), readonly(config), writable(allowList)],
    [walletList(wallets)])
}

// Anyone, after the window: the mint's rent receiver gets back its deposit and the platform's oracle the rest.
export function closeAllowListInstruction({ mint, rentReceiver, oracle, programId = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  const { config, allowList } = earlyAccessAddresses(mint, programId)
  return instruction(programId, 'close_allow_list', [readonly(config), readonly(platformAddress(programId)), writable(allowList), writable(rentReceiver),
    writable(oracle)])
}

export function decodeMintConfig(data) {
  const buffer = Buffer.from(data)
  if (buffer.length < 175 || !buffer.subarray(0, 8).equals(MINT_CONFIG_DISCRIMINATOR)) throw Error('Not an early access mint config')
  return { mint: new PublicKey(buffer.subarray(8, 40)), repoId: buffer.readBigUInt64LE(40).toString(), rules: buffer[48],
    earlyAccessEnd: Number(buffer.readBigInt64LE(49)), rentReceiver: new PublicKey(buffer.subarray(57, 89)), listDeposit: buffer.readBigUInt64LE(89),
    allowBump: buffer[97], bump: buffer[98], vault: new PublicKey(buffer.subarray(99, 131)),
    ramp: { startBps: buffer.readUInt16LE(131), endCapBps: buffer.readUInt16LE(133), vaultStart: buffer.readBigUInt64LE(135),
      vaultEnd: buffer.readBigUInt64LE(143), starsAtLaunch: buffer.readUInt32LE(151), starStep: buffer.readUInt32LE(155), starBonusBps: buffer.readUInt16LE(159),
      starMaxBonusBps: buffer.readUInt16LE(161) },
    starsNow: buffer.readUInt32LE(163), starsUpdatedAt: Number(buffer.readBigInt64LE(167)) }
}

// The fair ramp's limit for one wallet, in basis points of the supply, as the hook computes it (null: no limit), from the
// mint config, the base vault's balance now and what the wallet holds now (its own tokens never count as progress for it).
// It is the limit the wallet's next buy is measured against (the hook adds a buy's own amount back to the vault), so a page
// can show it and size a buy as the limit minus what the wallet holds.
export function walletCapBps(config, vaultBalance, held = 0n) {
  if (!(config.rules & RULES.FAIR_RAMP)) return null
  const { startBps, endCapBps, vaultStart, vaultEnd, starsAtLaunch, starStep, starBonusBps, starMaxBonusBps } = config.ramp
  const left = BigInt(vaultBalance), own = BigInt(held), span = vaultStart - vaultEnd
  const raw = vaultStart > left ? vaultStart - left : 0n, sold = raw > own ? raw - own : 0n
  if (sold >= span) return null
  let cap = BigInt(startBps) + BigInt(endCapBps - startBps) * sold / span
  if (config.rules & RULES.STAR_UNLOCKS) {
    const bonus = BigInt(Math.max(0, config.starsNow - starsAtLaunch)) / BigInt(starStep) * BigInt(starBonusBps)
    cap += bonus < BigInt(starMaxBonusBps) ? bonus : BigInt(starMaxBonusBps)
  }
  return cap >= BigInt(BPS) ? null : Number(cap)
}

export function decodePlatform(data) {
  const buffer = Buffer.from(data)
  if (buffer.length < 8 + 64 + 1 || !buffer.subarray(0, 8).equals(PLATFORM_DISCRIMINATOR)) throw Error('Not the early access platform account')
  return { admin: new PublicKey(buffer.subarray(8, 40)), oracle: new PublicKey(buffer.subarray(40, 72)), bump: buffer[72] }
}

export function decodeAllowList(data) {
  const buffer = Buffer.from(data)
  if (buffer.length < ALLOW_HEADER || !buffer.subarray(0, 8).equals(ALLOW_LIST_DISCRIMINATOR)) throw Error('Not an early access allow list')
  const count = buffer.readUInt32LE(40)
  if (buffer.length < ALLOW_HEADER + count * 32) throw Error('Allow list shorter than its count')
  return { mint: new PublicKey(buffer.subarray(8, 40)),
    wallets: Array.from({ length: count }, (_, index) => new PublicKey(buffer.subarray(ALLOW_HEADER + index * 32, ALLOW_HEADER + index * 32 + 32))) }
}

// The hook's error name in a failed transaction's logs or message, or null. Only the hook's own failure counts: other
// programs (DBC, Token-2022) reuse the same error numbers, so a bare `custom program error` is not enough.
export function hookErrorName(text, programId = EARLY_ACCESS_HOOK_PROGRAM_ID) {
  const failure = String(text ?? '').match(new RegExp(`Program ${key(programId).toBase58()} failed: custom program error: (0x[0-9a-f]+)`, 'i'))
  return failure ? HOOK_ERRORS[Number(failure[1])] ?? null : null
}
