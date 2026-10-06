import Link from 'next/link'
import { after } from 'next/server'
import { cache, Suspense } from 'react'
import { ArrowRight } from 'lucide-react'
import { ContentSkeleton } from '../components/loading-skeleton'
import { AppHeader, Footer, MarketTable } from '../components/ui'
import { RepoSearch } from '../components/repo-search'
import { LaunchBenefits } from '../components/launch-benefits'
import { GraduationRaceBoard, GraduationRaceFallback } from '../components/graduation-race'
import { listMarkets, discoveryRewardsEnabled, graduationRace, database } from '../lib/server.mjs'
import { solUsdPrice } from '../lib/sol-usd.mjs'
import { homeMarketTabs } from '../lib/market-order.mjs'
import { FlywheelVideo } from '../components/flywheel-video'
import { HomeProof, HomeProofFallback } from '../components/home-highlights'
import { PulseTicker } from '../components/pulse-ticker'
import { readPulseTicker } from '../lib/dev-pulse.mjs'
import { pulseIndex, withPulse } from '../lib/pulse-index.mjs'
import { shippingLeaders } from '../lib/pulse-rank.mjs'
import { ShippingLeaders } from '../components/shipping-leaders'
import { promotableMarkets, promotionExcluded } from '../lib/maintainer-opt-outs.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'
import { featuredMarkets, labeledRacers, featuredTicker } from '../lib/repo-quality.mjs'
import { hfMarketsEnabled, shownMarkets, withModelFacts } from '../lib/hf-markets.mjs'
import { selectModelStrip } from '../lib/hf-model-display.mjs'
import { ModelsStrip } from '../components/hf/models-strip'
import { HomeBoard } from '../components/home/home-board'
import { LiveMarket, LiveMarketFallback } from '../components/home/live-market'
import { marketCharts } from '../lib/market-charts.mjs'
import { LIVE_MARKET_RANGE, liveChart } from '../lib/live-market.mjs'
import { displayFont, monoFont } from '../home-fonts'
import '../home.css'

export const dynamic = 'force-dynamic'
export const metadata = { alternates: { canonical: '/', languages: { en: '/', ja: '/ja', 'x-default': '/' } } }

// The home page: the pitch and the launch box beside a live market ($REPOING), what builders are shipping, one tabbed board
// of market lists, and how it works. Every list streams in on its own, inside a frame that keeps the page still.
export default function Home() {
  const discoveryEnabled = discoveryRewardsEnabled()
  // With model markets on, the hero names both sources, links straight to a model launch and the board gets a Models tab.
  const models = hfMarketsEnabled()
  const tabs = [
    { id: 'trending', label: 'Trending', note: 'Ranked by 24h volume.' },
    { id: 'mcap', label: 'Market cap', note: 'Ranked by market cap: last trade price × 1B supply.' },
    { id: 'new', label: 'New', note: 'The newest launches.' },
    { id: 'graduating', label: 'Graduating', note: 'Closest to their graduation target, from verified on-chain reserves. At graduation, trading moves to a Meteora pool.' },
    { id: 'shipping', label: 'Shipping', note: 'The repositories whose developers shipped the most code this week.' },
    ...models ? [{ id: 'models', label: 'Models', note: 'Community launches for public AI models. Every trade pays the model’s owner in SOL.' }] : [],
  ]
  const panels = {
    trending: <Suspense fallback={<ContentSkeleton label="Loading markets"/>}><MarketListContent tab="Trending"/></Suspense>,
    mcap: <Suspense fallback={<ContentSkeleton label="Loading markets"/>}><MarketListContent tab="Market cap"/></Suspense>,
    new: <Suspense fallback={<ContentSkeleton label="Loading markets"/>}><MarketListContent tab="New"/></Suspense>,
    graduating: <Suspense fallback={<GraduationRaceFallback/>}><GraduationRaceContent/></Suspense>,
    shipping: <Suspense fallback={<ContentSkeleton label="Loading what builders shipped"/>}><ShippingLeadersContent/></Suspense>,
    ...models ? { models: <Suspense fallback={<ContentSkeleton label="Loading model markets"/>}><ModelsStripContent/></Suspense> } : {},
  }
  return <><AppHeader/><main className={`home ${displayFont.variable} ${monoFont.variable}`}>
    <section className="home-hero" aria-labelledby="home-title">
      <div className="home-hero-copy">
        <p className="home-kicker"><i aria-hidden="true"/>Open source markets on Solana</p>
        <h1 id="home-title">Every trade pays the builders.</h1>
        <p className="home-lead">{models ? 'Launch a market for any GitHub repo or Hugging Face model.' : 'Launch a market for any GitHub repo.'} Builders earn from every trade and claim it in SOL.</p>
        <RepoSearch models={models}/>
        <p className="home-hero-links">
          {models && <Link href={`/launch?repo=${encodeURIComponent('huggingface.co/')}`}>Launch a Hugging Face model<ArrowRight size={15} aria-hidden="true"/></Link>}
          <Link href="/find-repos">Find repos gaining attention<ArrowRight size={15} aria-hidden="true"/></Link>
        </p>
        <Suspense fallback={<HomeProofFallback/>}><HomeProof/></Suspense>
      </div>
      <div className="home-hero-live"><Suspense fallback={<LiveMarketFallback/>}><LiveMarketContent/></Suspense></div>
    </section>
    <Suspense fallback={null}><PulseTickerContent/></Suspense>
    <HomeBoard title="Markets" tabs={tabs} panels={panels}
      action={<Link href="/explore" className="view-all">View all <ArrowRight size={18} aria-hidden="true"/></Link>}
      footer={<Link href="/waiting" className="home-board-more">Builder fees waiting for maintainers <ArrowRight size={15} aria-hidden="true"/></Link>}/>
    <section className="home-how" aria-labelledby="home-how-title">
      <div className="home-how-copy">
        <p className="home-kicker">How it works</p>
        <h2 id="home-how-title">Find a repo. Launch its market. Builders get paid.</h2>
        <LaunchBenefits discoveryEnabled={discoveryEnabled}/>
        <Link href="/how-it-works" className="home-board-more">How repo.ing works <ArrowRight size={15} aria-hidden="true"/></Link>
      </div>
      <FlywheelVideo id="home-flywheel-video"/>
    </section>
  </main><Footer/></>
}

