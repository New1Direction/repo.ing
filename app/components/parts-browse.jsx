import Link from 'next/link'
import { BookOpen, CircleDot, CircleSlash, CircleX, Cpu, GitMerge } from 'lucide-react'
import { formatCents } from '../lib/format.mjs'
import { relativeDay } from '../lib/parts-fund.mjs'
import { PARTS_MAX_DAYS, PARTS_MAX_GOAL_CENTS, PARTS_MIN_DAYS } from '../../src/parts-fund.mjs'
import { XHandleLink } from './x-handle-link'

// /parts: parts lists across every market, laid out like an issue tracker. Open = green, Funded = purple (merged),
// missed = red, cancelled = gray. Everything maintainer-written renders as text.
const STATUS = {
  open: { Icon: CircleDot, label: 'Open' },
  funded: { Icon: GitMerge, label: 'Funded' },
  failed: { Icon: CircleX, label: 'Missed its goal' },
  cancelled: { Icon: CircleSlash, label: 'Cancelled' },
}
const TABS = [
  { state: 'open', label: 'Open', Icon: CircleDot },
  { state: 'funded', label: 'Funded', Icon: GitMerge },
  { state: 'closed', label: 'Closed', Icon: CircleSlash },
]
const EMPTY = {
  open: { title: 'No open parts lists yet', body: 'When a verified maintainer needs hardware for their repo (a dev board, sensors, a test rig), their list shows up here for anyone to back. If a list isn’t fully funded by its deadline, every backer is refunded.' },
  funded: { title: 'No funded parts lists yet', body: 'Lists that reach their goal are paid to the maintainer’s verified payout wallet and land here, with their build updates on the token page.' },
  closed: { title: 'No closed parts lists', body: 'Lists that miss their goal or are cancelled refund every backer automatically, then land here.' },
}
// Art from public/parts (2x WebP). Width/height are the display size; each file is twice that.
const EMPTY_ART = { src: '/parts/empty-cat-box.webp', width: 156, height: 134 }
// fetchPriority="low" also stops React from emitting a preload hint for these decorative images, which every
// prefetch of /parts (the main nav links it on every page) would otherwise make the browser download.
const PART_KINDS = [
  { label: 'Micro\u00ADcontrollers', src: '/parts/microcontroller.webp', width: 82, height: 66 },
  { label: 'Motor drivers', src: '/parts/motor-driver.webp', width: 64, height: 74 },
  { label: 'Sensors', src: '/parts/sensor.webp', width: 92, height: 52 },
  { label: 'Robot arms', src: '/parts/arm.webp', width: 88, height: 75 },
]
const plural = (count, word) => `${count.toLocaleString('en-US')} ${count === 1 ? word : `${word}s`}`
const IMAGE = /^https:\/\/pbs\.twimg\.com\//
const tabHref = state => state === 'open' ? '/parts' : `/parts?state=${state}`

export function PartsHeader() {
  return <header className="parts-browse-header">
    <span className="parts-browse-mark" aria-hidden="true"><Cpu size={22}/></span>
    <div><h1>Parts</h1>
      <p>Hardware lists from verified open-source maintainers. All-or-nothing: funded → paid to the builder, missed → everyone refunded.</p></div>
    <figure className="parts-kinds"><figcaption>What people list</figcaption>
      <ul>{PART_KINDS.map(({ label, src, width, height }) => <li key={label}>
        <img src={src} alt="" width={width} height={height} decoding="async" fetchPriority="low"/><span>{label}</span></li>)}</ul></figure>
  </header>
}

export function PartsTabs({ state, counts }) {
  return <nav className="parts-tabs" aria-label="Parts lists by state">{TABS.map(({ state: tab, label, Icon }) =>
    <Link key={tab} href={tabHref(tab)} className={`is-${tab}`} aria-current={state === tab ? 'page' : undefined} scroll={false}>
      <Icon size={16} aria-hidden="true"/><span>{counts ? <strong>{counts[tab].toLocaleString('en-US')}</strong> : null} {label}</span></Link>)}</nav>
}

function Meta({ fund, now, maintainerLink }) {
  const by = fund.openedBy
    ? <a href={`https://github.com/${encodeURIComponent(fund.openedBy)}`} target="_blank" rel="noopener noreferrer nofollow">@{fund.openedBy}</a>
    : 'the verified maintainer'
  const when = at => <time dateTime={at} title={new Date(at).toUTCString()}>{relativeDay(at, now)}</time>
  const closed = fund.closedAt ?? fund.createdAt
  return <p className="parts-row-meta"><span className="parts-row-ref">#parts</span>
    {fund.status === 'open' ? <span>opened {when(fund.createdAt)} by {by}</span>
      : <span>by {by} · {fund.status === 'funded' ? 'funded' : fund.status === 'failed' ? 'missed its goal' : 'cancelled'} {when(closed)}
        {!fund.settledAt && <> · {fund.status === 'funded' ? 'paying out' : 'refunding'}</>}</span>}
    {maintainerLink && <XHandleLink link={maintainerLink} trust className="parts-row-x"/>}
  </p>
}

