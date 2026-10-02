'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CopyAddress } from './copy-address'
import { formatSolDisplay } from '../lib/format.mjs'
import '../verification-bonus.css'

// Operator review of verification bonuses: what was earned and why, then Approve / Reject (with a reason the launcher
// sees) and, once payouts are on, Pay / Check status. The server re-checks every rule it can before acting.
const ENDPOINT = '/api/operations/verification-bonuses'
const DAY_MS = 86_400_000
const sol = value => value === null || value === undefined ? '—' : `${formatSolDisplay(value)} SOL`
const when = value => value ? `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '—'
const daysBetween = (from, to) => ((new Date(to).getTime() - new Date(from).getTime()) / DAY_MS).toFixed(1)
const short = value => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '—'
const explorer = signature => `https://explorer.solana.com/tx/${signature}`

function outcomeText(bonus, action, response) {
  const payout = response.payout
  if (action === 'reject') return `${bonus.fullName}: rejected.`
  if (payout?.status === 'waiting') return `${bonus.fullName}: approved. ${payout.reason}`
  if (payout?.status === 'settled') return `${bonus.fullName}: paid (${short(payout.signature)}).`
  if (payout?.status === 'pending') return `${bonus.fullName}: payout sent (${short(payout.signature)}); waiting for Solana finality.`
  if (payout?.status === 'aborted') return `${bonus.fullName}: the last attempt did not land (${payout.reason}). It can be paid again.`
  if (payout?.status === 'idle') return `${bonus.fullName}: no payout in flight.`
  return `${bonus.fullName}: ${action === 'approve' ? 'approved' : 'updated'}.`
}

function RepositoryCell({ bonus }) {
  const repo = bonus.evidence?.repository
  const age = repo?.createdAt ? `created ${daysBetween(repo.createdAt, bonus.activatedAt)} days before launch` : 'age not checked'
  return <td><a href={`https://github.com/${bonus.fullName}`} target="_blank" rel="noreferrer"><strong>{bonus.fullName}</strong> ↗</a>
    <small>{repo?.stars ?? '—'} stars when checked (now {bonus.currentStars}) · {age}</small>
    <small><Link href={`/token/${bonus.mint}`}>Market</Link> · repo {bonus.repoId} · {sol(bonus.amount)}</small></td>
}

function TimelineCell({ bonus }) {
  return <td>Launched {when(bonus.activatedAt)}
    <small>Verified by <a href={`https://github.com/${bonus.verifierLogin}`} target="_blank" rel="noreferrer">@{bonus.verifierLogin}</a> {daysBetween(bonus.activatedAt, bonus.verifiedAt)} days later</small></td>
}

function WalletsCell({ bonus }) {
  const selfLaunch = bonus.verifierLinkedToLauncher || bonus.repoPayoutWallet === bonus.launcherWallet
  const boundBy = bonus.repoPayoutBoundBy === bonus.verifierGithubUserId ? 'the verifier' : 'another admin'
  return <td><CopyAddress address={bonus.launcherWallet} compact label="launcher wallet"/>
    <small>Repo payout wallet: {bonus.repoPayoutWallet ? `${short(bonus.repoPayoutWallet)}, set by ${boundBy}` : 'not set yet'}</small>
    <span className="bonus-ops-flags">{selfLaunch && <span className="badge warn">Verifier is linked to the launcher wallet</span>}
      {!bonus.repoPayoutWallet && <span className="badge">Maintainer has no payout wallet yet</span>}</span></td>
}

function VolumeCell({ bonus }) {
  const volume = bonus.evidence?.volume ?? {}
  return <td>{sol(volume.other)}<small>by other wallets before verification</small>
    <small>Launcher {sol(volume.launcher)} · unattributed {sol(volume.unattributed)} · all-time curve {sol(bonus.curveVolume)}</small></td>
}

function PayoutState({ bonus, payoutsEnabled }) {
  if (bonus.payoutStatus === 'pending') return <small>Sending: <a href={explorer(bonus.payoutSignature)} target="_blank" rel="noopener noreferrer">{short(bonus.payoutSignature)} ↗</a></small>
  if (bonus.payoutStatus === 'aborted') return <small>Attempt {bonus.payoutAttempt} did not land: {bonus.payoutResolution}</small>
  return <small>{payoutsEnabled ? 'Ready to pay.' : 'Waiting: payouts are off.'}</small>
}

