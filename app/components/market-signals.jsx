import { BadgeCheck, Sprout } from 'lucide-react'
import { NEW_REPO_DAYS, NEW_REPO_MIN_STARS, PROMOTION_MIN_PERCENT } from '../lib/repo-quality.mjs'
import '../market-signals.css'

// Market rows, cards and the token page header (server and client safe). In lists Official takes the Verified badge's
// place: the maintainer is verified and launched the market from their payout wallet. compact: small cards.
export const OFFICIAL_TITLE = "Official: launched by the repository's verified maintainer, from the payout wallet they set on repo.ing"
export const NEW_REPO_TITLE = `New repo: created in the last ${NEW_REPO_DAYS} days or fewer than ${NEW_REPO_MIN_STARS} stars on GitHub. `
  + `repo.ing features it only after it reaches ${PROMOTION_MIN_PERCENT}% of its graduation target.`

export function OfficialBadge({ compact = false }) {
  return <span className={`badge official${compact ? ' compact' : ''}`} title={OFFICIAL_TITLE}>
    <BadgeCheck size={compact ? 11 : 13} strokeWidth={2.4} aria-hidden="true"/><span>Official</span></span>
}

export function NewRepoLabel({ compact = false }) {
  return <span className={`badge new-repo${compact ? ' compact' : ''}`} title={NEW_REPO_TITLE}>
    <Sprout size={compact ? 11 : 12} strokeWidth={2.4} aria-hidden="true"/><span>New repo</span></span>
}
