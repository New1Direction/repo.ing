import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity, RepoStats, GitHubLink } from '../../../components/ui'
import { LaunchForm } from '../../../components/launch-form'
import { repositoryById, marketByRepo, launchAvailable, discoveryRewardsEnabled, builderAllocationEnabled, database, configAddress } from '../../../lib/server.mjs'
import { trendCandidate } from '../../../../src/trend-intake.mjs'
import { checkAgentDraft } from '../../../lib/agent-launch.mjs'
import { activeLaunchFeeTerms } from '../../../lib/launch-fee.mjs'
import { maintainerDecision } from '../../../lib/maintainer-opt-outs.mjs'
import { LaunchBlocked } from '../../../components/maintainer-declined'
export const dynamic = 'force-dynamic'
export const metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }
export default async function Launch({ params, searchParams }) {
  const { repo: repoId } = await params
  const { market } = await marketByRepo(repoId)
  if (market) redirect(`/token/${market.mint}`)
  const repo = await repositoryById(repoId)
  if (!repo) notFound()
  // The maintainer opted this repository out of repo.ing (or that cannot be checked): no launch form.
  const optOut = await maintainerDecision(repoId)
  if (optOut !== null) return <><AppHeader/><main className="section-wrap launch-page"><LaunchBlocked repo={repo} decision={optOut}/></main><Footer/></>
  const query = await searchParams
  let draft
  if (query.draft !== undefined) {
    try { draft = checkAgentDraft(query.draft, repoId) }
    catch (error) { return <><AppHeader/><main className="section-wrap launch-page"><h1>Launch review unavailable</h1><p>{error.message}</p><Link href={`/launch/${repoId}`} className="button outline">Start a fresh review</Link></main><Footer/></> }
  }
  let trendRevision
  if (query.from === 'trend') {
    const candidate = await trendCandidate(database(), repoId)
    if (!candidate?.ready || candidate.approvedConfig !== configAddress() || !discoveryRewardsEnabled()) return <><AppHeader/><main className="section-wrap launch-page"><h1>Trend needs another review</h1><p>The repository, trend evidence, or launch configuration has changed. An operator must review it before this shortcut can continue.</p><Link href="/explore" className="button outline">Back to Explore</Link></main><Footer/></>
    trendRevision = candidate.revision
  }
  // Explained only when the config new launches use has a launch fee (read once per config, then cached).
  const launchFee = await activeLaunchFeeTerms()
  return <><AppHeader active="launch"/><main className="section-wrap launch-page"><Link href="/explore" className="back-link"><ArrowLeft size={18}/>Back to explore</Link><div className="repo-hero-card"><div><RepoIdentity repo={repo}/><RepoStats repo={repo} detailed/></div><div className="repo-hero-right"><GitHubLink repo={repo}/><div className="repo-details"><span>{repo.language || 'Language unavailable'}</span><span>{repo.license || 'License unavailable'}</span><span>{repo.updatedAt ? `Updated ${new Date(repo.updatedAt).toLocaleDateString()}` : 'Update date unavailable'}</span></div></div></div><LaunchForm key={`${repoId}:${query.draft || "manual"}`} repo={repo} draft={draft ? { token: query.draft, tokenName: draft.tokenName, tokenSymbol: draft.tokenSymbol, initialBuy: draft.initialBuy } : undefined} trendRevision={trendRevision} available={launchAvailable()} discoveryEnabled={discoveryRewardsEnabled()} allocationEnabled={builderAllocationEnabled()} launchFee={launchFee}/></main><Footer/></>
}
