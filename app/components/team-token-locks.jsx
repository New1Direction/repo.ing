import { LockKeyhole, ArrowUpRight } from 'lucide-react'
import { OFFICIAL_TEAM_LOCKS, lockNote, stillLockedBaseUnits } from '../lib/official-team-locks.mjs'
import { FIXED_SUPPLY_BASE_UNITS, percentLabel, sharePercent } from '../../src/trust-signals.mjs'
import { formatTokenShort } from '../lib/token-amount.mjs'
import { CopyAddress } from './copy-address'
import '../team-locks.css'

const date = (value, exact = false) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  ...(exact ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
}).format(new Date(value))
// Recorded whole-token amounts ('11,111,111', '5,666,666.666666'): compact for the list, exact on hover and in the schedule.
const wholeTokens = value => value.replaceAll(',', '').split('.')[0]
const compact = value => formatTokenShort(wholeTokens(value), 0)
const exact = value => Number(value.replaceAll(',', '')).toLocaleString('en-US', { maximumFractionDigits: 2 })
const supplyShare = value => percentLabel(sharePercent(BigInt(wholeTokens(value)) * 1_000_000n, FIXED_SUPPLY_BASE_UNITS))

// The official token's Jupiter locks (token page and /stats): the share still locked on top (the same figure as Launch
// facts), one compact row per lock, and the terms, wallets and full release schedules folded under "Lock details".
// Totals derive from the published locks so a new lock only needs adding to the list.
export function TeamTokenLocks({ now = Date.now() }) {
  const locked = percentLabel(sharePercent(stillLockedBaseUnits(now), FIXED_SUPPLY_BASE_UNITS))
  const deposited = OFFICIAL_TEAM_LOCKS.reduce((sum, lock) => sum + BigInt(wholeTokens(lock.deposited)), 0n)
  return <section id="team-locks" className="inner-card team-locks" aria-labelledby="team-locks-title">
    <div className="team-locks-heading"><div><h2 id="team-locks-title"><LockKeyhole size={18} aria-hidden="true"/>Token locks</h2>
      <p>{formatTokenShort(deposited, 0)} $REPOING in {OFFICIAL_TEAM_LOCKS.length} Jupiter locks. None can be cancelled.</p></div>
      <span className="badge">{locked} of supply locked</span></div>
    <ol className="team-locks-list">{OFFICIAL_TEAM_LOCKS.map(lock => <li key={lock.escrow} className="team-locks-row">
      <span className="team-locks-name"><strong>{lock.name}</strong><small>{supplyShare(lock.deposited)} of supply</small></span>
      <strong className="team-locks-amount" title={`${lock.deposited} REPOING`}>{compact(lock.deposited)}</strong>
      <span className="team-locks-dates"><time dateTime={lock.releases[0].at}>{date(lock.releases[0].at)}</time> to <time dateTime={lock.releases.at(-1).at}>{date(lock.releases.at(-1).at)}</time></span>
      <a href={`https://lock.jup.ag/escrow/${lock.escrow}`} target="_blank" rel="noopener noreferrer" aria-label={`View ${lock.name} on Jupiter Lock`}>Jupiter<ArrowUpRight size={14} aria-hidden="true"/></a>
    </li>)}</ol>
    <details className="team-locks-details"><summary>Lock details</summary>
      <p>Every lock disables cancellation and recipient changes; tokens become claimable on each schedule. {lockNote(OFFICIAL_TEAM_LOCKS)} Locked
        means a release date has not come yet. Terms were verified on-chain when each lock was recorded; current claim status is on Jupiter. Dates are UTC.</p>
      {OFFICIAL_TEAM_LOCKS.map(lock => <div key={lock.escrow} className="team-locks-terms-row">
        <h3>{lock.name}</h3>
        <p className="team-locks-wallet"><span>Creator and recipient: {lock.wallet.label}</span><CopyAddress address={lock.wallet.address} label={`${lock.wallet.label} address`} compact/></p>
        <p>{lock.deposited} REPOING deposited · terms verified <time dateTime={lock.verifiedAt}>{date(lock.verifiedAt)}</time></p>
        <ol>{lock.releases.map(release => <li key={release.at}><time dateTime={release.at}>{date(release.at, true)} UTC</time><span title={`${release.amount} REPOING`}>{exact(release.amount)} REPOING</span></li>)}</ol>
      </div>)}
    </details>
  </section>
}
