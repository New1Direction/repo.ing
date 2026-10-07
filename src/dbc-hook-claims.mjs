import BN from 'bn.js'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { deriveDbcEventAuthority, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, transferHookAccounts } from './early-access-hook.mjs'

// Fee claims on a contributor early access market (docs/EARLY_ACCESS.md, step 6): a Token-2022 transfer-hook pool, whose fees DBC
// pays only through claim_creator_trading_fee2 (the creator) and claim_trading_fee2 (the partner). The SDK's own builders for them
// route the SOL through the signer's permanent WSOL account, which anyone can create and fund; these build the same instruction from
// the SDK's parts with a one-time WSOL authority (`temporary`, as every other repo.ing claim does), and check it before anything is
// signed. The fees are SOL (the early access config collects them in the quote), so the base amount is always 0.

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const CLAIM_CREATOR_TRADING_FEE2_DISCRIMINATOR = Buffer.from([238, 247, 213, 94, 110, 145, 88, 142])
export const CLAIM_TRADING_FEE2_DISCRIMINATOR = Buffer.from('54bf473209a237c1', 'hex')
const KINDS = Object.freeze({
  // claim_creator_trading_fee2: pool_authority, pool, token_a, token_b, base_vault, quote_vault, base_mint, quote_mint, creator, token
  // programs, event_authority, program.
  creator: { discriminator: CLAIM_CREATOR_TRADING_FEE2_DISCRIMINATOR, method: 'claimCreatorTradingFee2', signer: 'creator', withConfig: false },
  // claim_trading_fee2: the same with the config after the pool authority, and the fee claimer as the signer.
  partner: { discriminator: CLAIM_TRADING_FEE2_DISCRIMINATOR, method: 'claimTradingFee2', signer: 'feeClaimer', withConfig: true },
})
const TRANSFER_HOOK_BASE = 0
const CLOSE_ACCOUNT = 9

// The claim's instructions, in order: the receiver's Token-2022 account for the market token (the instruction names it, though no
// token moves), the one-time WSOL account, the claim, and the WSOL account's close to the receiver (the SOL leaves it there).
// dbc: a DynamicBondingCurveClient. authority: the creator (creator) or the fee claimer (partner); payer pays the two accounts' rent.
export async function hookClaimInstructions(dbc, { kind, authority, payer, pool, maxQuoteAmount, receiver, temporary }) {
  const spec = KINDS[kind]
  if (!spec) throw Error('Unknown claim kind')
  const service = kind === 'creator' ? dbc.creator : dbc.partner
  const { virtualPool, poolConfigState } = await service.getPoolWithConfig(pool)
  if (poolConfigState.tokenType !== 1 || !poolConfigState.quoteMint.equals(NATIVE_MINT)) throw Error('Not a Token-2022 pool quoted in SOL')
  const { accounts, preInstructions, postInstructions } = await service.buildClaimTradingFeeAccountsForSol({ payer, feeReceiver: receiver, tempWSolAcc: temporary,
    pool, virtualPool, poolConfigState, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID })
  const { info, accounts: hookAccounts } = await service.getRemainingAccountsForTransferHook(virtualPool.poolState.baseMint)
  const claim = await service.program.methods[spec.method](new BN(0), new BN(String(maxQuoteAmount)), info)
    .accountsPartial({ ...accounts, ...spec.withConfig ? { config: virtualPool.poolState.config } : {}, [spec.signer]: authority })
    .remainingAccounts(hookAccounts).instruction()
  return [...preInstructions, claim, ...postInstructions]
}

// [pubkey, signer, writable] for each account, in order.
const accountsAre = (ix, expected) => ix.keys.length === expected.length &&
  expected.every(([pubkey, signer, writable], index) => ix.keys[index].pubkey.equals(pubkey) && ix.keys[index].isSigner === signer && ix.keys[index].isWritable === writable)
const idempotentAta = (ix, { payer, account, owner, mint, program }) => Boolean(ix?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
  ix.data.length === 1 && ix.data[0] === 1 && accountsAre(ix, [[payer, true, true], [account, false, true], [owner, false, false], [mint, false, false],
    [SystemProgram.programId, false, false], [program, false, false]]))

// Exactly the four instructions above, for this pool, mint, authority, receiver and one-time account: the claim's data (its
// discriminator, base 0, the quoted maximum, and either one TransferHookBase slice of the hook's five accounts, read-only, or none
// once the curve's last swap has revoked the hook), every account in its IDL place with its signer and writable flags.
export function assertHookClaimInstructions(instructions, { kind, authority, payer, pool, config, mint, maxQuoteAmount, receiver, temporary,
  hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  const fail = () => { throw Error('Claim transaction does not match the expected claim') }
  const spec = KINDS[kind]
  if (!spec || !Array.isArray(instructions) || instructions.length !== 4) fail()
  const [baseAccount, wsolAccount, claim, close] = instructions
  const tokenA = getAssociatedTokenAddressSync(mint, receiver, true, TOKEN_2022_PROGRAM_ID)
  const tokenB = getAssociatedTokenAddressSync(NATIVE_MINT, temporary, true, TOKEN_PROGRAM_ID)
  if (!idempotentAta(baseAccount, { payer, account: tokenA, owner: receiver, mint, program: TOKEN_2022_PROGRAM_ID }) ||
      !idempotentAta(wsolAccount, { payer, account: tokenB, owner: temporary, mint: NATIVE_MINT, program: TOKEN_PROGRAM_ID })) fail()
  if (!close?.programId.equals(TOKEN_PROGRAM_ID) || close.data.length !== 1 || close.data[0] !== CLOSE_ACCOUNT ||
      !accountsAre(close, [[tokenB, false, true], [receiver, false, true], [temporary, true, false]])) fail()
  const data = claim?.data
  if (!claim?.programId.equals(DBC_PROGRAM) || !data || !data.subarray(0, 8).equals(spec.discriminator)) fail()
  const slices = data.length >= 28 ? data.readUInt32LE(24) : -1
  if (data.length !== 28 + 2 * slices || (slices !== 0 && slices !== 1) || data.readBigUInt64LE(8) !== 0n || data.readBigUInt64LE(16) !== BigInt(maxQuoteAmount)) fail()
  const vault = deriveDbcTokenVaultAddress(pool, mint)
  const hook = slices ? transferHookAccounts(mint, vault, hookProgram).map(meta => meta.pubkey) : []
  if (slices && (data[28] !== TRANSFER_HOOK_BASE || data[29] !== hook.length)) fail()
  const fixed = [deriveDbcPoolAuthority(), ...spec.withConfig ? [config] : [], pool, tokenA, tokenB, vault, deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
    mint, NATIVE_MINT, authority, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, deriveDbcEventAuthority(), DBC_PROGRAM]
  const offset = spec.withConfig ? 1 : 0, signer = 8 + offset
  const writable = new Set([1, 2, 3, 4, 5].map(index => index + offset))
  if (claim.keys.length !== fixed.length + hook.length ||
      claim.keys.some((meta, index) => meta.isSigner !== (index === signer) || meta.isWritable !== writable.has(index)) ||
      [...fixed, ...hook].some((key, index) => !claim.keys[index].pubkey.equals(key))) fail()
}
