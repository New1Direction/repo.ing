import Link from 'next/link'
import { CopyAddress } from './copy-address'
import { formatTokenAmount, formatUsdValue } from '../lib/format.mjs'
import { tipStats, tipsEnabled } from '../lib/tips.mjs'
import { xHandlesFor } from '../lib/x-links.mjs'
import { XHandleLink } from './x-handle-link'

const LABEL = { tip: 'Tip', payout: 'Paid to maintainer', refund: 'Refunded' }
const day = value => new Date(value).toLocaleDateString('en-US', { timeZone: 'UTC' })

// /stats: the custodial tip wallet, what it holds for maintainers, and every tip, payout and refund receipt.
export async function TipStats() {
  if (!tipsEnabled()) return null
  let stats = null, handles = new Map()
  try { stats = await tipStats() } catch { stats = null }
  // Tippers who linked X show their @handle; payouts and refunds stay wallet-free.
  if (stats) try { handles = await xHandlesFor(stats.recent.filter(r => r.kind === 'tip').map(r => r.wallet)) } catch { handles = new Map() }
  if (!stats) return <section className="analytics-token" aria-labelledby="tips-title"><div><h2 id="tips-title">Tips</h2><p>Tip totals are temporarily unavailable.</p></div></section>
  const waiting = formatUsdValue(stats.usdWaiting), received = formatUsdValue(stats.usdReceived)
  return <section className="analytics-token tip-stats" aria-labelledby="tips-title"><div>
    <div className="eyebrow">TIP WALLET</div><h2 id="tips-title">Tips</h2>
    <p>Tips to repository maintainers are held in one public wallet until a verified maintainer claims them, or refunded to the sender after 90 days unclaimed.</p>
    <CopyAddress address={stats.wallet} compact label="tip wallet address"/> <a className="tip-stats-link" href={`https://solscan.io/account/${stats.wallet}`} target="_blank" rel="noopener noreferrer">Solscan ↗</a>
    {stats.byToken.length > 0 && <div className="operations-table-wrap tip-stats-table"><table><thead><tr><th>Token</th><th>Tipped</th><th>Paid out</th><th>Refunded</th><th>Waiting</th></tr></thead><tbody>
      {stats.byToken.map(row => <tr key={row.mint}><td><strong>{row.symbol}</strong><small>{row.tips} {row.tips === 1 ? 'tip' : 'tips'}</small></td>
        <td>{formatTokenAmount(row.received, row.decimals)}</td><td>{formatTokenAmount(row.paid, row.decimals)}</td>
        <td>{formatTokenAmount(row.refunded, row.decimals)}</td><td>{formatTokenAmount(row.waiting, row.decimals)}</td></tr>)}
    </tbody></table></div>}
    {stats.recent.length > 0 && <details className="analytics-data"><summary>View receipts</summary><ul>{stats.recent.map(r => <li key={`${r.kind}:${r.signature}`}>
      <a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noopener noreferrer">{LABEL[r.kind]} · {formatTokenAmount(r.amount, r.decimals)} {r.symbol} · {r.fullName} · {day(r.at)} ↗</a>{r.kind === 'tip' && handles.get(r.wallet) && <> <span className="tip-stats-from">from <XHandleLink link={handles.get(r.wallet)}/></span></>}</li>)}</ul>
      <p>Tips count once their finalized receipt shows the tip wallet received the exact amount. <Link href="/explore">Find a repository to tip →</Link></p></details>}
  </div><div className="analytics-token-state"><span>Waiting for maintainers</span><strong>{stats.byToken.length ? waiting ?? '—' : '$0.00'}</strong>
    <small>{stats.byToken.length ? `${received ? `≈ ${received} tipped in total` : 'Totals by token at left'} · USD at today’s prices` : 'No tips yet'}</small></div></section>
}
