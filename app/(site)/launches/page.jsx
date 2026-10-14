import { Suspense } from 'react'
import Link from 'next/link'
import { AppHeader, Footer } from '../../components/ui'
import { ContentSkeleton } from '../../components/loading-skeleton'
import { ExploreNavigation } from '../../components/explore-navigation'
import { calendar } from '../../lib/launch-calendar.mjs'
import { webhooksEnabled } from '../../../src/launch-webhooks.mjs'
import { NOT_LIVE } from '../../../src/launch-mechanism.mjs'
import { RISK_DISCLOSURES } from '../../../src/launch-quality.mjs'
import { activeLaunchFeeTerms } from '../../lib/launch-fee.mjs'
import { guideHref } from '../../lib/launch-guide-funnel.mjs'
import '../../transparency.css'

export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Launch calendar · repo.ing',
  description: 'Scheduled repository market launches, Group launch raises and new markets, with their launch terms and quality reports. Same notice for everyone, as JSON, Atom, iCalendar and webhooks.',
  alternates: { canonical: '/launches', types: { 'application/atom+xml': '/launches.atom' } },
}

const sol = lamports => `${(Number(BigInt(lamports ?? 0)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`
const utc = value => `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC`
const short = value => `${value.slice(0, 4)}…${value.slice(-4)}`
// Failed criteria by name (src/launch-quality.mjs ids).
const FLAG_LABELS = { repo_age: 'repository under 30 days old', repo_adoption: 'under 10 stars', maintainer: 'maintainer not verified or declined',
  launch_buy: 'initial buy above 3%', mint_authorities: 'mint or freeze authority', holder_concentration: 'top 10 hold over 50%',
  launcher_position: 'launcher holds over 10%', organic_volume: 'under 50% organic volume', liquidity_depth: 'no depth within 2%' }
const buyLimit = lamports => BigInt(lamports ?? 0) > 0n ? `initial buy at most ${sol(lamports)}` : 'no initial buy'

export default async function LaunchesPage() {
  // The fee schedule new launches use (DBC_CONFIG), read once per process; null when flat or unreadable.
  const fee = await activeLaunchFeeTerms()
  return <><AppHeader active="explore"/><main className="section-wrap launches-page">
    <ExploreNavigation active="launches"/>
    <header className="launches-intro">
      <div className="eyebrow">LAUNCH CALENDAR</div>
      <h1>Launches, announced in public.</h1>
      <p>A maintainer can schedule their repository&apos;s launch at least an hour ahead. Everyone sees the time, the wallet that will launch it and the most it will buy, at the same moment. Nobody can launch it earlier, and nobody gets an allowlist.</p>
      <nav className="launches-feeds" aria-label="Launch feeds">
        <a href="/launches.ics">Subscribe in your calendar</a><a href="/launches.atom">Atom feed</a><a href="/api/v1/launches">JSON</a>
        <a href="/api/v1/launches/events">Event stream</a>{webhooksEnabled() && <Link href="/launches/manage#webhooks">Webhooks</Link>}
        <a href="https://github.com/new1direction/repo.ing/blob/main/docs/MARKET_DATA_API.md" target="_blank" rel="noreferrer">API docs ↗</a>
      </nav>
    </header>
    <Suspense fallback={<ContentSkeleton label="Loading the launch calendar"/>}><Calendar/></Suspense>
    <section className="launches-cta"><p><strong>Maintain a public repository?</strong> Run a free preflight, then schedule its launch from a wallet you choose, with a preview before anything is public. Your GitHub admin access is checked again before anything changes.</p>
      <span className="launches-cta-actions"><Link className="button primary" href={guideHref('calendar')}>Guided launch with preflight</Link>
        <Link className="button outline" href="/launches/manage">Manage schedules</Link></span></section>
    <section className="launches-section" aria-labelledby="launches-how-title"><h2 id="launches-how-title">How a launch works</h2>
      <div className="launches-how">
        <div className="inner-card"><h3>One transaction opens the market</h3><p>The pool is created with, at most, the launcher&apos;s own initial buy, capped at 3% of supply and paying the regular fee. No one else can be in that transaction.</p></div>
        <div className="inner-card"><h3>A launch fee against bots</h3><p>{fee ? `New markets charge ${fee.startPercent} in their first second, falling to ${fee.endPercent} over ${fee.durationLabel}, the same for every wallet. Buying in the first block is expensive; nothing is reserved for anyone.`
          : 'Every wallet pays the same fee from the first block; nothing is reserved for anyone. Each market page shows its own fee terms.'}</p></div>
        <div className="inner-card"><h3>One public price curve</h3><p>The price depends only on the SOL in the curve, so every buyer pays the same price at the same reserve. At its target the market graduates to a pool with permanently locked liquidity.</p></div>
        <div className="inner-card"><h3>Facts after launch</h3><p>Each market gets a Launch quality report: evidence and unknowns, executable depth and spread, organic versus round-trip volume, and lock states of every seeded position.</p></div>
      </div>
      <details className="transparency-notlive"><summary>Not live yet</summary><ul>{NOT_LIVE.map(item => <li key={item.id}><strong>{item.title}.</strong> {item.text}</li>)}</ul></details>
      <ul className="transparency-note">{RISK_DISCLOSURES.map(item => <li key={item}>{item}</li>)}</ul>
    </section>
  </main><Footer/></>
}

