import Link from 'next/link'
import { ArrowRight, ArrowUpRight, ChevronDown, Star, TrendingUp } from 'lucide-react'
import { RepoAvatar } from './ui'
import { ForkOfLabel } from './market-signals'
import { IconArt } from './icon-art'
import { launcherRewardTerms } from '../../src/trend-launchable.mjs'
import { ageLabel, compactCount, rewardLimits, rewardShort, starGrowth, trendSignals } from '../lib/trend-launch-display.mjs'
import '../trending-launches.css'

// "Launch a trending repo" on /find-repos and its short strip on /launch. Server-rendered from one cached read
// (app/lib/trending-launches.mjs), so there is no client JavaScript and nothing shifts after load.
const VISIBLE_ROWS = 8
const MAX_ROWS = 48
const STRIP_ROWS = 3

function Signals({ repo, now, compact }) {
  const growth = compact && repo.starsGained ? starGrowth(repo.starsGained) : null
  // The full list shows every live signal and when it was checked; strip rows keep their strongest one.
  const signals = compact ? (growth ? [] : trendSignals(repo, now).slice(0, 1)) : trendSignals(repo, now)
  return <div className="trend-launch-signals">
    {(growth || signals.length > 0) && <ul aria-label="Trend evidence">
      {growth && <li className="growth"><TrendingUp size={13} aria-hidden="true"/>{growth.value} {growth.window}</li>}
      {signals.map(signal => <li key={signal.key}>{signal.text}</li>)}
    </ul>}
    <span className="trend-launch-meta">
      {compact && repo.stars !== null && <span><Star size={12} aria-hidden="true"/>{compactCount(repo.stars)}<span className="sr-only"> GitHub stars</span></span>}
      {repo.language && <span>{repo.language}</span>}
      {!compact && <span>Checked {ageLabel(repo.observedAt, now)}</span>}
    </span>
  </div>
}

function Stat({ repo }) {
  if (repo.starsGained) {
    const growth = starGrowth(repo.starsGained)
    return <div className="trend-launch-stat growing"><strong>{growth.value}</strong><span>{growth.window}</span>
      {repo.stars !== null && <span className="trend-launch-total"><Star size={12} aria-hidden="true"/>{compactCount(repo.stars)}<span className="sr-only"> stars</span> total</span>}</div>
  }
  if (repo.stars === null) return <div className="trend-launch-stat"/>
  return <div className="trend-launch-stat"><strong>{compactCount(repo.stars)}</strong><span>GitHub stars</span></div>
}

function Row({ repo, rank, now, termsId, reward, compact = false }) {
  return <li className="trend-launch-row">
    {!compact && <span className="trend-launch-rank" aria-hidden="true">{String(rank).padStart(2, '0')}</span>}
    <span className="trend-launch-avatar"><RepoAvatar repo={{ avatarUrl: repo.avatarUrl }}/></span>
    <div className="trend-launch-main">
      <a className="trend-launch-name" href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer">
        <span className="trend-launch-owner">{repo.owner}/</span><wbr/><strong>{repo.name}<ArrowUpRight size={14} aria-hidden="true"/></strong>
        <span className="sr-only"> on GitHub (opens in a new tab)</span>
      </a>
      {!compact && repo.description && <p className="trend-launch-description">{repo.description}</p>}
      {repo.forkOf && <ForkOfLabel parent={repo.forkOf} compact/>}
      <Signals repo={repo} now={now} compact={compact}/>
    </div>
    {!compact && <Stat repo={repo}/>}
    <div className="trend-launch-action">
      <Link className="button primary" href={repo.launchHref} aria-label={`Launch ${repo.fullName}`} aria-describedby={termsId}>
        Launch<ArrowRight size={16} aria-hidden="true"/>
      </Link>
      {/* A visual echo of the terms the button already references through aria-describedby. */}
      {reward && <span className="trend-launch-reward" aria-hidden="true">{reward}</span>}
    </div>
  </li>
}

function RewardTerms({ id, terms, discoveryEnabled }) {
  if (!discoveryEnabled) return <p className="trend-launch-terms"><strong>Every trade pays the builders.</strong> Trading fees accrue for the repository’s verified owner.</p>
  return <p className="trend-launch-terms" id={id}><strong>Launcher reward:</strong> your launch wallet earns {terms.sharePercent}% of repo.ing’s share
    of that market’s bonding-curve trading fees, {rewardLimits(terms)}. Rewards depend on trading.{' '}
    <Link href="/how-it-works#discovery">Reward details</Link></p>
}

