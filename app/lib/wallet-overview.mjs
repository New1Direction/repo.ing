import { PublicKey } from '@solana/web3.js'
import { discoveryEarned } from '../../src/discovery-rewards.mjs'

export function walletTokenBalances(accounts, wallet) {
  const balances = new Map()
  for (const { account } of accounts) {
    const data = account.data
    if (!Buffer.isBuffer(data) || data.length !== 72) throw new Error('Invalid token account data')
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
