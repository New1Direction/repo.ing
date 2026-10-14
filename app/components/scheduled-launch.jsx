'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { launchWindow } from '../lib/public-launch.mjs'
import { MarketFunnel } from './market-funnel'
import '../maintainer-opt-out.css'
import '../transparency.css'
import '../public-launch.css'

// The launch page of a repository with a scheduled launch (src/launch-schedules.mjs). Before the time there is no form: the page says
// when, from which wallet and with how much, the same facts everyone sees on /launches. During the window the form stays, with a note
// that only the announced wallet and buy can pass (the coordinator refuses anything else before a review is reserved).
const utc = value => `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC`
const sol = lamports => `${(Number(BigInt(lamports ?? 0)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`
const buy = lamports => (BigInt(lamports ?? 0) > 0n ? `an initial buy of at most ${sol(lamports)}` : 'no initial buy')

function Facts({ schedule }) {
  return <dl className="transparency-facts">
    <div><dt>Window opens</dt><dd><time dateTime={schedule.scheduledAt}>{utc(schedule.scheduledAt)}</time></dd></div>
    <div><dt>Window closes</dt><dd><time dateTime={schedule.windowEndsAt}>{utc(schedule.windowEndsAt)}</time></dd></div>
    <div><dt>Launching wallet</dt><dd><code title={schedule.launcherWallet}>{schedule.launcherWallet.slice(0, 4)}…{schedule.launcherWallet.slice(-4)}</code></dd></div>
    <div><dt>Initial buy</dt><dd>{BigInt(schedule.maxInitialBuyLamports) > 0n ? `At most ${sol(schedule.maxInitialBuyLamports)}` : 'None'}</dd></div>
  </dl>
}

export function ScheduledLaunchBlocked({ repo, schedule }) {
  return <ScheduledLaunch repo={repo} schedule={schedule}/>
}

export function ScheduledWindowNote({ schedule }) {
  return <ScheduledLaunch schedule={schedule} compact/>
}

function ScheduledLaunch({ repo, schedule, compact = false }) {
  const [now, setNow] = useState(null)
  useEffect(() => {
    let timer
    const sync = () => {
      clearInterval(timer)
      if (document.visibilityState !== 'visible') return
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), 1000)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', sync) }
  }, [])
  // Stable server HTML; the local clock enhances it after hydration, without polling or refreshing the launch form.
  const clock = launchWindow(schedule, now ?? (schedule.state === 'open' ? Date.parse(schedule.scheduledAt) : Date.parse(schedule.scheduledAt) - 1))
  const Heading = compact ? 'h2' : 'h1'
  return <section className={`launch-blocked inner-card${compact ? ' scheduled-window-note' : ''}`} aria-labelledby="scheduled-launch-title">
    <MarketFunnel page="schedule"/>
    <span className="declined-banner-icon" aria-hidden="true"><CalendarClock size={20}/></span>
    <Heading id="scheduled-launch-title" aria-live="polite">{clock.label}</Heading>
    {repo && <p className="launch-blocked-lead">A GitHub admin of {repo.fullName}, <strong>{schedule.announcedBy}</strong>, announced this window. A schedule is not a completed launch or a promise of liquidity.</p>}
    <div className="launch-clock">
      {clock.remaining && <><span>{clock.state === 'upcoming' ? 'Window opens in' : 'Exclusive window closes in'}</span><strong role="timer" aria-live="off">{now === null ? 'See UTC times below' : clock.remaining}</strong></>}
      <p>{clock.state === 'upcoming' ? 'Nobody can launch before this window. Only the announced wallet may launch during it.'
        : clock.state === 'open' ? 'Only the announced wallet may now launch, within the announced buy limit. Group launches and contributor early access are not allowed during this window. This clock does not confirm that a market exists.'
          : clock.state === 'ended' ? 'The exclusive window has ended. If no market exists, anyone may launch subject to current checks.'
            : 'Check the current page for launch availability.'}</p>
      <p>Announced terms: {buy(schedule.maxInitialBuyLamports)}. Times are UTC; countdown uses your device clock. Reload to check server state.</p>
    </div>
    {schedule.note && <blockquote className="declined-note"><span>Note from the maintainer</span><p>{schedule.note}</p></blockquote>}
    <Facts schedule={schedule}/>
    <p className="declined-meta">Announced <time dateTime={schedule.announcedAt}>{utc(schedule.announcedAt)}</time>. After the window, if it has not launched, anyone can launch it as usual.</p>
    <div className="launch-blocked-actions">{clock.state !== 'upcoming' && <a className="button primary" href={`/launch/${schedule.repoId}`} data-market-event="availability">Check launch availability</a>}
      <a className="button outline" href={`/launches.ics?repos=${schedule.repoId}`}>Add to calendar</a>
      <Link href={`/launches#schedule-${schedule.id}`} className="button outline">Launch calendar</Link></div>
    <p className="transparency-note">Anonymous page and availability-action counts only; no wallet, repository ID or persistent identifier is sent. GPC and Do Not Track disable measurement.</p>
  </section>
}
