import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { CopyAddress } from '../../../components/copy-address'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { operationsHealth } from '../../../lib/operations-health.mjs'
import { formatSolDisplay } from '../../../lib/format.mjs'
import { tokenBalanceLabel } from '../../../lib/token-balance.mjs'
import { formatCents, formatUnits } from '../../../lib/format.mjs'
import { holderNotesService } from '../../../lib/holder-notes.mjs'
import { HideNoteButton } from '../../../components/holder-note-moderation'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Operations health — repo.ing', robots: { index: false, follow: false } }

const sol = value => value === null || value === undefined ? '—' : `${formatSolDisplay(value)} SOL`
const age = ms => { const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24); return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m` }
const when = value => `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC`
const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—'
const monitorNote = { match: 'Worker alert watches this address', different: 'Worker alert watches a different address', unset: 'Worker alert not configured' }
const alertTitles = { OPS_WALLET_LOW: 'Operating wallet needs SOL', FEE_EVIDENCE_QUARANTINED: 'Trade fee evidence needs review', RESERVE_MOVED: 'Reserve moved', RECONCILIATION_MISMATCH: 'Reconciliation needs review', GRADUATION_REVIEW: 'Graduation evidence needs review', LAUNCH_EXPIRED: 'Expired launch released for retry', TRADE_VERIFICATION_FAILED: 'Trade verification failed', TRADE_LANDING_DEGRADED: 'Trades expiring or failing', TRADE_CANARY_FAILING: 'Trade canary failing', TIP_WALLET_SHORTFALL: 'Tip wallet below tip liabilities', TIP_RECEIPT_REVIEW: 'Landed tip does not reconcile', TIP_TRANSFER_REVIEW: 'Tip payout/refund needs reconciliation', PARTS_TRANSFER_REVIEW: 'Parts fund payout/refund needs reconciliation', PARTS_TRANSFER_FAILED: 'Parts fund payout/refund not sent (retrying)', PARTS_PLEDGE_REVIEW: 'Landed pledge does not reconcile', PARTS_FUND_REVIEW: 'Funded parts list has no payout wallet' }

function Section({ title, result, children }) {
  return <section className="inner-card operations-markets"><h2>{title}</h2>{result.ok ? children(result.data) : <p className="inline-error" role="status">{result.error}</p>}</section>
}

function Wallets({ result }) {
  return <Section title="Wallets" result={result}>{wallets => <><div className="operations-table-wrap"><table><thead><tr><th>Wallet</th><th>Address</th><th>SOL</th><th>$REPOING</th><th>Threshold</th></tr></thead><tbody>
    {wallets.map(w => <tr key={w.id}><td><strong>{w.label}</strong><small>{w.purpose}</small></td>
      <td>{w.address ? <><CopyAddress address={w.address} compact label={`${w.label} address`}/><small><a href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer">Solscan ↗</a></small></> : '—'}</td>
      <td>{w.error ? <span className="badge warn">{w.error}</span> : <>{sol(w.balanceLamports)} {w.state === 'low' && <span className="badge warn">Below threshold</span>}{w.state === 'ok' && <span className="badge ok">OK</span>}</>}</td>
      <td>{w.token ? w.tokenBaseUnits === null ? '—' : tokenBalanceLabel(w.tokenBaseUnits) : <small>n/a</small>}</td>
      <td>{w.minimumLamports ? <>{sol(w.minimumLamports)}<small>{monitorNote[w.monitored]}</small></> : <small>No alert threshold</small>}</td></tr>)}
  </tbody></table></div><p className="muted">Thresholds are the worker&apos;s OPS_WALLET_LOW minimums: payout signer {sol(wallets.find(w => w.id === 'creator')?.minimumLamports)}, collection signer {sol(wallets.find(w => w.id === 'partner')?.minimumLamports)}. Balances are single-RPC, confirmed commitment.</p></>}</Section>
}

function Launches({ result }) {
  return <Section title="Launches needing attention" result={result}>{rows => rows.length ? <><div className="operations-table-wrap"><table><thead><tr><th>Repository</th><th>Status</th><th>Age</th><th>Mint / pool</th><th>Signature</th></tr></thead><tbody>
    {rows.map(r => <tr key={r.repoId}><td><Link href={`/launch/${r.repoId}`}>{r.fullName ?? `Repo ${r.repoId}`}</Link><small>Repo {r.repoId}{r.fullName && <> · <a href={`https://github.com/${r.fullName}`} target="_blank" rel="noreferrer">GitHub ↗</a></>}</small></td>
      <td><span className="badge warn">{r.status}</span></td><td>{age(r.ageMs)}<small>{when(r.createdAt)}</small></td>
      <td>{r.mint ? <a href={`https://solscan.io/token/${r.mint}`} target="_blank" rel="noreferrer">{short(r.mint)}</a> : '—'}<small>{r.pool ? `Pool ${short(r.pool)}` : 'No pool'}</small></td>
      <td>{r.signature ? <a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noreferrer">{short(r.signature)} ↗</a> : '—'}</td></tr>)}
  </tbody></table></div><p className="muted">Markets in prepared, submitted, or ambiguous status. Launch-indexer results are not persisted, so only database status is shown. Facts only; no release action here.</p></> : <p>No launches in prepared, submitted, or ambiguous status.</p>}</Section>
}

