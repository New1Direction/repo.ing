import Link from 'next/link'
import { MarketLink } from './market-link'
import { LoadingSignal } from './loading-signal'
import { ArrowUpRight, Check, ChevronRight, Star, GitFork, Clock3, Code2 } from 'lucide-react'
import { GithubMark } from './github-mark'
import { XMark } from './x-mark'
import { BrandMark } from './brand-mark'
import { WalletButton } from './wallet'
import { ThemeToggle } from './theme-toggle'
import { MobileNav } from './mobile-nav'
import { WatchButton, WatchNotifications } from './watchlist'
import { NewRepoLabel, OfficialBadge } from './market-signals'
import { formatSolDisplay, formatUsdEstimate } from '../lib/format.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'
import { bondingProgress, marketCapDisplay } from '../lib/market-display.mjs'
import { isModelMarket, modelLikes, modelPageUrl, modelSummary, modelView } from '../lib/hf-model-display.mjs'
import { HuggingFaceLink, ModelDisclaimer, ModelLikesCell, ModelMark, ModelSourceChip, ModelStats } from './hf/model-ui'

function MarketEarnings({ market, usdPerSol }) {
  const usd = formatUsdEstimate(market.earned, usdPerSol)
  return <span className={`table-earnings${BigInt(market.earned ?? 0) > 0n ? ' has-earnings' : ''}`} title={`${formatSolDisplay(market.earned)} SOL earned in total · ${formatSolDisplay(market.claimed)} SOL paid · ${formatSolDisplay(market.remaining)} SOL available. USD estimate at the current SOL price.`}>
    <strong>{usd ?? `${formatSolDisplay(market.earned)} SOL`}</strong>
    <small>{BigInt(market.claimed) > 0n ? `${formatSolDisplay(market.claimed)} SOL paid` : `${formatSolDisplay(market.remaining)} SOL available`}</small>
  </span>
}
function MarketCap({ market, usdPerSol }) {
  const cap = marketCapDisplay(market.priceSol, usdPerSol)
  return <span className="table-mcap" title={cap?.title ?? 'No trades recorded yet'}>{cap?.value ?? '—'}</span>
}
// One thin line on the row's bottom edge; nothing is drawn when progress is unknown or stale.
function BondingLine({ market }) {
  const progress = bondingProgress(market)
  if (!progress) return null
  return <span className={`market-bonding${progress.percent >= 100 ? ' complete' : ''}`} role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={Math.floor(progress.percent)} title={progress.label}><span style={{ transform: `scaleX(${progress.percent / 100})` }}/></span>
}

const NAV_LINKS = [{ key: 'launch', href: '/launch', label: 'Launch' }, { key: 'explore', href: '/explore', label: 'Explore' }, { key: 'builders', href: '/builders', label: 'Builders' }, { key: 'stats', href: '/stats', label: 'Stats' }, { key: 'how-it-works', href: '/how-it-works', label: 'How it works' }, { key: 'repoing', href: OFFICIAL_TOKEN.marketPath, label: '$REPOING' }]
const NAV_CLASSES = { launch: 'nav-launch', repoing: 'nav-token' }
// $REPOING is repo.ing's own token: a green pill with the brand cat, kept beside Launch on phones instead of in the menu.
const navLabel = link => link.key === 'repoing'
  ? <><img src="/brand-cat.webp" alt="" width={22} height={22} decoding="async" fetchPriority="low"/>{link.label}<span className="sr-only">, repo.ing's official token</span></>
  : link.label
