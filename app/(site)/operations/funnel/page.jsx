import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { database } from '../../../lib/server.mjs'
import { formatSolDisplay } from '../../../lib/format.mjs'
import { FUNNEL_SOURCES, funnelSummary } from '../../../lib/claim-funnel.mjs'
import { FUNNEL_RETENTION_DAYS, funnelStore } from '../../../../src/funnel-store.mjs'
import { GUIDE_SOURCES, GUIDE_STEPS, guideSummary } from '../../../lib/launch-guide-funnel.mjs'
import { GUIDE_EVENT_RETENTION_DAYS, guideEvents } from '../../../../src/launch-guide-events.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Claim funnel — repo.ing', robots: { index: false, follow: false } }

const WINDOWS = [['day', '24 h'], ['week', '7 d'], ['month', '30 d']]
const EVENTS = [
  ['waiting_view', 'Waiting board views'], ['owner_lookup:found', 'Owner lookups with markets'], ['owner_lookup:none', 'Owner lookups with none'],
  ['claim_view', 'Claim page views'], ['app_access_required', 'Sent to GitHub App access'], ['verify_start', 'GitHub verification started'],
  ['verify_result:verified', 'Verified as admin'], ['verify_result:not-admin', 'Signed in, not an admin'], ['verify_result:cancelled', 'Cancelled on GitHub'],
  ['verify_result:failed', 'Verification failed'], ['builders_view', 'Dashboard views'], ['builders_connect', 'Dashboard GitHub connects'],
  ['builders_result:verified', 'Dashboard connected'], ['builders_result:cancelled', 'Dashboard cancelled'], ['builders_result:failed', 'Dashboard failed'],
]
const LEDGER = [['earning', 'Repositories that earned builder fees'], ['verified', 'A GitHub admin verified'], ['wallet', 'Payout wallet set'],
  ['paid', 'Paid at least once'], ['waiting', 'Still waiting for a maintainer']]
// Guided launch (docs/LAUNCH_GUIDE.md#measurement): page and step views, GitHub sign-in, selection, preflight and publish outcomes.
const GUIDE_ROWS = [
  ['guide_view', 'Guide views'], ['github_connect', 'GitHub sign-ins started'], ['github_result:verified', 'Signed in'], ['github_result:cancelled', 'Sign-in cancelled'],
  ['github_result:failed', 'Sign-in failed'], ['repo_selected:admin', 'Repository selected (admin)'], ['repo_selected:not-admin', 'Selected, not an admin'],
  ['repo_selected:no-access', 'Selected, App has no access'], ['draft_resumed', 'Draft resumed'], ['preflight_run:ready', 'Preflights ready'],
  ['preflight_run:needs-action', 'Preflights needing action'], ['preflight_run:blocked', 'Preflights blocked'], ['preflight_run:unavailable', 'Preflights unavailable'],
  ['publish:scheduled', 'Published schedules'], ['publish:refused', 'Publishes refused'], ['publish:failed', 'Publishes failed'], ['draft_discarded', 'Drafts discarded'],
]
const STEP_NAMES = { github: 'GitHub', repository: 'Repository', preflight: 'Preflight', plan: 'Plan', disclose: 'Disclose', preview: 'Preview', publish: 'Publish' }
const percent = (part, whole) => whole > 0 ? `${Math.round(part / whole * 100)}%` : '—'

