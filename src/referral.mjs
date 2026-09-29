import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token'

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
  const account = getAssociatedTokenAddressSync(NATIVE_MINT, owner)
  try {
    const info = await connection.getAccountInfo(account, 'confirmed')
    if (!info?.owner.equals(TOKEN_PROGRAM_ID)) return null
    const parsed = unpackAccount(account, info, TOKEN_PROGRAM_ID)
    return parsed.isInitialized && !parsed.isFrozen && parsed.mint.equals(NATIVE_MINT) && parsed.owner.equals(owner) ? account : null
  } catch { return null }
}
