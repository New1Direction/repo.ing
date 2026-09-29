import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { CopyAddress } from '../../../components/copy-address'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { operationsHealth } from '../../../lib/operations-health.mjs'
import { formatSolDisplay } from '../../../lib/format.mjs'
import { tokenBalanceLabel } from '../../../lib/token-balance.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Operations health — repo.ing', robots: { index: false, follow: false } }

const sol = value => value === null || value === undefined ? '—' : `${formatSolDisplay(value)} SOL`
const age = ms => { const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24); return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m` }
const when = value => `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC`
const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—'
const monitorNote = { match: 'Worker alert watches this address', different: 'Worker alert watches a different address', unset: 'Worker alert not configured' }
const alertTitles = { OPS_WALLET_LOW: 'Operating wallet needs SOL', FEE_EVIDENCE_QUARANTINED: 'Trade fee evidence needs review', RESERVE_MOVED: 'Reserve moved', RECONCILIATION_MISMATCH: 'Reconciliation needs review', GRADUATION_REVIEW: 'Graduation evidence needs review', LAUNCH_EXPIRED: 'Expired launch released for retry', TRADE_VERIFICATION_FAILED: 'Trade verification failed' }

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

function Csp({ result }) {
  return <Section title="CSP report-only" result={result}>{c => <>{c.total ? <div className="operations-table-wrap"><table><thead><tr><th>Blocked host</th><th>Reports</th></tr></thead><tbody>
    {c.hosts.map(h => <tr key={h.key}><td>{h.key}</td><td>{h.count}</td></tr>)}
  </tbody></table></div> : <p>No reports received.</p>}<p className="muted">{c.total} reports since last web restart ({when(c.since)}), this web process only. Top directives: {c.directives.map(d => `${d.key} (${d.count})`).join(', ') || 'none'}.</p></>}</Section>
}

export default async function OperationsHealthPage() {
  let access = false
  try { requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value)); access = true } catch {}
  const health = access ? await operationsHealth() : null
  return <><AppHeader /><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Operations health</h1><p>Read-only status across wallets, launches, alerts, revenue, migrations, and CSP.</p></div></div>
    {health ? <><Wallets result={health.wallets}/><Launches result={health.launches}/><Alerts result={health.alerts}/><Revenue result={health.revenue}/><Migrations result={health.migrations}/><Csp result={health.csp}/>
      <p className="muted health-footer">Generated {when(health.generatedAt)} · <Link href="/operations/fees">Platform fees</Link> · <Link href="/operations/graduation">Graduation</Link> · <Link href="/operations/trends">Trends</Link> · <Link href="/operations/invites">Invites</Link></p></>
      : <div className="inner-card"><h2>Operator access required</h2><p>Sign in with the configured operator GitHub account.</p><Link className="button outline" href="/api/github/start?mode=builders">Verify with GitHub</Link><p>Return here after verification.</p></div>}
  </main><Footer /></>
}
