import { PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'

const cache = new Map()
const inFlight = new Map()
// Holder counts scan every token account of the mint (getProgramAccounts: 10 Helius credits per call), and supply
// barely moves, so one read per mint per 5 minutes serves every viewer of this process.
const CACHE_MS = 5 * 60 * 1000

export function uniqueHolderCount(accounts, vaultAddress) {
  const owners = new Set()
  for (const account of accounts) {
    if (account.pubkey.toBase58() === vaultAddress) continue
    const data = account.account.data
    if (!Buffer.isBuffer(data) || data.length !== 40) throw new Error('Unexpected SPL token account data')
    if (data.readBigUInt64LE(32) > 0n) owners.add(new PublicKey(data.subarray(0, 32)).toBase58())
  }
  return owners.size
}

export async function marketTokenMetrics(connection, mintAddress, poolAddress, now = Date.now()) {
  const previous = cache.get(mintAddress)
  if (previous && now < previous.expiresAt) return previous.value
  if (inFlight.has(mintAddress)) return inFlight.get(mintAddress)
  const request = loadTokenMetrics(connection, mintAddress, poolAddress).then(value => {
    if (cache.size >= 500) cache.delete(cache.keys().next().value)
    cache.set(mintAddress, { value, expiresAt: Date.now() + CACHE_MS })
    return value
  }).finally(() => inFlight.delete(mintAddress))
  inFlight.set(mintAddress, request)
  return request
}

async function loadTokenMetrics(connection, mintAddress, poolAddress) {
  const mint = new PublicKey(mintAddress)
  const pool = new PublicKey(poolAddress)
  const [supply, accounts] = await Promise.all([
    connection.getTokenSupply(mint, 'finalized'),
    connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: 'finalized',
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mintAddress } }],
      dataSlice: { offset: 32, length: 40 },
    }),
  ])
  const value = {
    supplyBaseUnits: supply.value.amount,
    supplyDecimals: supply.value.decimals,
    holders: uniqueHolderCount(accounts, deriveDbcTokenVaultAddress(pool, mint).toBase58()),
  }
  return value
}