export function AppHeader({ active = '' }) {
  return <header className="app-header"><div className="header-inner">
    <Link href="/" className="brand"><BrandMark size={32}/><span className="brand-wordmark"><span>repo.</span><span className="brand-accent">ing</span></span></Link>
    <nav aria-label="Main navigation">{NAV_LINKS.map(link => <Link key={link.key} href={link.href} className={[NAV_CLASSES[link.key], active === link.key && 'active'].filter(Boolean).join(' ') || undefined} aria-current={active === link.key ? 'page' : undefined} title={link.key === 'repoing' ? "repo.ing's official token" : undefined}>{navLabel(link)}</Link>)}<MobileNav links={NAV_LINKS.filter(link => link.key !== 'repoing')} active={active}/></nav>
    <div className="header-actions"><WatchNotifications/><ThemeToggle/><WalletButton /></div>
  </div></header>
}
export function Footer() { return <footer className="footer"><div className="footer-inner"><Link href="/" className="footer-brand"><BrandMark size={29}/><span className="brand-wordmark"><span>repo.</span><span className="brand-accent">ing</span></span></Link><span>The market layer for open source.</span><div className="footer-spacer"/><Link href="/stats">Stats</Link><Link href="/how-it-works">How it works</Link><Link href="/referrals">Referrals</Link><Link href="/about">About</Link><Link href="/opt-out">Maintainers: opt out</Link><Link href="/ja" lang="ja" hrefLang="ja">日本語</Link><a href={OFFICIAL_TOKEN.xUrl} target="_blank" rel="noreferrer" aria-label="repo.ing on X"><XMark size={19}/></a><a href={OFFICIAL_TOKEN.githubUrl} target="_blank" rel="noreferrer" aria-label="repo.ing on GitHub"><GithubMark size={22}/></a></div></footer> }
export function Button({ children, variant = 'outline', className = '', ...props }) { return <button className={`button ${variant} ${className}`} {...props}>{children}</button> }
export function Badge({ children, tone = 'muted' }) { return <span className={`badge ${tone}`}>{tone === 'verified' && <Check size={12} strokeWidth={3}/>}<span>{children}</span></span> }
function githubAvatarUrl(value, width) {
  try { const url = new URL(value); if (url.hostname !== 'avatars.githubusercontent.com') return value; url.searchParams.set('s', String(width)); return url.href }
  catch { return value }
}
export function RepoAvatar({ repo, size = 'normal' }) {
  const large = size === 'large', width = large ? 256 : 128
  const image = repo?.mint ? `/api/token-image/${repo.mint}?w=${width}` : repo?.repoId ? `/api/repo-logo/${repo.repoId}?v=3&w=${width}` : repo?.avatarUrl && githubAvatarUrl(repo.avatarUrl, width)
  const px = large ? 126 : 52
  const placeholder = isModelMarket(repo) ? <ModelMark size={large ? 56 : 24}/> : <GithubMark size={large ? 56 : 24}/>
  return <div className={`repo-avatar ${size}`}>{image ? <img src={image} alt="" width={px} height={px} loading={large ? 'eager' : 'lazy'} decoding="async" /> : placeholder}</div>
}
// Repositories and Hugging Face models alike: a model shows its source label where a repository shows "Public".
export function RepoIdentity({ repo, compact = false, heading = false, children = null }) {
  const fullName = repo?.fullName ?? `${repo?.owner}/${repo?.name}`
  const slash = fullName.indexOf('/'), model = isModelMarket(repo)
  const displayName = slash < 0 ? fullName : <>{fullName.slice(0, slash + 1)}<wbr/>{fullName.slice(slash + 1)}</>
  return <div className={`repo-identity ${compact ? 'compact' : ''}`}><RepoAvatar repo={repo} size={compact ? 'normal' : 'large'} /><div className="repo-identity-copy"><div className="repo-name-line">{heading ? <h1 className="repo-name-heading"><strong>{displayName}</strong></h1> : <strong>{displayName}</strong>}{!compact && (model ? <ModelSourceChip/> : <Badge>Public</Badge>)}</div>{children}<p>{repo?.description || (model ? 'Public Hugging Face model' : 'Public GitHub repository')}</p></div></div>
}
export function RepoStats({ repo, detailed = false }) {
  if (isModelMarket(repo)) return <ModelStats view={modelView(repo)} detailed={detailed}/>
  return <div className="repo-stats"><span><Star size={18}/>{typeof repo?.stars === 'number' ? repo.stars.toLocaleString() : '—'}</span><span><GitFork size={18}/>{typeof repo?.forks === 'number' ? repo.forks.toLocaleString() : '—'}</span>{detailed && <><span><Code2 size={18}/>{repo?.language || '—'}</span><span><Clock3 size={18}/>{repo?.updatedAt ? new Date(repo.updatedAt).toLocaleDateString() : '—'}</span></>}</div>
}
// A model market links to its Hugging Face page instead (text only, no Hugging Face logo).
export function GitHubLink({ repo }) {
  if (isModelMarket(repo)) return <HuggingFaceLink url={modelPageUrl(repo?.fullName)}/>
  return <a className="button outline github-link" href={repo?.htmlUrl || `https://github.com/${repo?.fullName}`} target="_blank" rel="noreferrer"><GithubMark size={16}/>View on GitHub<ArrowUpRight size={16}/></a>
}
export function LoadingState({ children = 'Loading…' }) { return <div className="state-card" role="status"><LoadingSignal/>{children}</div> }
export function ErrorState({ children }) { return <div className="state-card error" role="alert">{children}</div> }
export function TransactionStatus({ stage, error }) { if (!stage && !error) return null; return <div className={`transaction-status ${error ? 'error' : ''}`} role="status">{!error && <LoadingSignal/>}{error || stage}</div> }
// Dev Pulse in market rows: "34 commits today" when the repository shipped in the last 24 hours, "Active this week" within 7 days.
export function PulseBadge({ badge }) {
  return badge ? <span className={`pulse-badge is-${badge.status}`} title={badge.title}><i aria-hidden="true"/>{badge.text}</span> : null
}
const MARKET_HEADINGS = ['#', 'Repository', 'Token', 'Market cap', '24h Volume', 'Repo Earnings', 'Stars']
// With Hugging Face models in the table the headings name both kinds; GitHub-only tables keep theirs.
const MIXED_HEADINGS = ['#', 'Repo / model', 'Token', 'Market cap', '24h Volume', 'Earnings', 'Stars / likes']
// A model row: the source label beside the name, the disclaimer badge before its summary, and its likes (linking to the
// model's Hugging Face page) where a repository shows stars. No "New repo" label or GitHub copy.
function MarketRow({ market, index, usdPerSol }) {
  const model = isModelMarket(market)
  return <div className={model ? 'market-row is-model' : 'market-row'}><span className="row-index">{index + 1}</span><MarketLink mint={market.mint} className="table-repo"><RepoAvatar repo={market}/><span><span className="table-repo-name"><strong>{market.fullName}</strong><span className="table-repo-ticker">${market.symbol}</span>{model && <ModelSourceChip/>}{market.officialLaunch ? <OfficialBadge/> : <Badge tone={market.wasVerified ? 'verified' : 'muted'}>{market.wasVerified ? 'Verified' : 'Unverified'}</Badge>}{!model && market.newRepo && <NewRepoLabel/>}<PulseBadge badge={market.pulse?.badge}/></span><small>{model ? modelSummary(market) : market.description || 'Public repository'}</small></span></MarketLink><span className="table-token"><strong>{market.symbol}</strong><small>{market.tokenName}</small></span><MarketCap market={market} usdPerSol={usdPerSol}/><span className="table-volume">{formatSolDisplay(market.volume24hLamports)} SOL</span><MarketEarnings market={market} usdPerSol={usdPerSol}/>{model ? <ModelLikesCell likes={modelLikes(market)} url={modelPageUrl(market.fullName)} path={market.fullName}/> : <span className="table-stars"><Star size={15}/>{typeof market.stars === 'number' ? market.stars.toLocaleString('en-US') : '—'}</span>}<span className="table-actions"><WatchButton market={market} compact/><MarketLink mint={market.mint} className="button outline table-action">Trade<ChevronRight size={15}/></MarketLink></span><BondingLine market={market}/></div>
}
// A table with model rows ends with the full disclaimer (the rows carry the short badge).
export function MarketTable({ markets = [], usdPerSol = null, empty = 'No indexed markets yet.' }) {
  const models = markets.some(isModelMarket)
  const table = <div className="market-table-scroll"><div className="market-table"><div className="market-head">{(models ? MIXED_HEADINGS : MARKET_HEADINGS).map(heading => <span key={heading}>{heading}</span>)}<span className="actions-heading">Action</span></div>{markets.length ? markets.map((market, index) => <MarketRow key={market.mint} market={market} index={index} usdPerSol={usdPerSol}/>) : <div className="table-empty">{empty}</div>}</div></div>
  return models ? <>{table}<ModelDisclaimer className="table-disclaimer"/></> : table
}
