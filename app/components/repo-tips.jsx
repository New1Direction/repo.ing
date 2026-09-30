import Link from 'next/link'
import { cache } from 'react'
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

// Token page: one memoized summary per request feeds both the header pill and the tip card.
const tokenPageTips = cache(repoId => repoTipSummary(repoId))
const jarLabel = summary => !summary?.waiting.length ? null : formatUsdValue(summary.usd) ?? `${summary.count} ${summary.count === 1 ? 'tip' : 'tips'}`

// Header pill: "Tip jar · $X" that opens the tip dialog. The page renders it only when tips are enabled.
export async function TipJarPill({ market }) {
  const jar = jarLabel(await tokenPageTips(market.repoId))
  return <TipRepo repoId={market.repoId} fullName={market.fullName} className="tip-jar-pill" ariaLabel={jar ? `Tip jar: ${jar} waiting. Tip this repo` : 'Tip jar is empty. Be the first to tip this repo'}
    label={<><span>Tip jar</span><b aria-hidden="true">·</b><strong>{jar ?? 'Be the first to tip'}</strong></>}/>
}
export const TipJarPillFallback = () => <span className="tip-jar-pill is-loading" aria-hidden="true"><span>Tip jar</span><b>·</b><strong>…</strong></span>

// Token page tip card, under the trade panel. Hidden entirely when tips are off.
export async function RepoTips({ market }) {
  const summary = await tokenPageTips(market.repoId)
  const waiting = summary?.waiting ?? []
  const jar = jarLabel(summary)
  const status = !market.beneficiaryWallet ? 'Waiting for the maintainer to verify on repo.ing' : waiting.length ? 'Maintainer verified · ready to claim' : 'Paid to the verified maintainer'
  const earned = /^\d+$/.test(String(market.earned ?? '')) && BigInt(market.earned) > 0n
  return <section id="tips" className="inner-card repo-tips tip-jar-card" aria-labelledby="repo-tips-title">
    <div className="tip-jar-top"><h3 id="repo-tips-title"><Gift size={16} aria-hidden="true"/>Tip jar</h3>
      <strong className="tip-jar-total">{jar ?? '$0'}</strong></div>
    {waiting.length > 0 ? <TipBreakdown waiting={waiting}/> : <p className="tip-jar-empty">Say thanks with SOL, USDC or tokenized stocks.</p>}
    <p className="tip-jar-status"><span className={market.beneficiaryWallet ? 'is-verified' : ''} aria-hidden="true"/>{status}</p>
    <TipRepo repoId={market.repoId} fullName={market.fullName} className="button primary tip-jar-cta"/>
    {(waiting.length > 0 || earned) && <div className="tip-jar-links">
      {waiting.length > 0 && <Link href={`/claim/${market.repoId}#tips`}>{market.beneficiaryWallet ? 'Claim tips' : 'Maintainer? Verify to claim'} →</Link>}
      {earned && <Link href={`/claim/${market.repoId}`}>Claim builder fees →</Link>}</div>}
  </section>
}
export const RepoTipsFallback = () => <section className="inner-card repo-tips tip-jar-card" aria-busy="true" aria-label="Tip jar">
  <div className="tip-jar-top"><h3><Gift size={16} aria-hidden="true"/>Tip jar</h3><strong className="tip-jar-total">…</strong></div>
  <p className="tip-jar-empty loading-placeholder">Checking tips…</p></section>