// Operator-only: the maintainer claim funnel. Stages from the ledgers (earned → verified → wallet → paid), and page and
// GitHub sign-in events by source (app/lib/claim-funnel.mjs) for the last 24 hours, 7 and 30 days.
export default async function OperationsFunnelPage() {
  let access = false
  try { requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value)); access = true } catch {}
  let ledger = null, events = null, error = null, guide = null
  if (access) {
    try {
      const store = funnelStore(database())
      const [ledgerRows, eventRows] = await Promise.all([store.ledger(), store.summary()])
      ledger = ledgerRows; events = funnelSummary(eventRows)
    } catch { error = 'The claim funnel is temporarily unavailable.' }
    // Before migration 0073 the guided launch section says so instead of failing the page.
    try { guide = guideSummary(await guideEvents(database()).summary()) } catch { guide = null }
  }
  return <><AppHeader /><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Claim funnel</h1><p>How maintainers find, verify and claim the builder fees their repositories earn, and how they launch with the guided launch.</p></div></div>
    {!access ? <div className="inner-card"><h2>Operator access required</h2><p>Sign in with the configured operator GitHub account.</p><Link className="button outline" href="/api/github/start?mode=builders">Verify with GitHub</Link><p>Return here after verification.</p></div>
      : error ? <p className="inline-error" role="status">{error}</p> : <>
        <section className="inner-card operations-markets"><h2>Ledger funnel</h2>
          <div className="operations-table-wrap"><table><thead><tr><th>Stage</th><th>Outside builders</th><th>Team repos</th></tr></thead>
            <tbody>{LEDGER.map(([key, label]) => <tr key={key}><td>{label}</td>{['outside', 'team'].map(side => <td key={side}><strong>{ledger[side][key]}</strong>{key !== 'earning' && <small>{percent(ledger[side][key], ledger[side].earning)}</small>}</td>)}</tr>)}
              <tr><td>SOL earned</td>{['outside', 'team'].map(side => <td key={side}>{formatSolDisplay(ledger[side].earnedLamports)} SOL</td>)}</tr>
              <tr><td>SOL paid</td>{['outside', 'team'].map(side => <td key={side}>{formatSolDisplay(ledger[side].paidLamports)} SOL<small>{percent(Number(BigInt(ledger[side].paidLamports) / 1_000_000n), Number(BigInt(ledger[side].earnedLamports) / 1_000_000n))}</small></td>)}</tr>
              <tr><td>SOL waiting for a maintainer</td>{['outside', 'team'].map(side => <td key={side}><strong>{formatSolDisplay(ledger[side].waitingLamports)} SOL</strong></td>)}</tr></tbody></table></div>
          <p className="muted">Canonical GitHub markets that earned builder fees (indexed credits). Verified: an admin verification is recorded. Waiting: no verification and no payout wallet, as on /waiting. Team repos are split out exactly as on /stats.</p>
        </section>
        <section className="inner-card operations-markets"><h2>Events</h2>
          <div className="operations-table-wrap"><table><thead><tr><th>Event</th>{WINDOWS.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
            <tbody>{EVENTS.map(([key, label]) => <tr key={key}><td>{label}</td>{WINDOWS.map(([window]) => <td key={window}>{events.count(key, window)}</td>)}</tr>)}</tbody></table></div>
        </section>
        <section className="inner-card operations-markets"><h2>By source, last 30 days</h2>
          {events.sources.length === 0 ? <p>No claim page visits or verifications yet.</p> :
            <div className="operations-table-wrap"><table><thead><tr><th>Source</th><th>Claim page views</th><th>Verification started</th><th>Verified as admin</th><th>Views → verified</th></tr></thead>
              <tbody>{events.sources.map(row => <tr key={row.source}><td>{FUNNEL_SOURCES[row.source] ?? 'Direct or unknown'}</td><td>{row.views.month}</td><td>{row.starts.month}</td><td>{row.verified.month}</td><td>{percent(row.verified.month, row.views.month)}</td></tr>)}</tbody></table></div>}
          <p className="muted">Sources come from <code>?src=</code> on claim links (waiting board, X posts, GitHub issue invites, shared invitations, token pages, the dashboard, the owner lookup, links a non-admin copies for an admin) and travel through GitHub sign-in. Events store only the event, source, outcome and public repository id: no login, wallet, cookie, URL or IP. Events older than {FUNNEL_RETENTION_DAYS} days are deleted.</p>
        </section></>}
    {access && <section className="inner-card operations-markets"><h2>Guided launch</h2>
      {!guide ? <p className="muted">Guided launch events are temporarily unavailable.</p> : <>
        <div className="operations-table-wrap"><table><thead><tr><th>Event</th>{WINDOWS.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
          <tbody>{GUIDE_ROWS.map(([key, label]) => <tr key={key}><td>{label}</td>{WINDOWS.map(([window]) => <td key={window}>{guide.count(key, window)}</td>)}</tr>)}</tbody></table></div>
        <div className="operations-table-wrap"><table><thead><tr><th>Step shown, 30 days</th><th>Views</th><th>Of guide views</th></tr></thead>
          <tbody>{GUIDE_STEPS.map(step => <tr key={step}><td>{STEP_NAMES[step]}</td><td>{guide.step(step)}</td><td>{percent(guide.step(step), guide.count('guide_view'))}</td></tr>)}</tbody></table></div>
        {guide.sources.length > 0 && <div className="operations-table-wrap"><table><thead><tr><th>Source</th><th>Guide views</th><th>Preflights</th><th>Published</th><th>Views → published</th></tr></thead>
          <tbody>{guide.sources.map(row => <tr key={row.source}><td>{GUIDE_SOURCES[row.source] ?? 'Direct or unknown'}</td><td>{row.views.month}</td><td>{row.preflights.month}</td><td>{row.published.month}</td><td>{percent(row.published.month, row.views.month)}</td></tr>)}</tbody></table></div>}
        <p className="muted">Sources come from <code>?src=</code> on links into /launches/new. Events store only the event, step, source, outcome and public repository id: no login, GitHub id, wallet, cookie, URL or IP. Browsers sending Global Privacy Control or Do Not Track send nothing. Events older than {GUIDE_EVENT_RETENTION_DAYS} days are deleted.</p>
      </>}</section>}
    <p className="muted health-footer"><Link href="/operations/health">Operations health</Link> · <Link href="/operations/invites">Invites</Link></p>
  </main><Footer /></>
}
