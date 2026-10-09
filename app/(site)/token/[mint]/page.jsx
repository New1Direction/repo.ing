import { ParticipationBadge } from '../../../components/participation-badge'
import { latestRelease } from '../../../lib/releases.mjs'
import { BuilderAllocation } from '../../../components/builder-allocation'
import { Suspense, cache } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowUpRight, Info } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity, RepoStats, GitHubLink, Badge } from '../../../components/ui'
import { MarketTrading } from '../../../components/market-trading'
import { ShareMarket } from '../../../components/share-market'
import { ActivityFeed } from '../../../components/activity-feed'
import { DiscoveryRewards } from '../../../components/discovery-rewards'
import { CopyAddress } from '../../../components/copy-address'
import { marketByMint, displayFeeStatus, tradeAvailable, listMarkets, graduationRace, database } from '../../../lib/server.mjs'
import { marketQuoteView } from '../../../../src/quote-assets.mjs'
import { signedPayoutWallet } from '../../../lib/official-launch.mjs'
import { MoreMarkets, MoreMarketsFallback } from '../../../components/more-markets'
import { selectMoreMarkets } from '../../../lib/more-markets.mjs'
import { formatSolDisplay, formatSolRounded, formatUsdEstimate } from '../../../lib/format.mjs'
import { displayRepository, refreshDisplayRepository } from '../../../lib/repository-display.mjs'
import { InviteOwner } from '../../../components/invite-owner'
import { solUsdPrice } from '../../../lib/sol-usd.mjs'
import { OFFICIAL_TOKEN } from '../../../lib/official-token.mjs'
import { TeamTokenLocks } from '../../../components/team-token-locks'
import { RepoingCase, RepoingCaseFallback } from '../../../components/repoing-case'
import { RepoTips, RepoTipsFallback, TipJarPill, TipJarPillFallback } from '../../../components/repo-tips'
import { tipsEnabled } from '../../../lib/tips.mjs'
import { PartsFundBadge, PartsFundCard } from '../../../components/parts-fund'
import { DetailsTabs } from '../../../components/details-tabs'
import { HolderNotes, HolderNotesFallback } from '../../../components/holder-notes'
import { JsonLd } from '../../../components/json-ld'
import { XHandle } from '../../../components/x-handle'
import { tokenJsonLd } from '../../../lib/json-ld.mjs'
import { timed } from '../../../lib/server-timing.mjs'
import { builderEarningsHeadline } from '../../../lib/builder-earnings.mjs'
import { Backers, BackersFallback, BackersPill } from '../../../components/backers'
import { TrustPanel } from '../../../components/trust-panel'
import { OfficialBadge, ForkOfLabel } from '../../../components/market-signals'
import { EarlyAccessNote } from '../../../components/early-access-note'
import { featuredMarkets, labeledRacers, repoFactsView } from '../../../lib/repo-quality.mjs'
import { MarketsToWatch, MarketsToWatchFallback, MarketsToWatchLists } from '../../../components/markets-to-watch'
import { newestLaunches, topOfRace, WATCH_LIMIT } from '../../../lib/graduation-race.mjs'
import { marketLaunchFeeTerms } from '../../../lib/launch-fee.mjs'
import { DevPulse } from '../../../components/dev-pulse'
import { DevPulseStrip } from '../../../components/dev-pulse-strip'
import { readRepoPulse } from '../../../lib/dev-pulse.mjs'
import { isPromotionExcluded } from '../../../lib/promotion-exclusions.mjs'
import { maintainerDecision, promotionExcluded } from '../../../lib/maintainer-opt-outs.mjs'
import { DeclinedBanner } from '../../../components/maintainer-declined'
import { PhoneMarketSummary } from '../../../components/phone-market-summary'
import { BuildingLive, readPageStream } from '../../../components/building-live'
import { ModelTokenPage, modelTokenMetadata } from '../../../components/hf/model-token-page'
import { githubMarkets, isModelMarket } from '../../../lib/hf-model-display.mjs'
import { shownMarkets } from '../../../lib/hf-markets.mjs'
import { StockFeeHeadline, StockFeeHeadlineFallback, StockFeeRouting } from '../../../components/stock-fee-routing'
import { isStockPairMarket } from '../../../../src/stock-owner-claims.mjs'
import { BundleVault, BundleVaultFallback } from '../../../components/bundle-vault'
import { isBundleMarket } from '../../../../src/bundles.mjs'
import { ogCardImageUrl } from '../../../lib/og-card.mjs'
import { DECLINED_TRADING, declinedSummary } from '../../../lib/declined-display.mjs'

