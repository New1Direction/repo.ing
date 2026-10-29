import { formatSolDisplay } from '../lib/format.mjs'
import { shareLabel, splitShare } from '../lib/builder-split.mjs'
import { TEAM_REPO_OWNERS } from '../../src/protocol-analytics.mjs'
import '../builder-split.css'

// /stats: one builder figure split between outside builders and the repo.ing team's own repositories. The two parts add
// up to the hero figure.
export function BuilderSplit({ split, label }) {
  if (!split) return null
  const total = BigInt(split.outside) + BigInt(split.team)
  const outside = splitShare(split.outside, total), team = splitShare(split.team, total)
  return <div className="builder-split">
    {label && <strong className="builder-split-label">{label}</strong>}
    {outside !== null && <span className="builder-split-bar" aria-hidden="true"><span style={{ width: `${outside}%` }}/></span>}
    <dl>
      <div><dt><i className="is-outside" aria-hidden="true"/>Outside builders</dt><dd>{formatSolDisplay(split.outside)} SOL{outside !== null && <small>{shareLabel(outside)}</small>}</dd></div>
      <div><dt><i className="is-team" aria-hidden="true"/>repo.ing team repos</dt><dd>{formatSolDisplay(split.team)} SOL{team !== null && <small>{shareLabel(team)}</small>}</dd></div>
    </dl>
  </div>
}

// Folded under the hero: who the builder figures went to. The totals above include both sides.
export function BuilderSplitDetails({ builders }) {
  if (!builders) return null
  return <details className="analytics-data builder-split-details"><summary>Outside builders vs. repo.ing team</summary>
    <div className="builder-split-pair"><BuilderSplit split={builders.paid} label="Paid"/><BuilderSplit split={builders.earned} label="Earned"/></div>
    <p className="builder-split-note">Team repos are repo.ing&apos;s own repositories (GitHub owner {TEAM_REPO_OWNERS.join(', ')}). Their builder fees go to the team.</p>
  </details>
}