async function Calendar() {
  const result = await calendar()
  if (result.unavailable) return <p className="subtle-notice" role="status">{result.unavailable}</p>
  const { scheduled, groupLaunches, recentLaunches } = result
  return <>
    <section className="launches-section" aria-labelledby="scheduled-title">
      <h2 id="scheduled-title">Scheduled <small>{scheduled.length ? `${scheduled.length} announced` : 'none announced right now'}</small></h2>
      {scheduled.length ? <ul className="launches-list">{scheduled.map(row => <li key={row.id} id={`schedule-${row.id}`} className="launches-row">
        <div className="launches-when"><time dateTime={row.scheduledAt}><strong>{utc(row.scheduledAt)}</strong></time><small>Window {row.windowMinutes} min · until {utc(row.windowEndsAt).slice(11)}</small></div>
        <div className="launches-what"><strong>{row.fullName ? <a href={`https://github.com/${row.fullName}`} target="_blank" rel="noreferrer">{row.fullName}</a> : `Repository ${row.repoId}`}</strong>
          <p>Launching wallet <code title={row.launcherWallet}>{short(row.launcherWallet)}</code> · {buyLimit(row.maxInitialBuyLamports)} · announced by GitHub admin {row.announcedBy} on {utc(row.announcedAt)}</p>
          {row.note && <p>“{row.note}”</p>}
          <div className="launches-tags"><span className={`launches-tag ${row.state === 'open' ? 'open' : ''}`}>{row.state === 'open' ? 'Window open' : 'Upcoming'}</span></div></div>
        <div className="launches-actions"><a className="button outline" href={`/launches.ics?repos=${row.repoId}`}>Add to calendar</a></div>
      </li>)}</ul> : <p className="launches-empty">No launches are scheduled. New ones appear here, in the feeds and in your calendar subscription the moment they are announced.</p>}
    </section>
    <section className="launches-section" aria-labelledby="group-title">
      <h2 id="group-title">Group launch raises <small>all or nothing, refunds if they miss the deadline</small></h2>
      {groupLaunches.length ? <ul className="launches-list">{groupLaunches.map(row => <li key={row.bundleId} className="launches-row">
        <div className="launches-when"><strong>{utc(row.deadline)}</strong><small>Deadline</small></div>
        <div className="launches-what"><strong>{row.fullName ?? `Repository ${row.repoId}`} · ${row.symbol}</strong><p>Raising {sol(row.targetLamports)}. When full, it buys the first tokens in one swap at one price into a program vault; backers share fees, not tokens.</p></div>
        <div className="launches-actions"><Link className="button outline" href={row.path}>View raise</Link></div>
      </li>)}</ul> : <p className="launches-empty">No Group launch raises are open.</p>}
    </section>
    <section className="launches-section" aria-labelledby="recent-title">
      <h2 id="recent-title">Launched this week <small>with each market&apos;s Launch quality report</small></h2>
      {recentLaunches.length ? <ul className="launches-list">{recentLaunches.map(row => <li key={row.repoId} className="launches-row">
        <div className="launches-when"><strong>{utc(row.launchedAt)}</strong><small>{row.groupLaunch ? 'Group launch' : 'Launched'}</small></div>
        <div className="launches-what"><strong><Link href={row.path}>{row.fullName ?? `Repository ${row.repoId}`} · ${row.symbol}</Link></strong>
          {row.quality?.flags?.length ? <p>Fails: {row.quality.flags.map(flag => FLAG_LABELS[flag] ?? flag.replaceAll('_', ' ')).join(' · ')}</p> : null}</div>
        <div className="launches-actions"><Link className="launches-quality" href={`${row.path}#transparency`}>{row.quality ? (row.quality.score === null ? 'Not enough evidence' : `${row.quality.score}/100`) : 'Not assessed yet'}
          {row.quality && <small>{row.quality.coveragePercent}% of criteria known</small>}</Link></div>
      </li>)}</ul> : <p className="launches-empty">No markets launched in the last seven days.</p>}
      <p className="transparency-note">Listed by time, never by score or payment. A report describes public facts; it is not an endorsement or advice.</p>
    </section>
  </>
}
