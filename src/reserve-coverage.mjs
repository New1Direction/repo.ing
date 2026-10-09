const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const amount = value => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw Error('Invalid accounting amount')
  return BigInt(value)
}

// A balance check is separate from ledger reconciliation. It does not classify
// external transfers as spending, move allocations, or authorize execution.
export function evaluateReserveCoverage(platform, observations) {
  if (platform.status !== 'MATCH') return { status: 'UNVERIFIED' }
  const required = amount(platform.buybackReserve) + amount(platform.liquidityReserve) + amount(platform.unallocated)
  const wallets = platform.custodyWallets ?? []
  if (!wallets.length && required === 0n) return { status: 'NO_RESERVES' }
  // Multiple receiving wallets require a per-allocation custody review; never
  // use another wallet's funds to hide a shortfall in the recorded receiver.
  // No balance is read or compared for them: the page says the reserves are held
  // in that many wallets and shows the recorded allocations (MULTIPLE_WALLETS).
  if (wallets.length > 1) return { status: 'MULTIPLE_WALLETS', walletCount: wallets.length }
  if (wallets.length !== 1 || observations.length !== 2) return { status: 'UNVERIFIED' }
  const [a, b] = observations
  if ([a, b].some(x => x.wallet !== wallets[0] || x.genesis !== MAINNET_GENESIS ||
      !Number.isSafeInteger(x.slot) || x.slot <= 0) || Math.abs(a.slot - b.slot) > 150 || a.balance !== b.balance)
    return { status: 'UNVERIFIED' }
  const balance = amount(a.balance)
  return { status: balance < required ? 'SHORTFALL' : 'COVERED', wallet: wallets[0],
    walletBalance: balance.toString(), required: required.toString(),
    shortfall: (balance < required ? required - balance : 0n).toString(), slots: [a.slot, b.slot] }
}

export async function readReserveCoverage(platform, { env = process.env, fetchImpl = fetch } = {}) {
  try {
    const wallets = platform.custodyWallets ?? []
    if (platform.status !== 'MATCH' || wallets.length !== 1) return evaluateReserveCoverage(platform, [])
    const urls = [env.SOLANA_RPC_URL, env.GRADUATION_VERIFICATION_RPC_URL]
    if (urls.some(url => !url) || urls[0] === urls[1]) return { status: 'UNVERIFIED' }
    const observations = await Promise.all(urls.map(async url => {
      const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        cache: 'no-store', signal: AbortSignal.timeout(2500), body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'getGenesisHash' },
          { jsonrpc: '2.0', id: 2, method: 'getBalance', params: [wallets[0], { commitment: 'finalized' }] },
        ]) })
      if (!response.ok) throw Error('RPC unavailable')
      const result = await response.json()
      if (!Array.isArray(result)) throw Error('Invalid RPC response')
      const genesis = result.find(x => x.id === 1), balance = result.find(x => x.id === 2)
      if (genesis?.error || balance?.error || !Number.isSafeInteger(balance?.result?.value) || balance.result.value < 0)
        throw Error('RPC balance unavailable')
      return { wallet: wallets[0], genesis: genesis?.result, slot: balance.result.context?.slot, balance: String(balance.result.value) }
    }))
    return { ...evaluateReserveCoverage(platform, observations), checkedAt: new Date().toISOString() }
  } catch { return { status: 'UNVERIFIED' } }
}
