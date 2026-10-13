import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import '../maintainer-opt-out.css'
import '../transparency.css'

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
  return <section className="launch-blocked inner-card" aria-labelledby="scheduled-launch-title">
    <span className="declined-banner-icon" aria-hidden="true"><CalendarClock size={20}/></span>
    <h1 id="scheduled-launch-title">Launch scheduled</h1>
    <p className="launch-blocked-lead">A GitHub admin of {repo.fullName}, <strong>{schedule.announcedBy}</strong>, scheduled its market launch. Nobody can launch it before the window opens. During the window only the announced wallet can, with {buy(schedule.maxInitialBuyLamports)}.</p>
    {schedule.note && <blockquote className="declined-note"><span>Note from the maintainer</span><p>{schedule.note}</p></blockquote>}
    <Facts schedule={schedule}/>
    <p className="declined-meta">Announced <time dateTime={schedule.announcedAt}>{utc(schedule.announcedAt)}</time>. After the window, if it has not launched, anyone can launch it as usual.</p>
    <div className="launch-blocked-actions"><a className="button primary" href={`/launches.ics?repos=${schedule.repoId}`}>Add to calendar</a>
      <Link href={`/launches#schedule-${schedule.id}`} className="button outline">Launch calendar</Link></div>
  </section>
}

export function ScheduledWindowNote({ schedule }) {
  return <section className="launch-blocked inner-card scheduled-window-note" aria-labelledby="scheduled-window-title">
    <h2 id="scheduled-window-title">Scheduled launch window open</h2>
    <p className="launch-blocked-lead">Until {utc(schedule.windowEndsAt)} only the announced wallet can launch this repository, with {buy(schedule.maxInitialBuyLamports)}. Any other wallet, a larger buy, a Group launch or early access is refused before anything is reserved.</p>
    <Facts schedule={schedule}/>
  </section>
}
