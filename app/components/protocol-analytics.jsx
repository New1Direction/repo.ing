import Link from 'next/link'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'
import { AnalyticsActivityChart } from './analytics-activity-chart'
import { ArrowUpRight } from 'lucide-react'
import { formatSolDisplay, formatUnits, formatUtcDateTime, formatUtcDay } from '../lib/format.mjs'
import { compactFigure } from '../lib/market-display.mjs'
import { formatTokenCompact } from '../lib/buyback-summary.mjs'
import { BuilderPayouts } from './builder-payouts'
import { BuilderSplitDetails } from './builder-split'
import { TeamTokenLocks } from './team-token-locks'
import { ReserveCoverage } from './reserve-coverage'
import { BuybackStatus, receiptUrl } from './buyback-status'
import { BUYBACK_RECEIPTS_BY_TIME, totalBuybackLamports } from '../lib/buyback-receipts.mjs'
import { LIQUIDITY_RECEIPTS, liquidityTotals } from '../lib/liquidity-receipts.mjs'
import { SourceSplit } from './hf/source-split'
const BUYBACK_SOURCE = { custody: 'platform revenue', team: 'team wallet' }

// One figure per amount: rounded dollars at today's SOL price ("$4.9k"), the exact SOL on hover; SOL when there is no price
// or the dollar figure would round to nothing.
export function headlineAmount(lamports, usdPerSol) {
  const sol = `${formatSolDisplay(lamports)} SOL`
  const usd = Number.isFinite(usdPerSol) && usdPerSol > 0 ? Number(lamports) / 1e9 * usdPerSol : null
  return usd !== null && usd >= 1 ? { text: `$${compactFigure(usd, 0)}`, title: sol } : { text: sol, title: undefined }
}
function Amount({ value, usdPerSol, hero = false }) {
  const { text, title } = headlineAmount(value, usdPerSol)
  return <div className={`analytics-amount${hero ? ' analytics-amount-large' : ''}`}><strong title={title}>{text}</strong></div>
}
// showSources (HF_MARKETS_ENABLED): adds the GitHub repos / Hugging Face models split under the builder figures.
export function ProtocolAnalytics({ data, usdPerSol, buybacks = BUYBACK_RECEIPTS_BY_TIME, buybackStatus = null, showSources = false }) {
  const { totals, platform } = data
  const rangeLabel = { '24h': 'Past 24 hours', '7d': 'Past 7 days', '30d': 'Past 30 days', all: 'All time' }[data.range]
  return <>
    <section className="analytics-hero" aria-label="Builder earnings and payouts">
      <div><span className="analytics-kicker">Paid to builders</span><Amount value={totals.paid} usdPerSol={usdPerSol} hero/><p>{rangeLabel}</p></div>
      <div><span className="analytics-kicker">Earned by builders</span><Amount value={totals.earned} usdPerSol={usdPerSol} hero/><p>{rangeLabel} · includes amounts already paid</p></div>
    </section>
    <BuilderSplitDetails builders={data.builders}/>
    {showSources && <SourceSplit sources={data.sources}/>}
    <div className="analytics-market-counts"><span><strong>{totals.markets}</strong> live markets</span><span><strong>{totals.graduated}</strong> graduated</span><span><strong>{totals.trades.toLocaleString('en-US')}</strong> trades · {rangeLabel.toLowerCase()}</span></div>
    <section className="analytics-chart-grid" aria-label="Protocol activity charts">
      {[['volume','Trading volume'],['earned','Builder fees earned'],['paid','Builder payouts']].map(([metric,title]) => <article className="analytics-card" key={metric}><h2>{title}</h2><Amount value={totals[metric]} usdPerSol={usdPerSol}/><p>{rangeLabel}{data.range==='all'?' · chart shows the last 14 days':''}</p><AnalyticsActivityChart data={data} metric={metric} title={title}/></article>)}
    </section>
    <section className="analytics-revenue" aria-labelledby="revenue-title"><div className="analytics-section-heading"><div><h2 id="revenue-title">Where platform revenue goes</h2><p>repo.ing&apos;s share of fees, all time. Builder fees are separate.</p></div></div>
        <div className="analytics-policy">{platform.policy ? <>{[[platform.policy.buybackPermille,'$REPOING buyback reserve'],[platform.policy.liquidityPermille,'Protocol liquidity'],[1000-platform.policy.buybackPermille-platform.policy.liquidityPermille,'Treasury']].map(([share,label])=><div key={label}><strong>{share/10}%</strong><span>{label}</span></div>)}</> : <p>No allocation policy has been activated.</p>}</div>
        {/* The figures show only once the platform accounts check out; until then the policy alone, with no "being checked" notice. */}
        {platform.status==='MATCH'&&<>
        <div className="analytics-reserves"><div><span>Platform fees collected</span><strong>{formatSolDisplay(platform.claimed)} SOL</strong></div></div>
        <details className="analytics-data"><summary>Details</summary>
          <div className="analytics-reserves">{[['buybackReserve','Not yet bought back'],['liquidityReserve','Not yet added as liquidity'],['treasuryAllocated','To treasury']].map(([key,label])=><div key={key}><span>{label}</span><strong>{formatSolDisplay(platform[key])} SOL</strong></div>)}</div>
          <ReserveCoverage coverage={platform.coverage}/>
          <p>The split applies to platform fees once they are collected. Unclaimed fees and discoverer rewards are left out. Amounts are after spending.</p>
        </details>
      </>}
    </section>
    <section className="analytics-token" aria-labelledby="repo-title"><div><div className="eyebrow"><Link href={OFFICIAL_TOKEN.marketPath}>$REPOING ↗</Link></div><h2 id="repo-title">Buybacks</h2><p>SOL spent buying $REPOING, from platform fees and the team wallet.</p><details className="analytics-data"><summary>View receipts</summary><ul>{buybacks.map(receipt => <li key={receipt.signature}><a href={receiptUrl(receipt.signature)} target="_blank" rel="noopener noreferrer">{formatSolDisplay(receipt.spentLamports)} SOL · {BUYBACK_SOURCE[receipt.source]} · {formatUtcDay(receipt.at)} ↗</a></li>)}</ul><p>Includes trading fees. Excludes network fees, the launch buy, and early team purchases. New buys from these wallets are added once confirmed on-chain.</p></details></div><div className="analytics-token-state"><span>SOL bought back</span><strong>{formatSolDisplay(totalBuybackLamports(buybacks))} SOL</strong><small>{formatSolDisplay(totalBuybackLamports(buybacks, 'custody'))} from platform fees · {formatSolDisplay(totalBuybackLamports(buybacks, 'team'))} from the team wallet</small></div></section>
    <BuybackStatus status={buybackStatus}/>
    <LiquidityReceipts/>
    <TeamTokenLocks/>
    <BuilderPayouts payouts={data.payouts} unavailable={false}/>
    <div className="protocol-bottom"><p>Dollar figures use today&apos;s SOL price. Updated {formatUtcDateTime(data.updatedAt)}.</p><Link href="/explore">Explore markets <ArrowUpRight size={16}/></Link></div>
  </>
}

