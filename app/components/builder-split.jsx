import { formatSolDisplay } from '../lib/format.mjs'
import { shareLabel, splitShare } from '../lib/builder-split.mjs'
import { TEAM_REPO_OWNERS } from '../../src/protocol-analytics.mjs'
import '../builder-split.css'

// /stats hero: one builder figure split between outside builders and the repo.ing team's own repositories. The two parts
// add up to the figure above them.
export function BuilderSplit({ split }) {
  if (!split) return null
  const total = BigInt(split.outside) + BigInt(split.team)
  const outside = splitShare(split.outside, total), team = splitShare(split.team, total)
  return <div className="builder-split">
    {outside !== null && <span className="builder-split-bar" aria-hidden="true"><span style={{ width: `${outside}%` }}/></span>}
    <dl>
      <div><dt><i className="is-outside" aria-hidden="true"/>Outside builders</dt><dd>{formatSolDisplay(split.outside)} SOL{outside !== null && <small>{shareLabel(outside)}</small>}</dd></div>
      <div><dt><i className="is-team" aria-hidden="true"/>repo.ing team repos</dt><dd>{formatSolDisplay(split.team)} SOL{team !== null && <small>{shareLabel(team)}</small>}</dd></div>
    </dl>
  </div>
}

export function BuilderSplitNote() {
  return <p className="builder-split-note">Team repos are the repo.ing team&apos;s own repositories (GitHub owner {TEAM_REPO_OWNERS.join(', ')}),
    repo.ing itself included. Their builder fees are paid to the team, so they are counted apart from outside builders. The totals include both.</p>
}
