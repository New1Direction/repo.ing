// Browser-safe views of a bundle (app/lib/bundle-state.mjs bundleJson) for the raise page, the token page's vault card and the
// wallet overview. No Solana or Node imports: the pages' client components use these.

// Where a raise stands, from the chain when its account exists, else from the site's row:
// opening (waiting for its creator's wallet), expired (never opened), raising, closing (deadline passed below target: refunds
// open once it is closed on chain), full (waiting for the launch), launching, launched, failed (refunds open).
export function raisePhase(state, now = Date.now()) {
  const chain = state?.chain
  if (!chain) return state?.siteStatus === 'opening' ? 'opening' : 'expired'
  if (chain.status === 'launched') return 'launched'
  if (chain.status === 'failed') return 'failed'
  if (BigInt(chain.raised) >= BigInt(chain.target)) return state.siteStatus === 'launching' ? 'launching' : 'full'
  return now > Date.parse(chain.deadline) ? 'closing' : 'raising'
}

export const PHASE_LABELS = Object.freeze({
  opening: 'Opening', expired: 'Never opened', raising: 'Raising', closing: 'Deadline passed', full: 'Full',
  launching: 'Launching', launched: 'Launched', failed: 'Failed · refunds open',
})

export const PHASE_NOTES = Object.freeze({
  opening: 'This bundle is waiting for its creator\'s wallet. It opens once that transaction lands.',
  expired: 'This bundle was never opened on Solana. Nothing was deposited.',
  raising: 'Deposits are open until the deadline. If the target is not reached by then, every backer gets a full refund.',
  closing: 'The deadline passed before the target was reached. The raise is being closed; then every backer can take a full refund here.',
  full: 'The target is reached. repo.ing launches the market next; if it does not launch within a day, the raise fails and refunds open.',
  launching: 'The launch transaction was sent. The market appears here once it is confirmed.',
  launched: 'The market is live. The vault holds the first tokens; backers earn their share of the partner fees.',
  failed: 'This raise failed. Every backer can take back exactly what they deposited.',
})

// The terms the page shows: the chain's once the account exists, else what the row prepared.
export const raiseFigures = state => state.chain
  ? { raised: state.chain.raised, target: state.chain.target, minDeposit: state.chain.minDeposit, deadline: state.chain.deadline }
  : { raised: '0', target: state.terms.target, minDeposit: state.terms.minDeposit, deadline: state.terms.deadline }

// Percent raised, two decimals, never above 100.
export function raisedPercent(raised, target) {
  const goal = BigInt(target)
  if (goal <= 0n) return 0
  const value = BigInt(raised) * 10_000n / goal
  return Number(value > 10_000n ? 10_000n : value) / 100
}

// Lamports still needed to fill the raise.
export const remainingLamports = (raised, target) => { const left = BigInt(target) - BigInt(raised); return left > 0n ? left : 0n }

// "2d 4h left", "3h 12m left", "12m 30s left"; null once the deadline passed.
export function timeLeft(deadline, now = Date.now()) {
  const seconds = Math.floor((Date.parse(deadline) - now) / 1000)
  if (!(seconds > 0)) return null
  const days = Math.floor(seconds / 86_400), hours = Math.floor(seconds % 86_400 / 3600), minutes = Math.floor(seconds % 3600 / 60)
  if (days) return `${days}d ${hours}h left`
  if (hours) return `${hours}h ${minutes}m left`
  return `${minutes}m ${seconds % 60}s left`
}

// A share in basis points as a percent ("12.5%"; "<0.01%" for a tiny one).
export const sharePercent = bps => bps > 0 && bps < 1 ? '<0.01%' : `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
