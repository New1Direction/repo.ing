import { formatSolDisplay } from '../lib/format.mjs'

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const countWord = count => COUNT_WORDS[count] ?? String(count)

// MULTIPLE_WALLETS (src/reserve-coverage.mjs): platform revenue was received in more than one wallet, and no balance is checked
// for them, so the notice says where the reserves are held instead of claiming a check is in progress.
export function ReserveCoverage({ coverage }) {
  if (coverage?.status === 'NO_RESERVES') return null
  if (coverage?.status === 'MULTIPLE_WALLETS') return <p className="subtle-notice">Reserves are held in {countWord(coverage.walletCount)} wallets. The figures below show the recorded allocations, not wallet balances.</p>
  if (!coverage || coverage.status === 'UNVERIFIED') return <p className="subtle-notice">Reserve balances are being verified. The figures below show recorded allocations.</p>
  return <div className="subtle-notice" role="status">
    {coverage.status === 'SHORTFALL'
      ? <>Reserve balances need reconciliation. The figures below are recorded allocations, not available spending balances.</>
      : <>Reserve balance checked: {formatSolDisplay(coverage.walletBalance)} SOL.</>}
  </div>
}