// The live card: the official $REPOING row and its 7-day chart from the cache /api/market/<mint>/trades serves (so the card
// and the API never disagree). Without either it says live prices are unavailable rather than showing nothing.
async function LiveMarketContent() {
  const [{ markets }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  const market = markets.find(row => row.mint === OFFICIAL_TOKEN.mint)
  let chart = null
  try { chart = market ? liveChart(JSON.parse(await marketCharts().get(market.mint, LIVE_MARKET_RANGE))) : null }
  catch (error) { console.error('home live market failed', error.message) }
  if (!market || !chart) return <LiveMarketFallback unavailable/>
  const { mint, repoId, symbol, fullName, source, priceSol, volume24hLamports, earned } = market
  return <LiveMarket market={{ mint, repoId, symbol, fullName, source, priceSol, volume24hLamports, earned }} initial={chart}
    usdPerSol={usdPerSol} renderedAt={Date.now()}/>
}

// Both list tabs from one read per render. Home lists promote: never a do-not-promote or maintainer-declined repository
// (nothing when that list is unreadable), and only markets that earned promotion (repo-quality.mjs): new repositories wait
// until 10% of their graduation target. /explore still lists every market.
const homeLists = cache(async () => {
  const [{ markets, unavailable }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  const promotable = await promotableMarkets(shownMarkets(markets))
  const notice = unavailable || (!promotable && 'Markets are temporarily unavailable.')
  return { notice, usdPerSol, tabs: homeMarketTabs(withModelFacts(await withPulse(featuredMarkets(promotable ?? [])), { schedule: after }), { usdPerSol }) }
})

async function MarketListContent({ tab }) {
  const { notice, usdPerSol, tabs } = await homeLists()
  return <>{notice && <p className="subtle-notice">{notice}</p>}<MarketTable markets={tabs[tab]} usdPerSol={usdPerSol}
    empty={tab === 'Trending' ? 'Nothing has traded in the last 24 hours. See the newest launches under New.' : tab === 'Market cap' ? 'No market has traded yet.' : 'No indexed markets yet. Paste a repository above to start one.'}/></>
}

// Hugging Face model markets (HF_MARKETS_ENABLED only), under the same do-not-promote rule as the lists.
async function ModelsStripContent() {
  const { markets } = await listMarkets()
  const promotable = await promotableMarkets(markets)
  return promotable ? <ModelsStrip markets={selectModelStrip(withModelFacts(promotable, { schedule: after }))}/>
    : <p className="home-board-empty">Model markets are temporarily unavailable.</p>
}

// The race ranks by verified reserves and keeps new repositories in place, labeled (labeledRacers); the market list is
// read only for those labels, so its outage never hides a racer.
async function GraduationRaceContent() {
  const [{ markets, unavailable }, listed] = await Promise.all([graduationRace(), listMarkets()])
  return <GraduationRaceBoard markets={await withPulse(labeledRacers(shownMarkets(markets), listed.markets))} unavailable={unavailable} compact/>
}

// Live from GitHub: the newest releases, merges, star spikes and Hacker News stories across live markets that earned
// promotion; hidden while the market list is unavailable.
async function PulseTickerContent() {
  const [{ markets, unavailable }, items] = await Promise.all([listMarkets(),
    readPulseTicker(database(), { limit: 40 }).catch(error => { console.error('pulse ticker failed', error.message); return [] })])
  return unavailable ? null : <PulseTicker items={featuredTicker(items, markets)}/>
}

// The community repositories that shipped the most code this week ($REPOING, do-not-promote and maintainer-declined repos,
// and new repos that have not earned promotion, excluded; unavailable while the do-not-promote set is unreadable).
async function ShippingLeadersContent() {
  const [{ markets }, index, excluded] = await Promise.all([listMarkets(), pulseIndex(), promotionExcluded()])
  if (!excluded) return <p className="home-board-empty">Shipping leaders are temporarily unavailable.</p>
  const leaders = shippingLeaders(featuredMarkets(shownMarkets(markets)).map(market => ({ ...market, pulse: index.get(String(market.repoId)) ?? null })),
    { excluded, skipMints: [OFFICIAL_TOKEN.mint], limit: 5 })
  return <ShippingLeaders markets={leaders}/>
}
