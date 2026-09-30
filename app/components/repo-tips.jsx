import Link from 'next/link'
import { Gift } from 'lucide-react'
import { TipRepo } from './tip-repo'
import { ClaimTips } from './claim-tips'
import { sealTipReview } from '../lib/auth.mjs'
import { formatTokenAmount, formatUsdValue } from '../lib/format.mjs'
import { repoTipSummary, tipsEnabled } from '../lib/tips.mjs'

export function TipBreakdown({ waiting }) {
  return <ul className="tip-breakdown">{waiting.map(row => <li key={row.mint}><strong>{formatTokenAmount(row.amount, row.decimals)} {row.symbol}</strong>
    <span>{row.tips} {row.tips === 1 ? 'tip' : 'tips'}{row.usd !== null ? ` · ≈ ${formatUsdValue(row.usd)}` : ''}</span></li>)}</ul>
}

// Claim page: tips waiting for this repository, and "Claim tips" once GitHub is verified and a payout wallet is set.
export async function ClaimPageTips({ market, session }) {
  if (!tipsEnabled()) return null
  const summary = await repoTipSummary(market.repoId)
  const waiting = summary?.waiting ?? []
  const verified = session?.repoId === market.repoId
  const inFlight = waiting.some(row => row.inFlight)
  const review = verified && market.beneficiaryWallet && waiting.length && !inFlight ? sealTipReview(session, { repoId: market.repoId,
    wallet: market.beneficiaryWallet, boundAt: market.beneficiaryBoundAt }) : null
  const usd = formatUsdValue(summary?.usd)
  return <section id="tips" className="inner-card repo-tips claim-page-tips" aria-labelledby="claim-tips-title">
    <div className="repo-tips-heading"><span className="repo-tips-icon" aria-hidden="true"><Gift size={20}/></span><div><h2 id="claim-tips-title">Tips</h2>
      <p>{waiting.length ? <strong>{usd ? `${usd} in tips waiting` : `${summary.count} ${summary.count === 1 ? 'tip' : 'tips'} waiting`}</strong> : 'No tips are waiting for this repository.'}</p></div></div>
    {waiting.length > 0 && <TipBreakdown waiting={waiting}/>}
    {waiting.length > 0 && (review ? <ClaimTips review={review} symbols={Object.fromEntries(waiting.map(r => [r.mint, r.symbol]))}/>
      : <p className="claim-next">{inFlight ? 'A tip payout is confirming. Refresh in a minute.' : !verified ? 'Verify GitHub above to claim tips.' : 'Set a payout wallet above to claim tips.'}</p>)}
    <div className="repo-tips-actions"><TipRepo repoId={market.repoId} fullName={market.fullName}/></div>
    <p className="tip-fineprint">Tips are paid in the token they were sent in, to your payout wallet. Unclaimed tips become refundable to their senders after 90 days.</p>
  </section>
}

// Token page: tips waiting for this repository's maintainer, plus the tip action. Hidden entirely when tips are off.
export async function RepoTips({ market }) {
  if (!tipsEnabled()) return null
  const summary = await repoTipSummary(market.repoId)
  const waiting = summary?.waiting ?? []
  const usd = formatUsdValue(summary?.usd)
  return <section className="inner-card repo-tips" aria-labelledby="repo-tips-title">
    <div className="repo-tips-heading"><span className="repo-tips-icon" aria-hidden="true"><Gift size={20}/></span><div><h3 id="repo-tips-title">Tips for the maintainer</h3>
      <p>{waiting.length ? <><strong>{usd ? `${usd} in tips waiting` : `${summary.count} ${summary.count === 1 ? 'tip' : 'tips'} waiting`}</strong>{market.beneficiaryWallet ? ' — the maintainer can claim them now.' : ' — verify to claim.'}</>
        : 'Say thanks with SOL, USDC or tokenized stocks. Tips are held until a verified maintainer claims them.'}</p></div></div>
    <div className="repo-tips-actions"><TipRepo repoId={market.repoId} fullName={market.fullName} className="button primary"/>
      {waiting.length > 0 && <Link href={`/claim/${market.repoId}#tips`}>{market.beneficiaryWallet ? 'Claim tips' : 'Maintainer? Verify to claim'} →</Link>}</div>
    {waiting.length > 0 && <TipBreakdown waiting={waiting}/>}
  </section>
}
