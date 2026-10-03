import { Suspense, cache } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowUpRight, Ban, Info } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity, Badge } from '../ui'
import { MarketTrading } from '../market-trading'
import { ShareMarket } from '../share-market'
import { ActivityFeed } from '../activity-feed'
import { DiscoveryRewards } from '../discovery-rewards'
import { CopyAddress } from '../copy-address'
import { MoreMarkets, MoreMarketsFallback } from '../more-markets'
import { DetailsTabs } from '../details-tabs'
import { HolderNotes, HolderNotesFallback } from '../holder-notes'
import { JsonLd } from '../json-ld'
import { XHandle } from '../x-handle'
import { Backers, BackersFallback, BackersPill } from '../backers'
import { TrustPanel } from '../trust-panel'
import { PhoneMarketSummary } from '../phone-market-summary'
import { ModelPulseSlot } from './model-pulse-slot'
import { ModelAllocation } from './model-allocation'
import { CommunityLaunchBadge, HuggingFaceLink, ModelBadges, ModelDisclaimer, ModelStats } from './model-ui'
import { displayFeeStatus, listMarkets, tradeAvailable } from '../../lib/server.mjs'
import { hfMarketsEnabled, modelCard, modelRegistry, shownMarkets } from '../../lib/hf-markets.mjs'
import { derivativeLabel, exactCount, modelEarningsHeadline, modelMetaDescription, modelShareText, modelView } from '../../lib/hf-model-display.mjs'
import { tokenJsonLd } from '../../lib/json-ld.mjs'
import { signedPayoutWallet } from '../../lib/official-launch.mjs'
import { OFFICIAL_TOKEN } from '../../lib/official-token.mjs'
import { selectMoreMarkets } from '../../lib/more-markets.mjs'
import { formatSolDisplay, formatSolRounded, formatUsdEstimate } from '../../lib/format.mjs'
import { solUsdPrice } from '../../lib/sol-usd.mjs'
import { marketLaunchFeeTerms } from '../../lib/launch-fee.mjs'
import { maintainerDecision, promotionExcluded } from '../../lib/maintainer-opt-outs.mjs'
import { timed } from '../../lib/server-timing.mjs'
import '../../maintainer-opt-out.css'

// The token page of a Hugging Face model market (app/(site)/token/[mint]/page.jsx returns here for a model id). It keeps
// the trading panel, chart, trust panel, recent trades and sharing, shows the model card, the Model Pulse slot and the
// disclaimer, and leaves out what models do not have in v1: tips, parts funds, maintainer invites, streams and Dev Pulse.
// Off unless HF_MARKETS_ENABLED.

const earningsEvidence = cache(repoId => Promise.all([displayFeeStatus(repoId), solUsdPrice()]))
const claimHref = market => `/claim/${market.repoId}`
const CLAIM_LABEL = 'Claim as the model’s owner'

export function modelTokenMetadata(market) {
  if (!hfMarketsEnabled()) return { title: 'Market not found — repo.ing' }
  const title = `$${market.symbol} · ${market.fullName} — repo.ing`
  const description = modelMetaDescription(market)
  const url = `https://repo.ing/token/${market.mint}`
  const image = { url: `${url}/opengraph-image`, width: 1200, height: 630, alt: `$${market.symbol} · ${market.fullName} Hugging Face model market on repo.ing` }
  return { title, description, alternates: { canonical: url },
    openGraph: { title, description, url, type: 'website', siteName: 'repo.ing', images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] } }
}