function Alerts({ result }) {
  return <Section title="Open alerts" result={result}>{rows => rows.length ? <>{rows.map(a => <div key={a.kind} className="operations-alert"><div><strong>{alertTitles[a.kind] ?? a.kind}</strong><span>{a.kind} · {a.count} unacknowledged · latest {when(a.latest)}</span></div></div>)}
    <p className="muted"><Link href="/operations/graduation">Review and acknowledge in graduation operations →</Link></p></> : <p>No unacknowledged alerts.</p>}</Section>
}

function Revenue({ result }) {
  return <Section title="Revenue policy vs actual" result={result}>{r => <><div className="operations-summary">
    <div className="inner-card"><span>Platform fees claimed</span><strong>{sol(r.claimed)}</strong></div>
    <div className="inner-card"><span>Unallocated</span><strong>{sol(r.available)}</strong></div>
    <div className="inner-card"><span>Allocated buyback / liquidity / treasury</span><strong>{sol(r.allocated.buyback)} / {sol(r.allocated.liquidity)} / {sol(r.allocated.treasury)}</strong></div>
    <div className="inner-card"><span>Buyback intents settled</span><strong>{sol(r.spent)}</strong></div>
    <div className="inner-card"><span>Buybacks disclosed (custody / team)</span><strong>{sol(r.buybacks.custody)} / {sol(r.buybacks.team)}</strong></div>
    <div className="inner-card"><span>Liquidity added</span><strong>{sol(r.liquidity.added)}</strong></div>
    <div className={`inner-card${BigInt(r.liquidity.owed) > 0n ? ' health-warn' : ''}`}><span>Liquidity owed, not added</span><strong>{sol(r.liquidity.owed)}</strong></div>
    <div className="inner-card"><span>Buyback allocated, not disclosed from custody</span><strong>{sol(r.buybackAllocatedNotDisclosed)}</strong></div>
  </div><p className="muted">Policy {r.policy ? `v${r.policy.version}: ${r.policy.buybackPermille / 10}% buyback, ${r.policy.liquidityPermille / 10}% liquidity` : 'not active'}. {r.buybacks.count} disclosed buyback receipts; team buybacks are funded outside the platform ledger. {r.liquidity.open ? `${r.liquidity.open} liquidity intent(s) open.` : ''}</p></>}</Section>
}

function Migrations({ result }) {
  return <Section title="Database migrations" result={result}>{m => <p>{m.status === 'UP_TO_DATE' ? <span className="badge ok">Up to date</span> : <span className="badge warn">{m.pending.length} pending</span>} {m.appliedCount} applied · {m.journalCount} in journal · latest applied {m.latestAppliedTag ?? m.latestApplied ?? 'none'}{m.pending.length > 0 && <small className="muted"> Pending: {m.pending.join(', ')}</small>}</p>}</Section>
}

