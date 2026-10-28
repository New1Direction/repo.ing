import { Suspense } from 'react'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { ContentSkeleton } from '../../../components/loading-skeleton'
import { ExploreNavigation } from '../../../components/explore-navigation'
import { HookCoinExplore } from '../../../components/hooks-explore'
import { exploreHookCoins, hookCoinRow } from '../../../lib/hooklab-explore.mjs'
import { solUsdPrice } from '../../../lib/sol-usd.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Hooks coins · repo.ing', description: 'Browse coins launched with Hooks: max wallets, creator fees and burns, traded in SOL on repo.ing.' }

export default function ExploreHooks() {
  return <><AppHeader active="explore"/><main className="section-wrap explore-page"><div className="page-intro"><div className="eyebrow">EXPLORE</div><h1>Hooks coins.</h1><p>Coins with their own rules, traded in SOL.</p><Link href="/hooks" className="button primary">Launch a coin</Link></div><ExploreNavigation active="hooks"/>
    <Suspense fallback={<ContentSkeleton label="Loading Hooks coins"/>}><Coins/></Suspense>
  </main><Footer/></>
}
async function Coins() {
  const [coins, usdPerSol] = await Promise.all([exploreHookCoins(), solUsdPrice()])
  return <HookCoinExplore coins={coins.map(hookCoinRow)} usdPerSol={usdPerSol}/>
}
