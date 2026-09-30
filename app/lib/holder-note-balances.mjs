import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'

// Holder badges on notes re-check balances lazily: one batched getMultipleAccountsInfo over every note author's
// associated token accounts (SPL Token and Token-2022), cached ~5 minutes per wallet so a page view is never N+1.
export const NOTE_BALANCE_TTL_MS = 5 * 60 * 1000
const MAX_ACCOUNTS_PER_CALL = 100
const MAX_CACHE_ENTRIES = 5000

export function noteAtaAddresses(mint, wallets) {
  const mintKey = new PublicKey(mint)
  return wallets.flatMap(wallet => [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(program =>
    ({ wallet, address: getAssociatedTokenAddressSync(mintKey, new PublicKey(wallet), true, program) })))
}

// A missing account is a zero balance. Data must name this mint and owner (mint 0..32, owner 32..64, amount 64..72).
export function sumAtaBalances(mint, entries, infos) {
  const balances = new Map()
  entries.forEach(({ wallet }, index) => {
    const data = infos[index]?.data
    let amount = 0n
    if (Buffer.isBuffer(data) && data.length >= 72 && new PublicKey(data.subarray(0, 32)).toBase58() === mint &&
        new PublicKey(data.subarray(32, 64)).toBase58() === wallet) amount = data.readBigUInt64LE(64)
    balances.set(wallet, (balances.get(wallet) ?? 0n) + amount)
  })
  return balances
}

export async function readAtaBalances(connection, mint, wallets) {
  const entries = noteAtaAddresses(mint, wallets), infos = []
  for (let i = 0; i < entries.length; i += MAX_ACCOUNTS_PER_CALL) {
    infos.push(...await connection.getMultipleAccountsInfo(entries.slice(i, i + MAX_ACCOUNTS_PER_CALL).map(e => e.address), { commitment: 'confirmed' }))
  }
  return sumAtaBalances(mint, entries, infos)
}

// get(mint, wallets) → Map(wallet → bigint | null). Only stale or missing wallets are fetched, in one batch; a failed
// read yields null (unknown, never "sold") and is not cached.
export function createBalanceCache({ fetchBalances, ttlMs = NOTE_BALANCE_TTL_MS, clock = Date.now, max = MAX_CACHE_ENTRIES }) {
  const entries = new Map()
  return async (mint, wallets) => {
    const now = clock(), result = new Map(), missing = []
    for (const wallet of new Set(wallets)) {
      const hit = entries.get(`${mint}:${wallet}`)
      if (hit && hit.expiresAt > now) result.set(wallet, hit.balance)
      else missing.push(wallet)
    }
    if (!missing.length) return result
    let fetched = null
    try { fetched = await fetchBalances(mint, missing) } catch { fetched = null }
    for (const wallet of missing) {
      const balance = fetched?.get(wallet) ?? null
      result.set(wallet, balance)
      if (balance === null) continue
      const key = `${mint}:${wallet}`
      entries.delete(key)
      entries.set(key, { balance, expiresAt: now + ttlMs })
    }
    for (const key of entries.keys()) { if (entries.size <= max) break; entries.delete(key) }
    return result
  }
}
