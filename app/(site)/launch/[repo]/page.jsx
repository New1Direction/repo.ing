import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity, RepoStats, GitHubLink } from '../../../components/ui'
import { LaunchForm } from '../../../components/launch-form'
import { LaunchRepoFacts } from '../../../components/launch-repo-facts'
import { repositoryById, marketByRepo, launchAvailable, discoveryRewardsEnabled, builderAllocationEnabled, database, configAddress } from '../../../lib/server.mjs'
import { trendCandidate } from '../../../../src/trend-intake.mjs'
import { checkAgentDraft } from '../../../lib/agent-launch.mjs'
import { activeLaunchFeeTerms } from '../../../lib/launch-fee.mjs'
import { maintainerDecision } from '../../../lib/maintainer-opt-outs.mjs'
import { LaunchBlocked } from '../../../components/maintainer-declined'
import { LaunchCopyBlocked } from '../../../components/fork-guard'
import { ForkOfLabel } from '../../../components/market-signals'
import { checkLaunchLineage, LineageError } from '../../../../src/repo-lineage.mjs'
import { verificationBonusLamports } from '../../../../src/verification-bonus.mjs'
import { isHfMarketId } from '../../../../src/hf-launch.mjs'
import { ModelLaunch } from '../../../components/hf/model-launch'
import { quoteOptions, stockPairsLaunchable } from '../../../../src/quote-assets.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }
export default async function Launch({ params, searchParams }) {
  const { repo: repoId } = await params
  // Hugging Face model market ids (src/market-identity.mjs) have their own launch page.
  if (isHfMarketId(repoId)) return <ModelLaunch repoId={repoId} searchParams={searchParams}/>
  const { market } = await marketByRepo(repoId)
  if (market) redirect(`/token/${market.mint}`)
  const repo = await repositoryById(repoId)
  if (!repo) notFound()
  // The maintainer opted this repository out of repo.ing (or that cannot be checked): no launch form.
  const optOut = await maintainerDecision(repoId)
  if (optOut !== null) return <><AppHeader/><main className="section-wrap launch-page"><LaunchBlocked repo={repo} decision={optOut}/></main><Footer/></>
  // The fork guard (src/repo-lineage.mjs): a fork or copy of a launched repository gets no launch form. Launch prepare checks
  // again, so a database hiccup here only skips the early notice.
  const pool = database()
  if (pool) {
    try { await checkLaunchLineage({ pool, repo }) }
    catch (error) {
      if (error instanceof LineageError) return <><AppHeader/><main className="section-wrap launch-page"><LaunchCopyBlocked error={error}/></main><Footer/></>
      console.warn('launch_lineage_unavailable', { code: error?.code ?? error?.name ?? 'error' })
    }
  }
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
  // SOL, plus the owner's company stock when stock pairs can be launched; from the owner GitHub reported in the read above.
  const pairs = quoteOptions(repo, { enabled: stockPairsLaunchable() })
  return <><AppHeader active="launch"/><main className="section-wrap launch-page"><Link href="/explore" className="back-link"><ArrowLeft size={18}/>Back to explore</Link><div className="repo-hero-card"><div><RepoIdentity repo={repo}><ForkOfLabel parent={repo.fork?.parent?.fullName}/></RepoIdentity><RepoStats repo={repo} detailed/></div><div className="repo-hero-right"><GitHubLink repo={repo}/><div className="repo-details"><span>{repo.language || 'Language unavailable'}</span><span>{repo.license || 'License unavailable'}</span><span>{repo.updatedAt ? `Updated ${new Date(repo.updatedAt).toLocaleDateString()}` : 'Update date unavailable'}</span></div></div></div><LaunchRepoFacts repo={repo}/><LaunchForm key={`${repoId}:${query.draft || "manual"}`} repo={repo} draft={draft ? { token: query.draft, tokenName: draft.tokenName, tokenSymbol: draft.tokenSymbol, initialBuy: draft.initialBuy } : undefined} trendRevision={trendRevision} available={launchAvailable()} discoveryEnabled={discoveryRewardsEnabled()} allocationEnabled={builderAllocationEnabled()} launchFee={launchFee} verificationBonus={verificationBonusLamports()?.toString() ?? null} quoteOptions={pairs}/></main><Footer/></>
}
