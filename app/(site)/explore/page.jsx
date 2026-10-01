import { Suspense } from 'react'
import { ContentSkeleton } from '../../components/loading-skeleton'
import Link from 'next/link'
import { AppHeader, Footer } from '../../components/ui'
import { ExploreList } from '../../components/explore-list'
import { ExploreGrowth } from '../../components/growth-surfaces'
import { ExploreNavigation } from '../../components/explore-navigation'
import { publicGrowth } from '../../lib/growth.mjs'
import { listMarkets, graduationRace } from '../../lib/server.mjs'
import { GraduationRace, GraduationRaceBoard, GraduationRaceFallback } from '../../components/graduation-race'
import { solUsdPrice } from '../../lib/sol-usd.mjs'
import { exploreGrowthView } from '../../lib/growth-view.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Explore markets · repo.ing', description: 'Browse live markets for open source repositories. Real repositories, real communities — every trade pays the builders.' }
export default function Explore() {
  return <><AppHeader active="explore"/><main className="section-wrap explore-page"><div className="page-intro"><div className="eyebrow">EXPLORE</div><h1>Discover open source markets.</h1><p>Real repositories. Real communities. Real earnings.</p><Link href="/launch" className="button primary">Launch a repository</Link></div><ExploreNavigation active="markets"/><GraduationRace><Suspense fallback={<GraduationRaceFallback/>}><Graduating/></Suspense></GraduationRace><h2 id="all-markets">All markets</h2>
    <Suspense fallback={<ContentSkeleton label="Loading markets"/>}><Markets/></Suspense>
    <div id="growth"><Suspense fallback={<ContentSkeleton label="Loading market highlights" rows={2}/>}><Highlights/></Suspense></div>
  </main><Footer/></>
}
async function Markets() {
  const [{ markets, unavailable }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  return <>{unavailable && <p className="subtle-notice">{unavailable}</p>}<ExploreList markets={markets} usdPerSol={usdPerSol}/></>
}
async function Graduating() {
  const { markets, unavailable } = await graduationRace()
  return <GraduationRaceBoard markets={markets} unavailable={unavailable}/>
}
async function Highlights() {
  let growth
  try { growth = await publicGrowth() } catch {}
  return growth ? <ExploreGrowth data={exploreGrowthView(growth)}/> : <p className="subtle-notice">Market highlights are temporarily unavailable.</p>
}
