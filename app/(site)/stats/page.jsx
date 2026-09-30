import { Suspense } from 'react'
import { ContentSkeleton } from '../../components/loading-skeleton'
import Link from 'next/link'
import { AppHeader, Footer } from '../../components/ui'
import { ProtocolAnalytics } from '../../components/protocol-analytics'
import { database } from '../../lib/server.mjs'
import { solUsdPrice } from '../../lib/sol-usd.mjs'
import { analyticsWindow, readProtocolAnalytics } from '../../../src/protocol-analytics.mjs'
import { readReserveCoverage } from '../../../src/reserve-coverage.mjs'
import { buybackReceipts, buybackStatus } from '../../lib/buyback-feed.mjs'
import { TipStats } from '../../components/tip-stats'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Protocol analytics · repo.ing', description: 'Trading activity, verified builder payouts, and platform revenue allocation on repo.ing.' }

export default async function StatsPage({ searchParams }) {
  const { range } = analyticsWindow((await searchParams)?.range)
  return <><AppHeader active="stats"/><main className="section-wrap protocol-page analytics-page">
    <div className="protocol-intro"><div><div className="eyebrow">PROTOCOL ANALYTICS</div><h1>Open source, in numbers.</h1><p>Real markets. Builder earnings. Transparent revenue.</p></div><span className="protocol-network"><span/>Solana mainnet</span></div>
    <div className="analytics-toolbar"><span>Activity</span><nav aria-label="Analytics period">{[['24h','24h'],['7d','7d'],['30d','30d'],['all','All time']].map(([value,label])=><Link key={value} href={`/stats${value==='all'?'':`?range=${value}`}`} aria-current={range===value?'page':undefined} scroll={false}>{label}</Link>)}</nav></div>
    <Suspense key={range} fallback={<ContentSkeleton label="Loading analytics for this period"/>}><Analytics range={range}/></Suspense>
    <Suspense fallback={null}><TipStats/></Suspense>
  </main><Footer/></>
}

async function Analytics({ range }) {
  const [result, price, buybacks, status] = await Promise.allSettled([readProtocolAnalytics(database(), { range }), solUsdPrice(), buybackReceipts(), buybackStatus()])
  if (result.status === 'fulfilled') result.value.platform.coverage = await readReserveCoverage(result.value.platform)
  return result.status === 'fulfilled' ? <ProtocolAnalytics data={result.value} usdPerSol={price.status === 'fulfilled' ? price.value : null} buybacks={buybacks.status === 'fulfilled' ? buybacks.value : undefined} buybackStatus={status.status === 'fulfilled' ? status.value : null}/> : <div className="state-card error" role="status">Protocol analytics are temporarily unavailable. Please try again shortly.</div>
}
