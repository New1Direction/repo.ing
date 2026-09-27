import Link from 'next/link'
import { Suspense } from 'react'
import { ContentSkeleton } from './components/loading-skeleton'
import { ArrowRight } from 'lucide-react'
import { AppHeader, Footer } from './components/ui'
import { RepoSearch } from './components/repo-search'
import { HomeMarkets } from './components/home-markets'
import { listMarkets, discoveryRewardsEnabled } from './lib/server.mjs'
import { solUsdPrice } from './lib/sol-usd.mjs'

export const dynamic = 'force-dynamic'
export default function Home() {
  const discoveryEnabled = discoveryRewardsEnabled()
  return <><AppHeader/><main><section className="hero"><div className="eyebrow">OPEN SOURCE MARKETS</div><h1>Launch open source markets.</h1><p><span className="hero-lead">Tokenize any GitHub repo.</span><span>Every trade pays the builders.</span></p><RepoSearch/>{discoveryEnabled && <div className="hero-rewards"><strong>Discover a repo. Launch its market. Earn a share of trading fees.</strong><span>50% of repo.ing’s share until graduation, 30 days, or 2.5 SOL earned. <Link href="/how-it-works#discovery">How rewards work →</Link></span></div>}</section><section className="section-wrap trending"><div className="section-heading"><div><h2>Explore repositories</h2><p>Open source projects. Real markets. Real builders.</p></div><Link href="/explore" className="view-all">View all <ArrowRight size={20}/></Link></div><Suspense fallback={<ContentSkeleton label="Loading markets"/>}><MarketContent/></Suspense></section></main><Footer/></>
}

async function MarketContent() {
  const [{ markets, unavailable }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  return <>{unavailable && <p className="subtle-notice">{unavailable}</p>}<HomeMarkets markets={markets} usdPerSol={usdPerSol}/></>
}