function Decision({ bonus, busy, payoutsEnabled, onAction }) {
  const [rejecting, setRejecting] = useState(false), [reason, setReason] = useState('')
  const formId = `bonus-reject-${bonus.repoId}`
  const pending = bonus.payoutStatus === 'pending'
  return <td><div className="bonus-ops-actions">
    {bonus.status === 'pending_review' && <button className="button primary" type="button" disabled={busy} onClick={() => onAction(bonus, 'approve')}>
      {payoutsEnabled ? `Approve and pay ${sol(bonus.amount)}` : 'Approve'}</button>}
    {bonus.status === 'approved' && !pending && payoutsEnabled && <button className="button primary" type="button" disabled={busy} onClick={() => onAction(bonus, 'pay')}>
      {bonus.payoutStatus === 'aborted' ? 'Pay again' : `Pay ${sol(bonus.amount)}`}</button>}
    {pending && <button className="button outline" type="button" disabled={busy} onClick={() => onAction(bonus, 'check')}>Check status</button>}
    {!pending && <button className="button outline" type="button" disabled={busy} aria-expanded={rejecting} aria-controls={formId}
      onClick={() => setRejecting(open => !open)}>Reject</button>}
  </div>
  {bonus.status === 'approved' && <PayoutState bonus={bonus} payoutsEnabled={payoutsEnabled}/>}
  {rejecting && !pending && <form id={formId} className="bonus-ops-reject" onSubmit={event => { event.preventDefault(); onAction(bonus, 'reject', reason) }}>
    <label htmlFor={`${formId}-reason`}>Reason (operators only; the launcher sees “not approved”)</label>
    <textarea id={`${formId}-reason`} value={reason} maxLength={300} onChange={event => setReason(event.target.value)}/>
    <button className="button outline" type="submit" disabled={busy || reason.trim().length < 3}>Confirm rejection</button>
  </form>}</td>
}

function ReviewTable({ title, id, rows, empty, busy, payoutsEnabled, onAction }) {
  return <section className="inner-card operations-markets" aria-labelledby={id}><h2 id={id}>{title} ({rows.length})</h2>
    {rows.length ? <div className="operations-table-wrap"><table><thead><tr><th>Repository</th><th>Launch and verification</th><th>Wallets</th><th>Curve volume</th><th>Decision</th></tr></thead>
      <tbody>{rows.map(bonus => <tr key={bonus.repoId} className="bonus-ops-row"><RepositoryCell bonus={bonus}/><TimelineCell bonus={bonus}/>
        <WalletsCell bonus={bonus}/><VolumeCell bonus={bonus}/><Decision bonus={bonus} busy={busy} payoutsEnabled={payoutsEnabled} onAction={onAction}/></tr>)}</tbody>
    </table></div> : <p>{empty}</p>}</section>
}

const statusBadge = { paid: ['ok', 'Paid'], rejected: ['warn', 'Rejected'], ineligible: ['warn', 'Ineligible'] }

function Decided({ rows }) {
  return <section className="inner-card operations-markets" aria-labelledby="bonus-decided-heading"><h2 id="bonus-decided-heading">Decided ({rows.length})</h2>
    {rows.length ? <div className="operations-table-wrap"><table><thead><tr><th>Repository</th><th>Status</th><th>Detail</th><th>When</th></tr></thead><tbody>
      {rows.map(bonus => { const [tone, label] = statusBadge[bonus.status] ?? ['', bonus.status]
        return <tr key={bonus.repoId}><td><a href={`https://github.com/${bonus.fullName}`} target="_blank" rel="noreferrer">{bonus.fullName} ↗</a><small>Launcher {short(bonus.launcherWallet)} · verifier @{bonus.verifierLogin}</small></td>
          <td><span className={`badge ${tone}`}>{label}</span><small>{sol(bonus.amount)}</small></td>
          <td>{bonus.status === 'paid' ? <><a href={explorer(bonus.payoutSignature)} target="_blank" rel="noopener noreferrer">Receipt {short(bonus.payoutSignature)} ↗</a><small>Network fee {sol(bonus.payoutNetworkFee)}</small></> : bonus.reason}
            {bonus.approverLogin && bonus.status === 'rejected' && <small>Approved by @{bonus.approverLogin} {when(bonus.approvedAt)}</small>}
            {bonus.reviewerLogin && <small>{bonus.status === 'rejected' ? 'Rejected' : 'Reviewed'} by @{bonus.reviewerLogin}</small>}</td>
          <td>{when(bonus.paidAt ?? bonus.reviewedAt ?? bonus.createdAt)}</td></tr> })}
    </tbody></table></div> : <p>No decided bonuses yet.</p>}</section>
}

// What one more bonus may spend: balance minus in-flight payouts, revenue held for other uses and the reserve.
function spendable(payer, policy) {
  if (!payer?.balance || policy.reserveLamports === null) return null
  const left = BigInt(payer.balance) - BigInt(payer.pendingLamports) - BigInt(payer.unallocatedLamports) -
    BigInt(payer.liquidityLamports) - BigInt(policy.reserveLamports)
  return left > 0n ? left.toString() : '0'
}

