import Link from 'next/link'
import { ArrowUpRight, Star } from 'lucide-react'
import { MarketLink } from './market-link'
import { RepoAvatar } from './ui'
import { GithubMark } from './github-mark'
import { XMark } from './x-mark'
import { WaitingCopyLink } from './waiting-copy-link'
import { amountDisplay, tagIntentUrl, waitingAnchor } from '../lib/waiting.mjs'
import { formatSolDisplay } from '../lib/format.mjs'

const AMOUNT_NOTE = 'Builders earned from trades and not yet claimed — the same indexed figure as “Builders earned” on Explore. USD is an estimate at the current SOL price. The claim page checks the on-chain balance before any payout.'

export function WaitingHeader({ total, count, usdPerSol }) {
  const amount = amountDisplay(total, usdPerSol)
  const empty = count === 0
  return <header className="waiting-intro" aria-labelledby="waiting-title">
    <div className="eyebrow">WAITING FOR MAINTAINERS</div>
    <h1 id="waiting-title">{empty ? 'No builder fees are waiting right now.' : <><span className="waiting-total">{amount.value}</span> is waiting for open-source maintainers</>}</h1>
    <p>Every trade on repo.ing pays the repository’s builders. A current GitHub admin verifies with GitHub, sets a payout wallet, and claims in SOL.</p>
    {!empty && <p className="waiting-intro-sol">{count.toLocaleString('en-US')} {count === 1 ? 'repository hasn’t' : 'repositories haven’t'} claimed yet{amount.sol && ` · ${amount.sol} in total`}</p>}
    {!empty && <aside className="waiting-help" aria-label="How to help">
      <strong>How to help</strong>
      <span>Know a maintainer below? <b>Tag them on X</b> — the post links straight to their claim page.</span>
    </aside>}
  </header>
}

function WaitingRow({ market, rank, usdPerSol }) {
  const amount = amountDisplay(market.remaining, usdPerSol)
  const anchor = waitingAnchor(market.repoId)
  const githubUrl = `https://github.com/${market.fullName}`
  const intent = tagIntentUrl({ repoId: market.repoId, owner: market.owner, fullName: market.fullName, amount: amount.value })
  return <li className="waiting-row" id={anchor}>
    <span className="waiting-rank" aria-hidden="true">{rank}</span>
    <div className="waiting-repo">
      <MarketLink mint={market.mint} className="waiting-avatar" aria-label={`${market.fullName} token page`} tabIndex={-1}><RepoAvatar repo={market}/></MarketLink>
      <div className="waiting-repo-copy">
        <MarketLink mint={market.mint} className="waiting-name"><strong>{market.fullName}</strong></MarketLink>
        <div className="waiting-meta">
          <span className="waiting-symbol">${market.symbol}</span>
          <span className="waiting-stars" aria-label={`${Number(market.stars || 0).toLocaleString('en-US')} GitHub stars`}><Star size={13} aria-hidden="true"/>{Number(market.stars || 0).toLocaleString('en-US')}</span>
          <a className="waiting-github" href={githubUrl} target="_blank" rel="noopener noreferrer" aria-label={`${market.fullName} on GitHub (opens in a new tab)`}><GithubMark size={14}/>GitHub<ArrowUpRight size={12} aria-hidden="true"/></a>
        </div>
      </div>
    </div>
    <div className="waiting-amount" title={AMOUNT_NOTE}>
      <strong>{amount.value} <span>waiting</span></strong>
      <small>{amount.sol ?? 'Builders earned'}</small>
    </div>
    <div className="waiting-actions">
      <a className="button primary waiting-tag" href={intent} target="_blank" rel="noopener noreferrer"><XMark size={14}/>Tag them on X<span className="sr-only"> — {market.fullName} maintainer, opens in a new tab</span></a>
      <Link className="button outline" href={`/claim/${market.repoId}`}>I’m the maintainer<span className="sr-only"> of {market.fullName}</span> → Claim</Link>
      <WaitingCopyLink anchor={anchor} fullName={market.fullName}/>
    </div>
  </li>
}

export function WaitingList({ markets, count, usdPerSol }) {
  if (!markets.length) return <div className="waiting-empty">
    <p>Every repository with unclaimed builder fees has a verified maintainer, or no fees have accrued yet. Every trade adds more — check back soon.</p>
    <Link className="button outline" href="/explore">Explore markets</Link>
  </div>
  return <section aria-labelledby="waiting-list-title">
    <div className="waiting-list-heading"><h2 id="waiting-list-title">Largest amounts waiting</h2><span>Builders earned, not yet claimed</span></div>
    <ol className="waiting-list">{markets.map((market, index) => <WaitingRow key={market.repoId} market={market} rank={index + 1} usdPerSol={usdPerSol}/>)}</ol>
    <p className="waiting-note">{count > markets.length && `Showing the top ${markets.length} of ${count.toLocaleString('en-US')}. `}{AMOUNT_NOTE} A market launch is not an endorsement by the maintainers.</p>
  </section>
}

export function RecentlyClaimed({ payouts }) {
  if (!payouts.length) return null
  return <section className="waiting-claimed" aria-labelledby="waiting-claimed-title">
    <h2 id="waiting-claimed-title">Recently claimed</h2>
    <ul>{payouts.map(payout => <li key={payout.signature}>
      <MarketLink mint={payout.mint} className="waiting-claimed-repo"><RepoAvatar repo={payout}/><span><strong>{payout.fullName}</strong><small>Maintainer claimed {formatSolDisplay(payout.amount)} SOL · <time dateTime={new Date(payout.settledAt).toISOString()}>{new Date(payout.settledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</time></small></span></MarketLink>
    </li>)}</ul>
  </section>
}
