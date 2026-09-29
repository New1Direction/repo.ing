import Link from 'next/link'
import { Suspense } from 'react'
import { ContentSkeleton } from '../components/loading-skeleton'
import { ArrowRight } from 'lucide-react'
import { AppHeader, Footer } from '../components/ui'
import { RepoSearch } from '../components/repo-search'
import { LaunchBenefits } from '../components/launch-benefits'
import { HomeMarkets } from '../components/home-markets'
import { listMarkets, discoveryRewardsEnabled } from '../lib/server.mjs'
import { solUsdPrice } from '../lib/sol-usd.mjs'
import { homeMarketTabs } from '../lib/market-order.mjs'
import { FlywheelVideo } from '../components/flywheel-video'

export const dynamic = 'force-dynamic'
export const metadata = { alternates: { canonical: '/', languages: { en: '/', ja: '/ja', 'x-default': '/' } } }
export default function Home() {
  const discoveryEnabled = discoveryRewardsEnabled()
  return <><AppHeader/><main><section className="hero" aria-labelledby="home-title"><div className="eyebrow">OPEN SOURCE MARKETS</div><h1 id="home-title">Launch open source markets.</h1><p><span className="hero-lead">Tokenize any GitHub repo.</span><span>Every trade pays the builders.</span></p><RepoSearch/><Link href="/find-repos" className="launch-find-link">Need inspiration? Find repos gaining attention <ArrowRight size={15} aria-hidden="true"/></Link><LaunchBenefits discoveryEnabled={discoveryEnabled} compact/></section><section className="section-wrap trending"><div className="section-heading"><div><h2>Explore repositories</h2><p>Open source projects. Real markets. Real builders.</p></div><Link href="/explore" className="view-all">View all <ArrowRight size={20}/></Link></div><Suspense fallback={<ContentSkeleton label="Loading markets"/>}><MarketContent/></Suspense></section><div className="section-wrap"><FlywheelVideo id="home-flywheel-video"/></div></main><Footer/></>
}

async function MarketContent() {
  const [{ markets, unavailable }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  return <>{unavailable && <p className="subtle-notice">{unavailable}</p>}<HomeMarkets tabs={homeMarketTabs(markets)} usdPerSol={usdPerSol}/></>
}
