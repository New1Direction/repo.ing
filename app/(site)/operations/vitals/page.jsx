import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { database } from '../../../lib/server.mjs'
import { VITALS_SAMPLE_RATE, VITAL_METRICS, VITAL_THRESHOLDS, vitalsSummary } from '../../../lib/web-vitals.mjs'
import { VITALS_RETENTION_DAYS, createVitalsStore } from '../../../../src/web-vitals-store.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Web vitals — repo.ing', robots: { index: false, follow: false } }

const DEVICES = { all: 'All devices', mobile: 'Mobile', desktop: 'Desktop' }
// LCP, FCP and TTFB read best in seconds, INP in milliseconds; CLS is unitless.
const inSeconds = metric => ['LCP', 'FCP', 'TTFB'].includes(metric)
const value = (metric, number) => metric === 'CLS' ? number.toFixed(3) : inSeconds(metric) ? `${(number / 1000).toFixed(2)} s` : `${Math.round(number)} ms`
const threshold = metric => VITAL_THRESHOLDS[metric].map(n => inSeconds(metric) ? n / 1000 : n).join(' / ') + (metric === 'CLS' ? '' : inSeconds(metric) ? ' s' : ' ms')
const ratingLabel = { good: 'good', 'needs-improvement': 'needs work', poor: 'poor' }

function Cell({ metric, stats }) {
  if (!stats || stats.p75 === null) return <td>—<small>n=0</small></td>
  return <td><strong>{value(metric, stats.p75)}</strong> <span className={`badge ${stats.rating === 'good' ? 'ok' : 'warn'}`}>{ratingLabel[stats.rating]}</span><small>n={stats.samples}</small></td>
}

// Operator-only: p75 of real-user Core Web Vitals per route (route patterns only), last 24 h and last 7 days.
export default async function OperationsVitalsPage({ searchParams }) {
  let access = false
  try { requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value)); access = true } catch {}
  const { device: requested } = await searchParams
  const device = Object.hasOwn(DEVICES, requested) && requested !== 'all' ? requested : null
  let routes = null, error = null
  if (access) {
    try { routes = vitalsSummary(await createVitalsStore(database()).summary({ device })) }
    catch { error = 'Web vitals are temporarily unavailable.' }
  }
  return <><AppHeader /><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Web vitals</h1><p>75th percentile of what real visitors experienced, per route: last 24 hours and last 7 days.</p></div></div>
    {!access ? <div className="inner-card"><h2>Operator access required</h2><p>Sign in with the configured operator GitHub account.</p><Link className="button outline" href="/api/github/start?mode=builders">Verify with GitHub</Link><p>Return here after verification.</p></div>
      : <section className="inner-card operations-markets"><h2>p75 by route</h2>
        <p className="muted">{Object.entries(DEVICES).map(([key, label], index) => <span key={key}>{index > 0 && ' · '}{(device ?? 'all') === key ? <strong>{label}</strong> : <Link href={key === 'all' ? '/operations/vitals' : `/operations/vitals?device=${key}`}>{label}</Link>}</span>)}</p>
        {error ? <p className="inline-error" role="status">{error}</p> : routes.length === 0 ? <p>No samples yet. About {Math.round(VITALS_SAMPLE_RATE * 100)}% of page views report once the page is hidden.</p>
          : <div className="operations-table-wrap"><table><thead><tr><th>Route</th>{VITAL_METRICS.map(metric => <th key={metric} colSpan={2}>{metric}<small>good / poor at {threshold(metric)}</small></th>)}</tr>
            <tr><th/>{VITAL_METRICS.map(metric => [<th key={`${metric}-day`}>24 h</th>, <th key={`${metric}-week`}>7 d</th>])}</tr></thead>
            <tbody>{routes.map(row => <tr key={row.route}><td><code>{row.route}</code></td>{VITAL_METRICS.map(metric => [<Cell key={`${metric}-day`} metric={metric} stats={row.metrics[metric]?.day}/>, <Cell key={`${metric}-week`} metric={metric} stats={row.metrics[metric]?.week}/>])}</tr>)}</tbody></table></div>}
        <p className="muted">Sampled from about {Math.round(VITALS_SAMPLE_RATE * 100)}% of page loads (Next.js useReportWebVitals), sent once when the page is hidden. Routes are patterns, not URLs; devices are a mobile/desktop User-Agent heuristic. CLS and INP of a visit are attributed to the route it landed on. Samples older than {VITALS_RETENTION_DAYS} days are deleted.</p>
      </section>}
    <p className="muted health-footer"><Link href="/operations/health">Operations health</Link></p>
  </main><Footer /></>
}
