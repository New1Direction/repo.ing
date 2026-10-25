import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AppHeader, Footer, RepoAvatar, RepoIdentity, RepoStats, GitHubLink } from '../../../components/ui'
import { LaunchTokenAvatar, LaunchTokenImageProvider } from '../../../components/launch-token-image'
import { LaunchForm } from '../../../components/launch-form'
import { newMarketBuysOpen } from '../../../lib/trading-recovery.mjs'
import { LaunchRepoFacts } from '../../../components/launch-repo-facts'
import { repositoryById, marketByRepo, discoveryRewardsEnabled, database, configAddress, ordinaryLaunchRuntime } from '../../../lib/server.mjs'
import { trendCandidate } from '../../../../src/trend-intake.mjs'
import { checkAgentDraft } from '../../../lib/agent-launch.mjs'
import { activeLaunchFeeTerms } from '../../../lib/launch-fee.mjs'
import { formatUtcDay } from '../../../lib/format.mjs'
import { maintainerDecision } from '../../../lib/maintainer-opt-outs.mjs'
import { LaunchBlocked } from '../../../components/maintainer-declined'
import { LaunchCopyBlocked } from '../../../components/fork-guard'
import { ForkOfLabel } from '../../../components/market-signals'
import { checkLaunchLineage, LineageError } from '../../../../src/repo-lineage.mjs'
import { isHfMarketId } from '../../../../src/hf-launch.mjs'
import { ModelLaunch } from '../../../components/hf/model-launch'
import { quoteOptions, stockPairsLaunchable } from '../../../../src/quote-assets.mjs'
import { EARLY_ACCESS_WINDOWS, earlyAccessLaunchable } from '../../../../src/early-access.mjs'
import { earlyAccessOptionTerms } from '../../../../src/early-access-rules.mjs'
import { bundleFormSettings, bundleLaunchable } from '../../../../src/bundle-launch.mjs'
import { repositoryBlockers } from '../../../../src/bundle-raise-store.mjs'
import { activeSchedule, publicSchedule } from '../../../../src/launch-schedules.mjs'
import { ScheduledLaunchBlocked, ScheduledWindowNote } from '../../../components/scheduled-launch'
import { guideHref } from '../../../lib/launch-guide-funnel.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }
export default async function Launch({ params, searchParams }) {
  const { repo: repoId } = await params
  // Hugging Face model market ids (src/market-identity.mjs) have their own launch page.
  if (isHfMarketId(repoId)) return <ModelLaunch repoId={repoId} searchParams={searchParams}/>
  const launch = ordinaryLaunchRuntime()
  const { market } = await marketByRepo(repoId)
  if (market) redirect(`/token/${market.mint}`)
  const repo = await repositoryById(repoId, { pool: launch.recovery ? launch.pool : database() })
  if (!repo) notFound()
  // The maintainer opted this repository out of repo.ing (or that cannot be checked): no launch form.
  const optOut = await maintainerDecision(repoId)
  if (optOut !== null) return <><AppHeader/><main className="section-wrap launch-page"><LaunchBlocked repo={repo} decision={optOut}/></main><Footer/></>
  // The fork guard (src/repo-lineage.mjs): a fork or copy of a launched repository gets no launch form. Advisory: launch prepare
  // checks again, so a database or GitHub hiccup here only skips the early notice.
  const pool = database()
  // Recovery GETs retain the public reader; authoritative lineage checks still run during POST prepare.
  if (pool && !launch.recovery) {
    try { await checkLaunchLineage({ pool, repo, advisory: true }) }
    catch (error) {
      if (error instanceof LineageError) return <><AppHeader/><main className="section-wrap launch-page"><LaunchCopyBlocked error={error}/></main><Footer/></>
      console.warn('launch_lineage_unavailable', { code: error?.code ?? error?.name ?? 'error' })
    }
  }
  // A scheduled launch (src/launch-schedules.mjs): before its time no form; during its window the form says who may launch. Advisory
  // like the checks above: the coordinator enforces it at reservation, so an unreadable schedule here only skips the notice.
  const schedule = pool ? await activeSchedule(pool, repoId).then(row => publicSchedule(row), () => null) : null
  if (schedule?.state === 'upcoming') return <><AppHeader active="launch"/><main className="section-wrap launch-page"><ScheduledLaunchBlocked repo={repo} schedule={schedule}/></main><Footer/></>
  const windowOpen = schedule?.state === 'open'
  const query = await searchParams
  let draft
  if (query.draft !== undefined) {
    try { draft = checkAgentDraft(query.draft, repoId) }
    catch (error) { return <><AppHeader/><main className="section-wrap launch-page"><h1>Launch review unavailable</h1><p>{error.message}</p><Link href={`/launch/${repoId}`} className="button outline">Start a fresh review</Link></main><Footer/></> }
  }
  let trendRevision
  if (query.from === 'trend' && !launch.recovery) {
    const candidate = await trendCandidate(database(), repoId)
    if (!candidate?.ready || candidate.approvedConfig !== configAddress() || !discoveryRewardsEnabled()) return <><AppHeader/><main className="section-wrap launch-page"><h1>Trend needs another review</h1><p>The repository, trend evidence, or launch configuration has changed. An operator must review it before this shortcut can continue.</p><Link href="/explore" className="button outline">Back to Explore</Link></main><Footer/></>
    trendRevision = candidate.revision
  }
  // Explained only when the config new launches use has a launch fee (read once per config, then cached).
  const launchFee = await activeLaunchFeeTerms({ config: launch.config })
  // SOL, plus the owner's company stock when stock pairs can be launched; from the owner GitHub reported in the read above.
  const pairs = quoteOptions(repo, { enabled: !launch.recovery && stockPairsLaunchable() })
  // Contributor early access (docs/EARLY_ACCESS.md): offered only while it can launch; the form shows it for SOL launches from here.
  const earlyAccess = !launch.recovery && earlyAccessLaunchable() && !windowOpen ? { windows: EARLY_ACCESS_WINDOWS.map(window => ({ ...window })), ...earlyAccessOptionTerms() } : null
  // Bundle launches (docs/BUNDLE_LAUNCH.md): offered only while a raise can be opened; the form shows it beside the standard launch.
  const bundle = !launch.recovery && bundleLaunchable() && !windowOpen ? bundleFormSettings() : null
  // A repository with a live bundle launches from its raise, whatever the switch says (the launch coordinator refuses a standard
  // launch beside it).
  const liveBundleId = pool ? (await repositoryBlockers(pool, repoId).catch(() => null))?.liveBundleId : null
  if (liveBundleId) return <><AppHeader active="launch"/><main className="section-wrap launch-page"><h1>This repository has a group launch</h1><p>Backers are funding its launch. Its market launches from the raise when it is full.</p><Link href={`/group/${liveBundleId}`} className="button primary">See the raise</Link></main><Footer/></>
  return <><AppHeader active="launch"/><main className="section-wrap launch-page"><LaunchTokenImageProvider><Link href="/explore" className="back-link"><ArrowLeft size={18}/>Back to explore</Link><div className="repo-hero-card"><div><RepoIdentity repo={repo} avatar={<LaunchTokenAvatar><RepoAvatar repo={repo} size="large"/></LaunchTokenAvatar>}><ForkOfLabel parent={repo.fork?.parent?.fullName}/></RepoIdentity><RepoStats repo={repo} detailed/></div><div className="repo-hero-right"><GitHubLink repo={repo}/><div className="repo-details"><span>{repo.language || 'Language unavailable'}</span><span>{repo.license || 'License unavailable'}</span><span>{repo.updatedAt ? `Updated ${formatUtcDay(repo.updatedAt)}` : 'Update date unavailable'}</span></div></div></div><LaunchRepoFacts repo={repo}/>{!launch.recovery && <p className="launch-guide-link"><Link href={guideHref('repo', repoId)}>Run this repository&apos;s free launch preflight</Link>: the Launch Quality facts known before launch and exactly what a launch needs. Maintainers can schedule it in public from there.</p>}{windowOpen && <ScheduledWindowNote schedule={schedule}/>}<LaunchForm key={`${repoId}:${query.draft || "manual"}`} repo={repo} draft={draft ? { token: query.draft, tokenName: draft.tokenName, tokenSymbol: draft.tokenSymbol, initialBuy: draft.initialBuy } : undefined} trendRevision={trendRevision} available={Boolean(launch.pool && launch.config && launch.creator)} discoveryEnabled={launch.discoveryEnabled} allocationEnabled={launch.builderAllocationEnabled} launchFee={launchFee} verificationBonus={launch.verificationBonusLamports?.toString() ?? null} quoteOptions={pairs} earlyAccess={earlyAccess} bundle={bundle} recovery={launch.recovery} firstBuyAvailable={launch.recovery && await newMarketBuysOpen()}/></LaunchTokenImageProvider></main><Footer/></>
}
