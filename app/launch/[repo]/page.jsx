import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity, RepoStats, GitHubLink } from '../../components/ui'
import { LaunchForm } from '../../components/launch-form'
import { repositoryById, marketByRepo, launchAvailable, discoveryRewardsEnabled, builderAllocationEnabled, database, configAddress } from '../../lib/server.mjs'
import { trendCandidate } from '../../../src/trend-intake.mjs'
export const dynamic = 'force-dynamic'
export default async function Launch({ params, searchParams }) {
  const { repo: repoId } = await params
  const { market } = await marketByRepo(repoId)
  if (market) redirect(`/token/${market.mint}`)
  const repo = await repositoryById(repoId)
  if (!repo) notFound()
  let trendRevision
  if ((await searchParams).from === 'trend') {
    const candidate = await trendCandidate(database(), repoId)
    if (!candidate?.ready || candidate.approvedConfig !== configAddress() || !discoveryRewardsEnabled()) return <><AppHeader/><main className="section-wrap launch-page"><h1>Trend needs another review</h1><p>The repository, trend evidence, or launch configuration has changed. An operator must review it before this shortcut can continue.</p><Link href="/explore" className="button outline">Back to Explore</Link></main><Footer/></>
    trendRevision = candidate.revision
  }
  return <><AppHeader active="launch"/><main className="section-wrap launch-page"><Link href="/explore" className="back-link"><ArrowLeft size={18}/>Back to explore</Link><div className="repo-hero-card"><div><RepoIdentity repo={repo}/><RepoStats repo={repo} detailed/></div><div className="repo-hero-right"><GitHubLink repo={repo}/><div className="repo-details"><span>{repo.language || 'Language unavailable'}</span><span>{repo.license || 'License unavailable'}</span><span>{repo.updatedAt ? `Updated ${new Date(repo.updatedAt).toLocaleDateString()}` : 'Update date unavailable'}</span></div></div></div><LaunchForm repo={repo} trendRevision={trendRevision} available={launchAvailable()} discoveryEnabled={discoveryRewardsEnabled()} allocationEnabled={builderAllocationEnabled()}/></main><Footer/></>
}