const outcomeLabels = { confirmed: 'Confirmed', expired: 'Expired', failed: 'Failed', verification_failed: 'Verification failed' }
const seconds = ms => ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`

function Trades({ result }) {
  return <Section title="Trades (24h)" result={result}>{t => <><div className="operations-summary">
    <div className="inner-card"><span>Prepared / submitted</span><strong>{t.counts.prepared} / {t.counts.submitted}</strong></div>
    {Object.entries(outcomeLabels).map(([key, label]) => <div key={key} className={`inner-card${key !== 'confirmed' && t.settled[key] > 0 ? ' health-warn' : ''}`}><span>{label}</span><strong>{t.settled[key]}</strong></div>)}
    <div className={`inner-card${t.successRate !== null && t.successRate < 0.9 ? ' health-warn' : ''}`}><span>Success rate</span><strong>{t.successRate === null ? '—' : `${(t.successRate * 100).toFixed(1)}%`}</strong></div>
    <div className="inner-card"><span>Confirm time p50 / p95</span><strong>{seconds(t.confirmP50Ms)} / {seconds(t.confirmP95Ms)}</strong></div>
  </div>{t.failures.length ? <div className="operations-table-wrap"><table><thead><tr><th>When</th><th>Outcome</th><th>Market</th><th>Priority fee</th><th>Error</th></tr></thead><tbody>
    {t.failures.map((f, i) => <tr key={`${f.createdAt}-${i}`}><td>{when(f.createdAt)}{f.signature && <small><a href={`https://solscan.io/tx/${f.signature}`} target="_blank" rel="noreferrer">{short(f.signature)} ↗</a></small>}</td>
      <td><span className="badge warn">{outcomeLabels[f.outcome] ?? f.outcome}</span></td>
      <td>{f.mint ? <a href={`https://solscan.io/token/${f.mint}`} target="_blank" rel="noreferrer">{short(f.mint)}</a> : '—'}<small>{[f.phase, f.direction].filter(Boolean).join(' · ') || '—'}</small></td>
      <td>{sol(f.priorityFeeLamports)}</td><td><small>{f.error ?? '—'}</small></td></tr>)}
  </tbody></table></div> : <p>No expired or failed trades recorded.</p>}<p className="muted">Trades submitted through the site trade API, per attempt (best outcome). Success = confirmed / settled attempts. Alerts when an hour has 3+ expired/failed or under 90% success over 5+ attempts.</p></>}</Section>
}

const CANARY_STALE_MS = 15 * 60 * 1000

function Canary({ result }) {
  return <Section title="Canary" result={result}>{c => <>{c.markets.length ? <><p>Last run {when(c.lastRunAt)}{Date.now() - new Date(c.lastRunAt).getTime() > CANARY_STALE_MS && <> <span className="badge warn">Stale</span></>}</p>
    <div className="operations-table-wrap"><table><thead><tr><th>Market</th><th>Status</th><th>Last run</th><th>Compute units</th><th>Last error</th></tr></thead><tbody>
    {c.markets.map(m => <tr key={m.repoId}><td><Link href={`/launch/${m.repoId}`}>{m.symbol ? `$${m.symbol}` : `Repo ${m.repoId}`}</Link><small>{m.phase ?? '—'}</small></td>
      <td>{m.ok ? <span className="badge ok">OK</span> : <span className="badge warn">Fail{m.consecutiveFailures > 1 ? ` ×${m.consecutiveFailures}` : ''}</span>}</td>
      <td>{when(m.lastRunAt)}<small>{m.lastOkAt ? `Last OK ${when(m.lastOkAt)}` : 'Never OK'}</small></td>
      <td>{m.detail ? `${m.detail.unitsWithAssertion} / ${m.detail.computeUnitLimit}` : '—'}</td><td><small>{m.lastError ?? '—'}</small></td></tr>)}
  </tbody></table></div></> : <p>No canary results in the last day. The worker runs it every 5 minutes.</p>}<p className="muted">Worker-simulated 0.01 SOL buys (never signed or sent) through the real prepare path on $REPOING and the two most-traded curve markets, including a wallet-appended Lighthouse assertion. Alerts after 2 consecutive failures of a market, or when every market fails.</p></>}</Section>
}

function Tips({ result }) {
  return <Section title="Tip wallet" result={result}>{t => !t?.enabled ? <p>Tips are disabled (TIP_WALLET_SECRET_KEY is not set).</p> : <>
    <p><CopyAddress address={t.wallet} compact label="tip wallet address"/> <a href={`https://solscan.io/account/${t.wallet}`} target="_blank" rel="noreferrer">Solscan ↗</a> · {t.pendingTransfers} payout/refund intent(s) pending · {t.openTips} tip(s) awaiting confirmation</p>
    <div className="operations-table-wrap"><table><thead><tr><th>Token</th><th>Owed (confirmed, unpaid)</th><th>Tips</th><th>Pledges</th><th>Wallet balance</th><th>Status</th></tr></thead><tbody>
    {t.coverage.map(c => <tr key={c.mint}><td><strong>{c.symbol}</strong><small>{short(c.mint)}</small></td>
      <td>{formatUnits(c.liability, c.decimals)}</td><td>{c.tips}</td><td>{c.pledges ?? 0}</td><td>{c.balance === null ? '—' : formatUnits(c.balance, c.decimals)}</td>
      <td>{c.short === null ? <span className="badge warn">Unreadable</span> : c.short ? <span className="badge warn">Below liabilities</span> : <span className="badge ok">Covered</span>}</td></tr>)}
  </tbody></table></div><p className="muted">Owed = confirmed tips plus confirmed parts-fund pledges. SOL balance also pays payout/refund network fees and recipient token-account rent; transfers pause when it is under SOL owed + 0.01 SOL. The worker raises TIP_WALLET_SHORTFALL when any token balance falls below what is owed (issuer permanent-delegate action, a leak, or a payout outside these ledgers).</p>
    {t.parts && <PartsFunds p={t.parts}/>}</>}</Section>
}

