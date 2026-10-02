'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { ClipboardCheck, Clock, ShieldCheck, TriangleAlert } from 'lucide-react'
import { CopyAddress } from './copy-address'
import { CONFIRM_CHARACTERS, PASTED_ADDRESS_HOLD_HOURS, PAYOUT_ADDRESS_WARNING, bindingLabel, confirmsAddress, formatHoldRemaining,
  formatUtcDateTime, holdRemainingMs, looksLikeSolanaAddress, normalizeAddressInput, pendingLabel } from '../../src/payout-address-policy.mjs'
import styles from './payout-address.module.css'

// Presentation and requests only. /api/payout-address re-checks the GitHub session, current admin permission, the
// address and the chain; a pasted address can receive payouts only after its hold (src/payout-address.mjs).
async function postPayoutAddress(body) {
  const response = await fetch('/api/payout-address', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'The payout address could not be saved. Refresh and try again.')
  return result
}

// Null until mounted, so the server render and hydration agree; then ticks.
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(null)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function HoldCountdown({ activeAt, onElapsed }) {
  const now = useNow()
  const remaining = now === null ? null : holdRemainingMs(activeAt, now)
  const elapsed = remaining === 0, fired = useRef(false)
  useEffect(() => {
    if (elapsed && !fired.current) { fired.current = true; onElapsed?.() }
  }, [elapsed, onElapsed])
  if (remaining === null) return null
  return <span className={styles.countdown}>{remaining > 0 ? `${formatHoldRemaining(remaining)} left` : 'activating'}</span>
}

// The repository's payout destination: the active binding and how it was set, and a pasted address waiting out its hold
// (with cancel for a verified admin).
export function PayoutDestination({ repoId, active, pending, canManage = false, onChanged, compact = false }) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (!active && !pending) return null
  async function cancel() {
    if (busy) return
    setBusy(true); setError('')
    try {
      await postPayoutAddress({ action: 'cancel', repoId, requestId: pending.id })
      setConfirming(false)
      onChanged?.('cancelled')
    } catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }
  return <div className={`${styles.destination} ${compact ? styles.compact : ''}`}>
    {active && <div className={styles.active}>
      {!compact && <span className={styles.label}>Payout address</span>}
      <CopyAddress address={active.wallet} compact={compact} label="payout address"/>
      <span className={`${styles.method} ${active.method === 'pasted' ? styles.pastedActive : styles.signed}`}>
        {active.method === 'pasted' ? <ClipboardCheck size={13} aria-hidden="true"/> : <ShieldCheck size={13} aria-hidden="true"/>}{bindingLabel(active)}</span>
    </div>}
    {pending && <div className={styles.pending}>
      <p className={styles.pendingTitle}><Clock size={15} aria-hidden="true"/>
        <span><strong>{active ? 'Pending change: ' : ''}{pendingLabel(pending)}</strong>
          {canManage && !confirming && <> <span className={styles.nowrap}>(<button type="button" className={styles.inlineButton} disabled={busy} onClick={() => setConfirming(true)}>cancel</button>)</span></>}</span></p>
      <CopyAddress address={pending.wallet} compact={compact} label="pending payout address"/>
      <p className={styles.pendingNote}>{active ? 'Until then, payouts keep going to the current address.' : 'Claims open when it becomes active.'}
        <HoldCountdown activeAt={pending.activeAt} onElapsed={() => onChanged?.('elapsed')}/></p>
      {canManage && pending.requestedByLogin && <small className={styles.requested}>Pasted by {pending.requestedByLogin} on {formatUtcDateTime(pending.requestedAt)}. Any admin of this repository can cancel it until then.</small>}
      {confirming && <div className={styles.confirmCancel}>
        <p>Cancel this pasted address? {active ? 'Payouts stay with the current address.' : 'Claims stay closed until a payout address is set.'}</p>
        <button type="button" className="button outline" disabled={busy} onClick={cancel}>{busy ? 'Cancelling…' : 'Yes, cancel it'}</button>
        <button type="button" className="claim-text-button" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
      </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>}
  </div>
}

