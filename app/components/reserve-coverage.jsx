import { formatSolDisplay } from '../lib/format.mjs'

export function ReserveCoverage({ coverage }) {
  if (coverage?.status === 'NO_RESERVES') return null
  if (!coverage || coverage.status === 'UNVERIFIED') return <p className="subtle-notice">Reserve balances are being verified. The figures below show recorded allocations.</p>
  return <div className="subtle-notice" role="status">
    {coverage.status === 'SHORTFALL'
      ? <>Reserve balances need reconciliation. The figures below are recorded allocations, not available spending balances.</>
      : <>Reserve balance checked: {formatSolDisplay(coverage.walletBalance)} SOL.</>}
  </div>
}
