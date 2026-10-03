import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { MarketLink } from './market-link'
import { RepoAvatar } from './ui'
import { ModelCardBadge, ModelDisclaimer, ModelSourceChip } from './hf/model-ui'
import { isModelMarket } from '../lib/hf-model-display.mjs'
import { listMarkets } from '../lib/server.mjs'
import { solUsdPrice } from '../lib/sol-usd.mjs'
import { platformTotals } from '../lib/platform-totals.mjs'
import { buybackReceipts } from '../lib/buyback-feed.mjs'
import { promotableMarkets } from '../lib/maintainer-opt-outs.mjs'
import { featuredMarkets } from '../lib/repo-quality.mjs'
import { shownMarkets } from '../lib/hf-markets.mjs'
import { MOVING_NOW_LIMIT, moverFacts, movingNow, proofFacts } from '../lib/home-highlights.mjs'
import '../home-highlights.css'

// Home hero, under the lead: what the platform has done, in one line. Shared cached reads (totals 5 min, buybacks 30 s).
export async function HomeProof() {
  const [totals, receipts] = await Promise.all([platformTotals(), buybackReceipts()])
  return <HomeProofLine facts={proofFacts({ totals, receipts })}/>
}

export function HomeProofLine({ facts }) {
  return <p className="home-proof">{facts.map(fact => <span key={fact.id}>
    {fact.href ? <Link href={fact.href}><strong>{fact.value}</strong> {fact.label}</Link> : <><strong>{fact.value}</strong> {fact.label}</>}</span>)}</p>
}

// Same box as the resolved line, so the figures stream in without moving the launch box below.
export const HomeProofFallback = () => <p className="home-proof is-loading" aria-hidden="true"><span className="skeleton-line"/></p>

// Home hero, under the launch box: live markets in the first screen, so a visitor who came to trade sees one before
// scrolling. The lists' promotion rules apply (do-not-promote, maintainer-declined, earned promotion; models only while
// open); nothing while they cannot be read.
export async function MovingNow() {
  const [{ markets, unavailable }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  const promotable = unavailable ? null : await promotableMarkets(shownMarkets(markets))
  if (!promotable) return null
  const picked = movingNow(featuredMarkets(promotable))
  return picked.markets.length ? <MovingNowStrip {...picked} usdPerSol={usdPerSol}/> : null
}

function MovingNowFrame({ title, children, footer = null, busy = false }) {
  return <section className="moving-now" aria-labelledby="moving-now-title" aria-busy={busy || undefined}>
    <div className="moving-now-heading"><h2 id="moving-now-title">{title}</h2>
      <Link href="/explore">All markets<ArrowRight size={14} aria-hidden="true"/></Link></div>
    <ol className="moving-now-cards">{children}</ol>{footer}
  </section>
}

// kind: 'moving' (traded in the last 24 hours, busiest first) or 'new' (nothing traded yet today: the newest launches).
export function MovingNowStrip({ kind, markets, usdPerSol = null, now = Date.now() }) {
  const title = kind === 'moving' ? <><span className="moving-now-dot" aria-hidden="true"/>Moving now</> : 'Just launched'
  return <MovingNowFrame title={title} footer={markets.some(isModelMarket) ? <ModelDisclaimer className="moving-now-disclaimer"/> : null}>
    {markets.map(market => <li key={market.mint}><MoverCard market={market} kind={kind} usdPerSol={usdPerSol} now={now}/></li>)}
  </MovingNowFrame>
}

function MoverCard({ market, kind, usdPerSol, now }) {
  const facts = moverFacts(market, usdPerSol, now)
  const lead = kind === 'moving' ? ['24h volume', facts.volume] : ['Launched', facts.launched ?? '—']
  return <MarketLink mint={market.mint} className="mover-card" aria-label={`${market.fullName}, $${market.symbol}: ${lead[0].toLowerCase()} ${lead[1]}`}>
    <div className="mover-top"><RepoAvatar repo={market}/><span className="mover-name"><strong>${market.symbol}</strong><small>{market.fullName}</small></span></div>
    <span className="mover-facts"><span><small>{lead[0]}</small><strong>{lead[1]}</strong></span><span><small>Market cap</small><strong>{facts.cap ?? '—'}</strong></span></span>
    <span className="mover-stage">{isModelMarket(market) && <ModelSourceChip compact/>}{facts.stage}</span>
    {isModelMarket(market) && <ModelCardBadge/>}
  </MarketLink>
}

export function MovingNowFallback() {
  return <MovingNowFrame title="Moving now" busy>{Array.from({ length: MOVING_NOW_LIMIT }, (_, index) => <li key={index} aria-hidden="true">
    <span className="mover-card is-loading"><span className="mover-top"><span className="skeleton-avatar"/><span className="mover-name"><span className="skeleton-line"/><span className="skeleton-line short"/></span></span>
      <span className="mover-facts"><span className="skeleton-line"/></span><span className="mover-stage"><span className="skeleton-line short"/></span></span></li>)}</MovingNowFrame>
}