export async function ModelTokenPage({ market, activity = false }) {
  if (!hfMarketsEnabled()) notFound()
  const mint = market.mint
  const [registry, launchFee, decision] = await Promise.all([modelRegistry(market.repoId),
    timed('launchFeeTerms', () => marketLaunchFeeTerms(market)), timed('maintainerDecision', () => maintainerDecision(market.repoId))])
  const stored = modelView(market, registry)
  const repo = { ...market, description: market.description || null }
  const payoutWallet = signedPayoutWallet(market)
  const rewards = rewardSections(market)
  const tabs = [
    { id: 'model', anchor: 'model', label: 'Model', content: <Suspense fallback={<ModelCard view={stored} pending/>}><LiveModelCard market={market} registry={registry}/></Suspense> },
    { id: 'token', label: 'Token', content: <TokenDetails market={market}/> },
    { id: 'earnings', label: 'Earnings', content: <Suspense fallback={<div className="inner-card earnings-card" aria-busy="true"><h3>Total model earnings</h3><strong className="earnings-amount">Checking…</strong><p role="status" className="loading-placeholder">Verifying fees…</p></div>}>
      <ModelEarnings market={market}/></Suspense> },
    { id: 'backers', anchor: 'backers', label: 'Backers', content: <Suspense fallback={<BackersFallback/>}><Backers market={market}/></Suspense> },
    // #rewards (linked from /wallet) opens this tab so a launcher lands on the claim button.
    ...rewards.length ? [{ id: 'rewards', anchor: 'rewards', label: 'Rewards', content: <div id="rewards" className="details-rewards">{rewards}</div> }] : [],
  ]
  return <><AppHeader/><main className="section-wrap market-page model-market"><JsonLd data={tokenJsonLd(market)}/>
    {decision && <ModelDeclinedBanner fullName={market.fullName} decision={decision}/>}
    <PhoneMarketSummary mint={mint} symbol={market.symbol} priceSol={market.priceSol} volume24hLamports={market.volume24hLamports}/>
    <ModelDisclaimer className="is-banner"/>
    <header className="market-hero">
      <div className="market-hero-earnings"><Suspense fallback={<EarningsHeadlineFallback/>}><ModelEarningsHeadline market={market}/></Suspense></div>
      <div className="market-hero-main"><RepoIdentity repo={repo} heading>
          <div className="market-hero-ticker"><strong>${market.symbol}</strong><span>Model market</span><Link className="platform-token-link" href={OFFICIAL_TOKEN.marketPath}>Platform token ${OFFICIAL_TOKEN.symbol} →</Link></div></RepoIdentity>
        <Suspense fallback={<HeroFacts view={stored}/>}><LiveHeroFacts market={market} registry={registry}/></Suspense>
        <div className="market-hero-pills">
          {payoutWallet && <Suspense fallback={null}><XHandle wallet={payoutWallet} trust avatar className="maintainer-x"/></Suspense>}
          <Suspense fallback={null}><BackersPill market={market} href={activity ? `/token/${mint}#backers` : '#backers'}/></Suspense></div></div>
      <div className="market-hero-actions">
        <CopyAddress address={mint} compact/><ShareMarket key={mint} mint={mint} symbol={market.symbol} fullName={market.fullName} repoId={market.repoId}
          shareText={modelShareText(market)} readme={false}
          more={<><Suspense fallback={null}><LiveModelLink market={market} registry={registry}/></Suspense>
            <a href={`https://solscan.io/token/${mint}`} target="_blank" rel="noreferrer">View token on Solscan ↗</a>
            <Link href={claimHref(market)}>{CLAIM_LABEL}</Link></>}/></div>
    </header>
    <div className="market-nav"><Link className={!activity ? 'active' : ''} href={`/token/${mint}`}>Market</Link>
      {/* A plain same-page anchor fires hashchange, which opens the Details "Model" tab. */}
      <a href={activity ? `/token/${mint}#model` : '#model'}>Model</a>
      <Link className={activity ? 'active' : ''} href={`/token/${mint}?view=activity`}>Activity</Link>
    </div>
    {activity ? <ActivityFeed mint={mint} symbol={market.symbol}/> : <>
      <MarketTrading key={mint} market={market} available={tradeAvailable()} usdPerSol={null}
        aside={<TrustPanel market={market} launchFee={launchFee} declined={decision || null}/>}
        below={<div className="market-below"><Suspense fallback={null}><ModelPulseSlot market={market}/></Suspense>
          <Suspense fallback={<HolderNotesFallback/>}><HolderNotes market={market}/></Suspense></div>}/>
      <section className="market-details" aria-labelledby="market-details-title"><h2 id="market-details-title">Details</h2>
        <DetailsTabs tabs={tabs} initial="model" label={`${market.symbol} details`}/></section>
      <Suspense fallback={<MoreMarketsFallback/>}><MoreMarketsContent mint={mint}/></Suspense>
    </>}
  </main><Footer/></>
}

// Details → Rewards: one section per reward the market carries, in the GitHub page's order; no tab when there is none.
// First the 1% builder allocation (where the GitHub page has BuilderAllocation), claimable once by the model's verified
// owner after graduation; then launcher discovery rewards, which work as for repositories. A model market never carries
// the verification bonus.
function rewardSections(market) {
  return [
    market.allocationVersion === 1 && <ModelAllocation key="allocation" repoId={market.repoId}/>,
    [1, 2].includes(market.discoveryVersion) && <DiscoveryRewards key="discovery" repoId={market.repoId}/>,
  ].filter(Boolean)
}

