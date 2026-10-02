import Link from 'next/link'
import { Suspense } from 'react'
import { ContentSkeleton } from '../components/loading-skeleton'
import { ArrowRight } from 'lucide-react'
import { AppHeader, Footer } from '../components/ui'
import { RepoSearch } from '../components/repo-search'
import { LaunchBenefits } from '../components/launch-benefits'
import { HomeMarkets } from '../components/home-markets'
import { GraduationRace, GraduationRaceBoard, GraduationRaceFallback } from '../components/graduation-race'
import { listMarkets, discoveryRewardsEnabled, graduationRace, database } from '../lib/server.mjs'
import { solUsdPrice } from '../lib/sol-usd.mjs'
import { homeMarketTabs } from '../lib/market-order.mjs'
import { FlywheelVideo } from '../components/flywheel-video'
import { BuybackCounter, BuybackFrame } from '../components/buyback-counter'
import { PulseTicker } from '../components/pulse-ticker'
import { readPulseTicker } from '../lib/dev-pulse.mjs'
import { pulseIndex, withPulse } from '../lib/pulse-index.mjs'
import { shippingLeaders } from '../lib/pulse-rank.mjs'
import { ShippingLeaders } from '../components/shipping-leaders'
import { promotableMarkets, promotionExcluded } from '../lib/maintainer-opt-outs.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'

export const dynamic = 'force-dynamic'
export const metadata = { alternates: { canonical: '/', languages: { en: '/', ja: '/ja', 'x-default': '/' } } }
export default function Home() {
  const discoveryEnabled = discoveryRewardsEnabled()
  return <><AppHeader/><main><section className="hero" aria-labelledby="home-title"><div className="eyebrow">OPEN SOURCE MARKETS</div><h1 id="home-title">Launch open source markets.</h1><p><span className="hero-lead">Tokenize any GitHub repo.</span><span>Every trade pays the builders.</span></p><RepoSearch/><Link href="/find-repos" className="launch-find-link">Need inspiration? Find repos gaining attention <ArrowRight size={15} aria-hidden="true"/></Link><LaunchBenefits discoveryEnabled={discoveryEnabled} compact/><Suspense fallback={<BuybackFrame/>}><BuybackCounter/></Suspense></section><div className="section-wrap"><Suspense fallback={null}><PulseTickerContent/></Suspense><Suspense fallback={null}><ShippingLeadersContent/></Suspense><GraduationRace><Suspense fallback={<GraduationRaceFallback/>}><GraduationRaceContent/></Suspense></GraduationRace></div><section className="section-wrap trending"><div className="section-heading"><div><h2>Explore repositories</h2><p>Open source projects. Real markets. Real builders.</p></div><Link href="/explore" className="view-all">View all <ArrowRight size={20}/></Link></div><Suspense fallback={<ContentSkeleton label="Loading markets"/>}><MarketContent/></Suspense><Link href="/waiting" className="launch-find-link">Builder fees waiting for maintainers <ArrowRight size={15} aria-hidden="true"/></Link></section><div className="section-wrap"><FlywheelVideo id="home-flywheel-video"/></div></main><Footer/></>
}

async function MarketContent() {
  const [{ markets, unavailable }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  // Home lists promote: never a do-not-promote or maintainer-declined repository, and nothing when that list is unreadable.
  const promotable = await promotableMarkets(markets)
  const notice = unavailable || (!promotable && 'Markets are temporarily unavailable.')
  return <>{notice && <p className="subtle-notice">{notice}</p>}<HomeMarkets tabs={homeMarketTabs(await withPulse(promotable ?? []))} usdPerSol={usdPerSol}/></>
}

async function GraduationRaceContent() {
  const { markets, unavailable } = await graduationRace()
  return <GraduationRaceBoard markets={await withPulse(markets)} unavailable={unavailable}/>
}

// Live from GitHub: the newest releases, merges, star spikes and Hacker News stories across live markets.
async function PulseTickerContent() {
  const items = await readPulseTicker(database()).catch(error => { console.error('pulse ticker failed', error.message); return [] })
  return <PulseTicker items={items}/>
}

// The three community repositories that shipped the most code this week ($REPOING, do-not-promote and maintainer-declined
// repos excluded; hidden when that list is unreadable).
async function ShippingLeadersContent() {
  const [{ markets }, index, excluded] = await Promise.all([listMarkets(), pulseIndex(), promotionExcluded()])
  if (!excluded) return null
  const leaders = shippingLeaders(markets.map(market => ({ ...market, pulse: index.get(String(market.repoId)) ?? null })),
    { excluded, skipMints: [OFFICIAL_TOKEN.mint] })
  return <ShippingLeaders markets={leaders}/>
}