// Hero headline and Earnings tab render in the same request: reconcile fees and price SOL once.
const earningsEvidence = cache(repoId => Promise.all([displayFeeStatus(repoId), solUsdPrice()]))

export const dynamic = 'force-dynamic'

// A market its maintainer (or a model's owner) declined is kept out of search (noindex, and out of app/sitemap.js), and its link
// previews' descriptions lead with the decline, in the banner's words. The decision read is the page's own (memoized per
// request); an unreadable one changes nothing here, as it shows no banner.
export async function generateMetadata({ params }) {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  if (!market) return { title: 'Market not found — repo.ing' }
  const declined = Boolean(await maintainerDecision(market.repoId))
  if (isModelMarket(market)) return modelTokenMetadata(market, { declined })
  const title = `$${market.symbol} · ${market.fullName} — repo.ing`
  const description = declined ? `${declinedSummary(market)} ${DECLINED_TRADING}`
    : (market.description || 'Explore this open source repository market on repo.ing.').slice(0, 180)
  const url = `https://repo.ing/token/${market.mint}`
  const image = { url: ogCardImageUrl(url), width: 1200, height: 630, alt: `$${market.symbol} · ${market.fullName} repository market on repo.ing` }
  return { title, description, alternates: { canonical: url }, ...(declined ? { robots: { index: false } } : {}),
    openGraph: { title, description, url, type: 'website', siteName: 'repo.ing', images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] } }
}