// Hero: likes, downloads, task, then the disclaimer badge and the gated / license / derivative badges; live when the Hub
// answers for this model's _id.
function HeroFacts({ view }) {
  return <div className="model-hero-facts"><ModelStats view={view} detailed/><ModelBadges view={view} lead={<CommunityLaunchBadge/>}/></div>
}
async function LiveHeroFacts({ market, registry }) {
  return <HeroFacts view={modelView(market, registry, await modelCard(registry))}/>
}

async function LiveModelCard({ market, registry }) {
  return <ModelCard view={modelView(market, registry, await modelCard(registry))}/>
}

// The "⋯" menu's link to the model, withheld (like the card's) when the path now leads to a different repository.
async function LiveModelLink({ market, registry }) {
  const { url } = modelView(market, registry, await modelCard(registry))
  return url ? <a href={url} target="_blank" rel="noreferrer">View on Hugging Face ↗</a> : null
}

// Details → Model: who publishes it, what it does, how it may be used, and its link on Hugging Face.
function ModelCard({ view, pending = false }) {
  const derivative = derivativeLabel(view.base)
  return <div id="model" className="inner-card model-card" aria-busy={pending || undefined}>
    <div className="card-heading"><h3>Model</h3><HuggingFaceLink url={view.url}/></div>
    <dl>
      <div><dt>Author</dt><dd>{view.owner || '—'}{view.ownerKind && <small>{view.ownerKind === 'org' ? 'Organization' : 'User'}</small>}</dd></div>
      <div><dt>Name</dt><dd>{view.name || '—'}</dd></div>
      <div><dt>Task</dt><dd>{view.task ?? '—'}</dd></div>
      <div><dt>License</dt><dd>{view.license ?? '—'}</dd></div>
      <div><dt>Access</dt><dd>{view.gated ? <span title={view.gated.title}>Gated</span> : 'Open'}</dd></div>
      <div><dt>Base model</dt><dd>{derivative ? (derivative.href ? <a href={derivative.href} target="_blank" rel="noreferrer" title={derivative.title}>{derivative.label}</a> : derivative.label) : 'None listed'}</dd></div>
      <div><dt>Downloads (30d)</dt><dd>{exactCount(view.downloads30d)}</dd></div>
      <div><dt>Likes</dt><dd>{exactCount(view.likes)}</dd></div>
    </dl>
    {view.moved && <p className="model-card-note">This model’s Hugging Face path now leads to a different repository. The market stays tied to the original model, so no link or live figures are shown.</p>}
    {view.missing && <p className="model-card-note">Hugging Face no longer shows this model publicly (it may be private, disabled or deleted); showing what repo.ing recorded.</p>}
    {!pending && !view.live && !view.moved && !view.missing && <p className="model-card-note">Live Hugging Face details are unavailable right now; showing what repo.ing recorded.</p>}
    <ModelDisclaimer/>
  </div>
}

function TokenDetails({ market }) {
  return <div className="inner-card token-details"><h3>Token details</h3><dl>
    <div><dt>Token name</dt><dd>{market.tokenName}</dd></div><div><dt>Ticker</dt><dd>{market.symbol}</dd></div>
    <div><dt>Mint address</dt><dd><CopyAddress address={market.mint}/></dd></div>
    <div><dt>Decimals</dt><dd>6</dd></div>
    <div><dt>Pool</dt><dd title={market.pool}>{market.pool.slice(0,6)}…{market.pool.slice(-4)}</dd></div>
  </dl></div>
}

// Same fixed box as the GitHub page's headline, so streaming the value in never shifts the layout.
function EarningsHeadlineFallback({ busy = true }) {
  return <div className="earnings-headline pending" aria-busy={busy || undefined}>
    <span className="earnings-headline-label">Earned by the owner</span>
    <strong className="earnings-headline-value"><span className="skeleton-line"/></strong>
    <span className="earnings-headline-detail" role="status">Verifying earnings…</span>
    <span className="earnings-headline-action note"><span className="skeleton-line"/></span>
  </div>
}

