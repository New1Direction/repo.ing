import Link from 'next/link'
import { MarketLink } from './market-link'
import { LoadingSignal } from './loading-signal'
import { ArrowUpRight, Check, ChevronRight, Star, GitFork, Clock3, Code2 } from 'lucide-react'
import { GithubMark } from './github-mark'
import { XMark } from './x-mark'
import { BrandMark } from './brand-mark'
import { WalletButton } from './wallet'
import { ThemeToggle } from './theme-toggle'
import { WatchButton, WatchNotifications } from './watchlist'
import { formatSolDisplay, formatUsdEstimate } from '../lib/format.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'

function MarketEarnings({ market, usdPerSol }) {
  const usd = formatUsdEstimate(market.earned, usdPerSol)
  return <span className="table-earnings" title={`${formatSolDisplay(market.earned)} SOL earned in total · ${formatSolDisplay(market.claimed)} SOL paid · ${formatSolDisplay(market.remaining)} SOL available. USD estimate at the current SOL price.`}>
    <strong>{usd ?? `${formatSolDisplay(market.earned)} SOL`}</strong>
    <small>{BigInt(market.claimed) > 0n ? `${formatSolDisplay(market.claimed)} SOL paid` : `${formatSolDisplay(market.remaining)} SOL available`}</small>
  </span>
}

export function AppHeader({ active = '' }) {
  return <header className="app-header"><div className="header-inner">
    <Link href="/" className="brand"><BrandMark size={32}/><span className="brand-wordmark"><span>repo.</span><span className="brand-accent">ing</span></span></Link>
    <nav aria-label="Main navigation"><Link href="/launch" className={`nav-launch${active === 'launch' ? ' active' : ''}`} aria-current={active === 'launch' ? 'page' : undefined}>Launch</Link><Link href="/explore" className={active === 'explore' ? 'active' : ''}>Explore</Link><Link href="/builders" className={active === 'builders' ? 'active' : ''}>Builders</Link><Link href="/stats" className={active === 'stats' ? 'active' : ''}>Stats</Link><Link href={OFFICIAL_TOKEN.marketPath} className={active === 'repoing' ? 'active' : ''}>$REPOING</Link><Link href="/how-it-works" className={active === 'how-it-works' ? 'active' : ''}>How it works</Link></nav>
    <div className="header-actions"><WatchNotifications/><ThemeToggle/><WalletButton /></div>
  </div></header>
}
export function Footer() { return <footer className="footer"><div className="footer-inner"><Link href="/" className="footer-brand"><BrandMark size={29}/><span className="brand-wordmark"><span>repo.</span><span className="brand-accent">ing</span></span></Link><span>The market layer for open source.</span><div className="footer-spacer"/><Link href="/stats">Stats</Link><Link href="/how-it-works">How it works</Link><Link href="/about">About</Link><Link href="/ja" lang="ja" hrefLang="ja">日本語</Link><a href={OFFICIAL_TOKEN.xUrl} target="_blank" rel="noreferrer" aria-label="repo.ing on X"><XMark size={19}/></a><a href={OFFICIAL_TOKEN.githubUrl} target="_blank" rel="noreferrer" aria-label="repo.ing on GitHub"><GithubMark size={22}/></a></div></footer> }
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
  return <div className={`repo-avatar ${size}`}>{image ? <img src={image} alt="" width={px} height={px} loading={large ? 'eager' : 'lazy'} decoding="async" /> : <GithubMark size={large ? 56 : 24}/>}</div>
}
export function RepoIdentity({ repo, compact = false, heading = false }) {
  const fullName = repo?.fullName ?? `${repo?.owner}/${repo?.name}`
  const slash = fullName.indexOf('/')
  const displayName = slash < 0 ? fullName : <>{fullName.slice(0, slash + 1)}<wbr/>{fullName.slice(slash + 1)}</>
  return <div className={`repo-identity ${compact ? 'compact' : ''}`}><RepoAvatar repo={repo} size={compact ? 'normal' : 'large'} /><div className="repo-identity-copy"><div className="repo-name-line">{heading ? <h1 className="repo-name-heading"><strong>{displayName}</strong></h1> : <strong>{displayName}</strong>}{!compact && <Badge>Public</Badge>}</div><p>{repo?.description || 'Public GitHub repository'}</p></div></div>
}
export function RepoStats({ repo, detailed = false }) { return <div className="repo-stats"><span><Star size={18}/>{typeof repo?.stars === 'number' ? repo.stars.toLocaleString() : '—'}</span><span><GitFork size={18}/>{typeof repo?.forks === 'number' ? repo.forks.toLocaleString() : '—'}</span>{detailed && <><span><Code2 size={18}/>{repo?.language || '—'}</span><span><Clock3 size={18}/>{repo?.updatedAt ? new Date(repo.updatedAt).toLocaleDateString() : '—'}</span></>}</div> }
export function GitHubLink({ repo }) { return <a className="button outline github-link" href={repo?.htmlUrl || `https://github.com/${repo?.fullName}`} target="_blank" rel="noreferrer"><GithubMark size={16}/>View on GitHub<ArrowUpRight size={16}/></a> }
export function LoadingState({ children = 'Loading…' }) { return <div className="state-card" role="status"><LoadingSignal/>{children}</div> }
export function ErrorState({ children }) { return <div className="state-card error" role="alert">{children}</div> }
export function TransactionStatus({ stage, error }) { if (!stage && !error) return null; return <div className={`transaction-status ${error ? 'error' : ''}`} role="status">{!error && <LoadingSignal/>}{error || stage}</div> }
export function MarketTable({ markets = [], usdPerSol = null, empty = 'No indexed markets yet.' }) { return <div className="market-table-scroll"><div className="market-table"><div className="market-head"><span>#</span><span>Repository</span><span>Token</span><span>24h Volume</span><span>Repo Earnings</span><span>Stars</span><span className="actions-heading">Action</span></div>{markets.length ? markets.map((market, index) => <div className="market-row" key={market.mint}><span className="row-index">{index + 1}</span><MarketLink mint={market.mint} className="table-repo"><RepoAvatar repo={market}/><span><span className="table-repo-name"><strong>{market.fullName}</strong><Badge tone={market.wasVerified ? 'verified' : 'muted'}>{market.wasVerified ? 'Verified' : 'Unverified'}</Badge></span><small>{market.description || 'Public repository'}</small></span></MarketLink><span className="table-token"><strong>{market.symbol}</strong><small>{market.tokenName}</small></span><span className="table-volume">{formatSolDisplay(market.volume24hLamports)} SOL</span><MarketEarnings market={market} usdPerSol={usdPerSol}/><span className="table-stars"><Star size={15}/>{typeof market.stars === 'number' ? market.stars.toLocaleString('en-US') : '—'}</span><span className="table-actions"><WatchButton market={market} compact/><MarketLink mint={market.mint} className="button outline table-action">Trade<ChevronRight size={15}/></MarketLink></span></div>) : <div className="table-empty">{empty}</div>}</div></div> }