function Backers({ fund, links }) {
  const shown = fund.backerWallets.map(wallet => links.get(wallet)).filter(link => link?.username).slice(0, 3)
  if (!shown.length) return null
  return <span className="parts-row-backers" title={`Backed by ${shown.map(link => `@${link.username}`).join(', ')}${fund.backers > shown.length ? ` and ${fund.backers - shown.length} more` : ''}`}>
    {shown.map(link => IMAGE.test(link.image ?? '')
      ? <img key={link.username} src={link.image} alt="" width={20} height={20} loading="lazy" decoding="async" referrerPolicy="no-referrer"/>
      : <span key={link.username} aria-hidden="true">{link.username.slice(0, 1).toUpperCase()}</span>)}
    <span className="sr-only">Backed by {shown.map(link => `@${link.username}`).join(', ')}</span>
  </span>
}

function PartsRow({ fund, now, links }) {
  const { Icon, label } = STATUS[fund.status] ?? STATUS.cancelled
  const closing = fund.status === 'open' && !fund.daysLeft
  return <li className={`parts-row is-${fund.status}`}>
    <span className="parts-row-icon" title={label}><Icon size={17} aria-hidden="true"/><span className="sr-only">{label}:</span></span>
    <div className="parts-row-main">
      <h3><Link href={`/token/${fund.mint}#parts-fund`}><span className="parts-row-repo">{fund.fullName}</span><span className="parts-row-title">{fund.title}</span></Link>
        {fund.symbol && <span className="parts-label">${fund.symbol}</span>}</h3>
      <Meta fund={fund} now={now} maintainerLink={fund.maintainerWallet ? links.get(fund.maintainerWallet) : null}/>
    </div>
    <div className="parts-row-side">
      <div className="parts-row-bar" role="progressbar" aria-label={`${fund.fullName} pledged toward its goal`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={fund.percent} aria-valuetext={`${formatCents(fund.pledgedCents)} of ${formatCents(fund.goalCents)}, ${fund.percent}%`}>
        <span style={{ transform: `scaleX(${fund.percent / 100})` }}/></div>
      <p className="parts-row-figures"><strong>{formatCents(fund.pledgedCents)}</strong> of {formatCents(fund.goalCents)}<span>{fund.percent}%</span></p>
      <p className="parts-row-counts"><Backers fund={fund} links={links}/>{plural(fund.backers, 'backer')} · {plural(fund.parts, 'part')}
        {fund.status === 'open' && <> · <span className={closing ? 'is-closing' : undefined}>{closing ? 'closing' : `${plural(fund.daysLeft, 'day')} left`}</span></>}</p>
    </div>
  </li>
}

function BlankSlate({ state }) {
  const { title, body } = EMPTY[state]
  return <div className={`parts-blank is-${state}`}>
    <img className="parts-blank-art" src={EMPTY_ART.src} alt="" width={EMPTY_ART.width} height={EMPTY_ART.height} decoding="async"/>
    <h3>{title}</h3><p>{body}</p>
    <div className="parts-blank-actions">
      <Link href="/builders" className="button primary">Verify your repo</Link>
      <Link href="/explore" className="button">Explore markets</Link>
    </div>
    {state !== 'open' && <Link href="/parts" className="parts-blank-back">View open lists</Link>}
  </div>
}

export function PartsList({ view, links = new Map(), now = Date.now(), notice = null }) {
  return <section className="parts-box" aria-labelledby="parts-list-title">
    <div className="parts-box-head"><h2 id="parts-list-title" className="sr-only">{TABS.find(tab => tab.state === view.state).label} parts lists</h2>
      <PartsTabs state={view.state} counts={view.counts}/></div>
    {notice && <p className="parts-notice" role="status">{notice}</p>}
    {view.lists.length
      ? <ul className="parts-rows">{view.lists.map(fund => <PartsRow key={fund.id} fund={fund} now={now} links={links}/>)}</ul>
      : <BlankSlate state={view.state}/>}
  </section>
}

export function PartsReadme() {
  return <aside className="parts-readme" aria-labelledby="parts-readme-title">
    <div className="parts-readme-head"><BookOpen size={15} aria-hidden="true"/><span>README</span></div>
    <div className="parts-readme-body">
      <h2 id="parts-readme-title">How parts funds work</h2>
      <ol>
        <li><span><strong>A verified maintainer lists the parts.</strong> Each part has a price and an optional shop link; the list has a deadline ({PARTS_MIN_DAYS}–{PARTS_MAX_DAYS} days) and a goal of up to {formatCents(PARTS_MAX_GOAL_CENTS)}.</span></li>
        <li><span><strong>Anyone backs it in USDC or SOL.</strong> Each pledge counts at its USD value when pledged and is held in the repo.ing tip wallet.</span></li>
        <li><span><strong>All or nothing.</strong> Funded → paid to the maintainer’s verified payout wallet. Missed or cancelled → every backer is refunded automatically.</span></li>
        <li><span><strong>Build in public.</strong> Maintainers post build updates, with photos, on their token page.</span></li>
      </ol>
      <p className="parts-readme-cta">Maintainers: verify your repo, then start a list from your token page.</p>
      <Link href="/builders" className="button">Verify your repo</Link>
    </div>
  </aside>
}
