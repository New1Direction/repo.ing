import { LockKeyhole, ArrowUpRight } from 'lucide-react'
import { OFFICIAL_TEAM_LOCKS, lockNote } from '../lib/official-team-locks.mjs'
import { CopyAddress } from './copy-address'

const date = (value, exact = false) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  ...(exact ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : {}),
}).format(new Date(value))
// Release amounts are recorded exactly (they sum to the deposit); show them rounded, exact on hover.
const tokens = value => Number(value.replaceAll(',', '')).toLocaleString('en-US', { maximumFractionDigits: 2 })

// Totals derive from the published locks so a new lock only needs adding to the list.
const lockedTotal = OFFICIAL_TEAM_LOCKS.reduce((sum, lock) => sum + Number(lock.deposited.replaceAll(',', '')), 0)
const FIXED_SUPPLY = 1_000_000_000

export function TeamTokenLocks() {
  return <section id="team-locks" className="inner-card team-locks" aria-labelledby="team-locks-title">
    <div className="team-locks-heading"><div><h2 id="team-locks-title"><LockKeyhole size={18} aria-hidden="true"/>Token locks</h2><p>{lockedTotal.toLocaleString('en-US')} $REPOING deposited into Jupiter Lock.</p></div><span className="badge">{+(lockedTotal / FIXED_SUPPLY * 100).toFixed(2)}% of fixed supply</span></div>
    <p className="team-locks-terms">Every lock disables cancellation and recipient changes. Tokens become claimable on the schedules below.</p>
    <div className="team-locks-grid">{OFFICIAL_TEAM_LOCKS.map(lock => <article key={lock.escrow} className="team-lock">
      <div className="card-heading"><h3>{lock.name}</h3><span>{lock.supplyPercent} of supply</span></div>
      <div className="team-lock-amount"><strong>{lock.deposited}</strong><span>REPOING deposited</span></div>
      <dl><div><dt>First release</dt><dd><time dateTime={lock.releases[0].at}>{date(lock.releases[0].at)}</time></dd></div><div><dt>Final release</dt><dd><time dateTime={lock.releases.at(-1).at}>{date(lock.releases.at(-1).at)}</time></dd></div>
        <div className="team-lock-wallet"><dt>Creator & recipient</dt><dd><span>{lock.wallet.label}</span><CopyAddress address={lock.wallet.address} label={`${lock.wallet.label} address`} compact/></dd></div>
        <div><dt>Terms verified</dt><dd><time dateTime={lock.verifiedAt}>{date(lock.verifiedAt)}</time></dd></div></dl>
      <details><summary>Release schedule · UTC</summary><ol>{lock.releases.map(release => <li key={release.at}><time dateTime={release.at}>{date(release.at, true)} UTC</time><strong title={`${release.amount} REPOING`}>{tokens(release.amount)} REPOING</strong></li>)}</ol></details>
      <a className="button outline" href={`https://lock.jup.ag/escrow/${lock.escrow}`} target="_blank" rel="noopener noreferrer" aria-label={`View ${lock.name} on Jupiter Lock`}>View on Jupiter Lock <ArrowUpRight size={15} aria-hidden="true"/></a>
    </article>)}</div>
    <p className="team-locks-note">{lockNote(OFFICIAL_TEAM_LOCKS)} Dates are UTC. Terms were verified on-chain when each lock was recorded; current claim status is available on Jupiter.</p>
  </section>
}
