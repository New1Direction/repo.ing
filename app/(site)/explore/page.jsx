import { Suspense } from 'react'
import { after } from 'next/server'
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
import { withPulse } from '../../lib/pulse-index.mjs'
import { labeledRacers } from '../../lib/repo-quality.mjs'
import { hfMarketsEnabled, shownMarkets, withModelFacts } from '../../lib/hf-markets.mjs'
import { HookCoinStrip } from '../../components/hooks-explore'
import { exploreHookCoins, hookCoinRow } from '../../lib/hooklab-explore.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Explore markets · repo.ing', description: 'Browse live markets for open source repositories. Every trade pays the builders.' }
export default function Explore() {
  return <><AppHeader active="explore"/><main className="section-wrap explore-page"><div className="page-intro"><div className="eyebrow">EXPLORE</div><h1>Discover open source markets.</h1><Link href="/launch" className="button primary">Launch a repository</Link></div><ExploreNavigation active="markets"/><Suspense fallback={<GraduationRace><GraduationRaceFallback/></GraduationRace>}><Graduating/></Suspense><Suspense fallback={null}><HooksStrip/></Suspense><h2 id="all-markets">All markets</h2>
    <Suspense fallback={<ContentSkeleton label="Loading markets"/>}><Markets/></Suspense>
    <div id="growth"><Suspense fallback={<ContentSkeleton label="Loading market highlights" rows={2}/>}><Highlights/></Suspense></div>
  </main><Footer/></>
}
async function Markets() {
  const [{ markets, unavailable }, usdPerSol] = await Promise.all([listMarkets(), solUsdPrice()])
  return <>{unavailable && <p className="subtle-notice">{unavailable}</p>}<ExploreList markets={withModelFacts(await withPulse(shownMarkets(markets)), { schedule: after })} usdPerSol={usdPerSol} modelsEnabled={hfMarketsEnabled()}/></>
}
// The busiest Hooks coins, linked to Explore → Hooks coins; nothing before the first coin (or while the listing is unavailable).
async function HooksStrip() {
  const [coins, usdPerSol] = await Promise.all([exploreHookCoins(), solUsdPrice()])
  return <HookCoinStrip coins={coins.map(hookCoinRow)} usdPerSol={usdPerSol}/>
}
// The race ranks by verified reserves and keeps new repositories in place, labeled (labeledRacers); the list below has
// all. No racers (or progress unavailable): the section is left out rather than showing an empty board.
async function Graduating() {
  const [{ markets, unavailable }, listed] = await Promise.all([graduationRace(), listMarkets()])
  const racers = labeledRacers(shownMarkets(markets), listed.markets)
  if (unavailable || !racers.length) return null
  return <GraduationRace><GraduationRaceBoard markets={await withPulse(racers)}/></GraduationRace>
}
async function Highlights() {
  let growth
  try { growth = await publicGrowth() } catch {}
  return growth ? <ExploreGrowth data={exploreGrowthView(growth)}/> : <p className="subtle-notice">Market highlights are temporarily unavailable.</p>
}