// Paste an address for one repository (claim page, a Builders row) or, on the dashboard, for every repository without one.
export function PasteAddressForm({ repoIds, replacing = false, onSaved, onClose }) {
  const id = useId()
  const [address, setAddress] = useState(''), [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const batch = repoIds.length > 1
  const value = normalizeAddressInput(address), typed = normalizeAddressInput(confirm)
  const shapeOk = looksLikeSolanaAddress(value)
  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setError('')
    if (!shapeOk) { setError('That does not look like a Solana address. Copy it again from your wallet app.'); return }
    if (!confirmsAddress(value, typed)) {
      setError(`The last ${CONFIRM_CHARACTERS} characters do not match the address. Check them in your wallet app (capital letters matter).`); return
    }
    setBusy(true)
    try {
      const result = await postPayoutAddress(batch ? { action: 'paste-batch', repoIds, address: value, confirm: typed }
        : { action: 'paste', repoId: repoIds[0], address: value, confirm: typed })
      setAddress(''); setConfirm('')
      onSaved?.(result)
    } catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }
  const scope = batch ? 'each repository' : 'this repository'
  const until = replacing ? 'Your current payout address keeps receiving claims until then.' : 'Claims open then.'
  return <form className={styles.form} onSubmit={submit} aria-busy={busy} noValidate>
    <div>
      <h3 className={styles.formTitle}>{batch ? `Paste one payout address for ${repoIds.length} repositories` : replacing ? 'Paste a new payout address' : 'Paste a payout address'}</h3>
    </div>
    <p className={styles.formIntro}>No wallet extension needed: copy your SOL receiving address from any Solana wallet app.</p>
    <div className={styles.field}>
      <label htmlFor={`${id}-address`}>Solana payout address</label>
      <input id={`${id}-address`} name="payout-address" value={address} onChange={event => setAddress(event.target.value)} disabled={busy}
        autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={64} inputMode="text"
        aria-invalid={Boolean(value) && !shapeOk} aria-describedby={`${id}-warning`}/>
    </div>
    <p id={`${id}-warning`} className={styles.warning}><TriangleAlert size={16} aria-hidden="true"/>{PAYOUT_ADDRESS_WARNING}</p>
    <div className={styles.field}>
      <label htmlFor={`${id}-confirm`}>Last {CONFIRM_CHARACTERS} characters, typed from your wallet app</label>
      <input id={`${id}-confirm`} name="payout-address-confirm" className={styles.confirmInput} value={confirm} disabled={busy}
        onChange={event => setConfirm(event.target.value)} maxLength={CONFIRM_CHARACTERS} autoComplete="off" autoCapitalize="off"
        autoCorrect="off" spellCheck={false} aria-describedby={`${id}-confirm-hint`}/>
      <small id={`${id}-confirm-hint`}>Read them in your wallet, not in the box above, so a wrong paste is caught.</small>
    </div>
    <p className={styles.holdNote}><Clock size={15} aria-hidden="true"/>
      <span>A pasted address waits {PASTED_ADDRESS_HOLD_HOURS} hours before it can receive payouts. {until} Any admin of {scope} can cancel it during the wait, and signing with a wallet replaces it at once.</span></p>
    <div className={styles.actions}>
      <button type="submit" className="button primary" disabled={busy || !shapeOk || typed.length !== CONFIRM_CHARACTERS}>
        {busy ? 'Checking and saving…' : batch ? `Save for ${repoIds.length} repositories` : 'Save pasted address'}</button>
      {onClose && <button type="button" className="claim-text-button" disabled={busy} onClick={onClose}>Close</button>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </form>
}

export const pasteSavedMessage = result => result?.pending?.activeAt || result?.activeAt
  ? `Saved. The pasted address can receive payouts from ${formatUtcDateTime(result.pending?.activeAt ?? result.activeAt)}, after the ${PASTED_ADDRESS_HOLD_HOURS}-hour hold.`
  : 'Saved.'
