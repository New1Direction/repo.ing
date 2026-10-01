'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Activity, ArrowUpRight, UserRoundSearch } from 'lucide-react'
import { PulseIcon } from './pulse-icon'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { formatCount, pulseAgo, pulseStatusLabel, starsToday } from '../lib/pulse-format.mjs'

const POLL_MS = 120_000

// Dev Pulse card on the token page: what the repository's developers shipped, from public GitHub activity collected
// by the worker. Polls while visible and hands new events to the price chart ('repoing:pulse-updated').
export function DevPulse({ mint, initial, repoUrl }) {
  const [pulse, setPulse] = useState(initial)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    let active = true, first = true
    const controller = new AbortController()
    const stop = visiblePolling(async () => {
      if (first) { first = false; return }
      try {
        const response = await fetch(`/api/market/${mint}/pulse`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        if (!response.ok) return
        const next = await response.json()
        if (!active || !next?.status || next.status === 'hidden') return
        setPulse(next); setNow(Date.now())
        window.dispatchEvent(new CustomEvent('repoing:pulse-updated', { detail: { mint, events: next.events ?? [] } }))
      } catch { /* Keep the last pulse; the next poll retries. */ }
    }, POLL_MS)
    return () => { active = false; controller.abort(); stop() }
  }, [mint])
  if (!pulse?.status || pulse.status === 'hidden') return null
  const pending = pulse.status === 'pending'
  const days = pulse.days ?? []
  const busiest = Math.max(1, ...days.map(day => day.commits))
  const today = starsToday(pulse.stars)
  return <section className={`dev-pulse is-${pulse.status}`} id="dev-pulse" aria-labelledby="dev-pulse-title">
    <header className="dev-pulse-head">
      <div><span className="dev-pulse-eyebrow"><Activity size={14} aria-hidden="true"/>Dev Pulse</span><h2 id="dev-pulse-title">What the builders are shipping</h2></div>
      <span className={`pulse-status is-${pulse.status}`}><i aria-hidden="true"/>{pulseStatusLabel(pulse, now)}</span>
    </header>
    {pending ? <p className="dev-pulse-note">Reading this repository’s public GitHub activity. It appears here within a few minutes.</p> : <>
      {pulse.hn && <a className="dev-pulse-hn pulse-kind-hn" href={pulse.hn.url} target="_blank" rel="noreferrer">
        <span className="pulse-dot"><PulseIcon kind="hn" size={16}/></span><span className="dev-pulse-hn-copy"><b>On Hacker News</b><span>{pulse.hn.title}</span></span>
        <strong>{formatCount(pulse.hn.points)} pts</strong><ArrowUpRight size={15} aria-hidden="true"/></a>}
      <div className="dev-pulse-stats">
        <Stat kind="commits" value={formatCount(pulse.commits24h)} label={pulse.commits24h === 1 ? 'commit today' : 'commits today'} sub={`${formatCount(pulse.commits7d)} this week`}/>
        <Stat kind="devs" value={formatCount(pulse.devs7d ?? 0)} label={pulse.devs7d === 1 ? 'developer this week' : 'developers this week'}/>
        <Stat kind="release" value={pulse.release?.title ?? 'None yet'} label={pulse.release ? `released ${pulseAgo(pulse.release.at, now)}` : 'latest release'} href={pulse.release?.url}/>
        <Stat kind="stars" value={today ?? (pulse.stars ? formatCount(pulse.stars.total) : '—')} label={today ? 'stars today' : 'stars'} sub={today && pulse.stars ? `${formatCount(pulse.stars.total)} total` : null}/>
        <Stat kind="merge" value={formatCount(pulse.merged7d)} label={pulse.merged7d === 1 ? 'PR merged this week' : 'PRs merged this week'}/>
        <Maintainer maintainer={pulse.maintainer}/>
      </div>
      <div className="dev-pulse-rhythm">
        <div className="dev-pulse-bars" role="img" aria-label={`Commits per day, last 14 days: ${days.map(day => day.commits).join(', ')}`}>
          {days.map((day, index) => <span key={day.day} className={[day.commits ? 'has-commits' : '', index === days.length - 1 ? 'is-today' : ''].join(' ').trim() || undefined}
            style={{ '--level': day.commits / busiest, '--i': index }} title={`${day.day}: ${day.commits} commit${day.commits === 1 ? '' : 's'}`}/>)}
        </div>
        <span className="dev-pulse-rhythm-label"><span>Commits · last 14 days</span><span>today</span></span>
      </div>
      {pulse.feed?.length ? <ol className="dev-pulse-feed" aria-label="Recent developer activity">{pulse.feed.map(item => <li key={item.id} className={`pulse-kind-${item.kind}`}>
        <span className="pulse-dot"><PulseIcon kind={item.kind} size={14}/></span>
        <div className="pulse-copy"><strong>{item.title}</strong><small><time dateTime={item.at}>{pulseAgo(item.at, now)}</time>{item.detail && <> · {item.detail}</>}</small></div>
        {item.url ? <a href={item.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.title}`}><ArrowUpRight size={15} aria-hidden="true"/></a> : <span/>}
      </li>)}</ol> : <p className="dev-pulse-note">No public commits, merged pull requests or releases in the last 30 days.</p>}
    </>}
    <footer className="dev-pulse-foot"><span>Public GitHub activity{pulse.checkedAt ? ` · checked ${pulseAgo(pulse.checkedAt, now)}` : ''}</span>
      <a href={repoUrl} target="_blank" rel="noreferrer">View on GitHub <ArrowUpRight size={14} aria-hidden="true"/></a></footer>
  </section>
}

function Stat({ kind, value, label, sub = null, href = null }) {
  const body = <><span className="pulse-stat-icon"><PulseIcon kind={kind} size={15}/></span><strong title={value}>{value}</strong><span>{label}</span>{sub && <small>{sub}</small>}</>
  return href ? <a className={`pulse-stat pulse-kind-${kind}`} href={href} target="_blank" rel="noreferrer">{body}</a> : <div className={`pulse-stat pulse-kind-${kind}`}>{body}</div>
}

function Maintainer({ maintainer }) {
  if (maintainer?.verified) return <div className="pulse-stat pulse-kind-verified"><span className="pulse-stat-icon"><PulseIcon kind="verified" size={15}/></span>
    <strong>Verified</strong><span>maintainer on repo.ing</span>{maintainer.since && <small>since {new Date(maintainer.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</small>}</div>
  return <Link className="pulse-stat pulse-kind-unverified" href={maintainer?.claimHref ?? '/builders'}><span className="pulse-stat-icon"><UserRoundSearch size={15} aria-hidden="true"/></span>
    <strong>Not yet</strong><span>maintainer verified</span><small>Maintainer? Claim →</small></Link>
}
