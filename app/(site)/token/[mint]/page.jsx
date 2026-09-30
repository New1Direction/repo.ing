import { ParticipationBadge } from '../../../components/participation-badge'
import { latestRelease } from '../../../lib/releases.mjs'
import { BuilderAllocation } from '../../../components/builder-allocation'
import { Suspense } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowUpRight, Info } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity, RepoStats, GitHubLink, Badge } from '../../../components/ui'
import { MarketTrading } from '../../../components/market-trading'
import { ShareMarket } from '../../../components/share-market'
import { ActivityFeed } from '../../../components/activity-feed'
import { DiscoveryRewards } from '../../../components/discovery-rewards'
import { CopyAddress } from '../../../components/copy-address'
import { marketByMint, feeStatus, tradeAvailable, listMarkets } from '../../../lib/server.mjs'
import { MoreMarkets, MoreMarketsFallback } from '../../../components/more-markets'
import { selectMoreMarkets } from '../../../lib/more-markets.mjs'
import { formatSolDisplay, formatSolRounded, formatUsdEstimate } from '../../../lib/format.mjs'
import { displayRepository, refreshDisplayRepository } from '../../../lib/repository-display.mjs'
import { InviteOwner } from '../../../components/invite-owner'
import { solUsdPrice } from '../../../lib/sol-usd.mjs'
import { OFFICIAL_TOKEN } from '../../../lib/official-token.mjs'
import { TeamTokenLocks } from '../../../components/team-token-locks'
import { RepoTips, RepoTipsFallback, TipJarPill, TipJarPillFallback } from '../../../components/repo-tips'
import { tipsEnabled } from '../../../lib/tips.mjs'
import { PartsFundBadge, PartsFundCard } from '../../../components/parts-fund'
import { DetailsTabs } from '../../../components/details-tabs'
import { HolderNotes, HolderNotesFallback } from '../../../components/holder-notes'
import { JsonLd } from '../../../components/json-ld'
import { tokenJsonLd } from '../../../lib/json-ld.mjs'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }) {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  if (!market) return { title: 'Market not found — repo.ing' }
  const title = `$${market.symbol} · ${market.fullName} — repo.ing`
  const description = (market.description || 'Explore this open source repository market on repo.ing.').slice(0, 180)
  const url = `https://repo.ing/token/${market.mint}`
  const image = { url: `${url}/opengraph-image`, width: 1200, height: 630, alt: `$${market.symbol} · ${market.fullName} repository market on repo.ing` }
  return { title, description, alternates: { canonical: url },
    openGraph: { title, description, url, type: 'website', siteName: 'repo.ing', images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] } }
}

export default async function Token({ params, searchParams }) {
  const { mint } = await params
  const query = await searchParams
  const activity = query.view === 'activity'
  const { market } = await marketByMint(mint)
  if (!market) notFound()
  const repo = { ...displayRepository(market), mint: market.mint }

  const official = market.mint === OFFICIAL_TOKEN.mint && String(market.repoId) === OFFICIAL_TOKEN.repoId
  const tips = tipsEnabled()
  const rewards = market.allocationVersion === 1 || [1, 2].includes(market.discoveryVersion)
  const tabs = [
    { id: 'repository', anchor: 'repository', label: 'Repository', content: <Suspense fallback={<RepositoryDetails repo={repo}/>}><FreshRepositoryDetails repo={repo}/></Suspense> },
    { id: 'token', label: 'Token', content: <TokenDetails market={market}/> },
    { id: 'earnings', label: 'Earnings', content: <Suspense fallback={<div className="inner-card earnings-card" aria-busy="true"><h3>Total repository earnings</h3><strong className="earnings-amount">Checking…</strong><p role="status" className="loading-placeholder">Verifying builder fees…</p></div>}>
      <RepositoryEarnings market={market}/></Suspense> },
    // #rewards (linked from /wallet) opens this tab so a launcher lands on the claim button.
    ...rewards ? [{ id: 'rewards', anchor: 'rewards', label: 'Rewards', content: <div id="rewards" className="details-rewards">
      {market.allocationVersion === 1 && <BuilderAllocation repoId={market.repoId}/>}
      {[1, 2].includes(market.discoveryVersion) && <DiscoveryRewards repoId={market.repoId}/>}</div> }] : [],
  ]
  return <><AppHeader active={official ? 'repoing' : ''}/><main className="section-wrap market-page"><JsonLd data={tokenJsonLd(market)}/>
    {official && <div className="official-market-note"><span><strong>Official $REPOING</strong> · repo.ing tokenized itself.</span><div className="official-market-links"><Link href={`${OFFICIAL_TOKEN.marketPath}#team-locks`}>Token locks</Link><Link href="/stats#repo-title">Revenue policy & buyback status →</Link></div></div>}
    <div className="market-title"><div><RepoIdentity repo={repo} heading/><RepoStats repo={repo} detailed/><Suspense fallback={null}><ParticipationBadge repoId={market.repoId}/></Suspense>
      {tips && <Suspense fallback={null}><PartsFundBadge market={market}/></Suspense>}</div>
      <div className="market-price"><strong>${market.symbol}</strong><span>Repository market</span>{!official && <Link className="platform-token-link" href={OFFICIAL_TOKEN.marketPath}>Platform token ${OFFICIAL_TOKEN.symbol} →</Link>}
        {tips && <div className="tip-jar-slot"><Suspense fallback={<TipJarPillFallback/>}><TipJarPill market={market}/></Suspense></div>}
        <CopyAddress address={market.mint} compact/><ShareMarket key={market.mint} mint={market.mint} symbol={market.symbol} fullName={market.fullName} repoId={market.repoId}/></div>
    </div>
    <div className="market-nav"><Link className={!activity ? 'active' : ''} href={`/token/${mint}`}>Market</Link>
      {/* A plain same-page anchor fires hashchange, which opens the Details "Repository" tab. */}
      <a href={activity ? `/token/${mint}#repository` : '#repository'}>Repository</a>
      <Link className={activity ? 'active' : ''} href={`/token/${mint}?view=activity`}>Activity</Link>
    </div>
    {activity ? <ActivityFeed mint={mint} symbol={market.symbol}/> : <>
      <MarketTrading key={market.mint} market={market} available={tradeAvailable()} usdPerSol={null}
        aside={tips ? <><Suspense fallback={<RepoTipsFallback/>}><RepoTips market={market}/></Suspense>
          <Suspense fallback={null}><PartsFundCard market={market}/></Suspense></> : null}
        below={<Suspense fallback={<HolderNotesFallback/>}><HolderNotes market={market}/></Suspense>}/>
      <section className="market-details" aria-labelledby="market-details-title"><h2 id="market-details-title">Details</h2>
        <DetailsTabs tabs={tabs} initial="earnings" label={`${market.symbol} details`}/></section>
      {official && <TeamTokenLocks/>}
      <Suspense fallback={<MoreMarketsFallback featured={official}/>}><MoreMarketsContent mint={market.mint} featured={official}/></Suspense>
    </>}
  </main><Footer/></>
}