export default async function Token({ params, searchParams }) {
  const { mint } = await params
  const query = await searchParams
  const activity = query.view === 'activity'
  const { market } = await marketByMint(mint)
  if (!market) notFound()
  // Hugging Face model markets have their own page (none of the GitHub-only reads below run for them).
  if (isModelMarket(market)) return <ModelTokenPage market={market} activity={activity}/>
  const repo = { ...displayRepository(market), mint: market.mint }
  // The market's pair: null for SOL; a stock pair's figures are in its stock (docs/STOCK_QUOTES.md).
  const quote = marketQuoteView(market)
  // The maintainer's stream link, shown under the same rule as Dev Pulse. Started now, awaited after the reads below (it
  // never rejects).
  const streamRead = activity || isPromotionExcluded(market.repoId) ? null : timed('repoStream', () => readPageStream(market.repoId))
  // Non-null only when this market's own config charges the launch fee (config read once, then cached).
  const launchFee = await timed('launchFeeTerms', () => marketLaunchFeeTerms(market))
  // A current GitHub admin declined this market (src/maintainer-opt-outs.mjs). undefined: unreadable, so nothing here
  // promotes it, but no banner is claimed either.
  const decision = await timed('maintainerDecision', () => maintainerDecision(market.repoId))
  // Dev Pulse: public GitHub activity from the worker's tables (one indexed read). Never shown for do-not-promote repos.
  const pulse = isPromotionExcluded(market.repoId) || decision !== null ? null
    : await timed('devPulse', () => readRepoPulse(database(), market.repoId)).catch(error => { console.error('dev-pulse read failed', { mint, error: error.message }); return null })
  const stream = decision === null ? await streamRead : null

  const official = market.mint === OFFICIAL_TOKEN.mint && String(market.repoId) === OFFICIAL_TOKEN.repoId
  const tips = tipsEnabled()
  // The launcher-rewards card also carries the one-time verification bonus, which a market may have without discovery.
  const launcherRewards = [1, 2].includes(market.discoveryVersion) || market.verificationBonusLamports != null
  const rewards = market.allocationVersion === 1 || launcherRewards
  // "Launch facts" repository row: age, stars and repo score (GitHub's live numbers when the display cache has them).
  const repoFacts = repoFactsView({ stars: repo.stars, forks: repo.forks, githubCreatedAt: repo.githubCreatedAt ?? market.githubCreatedAt }, pulse, Date.now(),
    { promoted: market.promoted })
  // A stock pair has no owner claim (src/stock-owner-claims.mjs): its fee routing replaces the claim link and the owner invitation.
  const stockPair = isStockPairMarket(market)
  const tabs = [
    { id: 'repository', anchor: 'repository', label: 'Repository', content: <Suspense fallback={<RepositoryDetails repo={repo}/>}><FreshRepositoryDetails repo={repo}/></Suspense> },
    { id: 'token', label: 'Token', content: <TokenDetails market={market} quote={quote}/> },
    stockPair ? { id: 'earnings', anchor: 'fee-routing', label: 'Fee routing', content: <Suspense fallback={<div className="inner-card" aria-busy="true"><h3>Fee routing</h3><p role="status" className="loading-placeholder">Reading fee routing…</p></div>}>
      <StockFeeRouting market={market}/></Suspense> } :
    { id: 'earnings', label: 'Earnings', content: <Suspense fallback={<div className="inner-card earnings-card" aria-busy="true"><h3>Total repository earnings</h3><strong className="earnings-amount">Checking…</strong><p role="status" className="loading-placeholder">Verifying builder fees…</p></div>}>
      <RepositoryEarnings market={market} declined={decision !== null}/></Suspense> },
    { id: 'backers', anchor: 'backers', label: 'Backers', content: <Suspense fallback={<BackersFallback/>}><Backers market={market}/></Suspense> },
    // A market launched from a Bundle (docs/BUNDLE_LAUNCH.md): its vault, its routed fees and the backers' claim, whatever Bundle
    // launches' switch says. #bundle-vault (linked from /wallet) opens it.
    ...isBundleMarket(market) ? [{ id: 'bundle', anchor: 'bundle-vault', label: 'Bundle vault',
      content: <Suspense fallback={<BundleVaultFallback/>}><BundleVault market={market}/></Suspense> }] : [],
    // #rewards (linked from /wallet) opens this tab so a launcher lands on the claim button.
    ...rewards ? [{ id: 'rewards', anchor: 'rewards', label: 'Rewards', content: <div id="rewards" className="details-rewards">
      {market.allocationVersion === 1 && <BuilderAllocation repoId={market.repoId}/>}
      {launcherRewards && <DiscoveryRewards repoId={market.repoId}/>}</div> }] : [],
  ]
  return <><AppHeader active={official ? 'repoing' : ''}/><main className="section-wrap market-page"><JsonLd data={tokenJsonLd(market)}/>
    {decision && <DeclinedBanner fullName={market.fullName} decision={decision}/>}
    <PhoneMarketSummary mint={market.mint} symbol={market.symbol} priceSol={market.priceSol} volume24hLamports={market.volume24hLamports}
      {...(quote ? { quote, stock: market.stock ?? null } : {})}/>
    {official && <div className="official-market-note"><span><strong>Official $REPOING</strong> · repo.ing tokenized itself.</span><div className="official-market-links"><Link href={`${OFFICIAL_TOKEN.marketPath}#team-locks`}>Token locks</Link><Link href="/stats#repo-title">Revenue policy & buyback status →</Link></div></div>}
    <EarlyAccessNote market={market}/>
    <header className="market-hero">
      <div className="market-hero-earnings"><Suspense fallback={stockPair ? <StockFeeHeadlineFallback market={market}/> : <EarningsHeadlineFallback/>}>{stockPair ? <StockFeeHeadline market={market} href={activity ? `/token/${mint}#fee-routing` : '#fee-routing'}/> : <EarningsHeadline market={market}/>}</Suspense></div>
      <div className="market-hero-main"><RepoIdentity repo={repo} heading>
          <ForkOfLabel parent={repo.fork?.parent?.fullName ?? market.forkParent}/>
          <div className="market-hero-ticker"><strong>${market.symbol}</strong><span>Repository market</span>{market.officialLaunch && !decision && <OfficialBadge/>}{!official && <Link className="platform-token-link" href={OFFICIAL_TOKEN.marketPath}>Platform token ${OFFICIAL_TOKEN.symbol} →</Link>}</div></RepoIdentity><RepoStats repo={repo} detailed/>
        <div className="market-hero-pills"><Suspense fallback={null}><ParticipationBadge repoId={market.repoId}/></Suspense>
          {signedPayoutWallet(market) && <Suspense fallback={null}><XHandle wallet={signedPayoutWallet(market)} trust avatar className="maintainer-x"/></Suspense>}
          {tips && <Suspense fallback={null}><PartsFundBadge market={market}/></Suspense>}
          <Suspense fallback={null}><BackersPill market={market} href={activity ? `/token/${mint}#backers` : '#backers'}/></Suspense></div>
        {!activity && <DevPulseStrip pulse={pulse}/>}</div>
      <div className="market-hero-actions">
        {tips && <div className="tip-jar-slot"><Suspense fallback={<TipJarPillFallback/>}><TipJarPill market={market}/></Suspense></div>}
        <CopyAddress address={market.mint} compact/><ShareMarket key={market.mint} mint={market.mint} symbol={market.symbol} fullName={market.fullName} repoId={market.repoId}
          {...(stockPair ? { readme: false } : {})} more={<><a href={repo.htmlUrl || `https://github.com/${market.fullName}`} target="_blank" rel="noreferrer">View on GitHub ↗</a>
            <a href={`https://solscan.io/token/${market.mint}`} target="_blank" rel="noreferrer">View token on Solscan ↗</a>
            {stockPair ? <a href={activity ? `/token/${mint}#fee-routing` : '#fee-routing'}>Fee routing</a> : <Link href={`/claim/${market.repoId}`}>Claim builder fees</Link>}</>}/></div>
    </header>
    {/* "Why hold $REPOING": live buyback, volume and shipping figures, on the market view only. */}
    {official && !activity && <Suspense fallback={<RepoingCaseFallback/>}><RepoingCase pulse={pulse}/></Suspense>}
    <div className="market-nav"><Link className={!activity ? 'active' : ''} href={`/token/${mint}`}>Market</Link>
      {/* A plain same-page anchor fires hashchange, which opens the Details "Repository" tab. */}
      <a href={activity ? `/token/${mint}#repository` : '#repository'}>Repository</a>
      <Link className={activity ? 'active' : ''} href={`/token/${mint}?view=activity`}>Activity</Link>
    </div>
    {activity ? <ActivityFeed mint={mint} symbol={market.symbol} {...(quote ? { quote } : {})}/> : <>
      <MarketTrading key={market.mint} market={market} quote={quote} available={tradeAvailable()} usdPerSol={null} pulse={pulse?.events ?? null}
        aside={<>{official && <MarketsToWatch><Suspense fallback={<MarketsToWatchFallback/>}><MarketsToWatchContent/></Suspense></MarketsToWatch>}<BuildingLive stream={stream}/><TrustPanel market={market} launchFee={launchFee} declined={decision || null} repoFacts={repoFacts}/>{tips && <><Suspense fallback={<RepoTipsFallback/>}><RepoTips market={market}/></Suspense>
          <Suspense fallback={null}><PartsFundCard market={market}/></Suspense></>}</>}
        below={<div className="market-below">{pulse && <DevPulse mint={market.mint} initial={pulse} repoUrl={repo.htmlUrl || `https://github.com/${market.fullName}`}/>}
          <Suspense fallback={<HolderNotesFallback/>}><HolderNotes market={market}/></Suspense></div>}/>
      <section className="market-details" aria-labelledby="market-details-title"><h2 id="market-details-title">Details</h2>
        <DetailsTabs tabs={tabs} initial="earnings" label={`${market.symbol} details`}/></section>
      {official && <TeamTokenLocks/>}
      <Suspense fallback={<MoreMarketsFallback featured={official}/>}><MoreMarketsContent mint={market.mint} featured={official} quote={quote}/></Suspense>
    </>}
  </main><Footer/></>
}