function Policy({ policy, payer, checking }) {
  const enrollment = policy.enrollmentLamports ? sol(policy.enrollmentLamports) : 'Not enrolling'
  const signer = payer?.address ? payer : null
  return <section className="inner-card operations-markets" aria-labelledby="bonus-policy-heading"><h2 id="bonus-policy-heading">Policy and payer</h2>
    <div className="operations-summary">
      <div className="inner-card"><span>New launches stamped with</span><strong>{enrollment}</strong></div>
      <div className={`inner-card${policy.payoutsEnabled ? '' : ' health-warn'}`}><span>Payouts</span><strong>{policy.payoutsEnabled ? 'On' : 'Off (approved bonuses wait)'}</strong></div>
      <div className="inner-card"><span>Rolling 30-day cap used</span><strong>{sol(policy.committedLamports)} of {sol(policy.capLamports)}</strong></div>
      <div className="inner-card"><span>Payer can spend on bonuses</span><strong>{signer ? sol(spendable(signer, policy)) : '—'}</strong>
        <small className="bonus-ops-note">{signer?.balance ? `of ${sol(signer.balance)} held` : 'Balance unavailable'}</small></div>
    </div>
    {signer && <p className="bonus-ops-policy"><span>Payer <CopyAddress address={signer.address} compact label="payer wallet"/></span>
      <span>In flight <strong>{sol(signer.pendingLamports)}</strong></span><span>Unallocated revenue <strong>{sol(signer.unallocatedLamports)}</strong></span>
      <span>Liquidity share not deployed <strong>{sol(signer.liquidityLamports)}</strong></span><span>Reserve <strong>{sol(policy.reserveLamports)}</strong></span></p>}
    {signer && <p className="muted">Bonuses are paid from the treasury share. Payouts refuse to spend in-flight payouts, unallocated revenue, the undeployed liquidity share or the reserve. The buyback share is not tracked here: confirm the platform sweep moved it to custody before paying.</p>}
    {[policy.enrollmentError, policy.configError, payer?.error].filter(Boolean).map(text => <p key={text} className="inline-error" role="alert">{text}</p>)}
    {!payer && <p className="muted">PLATFORM_PARTNER_SECRET_KEY is not configured on this server, so bonuses cannot be paid from here.</p>}
    {checking.length > 0 && <p className="muted">Being checked: {checking.map(item => `${item.fullName} (verified ${when(item.verifiedAt)})`).join(' · ')}. The worker decides each about 10 minutes after the first verification.</p>}
  </section>
}

export function VerificationBonusOperations() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  async function refresh() {
    try {
      const response = await fetch(ENDPOINT, { cache: 'no-store', signal: AbortSignal.timeout(60_000) })
      const value = await response.json()
      if (!response.ok) throw Error(value.error)
      setData(value)
    } catch (cause) { setError(cause.message || 'Verification bonuses are unavailable.') }
  }
  useEffect(() => { void refresh() }, [])
  async function act(bonus, action, reason) {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: bonus.repoId, action, reason, amount: bonus.amount, wallet: bonus.launcherWallet }) })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw Error(value.error || 'Request failed')
      setNotice(outcomeText(bonus, action, value))
      await refresh()
    } catch (cause) { setError(`${bonus.fullName}: ${cause.message}`) }
    finally { setBusy(false) }
  }
  const bonuses = data?.bonuses ?? [], payoutsEnabled = Boolean(data?.policy.payoutsEnabled)
  return <>
    <div className="operations-toolbar"><span>{data ? `Checked ${new Date(data.checkedAt).toLocaleTimeString()}` : 'Loading bonuses…'}</span>
      <button className="button outline" type="button" onClick={() => { setError(''); void refresh() }} disabled={busy}>Refresh</button></div>
    <div aria-live="polite">{notice && <p className="bonus-ops-result" role="status">{notice}</p>}{error && <p className="inline-error" role="alert">{error}</p>}</div>
    {data && <>
      <Policy policy={data.policy} payer={data.payer} checking={data.checking}/>
      <ReviewTable title="Waiting for review" id="bonus-pending-heading" rows={bonuses.filter(b => b.status === 'pending_review')} busy={busy}
        payoutsEnabled={payoutsEnabled} onAction={act} empty="No bonuses are waiting for review."/>
      <ReviewTable title="Approved" id="bonus-approved-heading" rows={bonuses.filter(b => b.status === 'approved')} busy={busy}
        payoutsEnabled={payoutsEnabled} onAction={act} empty="No approved bonuses are waiting to be paid."/>
      <Decided rows={bonuses.filter(b => !['pending_review', 'approved'].includes(b.status))}/>
      <p className="muted">Rules (each failure is recorded as ineligible): first maintainer verification within 30 days of launch, repository created 30+ days before launch with 10+ stars, 1+ SOL of curve volume from wallets other than the launcher before the verification, and no wallet link between the verifier and the launcher. Approval and payment re-check the wallet link. See docs/VERIFICATION_BONUS.md.</p>
    </>}
  </>
}
