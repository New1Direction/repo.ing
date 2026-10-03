import Link from 'next/link'
import { after } from 'next/server'
import { Suspense } from 'react'
import { ContentSkeleton } from '../components/loading-skeleton'
import { ArrowRight, Bot } from 'lucide-react'
import { AppHeader, Footer } from '../components/ui'
import { RepoSearch } from '../components/repo-search'
import { LaunchBenefits } from '../components/launch-benefits'
import { HomeMarkets } from '../components/home-markets'
import { GraduationRace, GraduationRaceBoard, GraduationRaceFallback } from '../components/graduation-race'
import { listMarkets, discoveryRewardsEnabled, graduationRace, database } from '../lib/server.mjs'
import { solUsdPrice } from '../lib/sol-usd.mjs'
import { homeMarketTabs } from '../lib/market-order.mjs'
import { FlywheelVideo } from '../components/flywheel-video'
import { HomeProof, HomeProofFallback, MovingNow, MovingNowFallback } from '../components/home-highlights'
import { PulseTicker } from '../components/pulse-ticker'
import { readPulseTicker } from '../lib/dev-pulse.mjs'
import { pulseIndex, withPulse } from '../lib/pulse-index.mjs'
import { shippingLeaders } from '../lib/pulse-rank.mjs'
import { ShippingLeaders } from '../components/shipping-leaders'
import { promotableMarkets, promotionExcluded } from '../lib/maintainer-opt-outs.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'
import { featuredMarkets, labeledRacers, featuredTicker } from '../lib/repo-quality.mjs'
import { officialLaunches } from '../lib/official-launch.mjs'
import { OfficialLaunches } from '../components/official-launches'
import { hfMarketsEnabled, shownMarkets, withModelFacts } from '../lib/hf-markets.mjs'
import { githubMarkets, selectModelStrip } from '../lib/hf-model-display.mjs'
import { ModelsStrip } from '../components/hf/models-strip'

export const dynamic = 'force-dynamic'
export const metadata = { alternates: { canonical: '/', languages: { en: '/', ja: '/ja', 'x-default': '/' } } }
export default function Home() {
  const discoveryEnabled = discoveryRewardsEnabled()
  // With model markets on, the hero names both sources and offers a direct way in for a Hugging Face model.
  const models = hfMarketsEnabled()
  return <><AppHeader/><main><section className="hero" aria-labelledby="home-title"><div className="eyebrow">OPEN SOURCE MARKETS</div><h1 id="home-title">Launch open source markets.</h1><p><span className="hero-lead">{models ? 'Tokenize any GitHub repo or Hugging Face model.' : 'Tokenize any GitHub repo.'}</span><span>Every trade pays the builders.</span></p><Suspense fallback={<HomeProofFallback/>}><HomeProof/></Suspense><RepoSearch models={models}/>{models && <Link href={`/launch?repo=${encodeURIComponent('huggingface.co/')}`} className="launch-model-cta"><Bot size={18} aria-hidden="true"/>Launch a Hugging Face model<ArrowRight size={16} aria-hidden="true"/></Link>}<Link href="/find-repos" className="launch-find-link">Need inspiration? Find repos gaining attention <ArrowRight size={15} aria-hidden="true"/></Link><Suspense fallback={<MovingNowFallback/>}><MovingNow/></Suspense><LaunchBenefits discoveryEnabled={discoveryEnabled} compact/></section><div className="section-wrap"><Suspense fallback={null}><PulseTickerContent/></Suspense><Suspense fallback={null}><ShippingLeadersContent/></Suspense><Suspense fallback={null}><OfficialLaunchesContent/></Suspense><GraduationRace><Suspense fallback={<GraduationRaceFallback/>}><GraduationRaceContent/></Suspense></GraduationRace></div>{models && <Suspense fallback={null}><ModelsStripContent/></Suspense>}<section className="section-wrap trending"><div className="section-heading"><div><h2>Explore repositories</h2><p>Open source projects. Real markets. Real builders.</p></div><Link href="/explore" className="view-all">View all <ArrowRight size={20}/></Link></div><Suspense fallback={<ContentSkeleton label="Loading markets"/>}><MarketContent/></Suspense><Link href="/waiting" className="launch-find-link">Builder fees waiting for maintainers <ArrowRight size={15} aria-hidden="true"/></Link></section><div className="section-wrap"><FlywheelVideo id="home-flywheel-video"/></div></main><Footer/></>
}

// Home lists promote: never a do-not-promote or maintainer-declined repository (nothing when that list is unreadable), and
// only markets that earned promotion (repo-quality.mjs): new repositories wait until 10% of their graduation target.
// /explore still lists every market.
async function MarketContent() {
  const [{ markets, unavailable }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  const promotable = await promotableMarkets(shownMarkets(markets))
  const notice = unavailable || (!promotable && 'Markets are temporarily unavailable.')
  return <>{notice && <p className="subtle-notice">{notice}</p>}<HomeMarkets tabs={homeMarketTabs(withModelFacts(await withPulse(featuredMarkets(promotable ?? [])), { schedule: after }))} usdPerSol={usdPerSol}/></>
}

// Hugging Face model markets (HF_MARKETS_ENABLED only), under the same do-not-promote rule as the lists; nothing without one.
async function ModelsStripContent() {
  const { markets } = await listMarkets()
  const promotable = await promotableMarkets(markets)
  return promotable ? <ModelsStrip markets={selectModelStrip(withModelFacts(promotable, { schedule: after }))}/> : null
}

// The race ranks by verified reserves and keeps new repositories in place, labeled (labeledRacers); the market list is
// read only for those labels, so its outage never hides a racer.
async function GraduationRaceContent() {
  const [{ markets, unavailable }, listed] = await Promise.all([graduationRace(), listMarkets()])
  return <GraduationRaceBoard markets={await withPulse(labeledRacers(shownMarkets(markets), listed.markets))} unavailable={unavailable} compact/>
}

// Markets the repository's own verified maintainer launched; hidden while there are none, and while the do-not-promote set
// (operator list and maintainer opt-outs) cannot be read.
async function OfficialLaunchesContent() {
  const [{ markets }, excluded] = await Promise.all([listMarkets(), promotionExcluded()])
  // Official is a verified GitHub maintainer's launch: repositories only.
  return excluded ? <OfficialLaunches markets={officialLaunches(githubMarkets(markets), { excluded })}/> : null
}

// Live from GitHub: the newest releases, merges, star spikes and Hacker News stories across live markets that earned
// promotion; hidden while the market list is unavailable.
async function PulseTickerContent() {
  const [{ markets, unavailable }, items] = await Promise.all([listMarkets(),
    readPulseTicker(database(), { limit: 40 }).catch(error => { console.error('pulse ticker failed', error.message); return [] })])
  return unavailable ? null : <PulseTicker items={featuredTicker(items, markets)}/>
}

// The three community repositories that shipped the most code this week ($REPOING, do-not-promote and maintainer-declined
// repos, and new repos that have not earned promotion, excluded; hidden when the do-not-promote set is unreadable).
async function ShippingLeadersContent() {
  const [{ markets }, index, excluded] = await Promise.all([listMarkets(), pulseIndex(), promotionExcluded()])
  if (!excluded) return null
  const leaders = shippingLeaders(featuredMarkets(shownMarkets(markets)).map(market => ({ ...market, pulse: index.get(String(market.repoId)) ?? null })),
    { excluded, skipMints: [OFFICIAL_TOKEN.mint] })
  return <ShippingLeaders markets={leaders}/>
}