async function ModelEarningsHeadline({ market }) {
  const [fees, usdPerSol] = await earningsEvidence(market.repoId)
  const view = modelEarningsHeadline(market, fees, usdPerSol)
  if (!view) return <EarningsHeadlineFallback busy={false}/>
  const { action } = view
  return <div className="earnings-headline">
    <span className="earnings-headline-label">Earned by the owner</span>
    <strong className="earnings-headline-value">{view.value}</strong>
    <span className="earnings-headline-detail">{view.detail}</span>
    {action.href ? <Link className={`button ${action.kind === 'claim' ? 'primary' : 'outline'} earnings-headline-action ${action.kind}`} href={action.href}>{action.label}<ArrowUpRight size={16}/></Link>
      : <span className="earnings-headline-action note">{action.label}</span>}
  </div>
}

// Details → Earnings: verified totals only (the reconciler must MATCH), and the claim entry for the model's owner.
async function ModelEarnings({ market }) {
  const [fees, usdPerSol] = await earningsEvidence(market.repoId)
  const claimable = fees.status === 'MATCH' ? fees.onchainCreatorFee : null
  const verifiedEarned = fees.status === 'MATCH' ? market.earned : null
  const usdEstimate = verifiedEarned === null ? null : formatUsdEstimate(verifiedEarned, usdPerSol)
  const note = fees.status === 'PENDING_REVIEW' ? 'A previous claim needs settlement review before another payout can be sent.'
    : claimable === null ? 'Current creator-fee state is unavailable or needs review.'
      : !market.beneficiaryWallet ? 'The model’s current owner on Hugging Face (the user, or an admin of the owning organization) can verify and set a payout wallet to claim available fees.'
        : 'USD value is estimated at the current SOL price. Fees settle in SOL.'
  return <div className="inner-card earnings-card"><h3>Total model earnings <Info size={17}/></h3>
    <strong className="earnings-amount">{verifiedEarned === null ? 'Checking…' : usdEstimate ? `≈ ${usdEstimate}` : `${formatSolDisplay(verifiedEarned)} SOL`}</strong>
    {usdEstimate && <span className="earnings-sol" title={`${market.earned} lamports earned in total`}>≈ {formatSolRounded(market.earned)} SOL earned</span>}
    <div className="earnings-breakdown"><span>Already paid<strong>{verifiedEarned === null ? '—' : `${formatSolDisplay(market.claimed)} SOL`}</strong></span><span>Available to claim<strong>{claimable === null ? '—' : `${formatSolDisplay(claimable)} SOL`}</strong></span></div>
    <div className="earnings-status"><Badge tone={market.beneficiaryWallet ? 'verified' : 'muted'}>{market.beneficiaryWallet ? 'Payout wallet set' : 'Payout wallet needed'}</Badge>{signedPayoutWallet(market) && <XHandle wallet={signedPayoutWallet(market)} trust avatar className="maintainer-x"/>}</div>
    <p>{note}</p><Link className="button white earnings-claim" href={claimHref(market)}>{CLAIM_LABEL}<ArrowUpRight size={16}/></Link>
  </div>
}

// The model's owner declined this market (maintainer opt-outs): shown above everything else while the decline is active.
function ModelDeclinedBanner({ fullName, decision }) {
  const day = new Date(decision.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
  return <div className="declined-banner" role="note">
    <span className="declined-banner-icon" aria-hidden="true"><Ban size={20}/></span>
    <div className="declined-banner-copy">
      <p className="declined-banner-lead"><strong>The owner of {fullName} has declined this market.</strong> repo.ing does not promote it, and it is not endorsed by the model’s creators.</p>
      {decision.note && <blockquote className="declined-note"><span>Note from the owner</span><p>{decision.note}</p></blockquote>}
      <p className="declined-meta">Declined by the model’s verified owner on <time dateTime={decision.createdAt}>{day}</time>. Trading stays open so holders can exit.</p>
    </div>
  </div>
}

// Same memoized listMarkets() rows as the GitHub page's strip; never a do-not-promote or declined market.
async function MoreMarketsContent({ mint }) {
  const [{ markets }, excluded] = await Promise.all([listMarkets(), promotionExcluded()])
  if (!excluded) return null
  return <MoreMarkets markets={selectMoreMarkets(shownMarkets(markets).filter(market => !excluded.has(String(market.repoId))), { excludeMints: [mint, OFFICIAL_TOKEN.mint] })}/>
}
