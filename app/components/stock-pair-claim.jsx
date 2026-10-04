import Link from 'next/link'
import { Suspense } from 'react'
import { ArrowLeft } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity, RepoStats, GitHubLink } from './ui'
import { StockFeeRouting } from './stock-fee-routing'
import { displayRepository } from '../lib/repository-display.mjs'
import { STOCK_PAIR_NO_OWNER_CLAIM, noOwnerClaimMessage, stockSymbol } from '../../src/stock-owner-claims.mjs'
import styles from './stock-pair.module.css'

// The claim page of a stock-paired market: the early return in app/(site)/claim/[repo]/page.jsx. A stock pair has no owner
// claim (src/stock-owner-claims.mjs), so this page never checks fees, asks GitHub for authority or offers a payout: it says
// where the fees go. /api/claim sends a claim attempt back here with ?error=STOCK_PAIR_NO_OWNER_CLAIM.
export function StockPairClaimPage({ market, query = {} }) {
  const repo = displayRepository(market)
  const refused = query.error === STOCK_PAIR_NO_OWNER_CLAIM
  return <><AppHeader/><main className="section-wrap claim-page">
    <Link href={`/token/${market.mint}`} className="back-link"><ArrowLeft size={18}/>Back to repository</Link>
    <div className="claim-intro"><div><h1>No owner claim on stock pairs</h1>
      <p>${market.symbol} trades against {stockSymbol(market)}, so its fees follow a fixed routing instead of a builder claim.</p></div></div>
    <div className="claim-repo-card"><div><RepoIdentity repo={repo}/><RepoStats repo={repo}/></div><GitHubLink repo={repo}/></div>
    <p className={`state-card${refused ? ' error' : ''}`} role={refused ? 'alert' : 'status'} data-code={STOCK_PAIR_NO_OWNER_CLAIM}>
      {refused && <strong>That claim was not sent. </strong>}{noOwnerClaimMessage(market)}</p>
    <Suspense fallback={<div className="inner-card" role="status" aria-busy="true">Reading fee routing…</div>}>
      <StockFeeRouting market={market}/>
    </Suspense>
    <p className={styles.footnote}>Tips sent to this repository, its stream link and the option to decline its market are on <Link href="/builders">Builders</Link>.</p>
  </main><Footer/></>
}
