import Link from 'next/link'
import { Search } from 'lucide-react'
import { claimHref } from '../lib/claim-funnel.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import { ownerTotal } from '../lib/owner-lookup.mjs'

const STATUS = { waiting: 'Not claimed yet: verify with GitHub', verified: 'Verified: payout wallet needed', wallet: 'Payout wallet set' }

// The public owner lookup on /builders (app/lib/owner-lookup.mjs). rows is null before a search.
export function OwnerLookup({ owner, defaultOwner = '', rows = null, unavailable = null }) {
  return <section className="owner-lookup inner-card" aria-labelledby="owner-lookup-title">
    <h2 id="owner-lookup-title">Find builder fees for a GitHub account or organization</h2>
    <p>No sign-in needed. See what is waiting for any owner.</p>
    <form action="/builders" method="get" role="search"><label className="sr-only" htmlFor="owner-lookup-input">GitHub user or organization</label>
      <input id="owner-lookup-input" name="owner" defaultValue={owner ?? defaultOwner} placeholder="GitHub user or organization" autoComplete="off" spellCheck={false} maxLength={39}/>
      <button className="button outline" type="submit"><Search size={15} aria-hidden="true"/>Find fees</button></form>
    {unavailable ? <p className="inline-error" role="status">{unavailable}</p> : rows === null ? null : !rows.length ?
      <p className="owner-lookup-total" role="status">No repo.ing markets found for <strong>{owner}</strong>. Check the spelling, or <Link href="/launch">launch a repository</Link>.</p> : <>
      <p className="owner-lookup-total" role="status"><strong>{formatSolDisplay(ownerTotal(rows))} SOL</strong> unclaimed across {rows.length} {rows.length === 1 ? 'repository' : 'repositories'} owned by {owner}.</p>
      <ul className="owner-lookup-results">{rows.map(row => <li key={row.repoId}><div><strong>{row.fullName}</strong><small>{row.remaining !== '0' && `${formatSolDisplay(row.remaining)} SOL unclaimed · `}{STATUS[row.status]}</small></div>
        <Link className={`button ${row.remaining !== '0' && row.status !== 'wallet' ? 'primary' : 'outline'}`} href={claimHref(row.repoId, 'lookup')}>{row.status === 'wallet' ? 'Manage' : 'Claim'}<span className="sr-only"> {row.fullName}</span></Link></li>)}</ul>
      <p className="muted">The claim page checks the balance again before any payout. Only a current GitHub admin of a repository can claim it.</p></>}
  </section>
}

// /waiting's header: a maintainer jumps straight to the owner lookup on /builders.
export function MaintainerLookupForm() {
  return <form className="waiting-maintainer-lookup" action="/builders" method="get" role="search" aria-label="Maintainers: find your repositories">
    <label className="sr-only" htmlFor="waiting-owner">Your GitHub user or organization</label>
    <input id="waiting-owner" name="owner" placeholder="Your GitHub user or org" autoComplete="off" spellCheck={false} maxLength={39}/>
    <button className="button outline" type="submit">Maintainer? Find your fees</button>
  </form>
}
