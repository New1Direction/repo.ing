import { CalendarClock, Sprout } from 'lucide-react'
import { NEW_REPO_NOTE, repoFactsView } from '../lib/repo-quality.mjs'
import '../market-signals.css'

// Launch review: the repository's age and stars from GitHub and, for a new repository, why repo.ing won't feature its
// market yet. Information only: launching is never blocked.
export function LaunchRepoFacts({ repo, now = Date.now() }) {
  // Not launched yet, so a new repository has earned nothing: labeled whenever it is new.
  const facts = repoFactsView(repo, null, now)
  const Icon = facts.labeled ? Sprout : CalendarClock
  const age = facts.age ? `Created ${facts.age} ago` : 'Creation date unavailable'
  return <p className={`launch-repo-facts${facts.labeled ? ' is-new' : ''}`} role="note">
    <Icon size={18} aria-hidden="true"/>
    <span>{facts.labeled && <><strong>{NEW_REPO_NOTE}</strong> </>}{age} · {facts.stars}{facts.labeled ? '. You can still launch it.' : ''}</span>
  </p>
}
