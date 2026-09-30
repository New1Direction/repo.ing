import { Suspense } from 'react'
import { AppHeader, Footer } from '../../components/ui'
import { ContentSkeleton } from '../../components/loading-skeleton'
import { ExploreNavigation } from '../../components/explore-navigation'
import { RecentlyClaimed, WaitingHeader, WaitingList } from '../../components/waiting-board'
import { waitingBoard } from '../../lib/waiting-board.mjs'
import { solUsdPrice } from '../../lib/sol-usd.mjs'
import '../../waiting.css'

export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Waiting for maintainers · repo.ing',
  description: 'Open-source repositories with builder fees waiting to be claimed, ranked by amount. Every trade pays the builders — tag a maintainer so they can verify with GitHub and claim.',
  alternates: { canonical: '/waiting' },
}

export default function WaitingPage() {
  return <><AppHeader active="explore"/><main className="section-wrap waiting-page">
    <ExploreNavigation active="waiting"/>
    <Suspense fallback={<ContentSkeleton label="Loading builder fees waiting for maintainers"/>}><Board/></Suspense>
  </main><Footer/></>
}

async function Board() {
  const [board, usdPerSol] = await Promise.all([waitingBoard(), solUsdPrice()])
  return <>
    <WaitingHeader total={board.total} count={board.count} usdPerSol={usdPerSol}/>
    {board.unavailable ? <p className="subtle-notice" role="status">{board.unavailable}</p> : <WaitingList markets={board.waiting} count={board.count} usdPerSol={usdPerSol}/>}
    <RecentlyClaimed payouts={board.claimed}/>
  </>
}
