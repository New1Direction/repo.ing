import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { LaunchBenefits } from '../../components/launch-benefits'
import { TrendingLaunchStrip } from '../../components/trending-launches'
import { discoveryRewardsEnabled } from '../../lib/server.mjs'
import { trendingLaunches } from '../../lib/trending-launches.mjs'
import { AppHeader, Footer } from '../../components/ui'
import { RepoSearch } from '../../components/repo-search'
import '../../maintainer-opt-out.css'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Launch a repository · repo.ing', description: 'Give open source a market. Paste a public GitHub repository, review the token and costs, then launch it with your wallet.' }
export default async function LaunchStart({ searchParams }) {
  const params = await searchParams
  const initialUrl = typeof params.repo === 'string' && params.repo.length <= 256 ? params.repo : ''
  // A README or bookmark link already names a repository: keep that page focused on it.
  const trending = initialUrl ? null : await trendingLaunches()
  const discoveryEnabled = discoveryRewardsEnabled()
  return <><AppHeader active="launch"/><main className="section-wrap launch-start">
    <div className="page-intro"><div className="eyebrow">LAUNCH</div><h1>Give open source a market.</h1><p>Paste a public GitHub repository. Review the token and costs, then launch with your wallet.</p></div>
    <RepoSearch key={initialUrl} initialUrl={initialUrl}/>
    {trending?.repos.length ? <TrendingLaunchStrip result={trending} discoveryEnabled={discoveryEnabled} now={Date.now()}/>
      : <Link href="/find-repos" className="launch-find-link">Find a repo gaining attention <ArrowRight size={15} aria-hidden="true"/></Link>}
    <LaunchBenefits discoveryEnabled={discoveryEnabled}/>
    <p className="launch-trust-note">One market per repository. Already launched? We’ll open its existing market. A community launch does not imply the maintainer’s endorsement. Maintainers can <Link href="/opt-out">opt their repository out</Link>.</p>
    <Link href="/agents" className="launch-find-link">Use an agent, README button, or browser shortcut <ArrowRight size={15} aria-hidden="true"/></Link>
  </main><Footer/></>
}
