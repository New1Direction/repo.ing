import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { database } from '../../../lib/server.mjs'
import { formatSolDisplay } from '../../../lib/format.mjs'
import { FUNNEL_SOURCES, funnelSummary } from '../../../lib/claim-funnel.mjs'
import { FUNNEL_RETENTION_DAYS, funnelStore } from '../../../../src/funnel-store.mjs'
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
const percent = (part, whole) => whole > 0 ? `${Math.round(part / whole * 100)}%` : '—'

// Operator-only: the maintainer claim funnel. Stages from the ledgers (earned → verified → wallet → paid), and page and
// GitHub sign-in events by source (app/lib/claim-funnel.mjs) for the last 24 hours, 7 and 30 days.
export default async function OperationsFunnelPage() {
  let access = false
  try { requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value)); access = true } catch {}
  let ledger = null, events = null, error = null
  if (access) {
    try {
      const store = funnelStore(database())
      const [ledgerRows, eventRows] = await Promise.all([store.ledger(), store.summary()])
      ledger = ledgerRows; events = funnelSummary(eventRows)
    } catch { error = 'The claim funnel is temporarily unavailable.' }
  }
  return <><AppHeader /><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Claim funnel</h1><p>How maintainers find, verify and claim the builder fees their repositories earn.</p></div></div>
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
    <p className="muted health-footer"><Link href="/operations/health">Operations health</Link> · <Link href="/operations/invites">Invites</Link></p>
  </main><Footer /></>
}
