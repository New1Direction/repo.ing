import { isGithubRepoId } from '../../src/market-identity.mjs'

// /builders?owner=: a maintainer finds the markets for their GitHub account or organization without signing in, including
// repositories not yet shared with the GitHub App (the dashboard only lists those). Public figures only, from the shared
// market list: the same indexed builder fee credits minus settled claims as Explore and /waiting. The claim page checks
// the chain before any payout.
export const OWNER_LOOKUP_LIMIT = 50
const lamports = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n

export function ownerRepositories(markets = [], owner, limit = OWNER_LOOKUP_LIMIT) {
  const wanted = String(owner ?? '').toLowerCase()
  if (!wanted) return []
  return markets.filter(m => isGithubRepoId(m.repoId) && String(m.owner ?? '').toLowerCase() === wanted)
    .map(m => ({ repoId: String(m.repoId), fullName: m.fullName, mint: m.mint, stars: Number(m.stars) || 0, remaining: lamports(m.remaining).toString(),
      // wallet: a payout wallet is set; verified: an admin verified but set no wallet yet; waiting: nobody has.
      status: m.beneficiaryWallet ? 'wallet' : m.wasVerified ? 'verified' : 'waiting' }))
    .sort((a, b) => { const diff = BigInt(b.remaining) - BigInt(a.remaining); return diff !== 0n ? (diff > 0n ? 1 : -1) : b.stars - a.stars || a.fullName.localeCompare(b.fullName) })
    .slice(0, limit)
}

export const ownerTotal = rows => rows.reduce((sum, row) => sum + BigInt(row.remaining), 0n).toString()
