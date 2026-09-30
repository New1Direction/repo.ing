import { cache } from 'react'
import { cookies } from 'next/headers'
import { Check, Cpu } from 'lucide-react'
import { BackBuild } from './parts-fund-back'
import { PartsFundActions, PartsFundEditor, PartsUpdateShare } from './parts-fund-manage'
import { githubSessionCookie, readGithubSession, sealTipReview } from '../lib/auth.mjs'
import { formatCents as centsLabel, formatTokenAmount, formatUsdValue } from '../lib/format.mjs'
import { partsEnabled, repoPartsFund } from '../lib/parts-fund.mjs'
import { xHandlesFor } from '../lib/x-links.mjs'
import { XHandleLink } from './x-handle-link'

// One memoized read per request feeds the title badge and the card.
const pageFund = cache(repoId => repoPartsFund(repoId).catch(error => {
  if (error?.code !== '42P01') console.error('parts fund unavailable', { repoId, error: error.message })
  return null
}))
const STATE = {
  open: fund => fund.daysLeft ? `${fund.daysLeft} ${fund.daysLeft === 1 ? 'day' : 'days'} left` : 'Closing',
  funded: fund => fund.settledAt ? 'Funded · paid to the maintainer' : 'Funded · paying out',
  failed: fund => fund.settledAt ? 'Missed its goal · everyone refunded' : 'Missed its goal · refunding',
  cancelled: fund => fund.settledAt ? 'Cancelled · everyone refunded' : 'Cancelled · refunding',
}
const STALE_MS = 14 * 24 * 60 * 60_000
const day = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// Title-area badge while a list is taking pledges.
export async function PartsFundBadge({ market }) {
  if (!partsEnabled()) return null
  const fund = await pageFund(market.repoId)
  if (fund?.status !== 'open') return null
  return <a className="parts-badge" href="#parts-fund"><Cpu size={13} aria-hidden="true"/>Parts fund<b aria-hidden="true">·</b><strong>{fund.percent}%</strong></a>
}

async function maintainerSession(market) {
  const session = readGithubSession((await cookies()).get(githubSessionCookie)?.value)
  return session?.repoId === String(market.repoId) ? session : null
}

// Token page card, under the tip jar. Shown when a list exists; a verified maintainer with a payout wallet also sees
// "Start a parts fund" and the controls. Everything user-written renders as text; links are nofollow.
export async function PartsFundCard({ market }) {
  if (!partsEnabled()) return null
  const [fund, session] = await Promise.all([pageFund(market.repoId), maintainerSession(market)])
  const maintainer = Boolean(session && market.beneficiaryWallet)
  // A list that missed its goal (or was cancelled) stays visible for two weeks after everyone was refunded.
  const stale = fund?.settledAt && fund.status !== 'funded' && Date.now() - new Date(fund.settledAt).getTime() > STALE_MS
  if (!fund || (fund.settledAt && fund.status !== 'funded' && maintainer) || stale) {
    if (!maintainer) return fund && !stale ? <FundBody fund={fund} market={market}/> : null
    return <section id="parts-fund" className="inner-card parts-card parts-card-empty" aria-labelledby="parts-fund-title">
      <h3 id="parts-fund-title"><Cpu size={16} aria-hidden="true"/>Parts fund</h3>
      <p>Need hardware for this repo? List the parts; backers fund it all-or-nothing in USDC or SOL, paid to your payout wallet.</p>
      <PartsFundEditor repoId={String(market.repoId)}/></section>
  }
  const review = maintainer && fund.status === 'open' && fund.goalMet ? sealTipReview(session, { repoId: market.repoId, wallet: market.beneficiaryWallet,
    boundAt: market.beneficiaryBoundAt, fundId: fund.id }, 'parts-collect-review') : null
  return <FundBody fund={fund} market={market} manage={maintainer ? { repoId: String(market.repoId), review } : null}/>
}

