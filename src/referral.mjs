import { PublicKey } from '@solana/web3.js'
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token'

// Meteora carves the referral from its own protocol fee (DBC HOST_FEE_PERCENT and the DAMM pool's
// referral_fee_percent are both 20% of the 20% protocol share): 4% of the trading fee, paid in SOL.
// Builder and platform fee shares are computed before this split and never change.
export const REFERRAL_FEE_PERCENT_OF_TRADING_FEE = 4

// A referrer is a plain on-curve wallet address. Anything else is ignored, never an error.
export function parseReferrer(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return null
  try {
    const key = new PublicKey(value)
    return key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()) ? key : null
  } catch { return null }
}

// The referral fee is paid into the referrer's own existing wrapped-SOL ATA. The trader never creates or
// funds it: a missing, foreign or unreadable account means the trade simply proceeds without a referral.
export async function resolveReferral(connection, referrer, wallet) {
  const owner = parseReferrer(referrer)
  if (!owner || owner.equals(new PublicKey(wallet))) return null
  try { return (await initializedWsolAccount(connection, owner))?.address ?? null } catch { return null }
}

// The wallet's own initialized wrapped-SOL ATA, or null. RPC errors propagate to the caller.
export async function initializedWsolAccount(connection, owner) {
  const account = getAssociatedTokenAddressSync(NATIVE_MINT, owner)
  const info = await connection.getAccountInfo(account, 'confirmed')
  if (!info?.owner.equals(TOKEN_PROGRAM_ID)) return null
  let parsed
  try { parsed = unpackAccount(account, info, TOKEN_PROGRAM_ID) } catch { return null }
  return parsed.isInitialized && !parsed.isFrozen && parsed.mint.equals(NATIVE_MINT) && parsed.owner.equals(owner)
    ? { address: account, lamports: BigInt(info.lamports), amount: parsed.amount } : null
}

// A trader's WSOL ATA that existed before the trade is recreated after the swap's close, so a referrer's payout
// account survives trading here. Returns the current rent-exempt minimum the re-created account will hold, or null.
// Unknown (RPC error) means the old behavior: closed and not recreated.
export async function keptWsolRent(connection, wallet) {
  try {
    if (!await initializedWsolAccount(connection, new PublicKey(wallet))) return null
    return BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed'))
  } catch { return null }
}
