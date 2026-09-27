import BN from 'bn.js'
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import { ActivationType } from '@meteora-ag/dynamic-bonding-curve-sdk'

const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111')

// Clock is five 64-bit fields: slot, epoch-start timestamp, epoch,
// leader-schedule epoch, unix timestamp. Use the same chain clock as DBC.
// getSlot -> getBlockTime can fail on a skipped or not-yet-available block.
export async function readChainPoint(connection, activationType) {
  if (![ActivationType.Slot, ActivationType.Timestamp].includes(activationType)) throw Error('Unsupported pool activation type')
  const account = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed')
  if (!account?.owner.equals(SYSVAR_OWNER) || account.data.length !== 40) throw Error('Solana clock is unavailable')
  const value = activationType === ActivationType.Slot ? account.data.readBigUInt64LE(0) : account.data.readBigInt64LE(32)
  if (value <= 0n) throw Error('Solana clock is unavailable')
  return new BN(value.toString())
}