async function FundBody({ fund: full, market, manage = null }) {
  // Backer wallets stay on the server: only @handles of backers who linked X (Connect X) are shown.
  const { backerWallets, ...fund } = full
  let handles = []
  try { handles = [...(await xHandlesFor(backerWallets)).values()].filter(Boolean).slice(0, 6) } catch { handles = [] }
  const holdings = fund.holdings.filter(h => BigInt(h.amount) > 0n)
  return <section id="parts-fund" className={`inner-card parts-card is-${fund.status}`} aria-labelledby="parts-fund-title">
    <div className="parts-top"><h3 id="parts-fund-title"><Cpu size={16} aria-hidden="true"/>Parts fund</h3><span className={`parts-state is-${fund.status}`}>{STATE[fund.status](fund)}</span></div>
    <h4 className="parts-title">{fund.title}</h4>
    {fund.description && <p className="parts-description">{fund.description}</p>}
    <div className="parts-progress" role="progressbar" aria-label="Pledged toward the goal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fund.percent}
      aria-valuetext={`${centsLabel(fund.pledgedCents)} of ${centsLabel(fund.goalCents)}`}><span style={{ transform: `scaleX(${fund.percent / 100})` }}/></div>
    <p className="parts-figures"><strong>{centsLabel(fund.pledgedCents)}</strong> of {centsLabel(fund.goalCents)} · {fund.backers} {fund.backers === 1 ? 'backer' : 'backers'}</p>
    {handles.length > 0 && <p className="parts-backers">Backed by {handles.map(link => <XHandleLink key={link.username} link={link}/>)}
      {fund.backers > handles.length && <span>+{fund.backers - handles.length} more</span>}</p>}
    {holdings.length > 0 && <p className="parts-holdings">Held: {holdings.map(h => `${formatTokenAmount(h.amount, h.decimals)} ${h.symbol}`).join(' · ')}
      {fund.usdToday !== null && <> · ≈ {formatUsdValue(fund.usdToday)} today</>}<small>Progress counts each pledge at its USD value when pledged.</small></p>}
    <ul className="parts-items">{fund.items.map(item => <li key={item.id} className={item.funded ? 'is-funded' : ''}>
      <span className="parts-item-check" aria-hidden="true">{item.funded ? <Check size={12} strokeWidth={3}/> : null}</span>
      <div><strong>{item.name}</strong><span>{item.quantity > 1 ? `${item.quantity} × ${centsLabel(item.unitPriceCents)}` : centsLabel(item.unitPriceCents)}
        {item.domain && <> · <a href={item.url} target="_blank" rel="noopener noreferrer nofollow ugc">{item.domain} ↗</a></>}</span>
        <span className="parts-item-bar" aria-hidden="true"><span style={{ transform: `scaleX(${item.percent / 100})` }}/></span></div>
      <small>{item.funded ? 'Funded' : `${item.percent}%`}<span className="sr-only"> of {centsLabel(item.costCents)}</span></small></li>)}</ul>
    {fund.status === 'open' && <BackBuild fund={fund} fullName={market.fullName}/>}
    {manage && <PartsFundActions repoId={manage.repoId} fund={fund} review={manage.review}/>}
    {fund.updates.length > 0 && <div className="parts-updates"><h4>Build updates</h4><ol>{fund.updates.map(update => <li key={update.id} id={`parts-update-${update.id}`}>
      <time dateTime={update.createdAt}>{day(update.createdAt)}</time><p>{update.body}</p>
      {update.images > 0 && <div className="parts-update-images">{Array.from({ length: update.images }, (_, i) =>
        <img key={i} src={`/api/parts-fund/image/${update.id}/${i}`} alt={`Build update photo ${i + 1}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" width="160" height="120"/>)}</div>}
      <PartsUpdateShare mint={market.mint} updateId={update.id} title={fund.title}/></li>)}</ol></div>}
    {fund.status === 'open' && <p className="tip-fineprint">All or nothing by {day(fund.deadline)}. Pledges are held in the repo.ing tip wallet, then paid to the maintainer’s verified payout wallet if funded, or refunded to every backer automatically.</p>}
  </section>
}

