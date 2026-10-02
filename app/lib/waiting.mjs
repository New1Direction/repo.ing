import { formatSolDisplay, formatSolRounded, formatUsdEstimate } from './format.mjs'
import { SITE_ORIGIN } from './share-links.mjs'
import { isGithubRepoId } from '../../src/market-identity.mjs'

// Public "Waiting for maintainers" board. Amounts are the market list's indexed builder fee credits
// minus settled claims (`remaining`): the same figure Explore shows as "Builders earned". They are not
// re-verified on-chain here; the claim page reconciles against chain state before any payout.
export const WAITING_LIMIT = 100
export const RECENTLY_CLAIMED_LIMIT = 4
export const X_POST_LIMIT = 280
// X shortens every link to a t.co URL of this length, joined to the text with one space.
const X_URL_WEIGHT = 23

const lamports = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n

// Waiting = nobody has verified GitHub admin access or bound a payout wallet, and fees are accruing.
// Repositories whose maintainers asked not to be contacted (a dismissed invite) are never listed. GitHub markets only
// (decided by the id range, src/market-identity.mjs): the board asks maintainers to verify with GitHub.
export function selectWaiting(markets = [], { optedOut = new Set(), limit = Infinity } = {}) {
  return markets
    .filter(m => isGithubRepoId(m.repoId) && !m.beneficiaryWallet && !m.wasVerified && lamports(m.remaining) > 0n && !optedOut.has(String(m.repoId)))
    .sort((a, b) => {
      const diff = lamports(b.remaining) - lamports(a.remaining)
      if (diff !== 0n) return diff > 0n ? 1 : -1
      return (Number(b.stars) || 0) - (Number(a.stars) || 0) || String(a.repoId).localeCompare(String(b.repoId))
    })
    .slice(0, limit)
}

export const waitingTotal = rows => rows.reduce((sum, row) => sum + lamports(row.remaining), 0n).toString()

// USD first; SOL when no price is available. `sol` is the secondary "≈ N SOL" line (only beside USD).
export function amountDisplay(raw, usdPerSol) {
  const usd = formatUsdEstimate(raw, usdPerSol)
  return { value: usd ?? `${formatSolDisplay(raw)} SOL`, sol: usd ? `≈ ${formatSolRounded(raw)} SOL` : null }
}

export const waitingAnchor = repoId => `repo-${repoId}`
export const claimPageUrl = (repoId, origin = SITE_ORIGIN) => `${origin}/claim/${encodeURIComponent(String(repoId))}`
export const waitingRowUrl = (repoId, origin = SITE_ORIGIN) => `${origin}/waiting#${waitingAnchor(repoId)}`

// X weighs most CJK and emoji as two characters; count anything outside Latin/Greek/Cyrillic-ish ranges as 2.
export function xWeightedLength(text) {
  let length = 0
  for (const char of text) length += char.codePointAt(0) <= 0x10ff ? 1 : 2
  return length
}

// Unverified repositories have no linked X account, so the GitHub owner is named without "@" and the
// poster can swap in the maintainer's handle. Falls back to a shorter text when a long name would not fit.
export function tagText({ owner, fullName, amount }) {
  const name = String(owner || String(fullName ?? '').split('/')[0] || 'Maintainers')
  const full = `${name}, you have ${amount} in builder fees waiting on repo.ing for ${fullName}. Verify with GitHub and claim 👉`
  if (xWeightedLength(full) + 1 + X_URL_WEIGHT <= X_POST_LIMIT) return full
  return `${name.slice(0, 39)}, you have ${amount} in builder fees waiting on repo.ing. Verify with GitHub and claim 👉`
}

export function tagIntentUrl({ repoId, owner, fullName, amount, origin = SITE_ORIGIN }) {
  const query = new URLSearchParams({ text: tagText({ owner, fullName, amount }), url: claimPageUrl(repoId, origin) })
  return `https://x.com/intent/post?${query}`
}

// Latest settled payouts, one per market, newest first.
export function recentlyClaimed(payouts = [], limit = RECENTLY_CLAIMED_LIMIT) {
  const seen = new Set()
  return payouts.filter(p => p?.mint && !seen.has(p.mint) && seen.add(p.mint)).slice(0, limit)
}
