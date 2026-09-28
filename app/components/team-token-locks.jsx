import { LockKeyhole, ArrowUpRight } from 'lucide-react'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'
import { OFFICIAL_TEAM_LOCKS } from '../lib/official-team-locks.mjs'
import { CopyAddress } from './copy-address'

const date = (value, exact = false) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  ...(exact ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : {}),
}).format(new Date(value))

export function TeamTokenLocks() {
  return <section id="team-locks" className="inner-card team-locks" aria-labelledby="team-locks-title">
    <div className="team-locks-heading"><div><h2 id="team-locks-title"><LockKeyhole size={18} aria-hidden="true"/>Team token locks</h2><p>45,000,000 $REPOING deposited into Jupiter Lock.</p></div><span className="badge">4.5% of fixed supply</span></div>
    <p className="team-locks-terms">Both locks disable cancellation and recipient changes. Tokens become claimable on the schedules below.</p>
    <div className="team-locks-grid">{OFFICIAL_TEAM_LOCKS.map(lock => <article key={lock.escrow} className="team-lock">
      <div className="card-heading"><h3>{lock.name}</h3><span>{lock.supplyPercent} of supply</span></div>
      <div className="team-lock-amount"><strong>{lock.deposited}</strong><span>REPOING deposited</span></div>
      <dl><div><dt>First release</dt><dd><time dateTime={lock.releases[0].at}>{date(lock.releases[0].at)}</time></dd></div><div><dt>Final release</dt><dd><time dateTime={lock.releases.at(-1).at}>{date(lock.releases.at(-1).at)}</time></dd></div></dl>
      <details><summary>Release schedule · UTC</summary><ol>{lock.releases.map(release => <li key={release.at}><time dateTime={release.at}>{date(release.at, true)} UTC</time><strong>{release.amount} REPOING</strong></li>)}</ol></details>
      <a className="button outline" href={`https://lock.jup.ag/escrow/${lock.escrow}`} target="_blank" rel="noopener noreferrer" aria-label={`View ${lock.name} on Jupiter Lock`}>View on Jupiter Lock <ArrowUpRight size={15} aria-hidden="true"/></a>
    </article>)}</div>
    <div className="team-locks-wallet"><span>Creator & recipient · team wallet</span><CopyAddress address={OFFICIAL_TOKEN.teamWallet} label="team wallet address" compact/></div>
    <p className="team-locks-note">Original deposits from the existing supply. These two escrows are separate from the 1% builder allocation after graduation and other team-wallet holdings. Dates are UTC. Terms verified Sep 28, 2026; current claim status is available on Jupiter.</p>
  </section>
}
