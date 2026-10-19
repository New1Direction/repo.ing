import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { LaunchBenefits } from '../../components/launch-benefits'
import { TrendingLaunchStrip } from '../../components/trending-launches'
import { discoveryRewardsEnabled } from '../../lib/server.mjs'
import { trendingLaunches } from '../../lib/trending-launches.mjs'
import { AppHeader, Footer } from '../../components/ui'
import { RepoSearch } from '../../components/repo-search'
import { hfMarketsEnabled } from '../../../src/hf-launch.mjs'
import { guideHref } from '../../lib/launch-guide-funnel.mjs'
import '../../maintainer-opt-out.css'
import '../../direct-coins.css'
export const dynamic = 'force-dynamic'
export function generateMetadata() {
  const project = hfMarketsEnabled() ? 'a public GitHub repository or Hugging Face model' : 'a public GitHub repository'
  return { title: 'Launch a repository · repo.ing', description: `Give open source a market. Paste ${project}, review the token and costs, then launch it with your wallet.` }
}
export default async function LaunchStart({ searchParams }) {
  const params = await searchParams
  const initialUrl = typeof params.repo === 'string' && params.repo.length <= 256 ? params.repo : ''
  // A README or bookmark link already names a repository: keep that page focused on it.
  const trending = initialUrl ? null : await trendingLaunches()
  const discoveryEnabled = discoveryRewardsEnabled(), models = hfMarketsEnabled()
  return <><AppHeader active="launch"/><main className="section-wrap launch-start">
    <div className="page-intro"><div className="eyebrow">LAUNCH</div><h1>Give open source a market.</h1><p>{models ? 'Paste a public GitHub repository or Hugging Face model. Review the token and costs, then launch with your wallet.'
      : 'Paste a public GitHub repository. Review the token and costs, then launch with your wallet.'}</p></div>
    {process.env.HOOK_OWNER_APPROVED_LAUNCHES === 'true'
      ? <section className="coin-entry-points" aria-label="Create your own coin">
        <div><strong>Your own coin, no repository needed</strong><p>Add a name, image and links, then snap on blocks: cap how much one wallet can hold and earn a fee on every trade. repo.ing approves each launch.</p></div>
        <Link className="button primary" href="/hooks/launch-review">Launch your own coin <ArrowRight size={15} aria-hidden="true"/></Link>
        <Link className="button outline" href="/hooks/blocks">See the blocks</Link>
      </section>
      : <section className="coin-entry-points" aria-label="Create your own coin">
        <div><strong>Your own coin, without a repository</strong><p>Device drafts and devnet checks. GitHub optional; launch execution is not available.</p></div>
        <Link className="button primary" href="/coins/new?lane=programmable">Programmable Coin draft <ArrowRight size={15} aria-hidden="true"/></Link>
        <Link className="button outline" href="/coins/new?lane=standard">Standard Coin draft</Link>
        <Link href="/programmable-coins">How programmable coins work</Link>
      </section>}
    <RepoSearch key={initialUrl} initialUrl={initialUrl} models={models}/>
    {trending?.repos.length ? <TrendingLaunchStrip result={trending} discoveryEnabled={discoveryEnabled} now={Date.now()}/>
      : <Link href="/find-repos" className="launch-find-link">Find a repo gaining attention <ArrowRight size={15} aria-hidden="true"/></Link>}
    <LaunchBenefits discoveryEnabled={discoveryEnabled}/>
    <p className="launch-trust-note">One market per repository. Already launched? We’ll open its existing market. A community launch does not imply the maintainer’s endorsement. Maintainers can <Link href="/opt-out">opt their repository out</Link>.</p>
    <Link href={guideHref('launch')} className="launch-find-link">Maintainer? Run a free preflight and schedule your launch in public <ArrowRight size={15} aria-hidden="true"/></Link>
    <Link href="/agents" className="launch-find-link">Use an agent, README button, or browser shortcut <ArrowRight size={15} aria-hidden="true"/></Link>
  </main><Footer/></>
}
