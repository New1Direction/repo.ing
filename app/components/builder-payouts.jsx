import Link from 'next/link'
import { PayoutAnchor } from './payout-anchor'
import { ArrowUpRight, CircleCheck } from 'lucide-react'
import { formatUnits, formatSolDisplay, formatUsdEstimate } from '../lib/format.mjs'

export function BuilderPayouts({ payouts, unavailable, usdPerSol }) {
  return <section id="builder-payouts" className="builder-payouts" tabIndex={-1} aria-labelledby="recent-payouts-title">
    <PayoutAnchor/>
    <div className="builder-list-heading"><div><h2 id="recent-payouts-title">Recent builder payouts</h2><p>Completed payouts to repository builders.</p></div><Link href="/builders" className="button outline">Claim your fees</Link></div>
    {unavailable ? <p className="builder-empty" role="status">Recent payouts are temporarily unavailable.</p> : !payouts.length ? <p className="builder-empty">Completed builder payouts will appear here.</p> :
      <div className="payout-list">{payouts.map(payout => <div className="payout-row" key={payout.signature}>
        <CircleCheck size={18} aria-label="Settled"/><div className="payout-repo"><Link href={`/token/${payout.mint}`}>{payout.fullName}</Link><time dateTime={new Date(payout.settledAt).toISOString()}>{new Date(payout.settledAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'UTC'})} UTC</time></div>
        <div className="payout-amount" title={`${formatUnits(payout.amount)} SOL`}><strong>{formatSolDisplay(payout.amount)} SOL</strong>{formatUsdEstimate(payout.amount,usdPerSol) && <small>≈ {formatUsdEstimate(payout.amount,usdPerSol)}</small>}</div>
        <a href={`https://solscan.io/tx/${payout.signature}`} target="_blank" rel="noreferrer" className="payout-receipt" aria-label={`View payout to ${payout.fullName} on Solscan`}>Receipt <ArrowUpRight size={16}/></a>
      </div>)}</div>}
  </section>
}