function PartsFunds({ p }) {
  return <><h3>Parts funds</h3><p>{p.openLists} open list(s) · {formatCents(p.heldCents)} confirmed pledges held · {p.openPledges} pledge(s) awaiting confirmation · {p.closingLists} closed list(s) paying out or refunding · {p.pendingTransfers} parts transfer intent(s) pending</p>
    {(p.overdueLists > 0 || p.stuckLists > 0) && <p className="inline-error" role="status">{p.overdueLists > 0 && `${p.overdueLists} list(s) are past their deadline but undecided (worker down, or pledges still in flight). `}
      {p.stuckLists > 0 && `${p.stuckLists} closed list(s) have waited over an hour for payouts/refunds: check PARTS_TRANSFER_FAILED alerts and that the worker has TIP_WALLET_SECRET_KEY.`}</p>}</>
}

function Csp({ result }) {
  return <Section title="CSP report-only" result={result}>{c => <>{c.total ? <div className="operations-table-wrap"><table><thead><tr><th>Blocked host</th><th>Reports</th></tr></thead><tbody>
    {c.hosts.map(h => <tr key={h.key}><td>{h.key}</td><td>{h.count}</td></tr>)}
  </tbody></table></div> : <p>No reports received.</p>}<p className="muted">{c.total} reports since last web restart ({when(c.since)}), this web process only. Top directives: {c.directives.map(d => `${d.key} (${d.count})`).join(', ') || 'none'}.</p></>}</Section>
}

// Latest holder notes, hidden ones included, with a hide/unhide action. Notes are plain text; links are never rendered.
async function HolderNotesModeration() {
  let rows = null
  try { rows = await holderNotesService()?.store.recent(30) ?? [] } catch { rows = null }
  return <section className="inner-card operations-markets"><h2>Holder notes</h2>{rows === null ? <p className="inline-error" role="status">Holder notes are temporarily unavailable.</p>
    : rows.length ? <div className="operations-table-wrap"><table><thead><tr><th>When</th><th>Market</th><th>Wallet</th><th>Note</th><th>Moderation</th></tr></thead><tbody>
    {rows.map(n => <tr key={n.id}><td>{when(n.updatedAt)}</td><td><Link href={`/token/${n.mint}`}>${n.symbol}</Link></td>
      <td><a href={`https://solscan.io/account/${n.wallet}`} target="_blank" rel="noreferrer">{short(n.wallet)}</a></td>
      <td><small>{n.body}</small></td><td><HideNoteButton id={n.id} hidden={Boolean(n.hiddenAt)}/>{n.hiddenBy && <small>{n.hiddenBy}</small>}</td></tr>)}
  </tbody></table></div> : <p>No holder notes yet.</p>}<p className="muted">Latest 30 notes across markets. Hidden notes disappear from token pages; editing or re-posting keeps them hidden.</p></section>
}

export default async function OperationsHealthPage() {
  let access = false
  try { requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value)); access = true } catch {}
  const health = access ? await operationsHealth() : null
  return <><AppHeader /><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Operations health</h1><p>Read-only status across wallets, launches, alerts, revenue, trades, migrations, and CSP.</p></div></div>
    {health ? <><Wallets result={health.wallets}/><Launches result={health.launches}/><Alerts result={health.alerts}/><Revenue result={health.revenue}/><Trades result={health.trades}/><Canary result={health.canary}/><Tips result={health.tips}/><Migrations result={health.migrations}/><Csp result={health.csp}/><HolderNotesModeration/>
      <p className="muted health-footer">Generated {when(health.generatedAt)} · <Link href="/operations/fees">Platform fees</Link> · <Link href="/operations/graduation">Graduation</Link> · <Link href="/operations/trends">Trends</Link> · <Link href="/operations/invites">Invites</Link> · <Link href="/operations/bonuses">Bonuses</Link> · <Link href="/operations/vitals">Web vitals</Link></p></>
      : <div className="inner-card"><h2>Operator access required</h2><p>Sign in with the configured operator GitHub account.</p><Link className="button outline" href="/api/github/start?mode=builders">Verify with GitHub</Link><p>Return here after verification.</p></div>}
  </main><Footer /></>
}
