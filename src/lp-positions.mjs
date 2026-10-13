import { PublicKey } from '@solana/web3.js'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'

// LP positions of one graduated DAMM v2 pool (docs/LAUNCH_TRANSPARENCY.md#market-maker-incentives-and-fee-rebates): each position's
// liquidity (unlocked + vesting + permanently locked) and its owner, the holder of the position NFT. Read-only; one program
// account scan per pool plus batched NFT-holder reads. Positions beyond MAX_POSITIONS are reported as truncated.
export const MAX_POSITIONS = 200

const big = value => BigInt(value?.toString?.() ?? value ?? 0)

export async function readLpPositions({ connection, pool, amm = new CpAmm(connection) }) {
  const poolKey = new PublicKey(pool)
  const [poolState, positions] = await Promise.all([amm.fetchPoolState(poolKey), amm.getAllPositionsByPool(poolKey)])
  const sorted = positions.map(({ publicKey, account }) => ({
    position: publicKey.toBase58(), nftMint: account.nftMint,
    liquidity: big(account.unlockedLiquidity) + big(account.vestedLiquidity) + big(account.permanentLockedLiquidity),
    permanentLockedLiquidity: big(account.permanentLockedLiquidity),
  })).sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : a.position.localeCompare(b.position)))
  const kept = sorted.slice(0, MAX_POSITIONS)
  const owners = await nftHolders(connection, kept.map(row => row.nftMint))
  return {
    pool: poolKey.toBase58(), poolLiquidity: big(poolState.liquidity), truncated: sorted.length > kept.length,
    positions: kept.map((row, index) => ({ position: row.position, owner: owners[index], liquidity: row.liquidity,
      permanentLockedLiquidity: row.permanentLockedLiquidity })),
  }
}

// The wallet holding each NFT mint (largest token account with amount 1), or null when it cannot be read. Holder lookups run ten at a
// time and account reads in chunks of 100 (the RPC limit), so one large pool never fires hundreds of calls at once.
async function nftHolders(connection, mints) {
  const accounts = []
  for (let start = 0; start < mints.length; start += 10) {
    accounts.push(...await Promise.all(mints.slice(start, start + 10).map(mint => connection.getTokenLargestAccounts(mint, 'confirmed')
      .then(result => result?.value?.find(entry => String(entry.amount) === '1')?.address ?? null).catch(() => null))))
  }
  const present = accounts.filter(Boolean)
  const infos = []
  for (let start = 0; start < present.length; start += 100) {
    const chunk = present.slice(start, start + 100)
    infos.push(...await connection.getMultipleAccountsInfo(chunk, 'confirmed').catch(() => chunk.map(() => null)))
  }
  const ownerOf = new Map(present.map((address, index) => {
    const data = infos[index]?.data
    return [address.toBase58(), data && data.length >= 64 ? new PublicKey(data.subarray(32, 64)).toBase58() : null]
  }))
  return accounts.map(address => (address ? ownerOf.get(address.toBase58()) ?? null : null))
}