// A stock pair also names the stock it trades in (quote: marketQuoteView), whose amounts the page shows as wallets show them.
function TokenDetails({ market, quote = null }) {
  return <div className="inner-card token-details"><h3>Token details</h3><dl>
    <div><dt>Token name</dt><dd>{market.tokenName}</dd></div><div><dt>Ticker</dt><dd>{market.symbol}</dd></div>
    <div><dt>Mint address</dt><dd><CopyAddress address={market.mint}/></dd></div>
    <div><dt>Decimals</dt><dd>6</dd></div>
    <div><dt>Pool</dt><dd title={market.pool}>{market.pool.slice(0,6)}…{market.pool.slice(-4)}</dd></div>
    {quote?.unavailable && <div><dt>Paired with</dt><dd>Unsupported pair · trading paused</dd></div>}
    {quote && !quote.unavailable && <><div><dt>Paired with</dt><dd>{`${quote.symbol} (${quote.name})`}</dd></div>
      <div><dt>{`${quote.symbol} mint`}</dt><dd><CopyAddress address={quote.mint}/></dd></div>
      <div><dt>{`${quote.symbol} decimals`}</dt><dd>{quote.decimals}</dd></div></>}
  </dl></div>
}

// $REPOING page: the graduation race's top three and the three newest launches, from the same memoized reads as the
// home page (no extra query per view). The official market itself is never listed, nor a do-not-promote or declined one;
// the newest launches also leave out a new repository that has not earned promotion (repo-quality.mjs), while the race
// keeps every racer and labels new repositories.
async function MarketsToWatchContent() {
  const [{ markets: race, unavailable: raceUnavailable }, { markets, unavailable }, excluded] = await Promise.all([graduationRace(), listMarkets(), promotionExcluded()])
  const excludeMints = [OFFICIAL_TOKEN.mint]
  // "Repo markets to watch": repositories only (its copy is about repos' builders); Hugging Face models are left out.
  return <MarketsToWatchLists race={topOfRace(labeledRacers(githubMarkets(race), markets), { limit: WATCH_LIMIT, excludeMints })} raceUnavailable={raceUnavailable}
    newest={excluded ? newestLaunches(featuredMarkets(githubMarkets(markets)), { excludeMints, excluded }) : []} newestUnavailable={unavailable || (!excluded && 'Markets are temporarily unavailable.') || null}/>
}