function LiquidityReceipts() {
  const totals = liquidityTotals()
  const tokens = formatTokenCompact(totals.tokenBaseUnits)
  return <section className="analytics-token" aria-labelledby="liquidity-title"><div><div className="eyebrow"><Link href={OFFICIAL_TOKEN.marketPath}>$REPOING ↗</Link></div><h2 id="liquidity-title">Protocol liquidity</h2><p>The 20% liquidity share of platform fees, added to the $REPOING pool.</p><details className="analytics-data"><summary>View receipts</summary><ul>{LIQUIDITY_RECEIPTS.map(receipt => <li key={receipt.signature}><a href={`https://explorer.solana.com/tx/${receipt.signature}`} target="_blank" rel="noopener noreferrer">{formatSolDisplay(receipt.solLamports)} SOL + {Number(formatUnits(receipt.tokenBaseUnits, 6, 0).replaceAll(',', '')).toLocaleString('en-US')} REPOING · {receipt.locked ? 'permanently locked' : 'not locked yet'} · {formatUtcDay(receipt.at)} ↗</a></li>)}</ul><p>Amounts the pool vaults received, verified on-chain. One-time position rent is excluded.</p></details></div><div className="analytics-token-state"><span>Liquidity added</span><strong>{formatSolDisplay(totals.solLamports)} SOL</strong><small>+ {tokens} $REPOING · {totals.allLocked ? 'permanently locked' : 'not locked yet'}</small></div></section>
}
