import Link from 'next/link'
import { GitFork } from 'lucide-react'
import '../maintainer-opt-out.css'

// The launch page of a fork or copy of a repository that already has a market (src/repo-lineage.mjs): no launch form.
export function LaunchCopyBlocked({ error }) {
  const original = error?.original
  return <section className="launch-blocked inner-card" aria-labelledby="launch-blocked-title">
    <span className="declined-banner-icon" aria-hidden="true"><GitFork size={20}/></span>
    <h1 id="launch-blocked-title">Launch unavailable</h1>
    <p className="launch-blocked-lead">{error?.message}</p>
    <p className="declined-meta">One market per project, so buyers never mistake a copy for the original. A fork of a repository without a market can still launch.</p>
    <div className="launch-blocked-actions">{original?.mint ? <Link href={`/token/${original.mint}`} className="button primary">Open {original.fullName}'s market</Link>
      : null}<Link href="/explore" className="button outline">Explore markets</Link></div>
  </section>
}