function TrendState({ unavailable = null }) {
  return <div className="trend-launch-board trend-launch-empty" role={unavailable ? 'status' : undefined}>
    <IconArt name="repository-search" size={88}/>
    <div>
      <h3>{unavailable ? 'Trending repos can’t be shown right now' : 'No trending repos to launch right now'}</h3>
      <p>{unavailable ? `${unavailable} You can still launch any public GitHub repository.`
        : 'New candidates are checked every 30 minutes. Have a repo in mind? You can launch any public GitHub repository.'}</p>
      <Link className="button outline" href="/launch">Launch a repository</Link>
    </div>
  </div>
}

export function TrendingLaunches({ result, discoveryEnabled = false, now = Date.now() }) {
  const terms = launcherRewardTerms()
  const termsId = discoveryEnabled ? 'trend-launch-terms' : undefined
  const reward = discoveryEnabled ? rewardShort(terms) : null
  const visible = result.repos.slice(0, VISIBLE_ROWS), more = result.repos.slice(VISIBLE_ROWS, MAX_ROWS)
  const row = (repo, rank) => <Row key={repo.repoId} repo={repo} rank={rank} now={now} termsId={termsId} reward={reward}/>
  return <section className="trend-launches" id="trending" aria-labelledby="trend-launches-title">
    <div className="trend-launches-head">
      <div className="trend-launches-intro">
        <h2 id="trend-launches-title">Launch a trending repo</h2>
        <p>Public GitHub repositories gaining attention right now, with no market yet. You don’t need to own a repository to launch it.</p>
      </div>
      <RewardTerms id={termsId} terms={terms} discoveryEnabled={discoveryEnabled}/>
    </div>
    {result.unavailable ? <TrendState unavailable={result.unavailable}/> : !result.repos.length ? <TrendState/> :
      <div className="trend-launch-board">
        <ol className="trend-launch-list">{visible.map((repo, index) => row(repo, index + 1))}</ol>
        {more.length > 0 && <details className="trend-launch-more">
          <summary>{more.length} more trending {more.length === 1 ? 'repo' : 'repos'}<ChevronDown size={16} aria-hidden="true"/></summary>
          <ol className="trend-launch-list" start={VISIBLE_ROWS + 1}>{more.map((repo, index) => row(repo, VISIBLE_ROWS + index + 1))}</ol>
        </details>}
      </div>}
    <p className="trend-launches-note">Trend evidence comes from GitHub (stars, forks, releases and commits), GitHub Trending and Hacker News,
      re-checked every few hours. Not listed: repositories that already have a market, archived ones, and ones whose maintainers opted out
      or that repo.ing does not promote. A community launch does not imply the maintainers’ endorsement.</p>
  </section>
}

// /launch: the first few launchable trends under the URL field. The page shows its plain link when this has nothing.
export function TrendingLaunchStrip({ result, discoveryEnabled = false, now = Date.now() }) {
  const repos = result.repos.slice(0, STRIP_ROWS), listed = Math.min(result.repos.length, MAX_ROWS)
  const terms = launcherRewardTerms()
  const termsId = discoveryEnabled ? 'trend-launch-strip-terms' : undefined
  const reward = discoveryEnabled ? rewardShort(terms) : null
  return <section className="trend-launch-strip" aria-labelledby="trend-launch-strip-title">
    <div className="trend-launch-strip-head">
      <h2 id="trend-launch-strip-title">Trending repos you can launch</h2>
      <Link href="/find-repos#trending">{listed > STRIP_ROWS ? <>See all {listed}<span className="sr-only"> trending repos</span></> : 'Find more repos'}<ArrowRight size={14} aria-hidden="true"/></Link>
    </div>
    <ol className="trend-launch-list">{repos.map(repo => <Row key={repo.repoId} repo={repo} compact now={now} termsId={termsId} reward={reward}/>)}</ol>
    {discoveryEnabled && <p className="trend-launch-strip-terms" id={termsId}>Launcher reward: {terms.sharePercent}% of repo.ing’s trading fees on the
      market you launch, {rewardLimits(terms)}.</p>}
  </section>
}
