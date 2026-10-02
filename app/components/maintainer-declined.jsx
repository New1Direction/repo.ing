import Link from 'next/link'
import { cookies } from 'next/headers'
import { Ban } from 'lucide-react'
import { MaintainerDecision } from './maintainer-decision'
import { githubSessionCookie, readGithubSession } from '../lib/auth.mjs'
import { maintainerDecision } from '../lib/maintainer-opt-outs.mjs'
import { OPT_OUT_ERROR } from '../../src/maintainer-opt-outs.mjs'
import '../maintainer-opt-out.css'

const dayLabel = value => new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })

function MaintainerNote({ note }) {
  return note ? <blockquote className="declined-note"><span>Note from the maintainer</span><p>{note}</p></blockquote> : null
}

// Token page, above everything else, while a maintainer's decline is active.
export function DeclinedBanner({ fullName, decision }) {
  return <div className="declined-banner" role="note">
    <span className="declined-banner-icon" aria-hidden="true"><Ban size={20}/></span>
    <div className="declined-banner-copy">
      <p className="declined-banner-lead"><strong>The maintainer of {fullName} has declined this market.</strong> repo.ing does not promote it, and it is not endorsed by the project.</p>
      <MaintainerNote note={decision.note}/>
      <p className="declined-meta">Declined by a verified GitHub admin on <time dateTime={decision.createdAt}>{dayLabel(decision.createdAt)}</time>. Trading stays open so holders can exit.</p>
    </div>
  </div>
}

// Launch page for a repository without a market whose maintainer opted out (decision), or whose opt-out status cannot be
// read (undefined): no launch form either way.
export function LaunchBlocked({ repo, decision }) {
  if (decision === undefined) return <section className="launch-blocked inner-card" aria-labelledby="launch-blocked-title">
    <h1 id="launch-blocked-title">Launch review unavailable</h1><p>Launch checks are temporarily unavailable. Try again shortly.</p>
    <div className="launch-blocked-actions"><Link href={`/launch/${repo.repoId}`} className="button outline">Try again</Link></div>
  </section>
  return <section className="launch-blocked inner-card" aria-labelledby="launch-blocked-title">
    <span className="declined-banner-icon" aria-hidden="true"><Ban size={20}/></span>
    <h1 id="launch-blocked-title">Launch unavailable</h1>
    <p className="launch-blocked-lead">{OPT_OUT_ERROR}.</p>
    <MaintainerNote note={decision.note}/>
    <p className="declined-meta">A verified GitHub admin of {repo.fullName} opted it out on <time dateTime={decision.createdAt}>{dayLabel(decision.createdAt)}</time>. repo.ing will not launch, suggest or promote it.</p>
    <div className="launch-blocked-actions"><Link href="/find-repos" className="button outline">Find another repository</Link><Link href="/opt-out" className="launch-blocked-manage">Maintainer? Manage this opt-out →</Link></div>
  </section>
}

// Claim page: decline the market (or withdraw a decline). Offered to any GitHub session for this repository or the builder
// dashboard; the server checks current admin access again on every change.
export async function ClaimPageDecision({ market }) {
  const [cookieStore, decision] = await Promise.all([cookies(), maintainerDecision(market.repoId)])
  if (decision === undefined) return null
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  const canAct = Boolean(session && (session.repoId === String(market.repoId) || session.scope === 'builders'))
  return <MaintainerDecision repoId={String(market.repoId)} fullName={market.fullName} live decision={decision} canAct={canAct}/>
}
