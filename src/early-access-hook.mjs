// Client for the contributor early access transfer hook (programs/early-access-hook, docs/EARLY_ACCESS.md): its addresses,
// instructions, accounts and errors. The program id is the declare_id! of programs/early-access-hook/src/lib.rs.
import { createHash } from 'node:crypto'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

export const EARLY_ACCESS_HOOK_PROGRAM_ID = new PublicKey('Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep')
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

// The program's own limits (lib.rs).
export const MAX_EARLY_ACCESS_SECONDS = 24 * 60 * 60
export const MAX_WALLETS_PER_CALL = 24
export const MAX_ALLOW_LIST = 1024

// Anchor error numbers, in the order of HookError.
const ERROR_NAMES = ['NotUpgradeAuthority', 'NotAdmin', 'NotOracle', 'BadWindow', 'TooManyWallets', 'WindowClosed', 'WindowOpen',
  'BadAllowList', 'BadDestination', 'NotAssociatedAccount', 'NotContributor', 'MathOverflow', 'BadKey']
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

// The accounts a transfer of the mint needs on top of Token-2022's own, in spl-token's resolution order (the extra
// accounts, the hook program, its account list). Meteora DBC takes them as one TransferHookBase slice; they depend only on
// the mint, so they can be named before the mint exists (the launch transaction's first buy).
export function transferHookAccounts(mint, programId = EARLY_ACCESS_HOOK_PROGRAM_ID) {
  const { config, allowList, extraAccountMetas } = earlyAccessAddresses(mint, programId)
  return [readonly(config), readonly(allowList), readonly(programId), readonly(extraAccountMetas)]
}

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

// A mint's window and first wallets; `payer` pays the rent and gets its share back when the allow list is closed. The window
// must end in the future (the program refuses 0: there is no "early access off" for a mint set up here).
export function initMintInstruction({ payer, admin, mint, repoId, earlyAccessEnd, wallets = [], programId = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  if (!Number.isSafeInteger(earlyAccessEnd) || earlyAccessEnd <= 0) throw Error('earlyAccessEnd must be a unix time in seconds')
  const { config, allowList, extraAccountMetas } = earlyAccessAddresses(mint, programId)
  return instruction(programId, 'init_mint', [writable(payer, true), readonly(admin, true), readonly(platformAddress(programId)), readonly(mint),
    writable(config), writable(allowList), writable(extraAccountMetas), readonly(SystemProgram.programId)],
  [u64(repoId), i64(earlyAccessEnd), walletList(wallets)])
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
  if (buffer.length < 8 + 32 + 8 + 8 + 32 + 8 + 1 + 1 || !buffer.subarray(0, 8).equals(MINT_CONFIG_DISCRIMINATOR)) throw Error('Not an early access mint config')
  return { mint: new PublicKey(buffer.subarray(8, 40)), repoId: buffer.readBigUInt64LE(40).toString(), earlyAccessEnd: Number(buffer.readBigInt64LE(48)),
    rentReceiver: new PublicKey(buffer.subarray(56, 88)), listDeposit: buffer.readBigUInt64LE(88), allowBump: buffer[96], bump: buffer[97] }
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