// Same memoized listMarkets() rows as the home tabs: no extra query per token page view. Never recommends a do-not-promote
// or maintainer-declined market (nothing when that list is unreadable). quote: this page's pair, for the strip's line.
async function MoreMarketsContent({ mint, featured, quote = null }) {
  const [{ markets }, excluded] = await Promise.all([listMarkets(), promotionExcluded()])
  if (!excluded) return null
  return <MoreMarkets markets={selectMoreMarkets(shownMarkets(markets).filter(market => !excluded.has(String(market.repoId))), { excludeMints: [mint, OFFICIAL_TOKEN.mint] })} featured={featured} quote={quote}/>
}

// Fixed-size placeholder: the resolved headline occupies exactly this box, so streaming it in never shifts layout.
function EarningsHeadlineFallback({ busy = true }) {
  return <div className="earnings-headline pending" aria-busy={busy || undefined}>
    <span className="earnings-headline-label">Earned by builders</span>
    <strong className="earnings-headline-value"><span className="skeleton-line"/></strong>
    <span className="earnings-headline-detail" role="status">Verifying builder earnings…</span>
    <span className="earnings-headline-action note"><span className="skeleton-line"/></span>
  </div>
}

async function EarningsHeadline({ market }) {
  const [fees, usdPerSol] = await earningsEvidence(market.repoId)
  const view = builderEarningsHeadline(market, fees, usdPerSol)
  if (!view) return <EarningsHeadlineFallback busy={false}/>
  const { action } = view
  return <div className="earnings-headline">
    <span className="earnings-headline-label">Earned by builders</span>
    <strong className="earnings-headline-value">{view.value}</strong>
    <span className="earnings-headline-detail">{view.detail}</span>
    {action.href ? <Link className={`button ${action.kind === 'claim' ? 'primary' : 'outline'} earnings-headline-action ${action.kind}`} href={action.href}>{action.label}<ArrowUpRight size={16}/></Link>
      : <span className="earnings-headline-action note">{action.label}</span>}
  </div>
}

async function RepositoryEarnings({ market, declined = false }) {
  const [fees, usdPerSol] = await earningsEvidence(market.repoId)
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
          <div className="earnings-status"><Badge tone={market.beneficiaryWallet ? 'verified' : 'muted'}>{market.beneficiaryWallet ? 'Payout wallet set' : 'Payout wallet needed'}</Badge>{signedPayoutWallet(market) && <XHandle wallet={signedPayoutWallet(market)} trust avatar className="maintainer-x"/>}</div>
          <p>{earningsNote}</p><Link className="button white earnings-claim" href={`/claim/${market.repoId}`}>Claim builder fees<ArrowUpRight size={16}/></Link>
          {!market.beneficiaryWallet && !declined && <InviteOwner repoId={market.repoId} fullName={market.fullName} available={claimable?.toString() ?? null}/> }
        </div>)
}

async function FreshRepositoryDetails({ repo }) {
  const refreshed = await timed('githubRepository', () => refreshDisplayRepository(repo))
  const release = await timed('githubRelease', () => latestRelease(refreshed))
  return <RepositoryDetails repo={{ ...refreshed, mint: repo.mint }} release={release}/>
}
function RepositoryDetails({ repo, release }) {
  return (<div id="repository" className="inner-card repository-card"><div className="card-heading"><h3>Repository</h3><GitHubLink repo={repo}/></div>
          <RepoIdentity repo={repo} compact/><RepoStats repo={repo}/>
          {release && <a className="repo-release" href={release.url} target="_blank" rel="noreferrer"><span>Latest release</span><strong>{release.tag} ↗</strong><small>{new Date(release.publishedAt).toLocaleDateString()}</small></a>}
          <div className="repo-meta-grid"><div>Language<strong>{repo.language || '—'}</strong></div><div>License<strong>{repo.license || '—'}</strong></div><div>Updated<strong>{repo.updatedAt ? new Date(repo.updatedAt).toLocaleDateString() : '—'}</strong></div></div>
        </div>)
}
