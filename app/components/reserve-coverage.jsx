import { formatSolDisplay } from '../lib/format.mjs'

export function ReserveCoverage({ coverage }) {
  if (coverage?.status === 'NO_RESERVES') return null
  if (!coverage || coverage.status === 'UNVERIFIED') return <p className="subtle-notice">Reserve wallet coverage is not verified. Allocations below are ledger amounts, not confirmed spendable balances.</p>
  return <div className="subtle-notice" role="status">
    <strong>{coverage.status === 'SHORTFALL' ? 'Reserve custody needs review.' : 'Receiving wallet balance checked.'}</strong>{' '}
    The <a href={`https://explorer.solana.com/address/${coverage.wallet}`} target="_blank" rel="noopener noreferrer">recorded receiving wallet</a> held {formatSolDisplay(coverage.walletBalance)} SOL against {formatSolDisplay(coverage.required)} SOL in remaining buyback, liquidity, and unallocated reserves.
    {coverage.status === 'SHORTFALL' && <> The {formatSolDisplay(coverage.shortfall)} SOL difference needs reconciliation before these allocations can be described as funded.</>}
    {' '}Two finalized RPC reads, {new Date(coverage.checkedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC. This check does not authorize spending or assign a purpose to external transfers.
  </div>
}
