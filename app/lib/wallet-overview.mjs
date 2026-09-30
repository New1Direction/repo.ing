import { PublicKey } from '@solana/web3.js'
import { discoveryEarned } from '../../src/discovery-rewards.mjs'

// SPL Token accounts are 165 bytes (the wallet API reads a 72-byte slice: mint, owner, amount). Token-2022 accounts
// share that base layout and may append an account-type byte (2 = Account) plus extensions, so the API reads one
// byte past the base to tell them apart. Mint, owner and amount sit at the same offsets for both programs.
const BASE_ACCOUNT_LENGTH = 165
const ACCOUNT_TYPE_ACCOUNT = 2
export const SPL_ACCOUNT_SLICE = { offset: 0, length: 72 }
export const TOKEN_2022_ACCOUNT_SLICE = { offset: 0, length: BASE_ACCOUNT_LENGTH + 1 }

function validAccountData(data, token2022) {
  if (!Buffer.isBuffer(data)) return false
  if (data.length === SPL_ACCOUNT_SLICE.length || data.length === BASE_ACCOUNT_LENGTH) return true
  return token2022 && data.length > BASE_ACCOUNT_LENGTH && data[BASE_ACCOUNT_LENGTH] === ACCOUNT_TYPE_ACCOUNT
}

// Sums balances per mint across the SPL Token and Token-2022 accounts the wallet owns.
export function walletTokenBalances(accounts, wallet, token2022Accounts = []) {
  const balances = new Map()
  const entries = [...accounts.map(({ account }) => [account.data, false]), ...token2022Accounts.map(({ account }) => [account.data, true])]
  for (const [data, token2022] of entries) {
    if (!validAccountData(data, token2022)) throw new Error('Invalid token account data')
    if (new PublicKey(data.subarray(32, 64)).toBase58() !== wallet) throw new Error('Token account owner mismatch')
    const mint = new PublicKey(data.subarray(0, 32)).toBase58()
    balances.set(mint, (balances.get(mint) ?? 0n) + data.readBigUInt64LE(64))
  }
  return balances
}

export function walletMarkets(markets, balances, wallet, rewards) {
  const byRepo = new Map(rewards.map(row => {
    const earned = discoveryEarned(row.partnerEarned, row.version ?? 1), paid = BigInt(row.paid)
    if (paid > earned || paid < 0n) throw new Error('Discovery balance needs review')
    return [row.repoId, { earned: earned.toString(), paid: paid.toString(), remaining: (earned - paid).toString() }]
  }))
  return markets.filter(m => (balances?.get(m.mint) ?? 0n) > 0n || m.launcherWallet === wallet || m.beneficiaryWallet === wallet)
    .map(m => ({ repoId: m.repoId, mint: m.mint, symbol: m.symbol, tokenName: m.tokenName, fullName: m.fullName,
      balanceBaseUnits: balances ? (balances.get(m.mint) ?? 0n).toString() : null,
      launchedByYou: m.launcherWallet === wallet, builderWallet: m.beneficiaryWallet === wallet,
      builderAvailable: m.beneficiaryWallet === wallet ? m.remaining : null,
      discovery: m.launcherWallet === wallet ? byRepo.get(m.repoId) ?? null : null }))
}

// One wallet's discovery rewards across every enrolled market it launched. Rows are re-checked so a
// ledger inconsistency is surfaced rather than summed into an overstated claimable total.
export function launcherRewardTotals(rows) {
  let markets = 0, earned = 0n, paid = 0n, claimable = 0n, claimableMarkets = 0
  for (const { discovery } of rows) {
    if (!discovery) continue
    const e = BigInt(discovery.earned), p = BigInt(discovery.paid), r = BigInt(discovery.remaining)
    if (p < 0n || p > e || r !== e - p) throw new Error('Discovery balance needs review')
    markets++; earned += e; paid += p; claimable += r
    if (r > 0n) claimableMarkets++
  }
  return { markets, earned: String(earned), paid: String(paid), claimable: String(claimable), claimableMarkets }
}
