import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
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

// token2022: the market's mint is a Token-2022 mint (a contributor early access market, stamped with its transfer hook program).
export async function marketTokenMetrics(connection, mintAddress, poolAddress, now = Date.now(), { token2022 = false } = {}) {
  const previous = cache.get(mintAddress)
  if (previous && now < previous.expiresAt) return previous.value
  if (inFlight.has(mintAddress)) return inFlight.get(mintAddress)
  const request = loadTokenMetrics(connection, mintAddress, poolAddress, token2022).then(value => {
    if (cache.size >= 500) cache.delete(cache.keys().next().value)
    cache.set(mintAddress, { value, expiresAt: Date.now() + CACHE_MS })
    return value
  }).finally(() => inFlight.delete(mintAddress))
  inFlight.set(mintAddress, request)
  return request
}

// A Token-2022 token account's size depends on its extensions (a hook mint's carry TransferHookAccount), so it is matched by its
// account-type byte (offset 165: 2 = token account) instead of its size; the mint, owner and amount are where SPL keeps them.
export const tokenAccountFilters = (mintAddress, token2022) => token2022
  ? [{ memcmp: { offset: 0, bytes: mintAddress } }, { memcmp: { offset: 165, bytes: '3' } }]
  : [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mintAddress } }]

async function loadTokenMetrics(connection, mintAddress, poolAddress, token2022) {
  const mint = new PublicKey(mintAddress)
  const pool = new PublicKey(poolAddress)
  const [supply, accounts] = await Promise.all([
    connection.getTokenSupply(mint, 'finalized'),
    connection.getProgramAccounts(token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, {
      commitment: 'finalized',
      filters: tokenAccountFilters(mintAddress, token2022),
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
