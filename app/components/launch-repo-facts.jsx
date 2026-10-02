import { CalendarClock, Sprout } from 'lucide-react'
import { NEW_REPO_NOTE, repoFactsView } from '../lib/repo-quality.mjs'
import '../market-signals.css'

// Launch review: the repository's age and stars from GitHub and, for a new repository, why repo.ing won't feature its
// market yet. Information only: launching is never blocked.
export function LaunchRepoFacts({ repo, now = Date.now() }) {
  const facts = repoFactsView(repo, null, now)
  const Icon = facts.isNew ? Sprout : CalendarClock
  const age = facts.age ? `Created ${facts.age} ago` : 'Creation date unavailable'
  return <p className={`launch-repo-facts${facts.isNew ? ' is-new' : ''}`} role="note">
    <Icon size={18} aria-hidden="true"/>
    <span>{facts.isNew && <><strong>{NEW_REPO_NOTE}</strong> </>}{age} · {facts.stars}{facts.isNew ? '. You can still launch it.' : ''}</span>
  </p>
}