function TokenDetails({ market }) {
  return <div className="inner-card token-details"><h3>Token details</h3><dl>
    <div><dt>Token name</dt><dd>{market.tokenName}</dd></div><div><dt>Ticker</dt><dd>{market.symbol}</dd></div>
    <div><dt>Mint address</dt><dd><CopyAddress address={market.mint}/></dd></div>
    <div><dt>Decimals</dt><dd>6</dd></div>
    <div><dt>Pool</dt><dd title={market.pool}>{market.pool.slice(0,6)}…{market.pool.slice(-4)}</dd></div>
  </dl></div>
}

// Same memoized listMarkets() rows as the home tabs: no extra query per token page view.
async function MoreMarketsContent({ mint, featured }) {
  const { markets } = await listMarkets()
  return <MoreMarkets markets={selectMoreMarkets(markets, { excludeMints: [mint, OFFICIAL_TOKEN.mint] })} featured={featured}/>
}

async function RepositoryEarnings({ market }) {
  const [fees, usdPerSol] = await Promise.all([feeStatus(market.repoId), solUsdPrice()])
  const claimable = fees.status === 'MATCH' ? fees.onchainCreatorFee : null
  const verifiedEarned=fees.status==='MATCH'?market.earned:null
  const usdEstimate = verifiedEarned===null?null:formatUsdEstimate(verifiedEarned, usdPerSol)
  const earningsNote = fees.status === 'PENDING_REVIEW' ? 'A previous claim needs settlement review before another payout can be sent.' :
    claimable === null ? 'Current creator-fee state is unavailable or needs review.' :
      !market.beneficiaryWallet ? 'A GitHub admin can verify and set a payout wallet to claim available fees.' :
        'USD value is estimated at the current SOL price. Creator fees settle in SOL.'
  return (<div className="inner-card earnings-card"><h3>Total repository earnings <Info size={17}/></h3>
          <strong className="earnings-amount">{verifiedEarned===null?'Checking…':usdEstimate ? `≈ ${usdEstimate}` : `${formatSolDisplay(verifiedEarned)} SOL`}</strong>
          {usdEstimate && <span className="earnings-sol" title={`${market.earned} lamports earned in total`}>≈ {formatSolRounded(market.earned)} SOL earned</span>}
          <div className="earnings-breakdown"><span>Already paid<strong>{verifiedEarned===null?'—':`${formatSolDisplay(market.claimed)} SOL`}</strong></span><span>Available to claim<strong>{claimable === null ? '—' : `${formatSolDisplay(claimable)} SOL`}</strong></span></div>
          <div className="earnings-status"><Badge tone={market.beneficiaryWallet ? 'verified' : 'muted'}>{market.beneficiaryWallet ? 'Payout wallet set' : 'Payout wallet needed'}</Badge></div>
          <p>{earningsNote}</p><Link className="button white earnings-claim" href={`/claim/${market.repoId}`}>Claim builder fees<ArrowUpRight size={16}/></Link>
          {!market.beneficiaryWallet && <InviteOwner repoId={market.repoId} fullName={market.fullName} available={claimable?.toString() ?? null}/> }
        </div>)
}

async function FreshRepositoryDetails({ repo }) {
  const refreshed = await refreshDisplayRepository(repo)
  const release = await latestRelease(refreshed)
  return <RepositoryDetails repo={{ ...refreshed, mint: repo.mint }} release={release}/>
}
function RepositoryDetails({ repo, release }) {
  return (<div id="repository" className="inner-card repository-card"><div className="card-heading"><h3>Repository</h3><GitHubLink repo={repo}/></div>
          <RepoIdentity repo={repo} compact/><RepoStats repo={repo}/>
          {release && <a className="repo-release" href={release.url} target="_blank" rel="noreferrer"><span>Latest release</span><strong>{release.tag} ↗</strong><small>{new Date(release.publishedAt).toLocaleDateString()}</small></a>}
          <div className="repo-meta-grid"><div>Language<strong>{repo.language || '—'}</strong></div><div>License<strong>{repo.license || '—'}</strong></div><div>Updated<strong>{repo.updatedAt ? new Date(repo.updatedAt).toLocaleDateString() : '—'}</strong></div></div>
        </div>)
}
