import { ComputeBudgetProgram, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from '@solana/spl-token'
import { deriveDbcEventAuthority, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { readTradeComputeBudget } from './trade-landing.mjs'
import { ATA_PROGRAM, NATIVE_MINT, TOKEN_PROGRAM, isCreateWsolAta, wsolAta } from './wsol-account.mjs'
import { BPS, EARLY_ACCESS_HOOK_PROGRAM_ID, dbcBaseVault, decodeAllowList, decodeMintConfig, earlyAccessAddresses, hookErrorName, transferHookAccounts,
  walletCapBps } from './early-access-hook.mjs'
import { hasFairRamp, marketHookRules } from './early-access-rules.mjs'
import { earlyAccessEndUtc } from './early-access.mjs'

// Curve trades of a contributor early access market (docs/EARLY_ACCESS.md, step 5d): Meteora DBC's swap2WithTransferHook on the
// market's Token-2022 transfer-hook pool, built by the SDK and checked here before anything is signed; the hook's refusals in
// words a trader can act on.

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const SWAP2_TRANSFER_HOOK_DISCRIMINATOR = Buffer.from([183, 93, 153, 40, 24, 230, 194, 151])
// swap2_with_transfer_hook's data: the discriminator, SwapParameters2 { amount_0: u64, amount_1: u64, swap_mode: u8 } and
// TransferHookAccountsInfo { slices: Vec<{ accounts_type: u8, length: u8 }> } with one TransferHookBase slice (no referral).
const EXACT_IN = 0, TRANSFER_HOOK_BASE = 0
const HOOK_SWAP_DATA_LENGTH = 8 + 8 + 8 + 1 + 4 + 2
// Its fixed accounts (DBC IDL, SDK 1.5.13), then the remaining ones: Instructions sysvar (only when the config asks for it),
// then the hook's accounts for the base mint.
const FIXED_ACCOUNTS = 15
// Writable in the IDL: pool, the two token accounts, the two vaults and the base mint. The referral slot holds the program ID
// (read-only) when there is no referral, and the payer only signs.
const WRITABLE = new Set([2, 3, 4, 5, 6, 7])
// Near the window's end the server's clock may differ from the chain's, so the hook's own check (the simulation) decides.
const WINDOW_END_MARGIN_MS = 30_000

// The one swap carries the quoted exact-input amounts and the canonical accounts: the wallet's own Token-2022 account for the
// market token and its WSOL account, the pool's two vaults, no referral (the program ID in its slot), and after them exactly the
// hook's accounts for this mint and vault; every account signs and is writable exactly as the IDL says. Besides the compute budget only the wallet's own setup may surround it: the
// two associated accounts, for a buy the wrap of exactly amountIn, then the single WSOL close and (keepWsol) its re-create.
export function assertPreparedDbcHookSwap(tx, { direction, wallet, pool, config, mint, amountIn, minimumAmountOut, keepWsol = false,
  hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  const fail = () => { throw new Error('Trade transaction swap does not match the quote') }
  if (direction !== 'buy' && direction !== 'sell') fail()
  readTradeComputeBudget(tx.instructions)
  const token = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID), wsol = wsolAta(wallet)
  const [input, output] = direction === 'buy' ? [wsol, token] : [token, wsol]
  const swaps = tx.instructions.filter(ix => ix.programId.equals(DBC_PROGRAM))
  if (swaps.length !== 1) fail()
  const [ix] = swaps, data = ix.data
  if (data.length !== HOOK_SWAP_DATA_LENGTH || !data.subarray(0, 8).equals(SWAP2_TRANSFER_HOOK_DISCRIMINATOR) ||
      data.readBigUInt64LE(8) !== amountIn || data.readBigUInt64LE(16) !== minimumAmountOut || data[24] !== EXACT_IN ||
      data.readUInt32LE(25) !== 1 || data[29] !== TRANSFER_HOOK_BASE) fail()
  const fixed = [deriveDbcPoolAuthority(), config, pool, input, output, deriveDbcTokenVaultAddress(pool, mint), deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
    mint, NATIVE_MINT, wallet, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM, DBC_PROGRAM, deriveDbcEventAuthority(), DBC_PROGRAM]
  const hook = transferHookAccounts(mint, fixed[5], hookProgram).map(meta => meta.pubkey)
  const remaining = ix.keys.slice(FIXED_ACCOUNTS)
  const sysvar = remaining[0]?.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY) ? 1 : 0
  if (data[30] !== hook.length || ix.keys.length !== FIXED_ACCOUNTS + sysvar + hook.length ||
      ix.keys.some((meta, index) => meta.isSigner !== (index === 9) || meta.isWritable !== WRITABLE.has(index)) ||
      fixed.some((key, index) => !ix.keys[index].pubkey.equals(key)) ||
      remaining.slice(sysvar).some((meta, index) => !meta.pubkey.equals(hook[index]))) fail()
  assertHookSwapSetup(tx, ix, { direction, wallet, mint, token, wsol, amountIn, keepWsol })
}

// Everything around the swap, in order: setup before it, then the close, then at most the kept WSOL account's re-create.
function assertHookSwapSetup(tx, swap, { direction, wallet, mint, token, wsol, amountIn, keepWsol }) {
  const unexpected = () => { throw new Error('Trade transaction contains an unexpected instruction') }
  const at = tx.instructions.indexOf(swap)
  const before = tx.instructions.slice(0, at)
  const created = new Set()
  let wrapped = 0, synced = 0
  for (const ix of before) {
    const k = ix.keys.map(key => key.pubkey)
    if (ix.programId.equals(ATA_PROGRAM)) {
      // CreateIdempotent of the wallet's own account, paid by the wallet: WSOL under SPL Token, the market token under Token-2022.
      const own = isCreateWsolAta(ix, wallet) ? 'wsol' : ix.data.length === 1 && ix.data[0] === 1 && k.length === 6 && k[0].equals(wallet) &&
        k[1].equals(token) && k[2].equals(wallet) && k[3].equals(mint) && k[4].equals(SystemProgram.programId) && k[5].equals(TOKEN_2022_PROGRAM_ID) ? 'token' : null
      if (!own || created.has(own)) unexpected()
      created.add(own)
    } else if (ix.programId.equals(SystemProgram.programId)) {
      // A buy wraps exactly its input: SystemProgram transfer (index 2) from the wallet to its WSOL account.
      if (direction !== 'buy' || wrapped++ || ix.data.length !== 12 || ix.data.readUInt32LE(0) !== 2 || ix.data.readBigUInt64LE(4) !== amountIn ||
          k.length !== 2 || !k[0].equals(wallet) || !k[1].equals(wsol)) unexpected()
    } else if (ix.programId.equals(TOKEN_PROGRAM)) {
      // ...then SyncNative on that account.
      if (direction !== 'buy' || !wrapped || synced++ || ix.data.length !== 1 || ix.data[0] !== 17 || k.length !== 1 || !k[0].equals(wsol)) unexpected()
    } else if (!ix.programId.equals(ComputeBudgetProgram.programId)) unexpected()
  }
  if (direction === 'buy' && (!wrapped || !synced)) unexpected()
  const after = tx.instructions.slice(at + 1), close = after[0]?.keys.map(key => key.pubkey) ?? []
  if (!after[0]?.programId.equals(TOKEN_PROGRAM) || after[0].data.length !== 1 || after[0].data[0] !== 9 || close.length !== 3 ||
      !close[0].equals(wsol) || !close[1].equals(wallet) || !close[2].equals(wallet)) {
    throw new Error('Trade transaction swap does not match the quote')
  }
  if (after.length !== (keepWsol ? 2 : 1) || (keepWsol && !isCreateWsolAta(after[1], wallet))) {
    throw new Error('Trade transaction contains an unexpected instruction after the WSOL close')
  }
}

// While the window is open (the market's stamp, which equals the hook's), only wallets on the mint's allow list may receive the
// token: a buy from any other wallet is refused before anything is built. A missing or unreadable list lists nobody, as for the hook.
// The hook decides by the chain's clock: in the window's last 30 seconds nothing is checked here and the simulation decides.
export async function assertListedDuringWindow({ connection, market, wallet, hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID, now = Date.now() }) {
  const end = market.earlyAccessEnd ? new Date(market.earlyAccessEnd).getTime() : 0
  if (!(now < end - WINDOW_END_MARGIN_MS)) return
  const info = await connection.getAccountInfo(earlyAccessAddresses(market.mint, hookProgram).allowList, 'confirmed')
  let listed = false
  try {
    const list = info?.owner.equals(new PublicKey(hookProgram)) ? decodeAllowList(info.data) : null
    listed = Boolean(list?.mint.equals(new PublicKey(market.mint)) && list.wallets.some(entry => entry.equals(new PublicKey(wallet))))
  } catch {}
  if (!listed) throw new Error(contributorsOnly(end))
}

export const contributorsOnly = (end = null) =>
  `Contributor early access: only this repository's linked contributors can buy until ${end ? earlyAccessEndUtc(end) : 'the early access window ends'}.`
export const EARLY_ACCESS_WALLET_LIMIT = 'Contributor early access: this buy would put more of the supply in one wallet than the launch allows now. Try a smaller amount.'
// The fair ramp's own refusal, before anything is built: the limit now and about how many whole tokens still fit.
export const fairRampLimit = (capBps, room) => `Contributor early access: with the fair ramp one wallet can hold at most ${(capBps / 100).toFixed(2).replace(/\.?0+$/, '')}% of the ` +
  `supply right now (it rises as the curve sells). This wallet can get about ${(room / 1_000_000n).toLocaleString('en-US')} more tokens.`

// A buy under the fair ramp (src/early-access-rules.mjs) that would take the wallet past its limit is refused before anything is
// built, as the hook would refuse it: the limit is measured with the curve's vault and the wallet's balance before the buy, and the
// wallet may then hold at most limit × supply (the live supply). outputAmount: the quoted tokens. Unreadable accounts: the hook decides.
export async function assertWithinWalletLimit({ connection, market, wallet, outputAmount, hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  if (!hasFairRamp(marketHookRules(market))) return
  const mint = new PublicKey(market.mint), program = new PublicKey(hookProgram)
  const vault = dbcBaseVault(mint, new PublicKey(market.pool)), account = getAssociatedTokenAddressSync(mint, new PublicKey(wallet), false, TOKEN_2022_PROGRAM_ID)
  const [configInfo, mintInfo, vaultInfo, heldInfo] = await connection.getMultipleAccountsInfo([earlyAccessAddresses(mint, program).config, mint, vault, account], 'confirmed')
  let capBps, supply, held
  try {
    if (!configInfo?.owner.equals(program)) return
    supply = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID).supply
    held = heldInfo ? unpackAccount(account, heldInfo, TOKEN_2022_PROGRAM_ID).amount : 0n
    capBps = walletCapBps(decodeMintConfig(configInfo.data), unpackAccount(vault, vaultInfo, TOKEN_2022_PROGRAM_ID).amount, held)
  } catch { return }
  if (capBps === null || (held + BigInt(outputAmount)) * BigInt(BPS) <= supply * BigInt(capBps)) return
  const room = supply * BigInt(capBps) / BigInt(BPS) - held
  throw new Error(fairRampLimit(capBps, room > 0n ? room : 0n))
}
export const EARLY_ACCESS_TRANSFER_REFUSED = 'Contributor early access: the token\'s launch rules refused this trade.'

// The words for a failed simulation's logs when the hook itself refused the transfer; null for any other failure.
export function hookRefusal(logs, hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID) {
  const name = hookErrorName((logs ?? []).join('\n'), hookProgram)
  if (!name) return null
  return name === 'NotContributor' ? contributorsOnly() : name === 'WalletLimit' ? EARLY_ACCESS_WALLET_LIMIT : EARLY_ACCESS_TRANSFER_REFUSED
}
