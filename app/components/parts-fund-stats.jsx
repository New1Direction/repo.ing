import { formatCents, formatTokenAmount } from '../lib/format.mjs'
import { partsEnabled, partsStats } from '../lib/parts-fund.mjs'

const LABEL = { pledge: 'Pledge', payout: 'Paid to maintainer', refund: 'Refunded' }
const day = value => new Date(value).toLocaleDateString('en-US', { timeZone: 'UTC' })

// /stats: parts funds (active, funded, refunded; USD at pledge time) and their pledge, payout and refund receipts.
export async function PartsFundStats() {
  if (!partsEnabled()) return null
  let stats = null
  try { stats = await partsStats() } catch (error) { if (error?.code !== '42P01') console.error('parts stats unavailable', { error: error.message }) }
  if (!stats) return <section className="analytics-token" aria-labelledby="parts-title"><div><h2 id="parts-title">Parts funds</h2><p>Parts fund totals are temporarily unavailable.</p></div></section>
  const lists = stats.activeLists + stats.fundedLists + stats.refundedLists
  return <section className="analytics-token parts-stats" aria-labelledby="parts-title"><div>
    <div className="eyebrow">PARTS FUNDS</div><h2 id="parts-title">Parts funds</h2>
    <p>Verified maintainers list the hardware a build needs; backers pledge USDC or SOL all-or-nothing. Pledges sit in the tip wallet until a list is funded (paid to the maintainer) or not (refunded to every backer).</p>
    <div className="parts-stats-grid">
      <div><span>Active</span><strong>{formatCents(stats.activeCents)}</strong><small>{stats.activeLists} {stats.activeLists === 1 ? 'list' : 'lists'}</small></div>
      <div><span>Funded</span><strong>{formatCents(stats.fundedCents)}</strong><small>{stats.fundedLists} {stats.fundedLists === 1 ? 'list' : 'lists'}</small></div>
      <div><span>Refunded</span><strong>{formatCents(stats.refundedCents)}</strong><small>{stats.refundedLists} {stats.refundedLists === 1 ? 'list' : 'lists'}</small></div>
    </div>
    {stats.recent.length > 0 && <details className="analytics-data"><summary>View receipts</summary><ul>{stats.recent.map(r => <li key={`${r.kind}:${r.signature}`}>
      <a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noopener noreferrer">{LABEL[r.kind]} · {formatTokenAmount(r.amount, r.decimals)} {r.symbol} · {r.fullName} · {day(r.at)} ↗</a></li>)}</ul>
      <p>A pledge counts once its finalized receipt shows the tip wallet received the exact amount with its memo.</p></details>}
  </div><div className="analytics-token-state"><span>Pledged in total</span>
    <strong>{formatCents(Number(stats.activeCents) + Number(stats.fundedCents) + Number(stats.refundedCents))}</strong>
    <small>{lists ? `${lists} ${lists === 1 ? 'list' : 'lists'} · USD at pledge time` : 'No parts lists yet'}</small></div></section>
}
