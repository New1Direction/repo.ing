import { cache } from 'react'
import { PublicKey } from '@solana/web3.js'
import { deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { holderConcentration, mintFacts, parseMintAccount, parseTokenAccount, readLauncherTrades, launcherPosition } from '../../src/trust-signals.mjs'
import { backerLabels } from './backers.mjs'
import { chain, database } from './server.mjs'

// On-chain holder snapshot per mint: three batched RPC reads (largest token accounts; the mint plus those accounts;
// their owners' program ids, no data), shared by every token page view for SNAPSHOT_MS with in-flight dedupe.
const SNAPSHOT_MS = 60_000
// A failed read is remembered briefly so a slow or rate-limited RPC is not retried by every page view.
const FAILURE_MS = 15_000
const RPC_TIMEOUT_MS = 6_000
const MAX_ENTRIES = 500
const snapshots = new Map()
const inFlight = new Map()

const withTimeout = (promise, ms) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), ms).unref?.())])

// Exported for tests: a fake connection only needs the three methods used here.
export async function loadHolderSnapshot(connection, mintAddress, poolAddress, { labels = new Map() } = {}) {
  const mint = new PublicKey(mintAddress)
  const largest = await connection.getTokenLargestAccounts(mint, 'confirmed')
  const addresses = (largest?.value ?? []).map(entry => entry.address)
  const [mintInfo, ...tokenInfos] = await connection.getMultipleAccountsInfo([mint, ...addresses], 'confirmed')
  if (!mintInfo) throw new Error('Mint account is missing')
  const parsedMint = parseMintAccount(mintInfo.data)
  const accounts = []
  tokenInfos.forEach((info, index) => {
    if (!info) return
    const account = parseTokenAccount(info.data)
    if (!mint.equals(new PublicKey(account.mint))) return
    accounts.push({ address: addresses[index].toBase58(), owner: new PublicKey(account.owner).toBase58(), amount: account.amount })
  })
  const owners = [...new Set(accounts.map(account => account.owner))]
  const ownerInfos = owners.length ? await connection.getMultipleAccountsInfo(owners.map(owner => new PublicKey(owner)),
    { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }) : []
  const ownerPrograms = new Map(owners.map((owner, index) => [owner, ownerInfos[index]?.owner?.toBase58() ?? null]))
  let curveVault = null
  try { curveVault = deriveDbcTokenVaultAddress(new PublicKey(poolAddress), mint).toBase58() } catch { curveVault = null }
  return {
    mint: mintFacts(parsedMint),
    holders: holderConcentration({ supply: parsedMint.supplyBaseUnits, accounts, curveVault, ownerPrograms, labels }),
  }
}

// Never throws: null while the RPC is unavailable. Cached per mint for SNAPSHOT_MS.
export async function holderSnapshot(market, { connection = null, now = Date.now } = {}) {
  const key = market.mint
  const previous = snapshots.get(key)
  if (previous && now() < previous.expiresAt) return previous.value
  if (inFlight.has(key)) return inFlight.get(key)
  const request = (async () => {
    let value = null
    try {
      const labels = backerLabels({ beneficiaryWallet: market.beneficiaryWallet, pool: market.pool })
      value = await withTimeout(loadHolderSnapshot(connection ?? chain(), market.mint, market.pool, { labels }), RPC_TIMEOUT_MS)
    } catch (error) {
      console.error('holder snapshot unavailable', { mint: key, error: error.message })
    }
    if (snapshots.size >= MAX_ENTRIES) snapshots.delete(snapshots.keys().next().value)
    snapshots.set(key, { value, expiresAt: now() + (value ? SNAPSHOT_MS : FAILURE_MS) })
    return value
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}

// Launcher's indexed position, once per request. null when the database is off or the read fails.
export const launcherSummary = cache(async (mint, launcherWallet, beneficiaryWallet, pool) => {
  const db = database()
  if (!db || !launcherWallet) return null
  try {
    const row = await readLauncherTrades(db, mint)
    const position = launcherPosition(row ?? { boughtBaseUnits: '0', soldBaseUnits: '0', launchBuyBaseUnits: '0' })
    const label = backerLabels({ beneficiaryWallet, pool }).get(launcherWallet) ?? null
    return { wallet: launcherWallet, label, position }
  } catch (error) {
    console.error('launcher summary unavailable', { mint, error: error.message })
    return null
  }
})
