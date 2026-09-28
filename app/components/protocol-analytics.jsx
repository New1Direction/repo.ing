import Link from 'next/link'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'
import { AnalyticsActivityChart } from './analytics-activity-chart'
import { ArrowUpRight } from 'lucide-react'
import { formatSolDisplay, formatUsdEstimate } from '../lib/format.mjs'
import { BuilderPayouts } from './builder-payouts'
import { TeamTokenLocks } from './team-token-locks'

function Amount({ value, usdPerSol, hero = false }) {
  const usd = formatUsdEstimate(value, usdPerSol)
  return <div className={`analytics-amount${hero ? ' analytics-amount-large' : ''}`}><strong>{usd ? `≈ ${usd}` : `${formatSolDisplay(value)} SOL`}</strong>{usd && <span>{formatSolDisplay(value)} SOL</span>}</div>
}
export function ProtocolAnalytics({ data, usdPerSol }) {
  const { totals, platform } = data
  const rangeLabel = { '24h': 'Past 24 hours', '7d': 'Past 7 days', '30d': 'Past 30 days', all: 'All time' }[data.range]
  return <>
    <section className="analytics-hero" aria-label="Builder earnings and payouts">
      <div><span className="analytics-kicker">Paid to builders</span><Amount value={totals.paid} usdPerSol={usdPerSol} hero/><p>Settled payouts · {rangeLabel.toLowerCase()}</p></div>
      <div><span className="analytics-kicker">Earned by builders</span><Amount value={totals.earned} usdPerSol={usdPerSol} hero/><p>Indexed fees, including amounts already paid</p></div>
    </section>
    <div className="analytics-market-counts"><span><strong>{totals.markets}</strong> live markets</span><span><strong>{totals.graduated}</strong> graduated</span><span><strong>{totals.trades.toLocaleString('en-US')}</strong> trades · {rangeLabel.toLowerCase()}</span></div>
    <section className="analytics-chart-grid" aria-label="Protocol activity charts">
      {[['volume','Trading volume'],['earned','Builder fees earned'],['paid','Builder payouts']].map(([metric,title]) => <article className="analytics-card" key={metric}><h2>{title}</h2><Amount value={totals[metric]} usdPerSol={usdPerSol}/><p>{data.bucket==='hour'?'Hourly':'Daily'} in UTC{data.range==='all'?' · last 14 days shown':''}</p><AnalyticsActivityChart data={data} metric={metric} title={title}/></article>)}
    </section>
    <section className="analytics-revenue" aria-labelledby="revenue-title"><div className="analytics-section-heading"><div><h2 id="revenue-title">Where platform revenue goes</h2><p>All-time settled platform revenue. Builder earnings stay separate.</p></div><span className="analytics-status">{platform.status==='MATCH'?'Ledger reconciled':'Being verified'}</span></div>
      {platform.status!=='MATCH'?<p className="subtle-notice">Platform accounting is being verified. Reserve totals are temporarily unavailable.</p>:<>
        <div className="analytics-policy">{platform.policy ? <>{[[platform.policy.buybackPermille,'$REPOING buyback reserve'],[platform.policy.liquidityPermille,'Protocol liquidity'],[1000-platform.policy.buybackPermille-platform.policy.liquidityPermille,'Treasury']].map(([share,label])=><div key={label}><strong>{share/10}%</strong><span>{label}</span></div>)}</> : <p>No allocation policy has been activated.</p>}</div>
        <div className="analytics-reserves">{[['claimed','Platform fees claimed'],['buybackReserve','Buyback reserve'],['liquidityReserve','Available liquidity reserve'],['treasuryAllocated','Allocated to treasury']].map(([key,label])=><div key={key}><span>{label}</span><strong>{formatSolDisplay(platform[key])} SOL</strong></div>)}</div>
        <p className="analytics-note">The policy applies when eligible claimed platform fees are allocated. Unclaimed fees and discoverer obligations are excluded. Treasury allocation is a historical total, not a live wallet balance.</p>
      </>}
    </section>
    <section className="analytics-token" aria-labelledby="repo-title"><div><div className="eyebrow"><Link href={OFFICIAL_TOKEN.marketPath}>$REPOING ↗</Link></div><h2 id="repo-title">Buyback transparency</h2><p>The buyback reserve is visible above. The official token is live. Buybacks still require a reviewed executor, spending limits, a successful rehearsal, and explicit activation.</p><p className="analytics-note">Buyback execution is not active. No burn mechanism is configured.</p></div><div className="analytics-token-state"><span className="analytics-status">Awaiting activation</span><span>Completed buybacks</span><strong>{platform.status==='MATCH'?platform.buybacks:'—'}</strong><small>{platform.status==='MATCH'?`${formatSolDisplay(platform.buybackSpent)} SOL spent`:'Accounting being verified'}</small></div></section>
    <TeamTokenLocks/>
    <BuilderPayouts payouts={data.payouts} unavailable={false} usdPerSol={usdPerSol}/>
    <div className="protocol-bottom"><p>Indexed finalized DBC and verified DAMM activity. Trades use chain timestamps; fees use indexing time; payouts use settlement records. UTC chart buckets at the range edges may be partial. USD figures are estimates at today’s SOL price, not historical dollar proceeds. Updated {new Date(data.updatedAt).toLocaleString('en-US',{timeZone:'UTC'})} UTC.</p><Link href="/explore">Explore markets <ArrowUpRight size={16}/></Link></div>
  </>
}
