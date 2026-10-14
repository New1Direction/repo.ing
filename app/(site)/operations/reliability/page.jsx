import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { operatorReliability } from '../../../lib/operator-reliability.mjs'
import styles from './reliability.module.css'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Operator reliability — repo.ing', robots: { index: false, follow: false } }
const labels = { ok: 'Observed OK', degraded: 'Needs attention', unknown: 'Unknown' }
const duration = ms => ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`
const stamp = value => value ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : 'Not observed'
const count = (value, capped = false) => value === undefined ? '—' : `${value}${capped ? '+' : ''}`
function Badge({ status }) { return <span className={`${styles.badge} ${styles[status]}`}>{labels[status] ?? status}</span> }
function Metric({ label, children }) { return <div><dt>{label}</dt><dd>{children}</dd></div> }
function Card({ title, result, children }) {
  return <section className={styles.card}><div className={styles.cardHeading}><h2>{title}</h2><Badge status={result.status}/></div>
    <p>{result.summary}</p>{children}<p className={styles.action}>{result.action}</p></section>
}

function ReliabilityDashboard({ data: d }) {
  const worker = d.worker, markets = d.markets, hooks = d.webhooks
  return <>
    <section className={styles.overview} aria-label="Snapshot status"><div><Badge status={d.status}/><p>Snapshot <time dateTime={d.generatedAt}>{stamp(d.generatedAt)}</time></p></div>
      <p>Read-only observations, not an uptime guarantee. Snapshots are shared for 30 seconds; reload to check again. No automatic polling.</p></section>
    <div className={styles.grid}>
      <Card title="Worker progress" result={worker}><dl className={styles.metrics}>
        <Metric label="Snapshot lag">{duration(worker.lagMs)}</Metric><Metric label="Recorded stages">{worker.stages?.length ?? '—'}</Metric>
      </dl><p className={styles.detail}>Heartbeat: {stamp(worker.capturedAt)}<br/>Process started: {stamp(worker.startedAt)}</p></Card>
      <Card title="Transparency & stale markets" result={markets}><dl className={styles.metrics}>
        <Metric label="Reports stale / missing">{count(markets.reportsStale)} / {count(markets.reportsMissing)}</Metric>
        <Metric label="Liquidity stale / missing">{count(markets.samplesStale)} / {count(markets.samplesMissing)}</Metric>
      </dl><p className={styles.detail}>{count(markets.sampled)} eligible markets inspected{markets.truncated ? ' · Coverage capped; unseen markets are unknown.' : '.'} Finalized, indexed SOL markets only.</p></Card>
      <Card title="Pending launches" result={d.pending}><dl className={styles.metrics}>
        <Metric label="Unresolved">{count(d.pending.count, d.pending.truncated)}</Metric><Metric label="Overdue in sample">{count(d.pending.overdue)}</Metric>
      </dl><p className={styles.detail}>Prepared, submitted or ambiguous · oldest {stamp(d.pending.oldestAt)}</p></Card>
      <Card title="Webhook deliveries" result={hooks}><dl className={styles.metrics}>
        <Metric label="Pending / sending">{count(hooks.pending, hooks.truncated)}</Metric><Metric label="Failed · created in 24h">{count(hooks.failed24h, hooks.failuresTruncated)}</Metric>
        <Metric label="Overdue in sample">{count(hooks.overdue)}</Metric><Metric label="Retrying in sample">{count(hooks.retrying)}</Metric>
      </dl></Card>
      <Card title="Database" result={d.database}><dl className={styles.metrics}><Metric label="Read probe latency">{duration(d.database.latencyMs)}</Metric></dl></Card>
      <Card title="Solana RPC" result={d.rpc}><dl className={styles.metrics}><Metric label="Probe latency">{duration(d.rpc.latencyMs)}</Metric><Metric label="Confirmed slot">{d.rpc.slot ?? '—'}</Metric></dl></Card>
    </div>
    <section className={styles.card}><h2>Stage runtimes & last success</h2>
      <p>Latest invocation per recorded stage, from the last reporting worker process. Success means a completed invocation with no recognized error or deferral; empty work can complete successfully. Not a fleet-wide SLA.</p>
      {worker.stages?.length ? <div className={styles.tableWrap} role="region" aria-label="Worker stage observations, scroll horizontally on narrow screens" tabIndex={0}>
        <table><caption>Latest stage observations</caption><thead><tr><th scope="col">Stage</th><th scope="col">Last state</th><th scope="col">Last runtime</th><th scope="col">Running for</th><th scope="col">Last success (this process)</th></tr></thead>
          <tbody>{worker.stages.map(s => <tr key={s.name}><th scope="row">{s.name}</th><td>{s.state}{s.slow && <strong className={styles.slow}> · Slow</strong>}</td><td>{duration(s.durationMs)}</td><td>{duration(s.elapsedMs)}</td><td>{stamp(s.lastSuccessAt)}</td></tr>)}</tbody></table>
      </div> : <p className={styles.action}>No stage evidence available. Disabled, uninstrumented and not-yet-run jobs are not presented as healthy.</p>}
      <p className={styles.detail}>Snapshot lag and thresholds apply even when a stage&apos;s last state says completed. Live trade subscriptions and jobs outside the runOnce wrapper are not covered.</p>
    </section>
    <div className={styles.grid}>
      <section className={styles.card}><h2>Deployment versions</h2><dl className={styles.versions}>
        <Metric label="Web commit"><code>{d.version ?? 'Not configured'}</code></Metric><Metric label="Worker commit"><code>{worker.version ?? 'Not observed'}</code></Metric>
      </dl>{d.version && worker.version && d.version !== worker.version && <p className={styles.action}>Versions differ. Check rollout progress before diagnosing incompatible behavior.</p>}
        <p className={styles.detail}>Commit metadata supplied by the deployment environment; not a release or migration verification.</p></section>
      <section className={styles.card}><h2>Active warning thresholds</h2><dl className={styles.thresholds}>
        <Metric label="Worker snapshot older than">{duration(d.thresholds.workerStaleMs)}</Metric><Metric label="Stage runtime over">{duration(d.thresholds.stageSlowMs)}</Metric>
        <Metric label="Report / liquidity age over">{duration(d.thresholds.reportStaleMs)} / {duration(d.thresholds.marketStaleMs)}</Metric>
        <Metric label="Pending age / webhook overdue over">{duration(d.thresholds.pendingStaleMs)}</Metric><Metric label="Dependency probe over">{duration(d.thresholds.dependencySlowMs)}</Metric>
      </dl><p className={styles.detail}>Any missing report/sample, failed recent delivery or retry raises attention. This dashboard does not send alerts. Threshold configuration and alert routing: <code>docs/OPERATOR_RELIABILITY.md</code>.</p></section>
    </div>
  </>
}

export default async function OperatorReliabilityPage() {
  let access = false
  try { requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value)); access = true } catch {}
  const data = access ? await operatorReliability() : null
  return <><AppHeader/><main className={`section-wrap ${styles.page}`}>
    <header className={styles.heading}><div><p className={styles.eyebrow}>Operator console / read only</p><h1>Reliability</h1><p>Worker progress, data freshness and dependency observations.</p></div>
      <nav aria-label="Operations"><Link href="/operations/health">Operations health</Link>{access && <a href="/api/operations/reliability">JSON snapshot</a>}</nav></header>
    {data ? <ReliabilityDashboard data={data}/> : <section className={styles.card}><h2>Operator access required</h2><p>Sign in with a GitHub account listed in PLATFORM_OPERATOR_GITHUB_IDS. Builder or repository access alone does not grant operator access.</p><Link className="button outline" href="/api/github/start?mode=builders">Verify with GitHub</Link><p>Return here after verification.</p></section>}
  </main><Footer/></>
}
