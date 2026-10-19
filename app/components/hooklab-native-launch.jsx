'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronDown } from 'lucide-react'
import { useWallet } from './wallet'
import { HookWalletSignIn, shortAddress, useHookWalletSession } from './hooklab-wallet-signin'
import { formatUnits } from '../lib/format.mjs'
import { lockedLaunchFields, reservationInput } from '../lib/hooklab-native-launch-form.mjs'

const endpoint = '/api/hook-lab/native-launch'
const storageKey = 'repo.ing.hooks.native-launch.ids.v1'
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const pendingStatuses = new Set(['submission-claimed', 'outcome-unknown', 'submitted'])
const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const encode = bytes => btoa(String.fromCharCode(...bytes))
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
const statusLabels = {
  reviewed: 'Ready for your review', partial: 'Wallet signed; additional signatures needed', signed: 'All signatures retained; ready to submit',
  'signing-claimed': 'Waiting for the repo.ing approval signature. Keep this page open.', 'signing-unknown': 'The approval signature did not arrive before the transaction deadline. Nothing was sent. Once the deadline has passed, close this attempt and start a fresh review.',
  expired: 'This attempt expired before every signature arrived. Nothing was sent. Start a fresh review to try again.',
  'submission-claimed': 'Submission in progress', submitted: 'Submitted; awaiting finalized confirmation', 'outcome-unknown': 'Transaction outcome is unknown; checking the original signature',
  'finalized-success': 'Confirmed and finalized', 'finalized-failure': 'Finalized with a failure. Do not start a replacement until the retained operation is reviewed.',
  'review-required': 'Conflicting evidence requires operator review. Signing and submission are stopped.',
}
const sol = lamports => `${formatUnits(lamports, 9)} SOL`
// Owner-approved creators see the same states in plain words (the operator view keeps the exact wording above).
const guidedStatus = {
  ...statusLabels, reviewed: 'Check the amount below, then sign in your wallet.', partial: 'Your wallet signed. repo.ing adds the remaining signature next.',
  signed: 'All signatures are in. Send it to Solana to finish this step.', 'submission-claimed': 'Sending to Solana…',
  submitted: 'Sent. Waiting for Solana to confirm it.', 'outcome-unknown': 'Checking whether it landed. Don’t sign again.',
}
const guidedStage = { preparation: { title: 'Preparation', step: 'Signature 1 of 2', about: 'Creates your coin and its accounts on Solana.', done: 'Preparation is confirmed. One more signature to go.' },
  launch: { title: 'Launch', step: 'Signature 2 of 2', about: 'Opens trading with your wallet cap and creator fee. repo.ing co-signs this step.', done: 'Your coin is live.' } }
const OPERATOR_LABELS = { sign: stage => `Sign ${stage} in wallet`, accept: 'I reviewed this exact transaction, fees, debit limit and wallet cap.', cosign: 'Complete next server signature',
  submit: stage => `Submit signed ${stage} transaction once`, refreshReview: 'Refresh unsigned review', expire: 'Close expired attempt (nothing was sent)',
  fresh: stage => `Start a fresh ${stage} review`, reconcile: 'Check original transaction now', launch: 'Review launch with confirmed preparation' }
const GUIDED_LABELS = { sign: stage => `Sign ${stage} in wallet`, accept: 'I checked the amount and the coin details.', cosign: 'Add repo.ing’s signature',
  submit: stage => `Send ${stage} to Solana`, refreshReview: 'Refresh this review', expire: 'Close expired attempt (nothing was sent)',
  fresh: stage => `Start ${stage} again`, reconcile: 'Check now', launch: 'Continue to the launch signature' }

async function request(body) {
  const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let value
  try { value = await response.json() } catch { throw Error('The server response was interrupted. Preserve your IDs and refresh the retained operation before any further action.') }
  if (value.status === 'blocked') return value
  if (!response.ok) throw Error(value.error || 'The operation could not finish. Preserve your IDs and refresh the retained operation.')
  if (value.status !== 'available') throw Error('Unexpected server response. No further signing is allowed until the retained operation is refreshed.')
  return value
}

// guided: a plain cost summary first, with the exact review folded under "Technical details".
function Review({ operation, quote, guided = false }) {
  const review = operation.review
  if (guided) return <section aria-label="Transaction review" className="hooks-review">
    <div className="hooks-cost"><span>You pay at most</span><strong>{sol(review.maxNativeDebitLamports)}</strong>
      <small>Account deposits plus the network fee. Your wallet shows the exact amount before you approve.</small></div>
    {quote ? <p className="hooks-review-terms">Max {quote.capBps / 100}% per wallet · {quote.creatorFeeBps / 100}% creator fee, checked by repo.ing</p> : <p role="alert">repo.ing has not confirmed this coin’s terms yet, so signing is off.</p>}
    <details className="hooks-technical"><summary>Technical details</summary><Review operation={operation} quote={quote}/></details>
  </section>
  return <section aria-label="Exact transaction review">
    <h3>Review {operation.stage} before signing</h3>
    <dl>
      <dt>Wallet / payer</dt><dd>{review.wallet} / {review.payer}</dd>
      <dt>Network genesis</dt><dd>{review.genesisHash}</dd>
      <dt>Network base fee</dt><dd>{review.baseFeeLamports} lamports</dd>
      <dt>Maximum network fee</dt><dd>{review.maxFeeLamports} lamports</dd>
      <dt>Instruction debit</dt><dd>{review.instructionDebitLamports} lamports</dd>
      <dt>Total native debit cap</dt><dd>{review.maxNativeDebitLamports} lamports</dd>
      <dt>Review expires</dt><dd>{new Date(review.reviewExpiresAtMs).toISOString()}</dd>
      <dt>Exact message SHA-256</dt><dd>{review.messageSha256}</dd>
      <dt>Required signers</dt><dd>{review.requiredSigners.join(', ')}</dd>
      <dt>Signatures retained</dt><dd>{operation.signedBy?.join(', ') || 'None'}</dd>
    </dl>
    {quote ? <><h4>Server-verified economics and wallet cap</h4><dl><dt>Mint</dt><dd>{quote.mint}</dd><dt>Max-wallet cap</dt><dd>{quote.capBps} basis points ({quote.capBps / 100}% of initial supply)</dd><dt>Creator fee rate</dt><dd>{quote.creatorFeeBps} basis points ({quote.creatorFeeBps / 100}%)</dd><dt>Collected creator fee split</dt><dd>25% to the platform, remainder to the creator. Platform amount rounds down per swap; the creator receives the remainder.</dd><dt>Fee model / policy version</dt><dd>{quote.feeModel} / {quote.policyVersion}</dd></dl><details><summary>Exact verified economic request</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(quote, null, 2)}</pre></details></> : <p role="alert">The server has not supplied verified economics. Signing is unavailable.</p>}
    <details><summary>Review exact accounts and deployment pins</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ profileSha256: review.profileSha256, policySha256: review.policySha256, intentSha256: review.intentSha256, accounts: review.accounts, lookupTables: review.lookupTables?.map(({ address, owner, sha256 }) => ({ address, owner, sha256 })) }, null, 2)}</pre></details>
  </section>
}

// approvedIntent: an invited owner-approved coin, shown as a guided launch. session: the page's wallet session, if it has one.
// freshInvite: the invite is not bound to a launch yet, so any IDs this browser kept belong to an earlier coin.
// boundOperationId: the operation the server already bound this request to (it wins over anything stored here).
export function HookNativeLaunch({ genesisHash, initialBlockers = [], approvedIntent = null, session: sharedSession = null, freshInvite = false, boundOperationId = null }) {
  const { wallet, connect, provider } = useWallet()
  const ownSession = useHookWalletSession(genesisHash, { enabled: !sharedSession })
  const session = sharedSession ?? ownSession
  const identity = session.identity
  const guided = !!approvedIntent
  const walletRef = useRef(wallet); walletRef.current = wallet
  const running = useRef(false)
  const [ids, setIds] = useState({ operationId: '', preparationId: '', launchId: '' })
  const [completedIds, setCompletedIds] = useState(null)
  const [form, setForm] = useState({ label: '', name: '', symbol: '', uri: '', capBps: '', creatorFeeBps: '', virtualQuote: '' })
  const [reservation, setReservation] = useState(null)
  const [operation, setOperation] = useState(null)
  const [quote, setQuote] = useState(null)
  const [blockers, setBlockers] = useState(initialBlockers)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const activeWallet = !!identity && identity.wallet === wallet
  const signingId = operation?.id || ids.launchId || ids.preparationId
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey))
      if (saved && ['operationId', 'preparationId', 'launchId'].every(key => saved[key] === '' || uuid(saved[key]))) {
        // A new invite cannot reuse an earlier coin's operation (each operation binds one request), so set those IDs aside.
        if (freshInvite && Object.values(saved).some(Boolean)) { localStorage.setItem(storageKey + '.previous', JSON.stringify(saved)); localStorage.removeItem(storageKey) }
        else setIds(saved)
      }
      const completed = JSON.parse(localStorage.getItem(storageKey + '.last-completed')); if (completed && ['operationId', 'preparationId', 'launchId'].every(key => uuid(completed[key]))) setCompletedIds(completed)
    } catch {}
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => { setAccepted(false); setOperation(null); setQuote(null); setReservation(null) }, [wallet])
  function retain(next) {
    // IDs only: never store session tokens, signed transactions, or private keys in browser storage.
    localStorage.setItem(storageKey, JSON.stringify(next)); setIds(next)
  }
  function receive(value, expectedSigningId = signingId) {
    if (value.status === 'blocked') { setBlockers(value.blockers || [{ code: 'UNAVAILABLE', message: 'Operator adoption is not configured.' }]); setAccepted(false); return false }
    setBlockers([])
    if (value.operation) {
      if (!uuid(value.operation.id) || value.operation.id !== expectedSigningId || !['preparation', 'launch'].includes(value.operation.stage) || value.operation.review?.genesisHash !== genesisHash || value.operation.review?.payer !== walletRef.current || value.operation.review?.wallet !== walletRef.current || value.operation.custodyOperationId !== ids.operationId) throw Error('The retained operation belongs to another wallet or operation. Signing has been stopped.')
      setOperation(value.operation); setAccepted(false)
      const intent = value.operation.request
      setQuote(intent?.feeModel === 2 && intent.protocolShareBps === 2500 && intent.policyVersion === 2 && Number.isInteger(intent.capBps) && Number.isInteger(intent.creatorFeeBps) ? intent : null)
    }
    return true
  }
  async function run(action) {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause.message || 'Operation interrupted. Refresh before continuing.'); setUncertain(!!operation || !!signingId); setAccepted(false) }
    finally { running.current = false; setBusy(false) }
  }
  const refresh = () => run(async () => {
    if (!uuid(signingId)) throw Error('Enter the saved signing ID to resume.')
    const value = await request({ action: 'get', signingId })
    if (receive(value)) setUncertain(false)
  })
  // A reload while a reserve was in flight can read the invite before the bind lands, so the IDs were set aside
  // as stale. Once the server reports the bound operation, take it back (with its signing IDs when they were kept).
  // Reads storage, not state: on a plain reload the restore above has not reached state yet and must not be overwritten.
  useEffect(() => {
    if (!guided || !boundOperationId || operation) return
    const stored = key => { try { return JSON.parse(localStorage.getItem(key)) } catch { return null } }
    if (stored(storageKey)?.operationId === boundOperationId) return
    const previous = stored(storageKey + '.previous')
    const next = previous?.operationId === boundOperationId ? previous : { operationId: boundOperationId, preparationId: '', launchId: '' }
    try { retain(next) } catch { setIds(next) }
  }, [guided, boundOperationId])
  // Guided launches pick up a retained operation by themselves after a reload (a read; nothing is signed or sent).
  useEffect(() => { if (guided && activeWallet && !operation && uuid(signingId)) refresh() }, [guided, activeWallet, signingId])
  useEffect(() => {
    if (!activeWallet || !operation || !pendingStatuses.has(operation.status)) return
    const timer = setInterval(() => {
      run(async () => { const value = await request({ action: 'reconcile', signingId: operation.id }); if (receive(value)) setUncertain(false) })
    }, 8000)
    return () => clearInterval(timer)
  }, [activeWallet, operation?.id, operation?.status, ids.operationId])
  const reserve = () => run(async () => {
    if (!activeWallet) throw Error('Connect and sign in with the same wallet first.')
    const input = reservationInput(form, approvedIntent)
    const next = { ...ids, operationId: ids.operationId || crypto.randomUUID() }; retain(next)
    const value = await request({ action: 'reserve', operationId: next.operationId, ...input })
    if (receive(value)) {
      if (value.operationId !== next.operationId || !value.mint) throw Error('Reservation identity changed. Preserve the operation ID.')
      setReservation(value); setUncertain(false)
    }
  })
  const reviewStage = stage => run(async () => {
    const key = stage === 'preparation' ? 'preparationId' : 'launchId'
    const next = { ...ids, [key]: ids[key] || crypto.randomUUID() }; retain(next)
    const value = await request({ action: 'review', operationId: next.operationId, signingId: next[key], stage })
    if (receive(value, next[key])) setUncertain(false)
  })
  const sign = () => run(async () => {
    const address = walletRef.current
    const reviewed = operation.review
    if (!activeWallet || !accepted || !quote || Date.now() >= reviewed.reviewExpiresAtMs) throw Error('Review the current transaction with your authenticated wallet before signing.')
    const value = await request({ action: 'wallet-request', signingId: operation.id })
    if (value.status === 'blocked') { receive(value); return }
    if (value.review.messageSha256 !== reviewed.messageSha256 || value.review.wallet !== address || value.review.genesisHash !== genesisHash) throw Error('The transaction changed after review. Signing was stopped.')
    const { VersionedTransaction } = await import('@solana/web3.js')
    const tx = VersionedTransaction.deserialize(decode(value.partialTransactionBase64))
    const message = tx.message.serialize()
    if (encode(message) !== value.review.messageBase64) throw Error('Transaction bytes differ from the reviewed message.')
    const digest = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', message)))
    const expectedDigest = encode(Uint8Array.from(reviewed.messageSha256.match(/../g), value => parseInt(value, 16)))
    if (digest !== expectedDigest || walletRef.current !== address) throw Error('Transaction identity or connected wallet changed.')
    const previousSignatures = tx.signatures.map(signature => Uint8Array.from(signature))
    const adapter = provider()
    if (typeof adapter?.signTransaction !== 'function') throw Error('Connect a wallet that supports transaction signing.')
    if (Date.now() >= reviewed.reviewExpiresAtMs || walletRef.current !== address) throw Error('The review expired or wallet changed before the signature prompt. Refresh the unsigned review.')
    const signed = await adapter.signTransaction(tx)
    if (walletRef.current !== address || !equal(signed.message.serialize(), message)) throw Error('Wallet changed the reviewed message or active account. Submission was stopped.')
    for (let index = 0; index < previousSignatures.length; index++) {
      if (reviewed.requiredSigners[index] !== address && !equal(signed.signatures[index], previousSignatures[index])) throw Error('Wallet changed another signer’s signature. Submission was stopped.')
    }
    const result = await request({ action: 'retain-wallet', signingId: operation.id, signedTransactionBase64: encode(signed.serialize()) })
    receive(result)
  })
  const action = name => run(async () => {
    if (!activeWallet) throw Error('Sign in with the retained operation’s wallet.')
    // Clear authority before I/O. An interrupted send may only be refreshed/reconciled.
    if (name === 'submit' || name === 'cosign') setUncertain(true)
    const value = await request({ action: name, signingId: operation.id })
    if (receive(value)) setUncertain(false)
  })
  // After an expired attempt: same operation, new signing ID, entirely fresh review and signatures.
  const freshReview = stage => run(async () => {
    const key = stage === 'preparation' ? 'preparationId' : 'launchId'
    const next = { ...ids, [key]: crypto.randomUUID() }; retain(next); setAccepted(false); setQuote(null)
    const value = await request({ action: 'review', operationId: next.operationId, signingId: next[key], stage })
    if (receive(value, next[key])) setUncertain(false)
  })
  const startSeparateLaunch = () => run(async () => {
    if (!activeWallet || operation?.status !== 'finalized-success' || operation.stage !== 'launch') throw Error('The original launch must be finalized before starting a separate launch.')
    localStorage.setItem(storageKey + '.last-completed', JSON.stringify(ids))
    retain({ operationId: '', preparationId: '', launchId: '' }); setCompletedIds(ids)
    setOperation(null); setReservation(null); setQuote(null); setAccepted(false); setUncertain(false)
    setForm({ label: '', name: '', symbol: '', uri: '', capBps: '', creatorFeeBps: '', virtualQuote: '' })
  })
  const expired = operation && clock >= operation.review.reviewExpiresAtMs
  const canAct = activeWallet && !busy && !uncertain && blockers.length === 0 && (!operation || !!quote)
  const waiting = operation && pendingStatuses.has(operation.status)
  const locked = lockedLaunchFields(approvedIntent)
  const awaitingInvite = blockers.length > 0 && blockers.every(item => item.code === 'AWAITING_OWNER_INVITE')
  const labels = guided ? GUIDED_LABELS : OPERATOR_LABELS
  const button = primary => guided ? `button ${primary ? 'primary' : 'outline'}` : undefined
  const statusText = operation && (guided && operation.status === 'finalized-success' ? guidedStage[operation.stage].done
    : (guided ? guidedStatus : statusLabels)[operation.status] || `Retained status: ${operation.status}`)
  const operationCard = operation && <section className="inner-card hooks-operation" aria-live="polite">
    {guided ? <><p className="hooks-step-eyebrow">{guidedStage[operation.stage].step}</p><h3>{guidedStage[operation.stage].title}</h3><p>{guidedStage[operation.stage].about}</p></>
      : <h2>{operation.stage === 'preparation' ? 'Mint preparation' : 'Coin launch'}</h2>}
    <p className={guided ? 'hooks-operation-status' : undefined}>{statusText}</p>
    {!guided && <p>Signing ID: {operation.id}</p>}
    <Review operation={operation} quote={quote} guided={guided}/>
    {expired && !waiting && operation.status !== 'finalized-success' && <p role="alert">This exact review has expired. The server must resolve the retained operation before new signing or submission.</p>}
    {operation.status === 'reviewed' && expired && !operation.walletRequestIssued && <button className={button(true)} disabled={!activeWallet || busy || uncertain} onClick={() => action('refresh-review')}>{labels.refreshReview}</button>}
    {['reviewed', 'partial'].includes(operation.status) && !operation.signedBy?.includes(wallet) && <><label className={guided ? 'hooks-accept' : undefined}><input type="checkbox" checked={accepted} disabled={!canAct || expired || !quote} onChange={event => setAccepted(event.target.checked)}/> {labels.accept}</label><button className={button(true)} disabled={!canAct || !accepted || expired || !quote} onClick={sign}>{busy ? 'Check your wallet…' : labels.sign(operation.stage)}</button></>}
    {operation.status === 'partial' && operation.signedBy?.includes(wallet) && <button className={button(true)} disabled={!canAct || expired} onClick={() => action('cosign')}>{labels.cosign}</button>}
    {operation.status === 'reviewed' && expired && operation.walletRequestIssued && <p role="alert">The original message was issued to your wallet. Preserve this signing ID; a new review is blocked until the original outcome is resolved.</p>}
    {operation.status === 'signed' && <button className={button(true)} disabled={!canAct || expired} onClick={() => action('submit')}>{labels.submit(operation.stage)}</button>}
    {expired && ['reviewed', 'partial', 'signed', 'signing-claimed', 'signing-unknown'].includes(operation.status) && !operation.signature && <><p>This attempt's deadline has passed and it was never sent. Closing it is checked against the chain first, so the old transaction can never land.</p><button className={button(false)} disabled={!activeWallet || busy} onClick={() => action('expire')}>{labels.expire}</button></>}
    {operation.status === 'expired' && <button className={button(true)} disabled={!canAct} onClick={() => freshReview(operation.stage)}>{labels.fresh(operation.stage)}</button>}
    {waiting && <><p>{guided ? 'We check it every 8 seconds while this page is open.' : 'The original transaction is checked every 8 seconds while this page is open.'}</p><button className={button(false)} disabled={busy || !activeWallet} onClick={() => action('reconcile')}>{labels.reconcile}</button></>}
    {operation.signature && <p className={guided ? 'hooks-receipt' : undefined}>{guided ? 'Receipt: ' : 'Transaction receipt: '}{genesisHash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' ? <a href={`https://explorer.solana.com/tx/${encodeURIComponent(operation.signature)}`} target="_blank" rel="noreferrer">{guided ? `${operation.signature.slice(0, 10)}… on Solana Explorer` : operation.signature}</a> : <code>{operation.signature}</code>}</p>}
    {operation.status === 'finalized-success' && operation.stage === 'preparation' && <button className={button(true)} disabled={!canAct} onClick={() => reviewStage('launch')}>{labels.launch}</button>}
    {operation.status === 'finalized-success' && operation.stage === 'launch' && (guided
      ? <p>Keep the receipt for your records. <Link href="/hooks/trade">Buy or sell on repo.ing</Link>.</p>
      : <><p>Your launch is finalized. Keep both signing IDs and the transaction receipt for your records. <Link href="/hooks/trade">Open buy / sell and check trading availability</Link>.</p><button disabled={!canAct} onClick={startSeparateLaunch}>Start a separate launch</button></>)}
  </section>
  const recoveryFields = <>
    {Object.entries({ operationId: 'Operation ID', preparationId: 'Preparation signing ID', launchId: 'Launch signing ID' }).map(([key, label]) => <label key={key} className={guided ? 'hooks-recovery-field' : undefined} style={guided ? undefined : { display: 'block' }}>{label}<input className={guided ? 'field-input' : undefined} style={guided ? undefined : { display: 'block', width: '100%' }} value={ids[key]} disabled={busy || !!operation} onChange={event => { const next = { ...ids, [key]: event.target.value }; setIds(next); setAccepted(false) }}/></label>)}
    <button className={button(false)} disabled={!activeWallet || busy || !uuid(signingId)} onClick={() => { try { retain(ids); refresh() } catch { setError('Browser storage is unavailable. Save the IDs before proceeding.') } }}>{guided ? 'Resume with these IDs' : 'Refresh / resume retained operation'}</button>
    {/* Re-review the same retained ID; the server returns an existing request rather than replacing it. */}
    {!operation && uuid(ids.operationId) && !ids.launchId && <button className={button(false)} disabled={!activeWallet || busy} onClick={() => reviewStage('preparation')}>Resume retained preparation review</button>}
    {!operation && uuid(ids.operationId) && uuid(ids.launchId) && <button className={button(false)} disabled={!activeWallet || busy} onClick={() => reviewStage('launch')}>Resume retained launch review</button>}
  </>
  const otherBlockers = blockers.filter(item => item.code !== 'AWAITING_OWNER_INVITE')

  if (guided) {
    const prepDone = operation?.stage === 'launch' || (operation?.stage === 'preparation' && operation.status === 'finalized-success')
    const steps = [['Reserve address', !!reservation || !!operation], ['Sign preparation', prepDone], ['Sign launch', operation?.stage === 'launch' && operation.status === 'finalized-success']]
    const current = steps.findIndex(([, done]) => !done)
    return <div className="hooks-guided">
      <ol className="hooks-sign-steps" aria-label="Launch signatures">{steps.map(([label, done], index) =>
        <li key={label} data-state={done ? 'done' : index === current ? 'current' : 'todo'} aria-current={index === current ? 'step' : undefined}><span>{done ? <Check size={14} aria-hidden="true"/> : index + 1}</span>{label}</li>)}</ol>
      {!activeWallet && <HookWalletSignIn genesisHash={genesisHash} session={session} title="Sign in with the wallet that sent the request">Your invite belongs to that wallet. Signing in is free and sends no transaction.</HookWalletSignIn>}
      {activeWallet && !operation && !reservation && <section className="inner-card hooks-operation"><h3>Reserve your coin’s address</h3>
        <p>This holds a fresh address for ${approvedIntent.symbol}. It’s free, and there’s nothing to sign yet.</p>
        <button className="button primary" disabled={busy || uncertain || otherBlockers.length > 0} onClick={reserve}>{busy ? 'Reserving…' : 'Reserve address'}</button></section>}
      {reservation && !operation && <section className="inner-card hooks-operation"><h3>Address reserved</h3>
        <p>${approvedIntent.symbol} will live at <code title={reservation.mint}>{shortAddress(reservation.mint)}</code>. Next, review the first of two signatures.</p>
        <button className="button primary" disabled={!canAct} onClick={() => reviewStage('preparation')}>{busy ? 'Preparing review…' : 'Review preparation'}</button></section>}
      {operationCard}
      {otherBlockers.length > 0 && <section className="hooks-notice" role="status"><div><strong>Launching is paused right now</strong><p>{otherBlockers.map(item => item.message).join(' ')} Nothing will be signed until it reopens.</p></div></section>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {uncertain && <div className="hooks-uncertain" role="alert"><p>Check the status before doing anything else. Keep your recovery IDs and don’t sign or send again.</p>
        {uuid(signingId) && <button type="button" className="button primary" disabled={busy || !activeWallet} onClick={refresh}>{busy ? 'Checking…' : 'Check status'}</button>}</div>}
      <details className="launch-customize hooks-recovery"><summary><span>Recovery IDs</span><ChevronDown size={18} aria-hidden="true"/></summary>
        <div className="launch-customize-body"><p>If the page reloads or times out, these IDs pick up the same launch. Never start a second launch to get around an unclear result.</p>{recoveryFields}
          {completedIds && <p className="hooks-fine">Last completed launch: {completedIds.operationId}</p>}</div></details>
    </div>
  }

  return <div style={{ overflowWrap: 'anywhere' }}>
    <ol aria-label="Launch steps"><li>Connect and authenticate wallet</li><li>Reserve your mint and review exact economics</li><li>Sign and confirm preparation</li><li>Review, sign and confirm launch</li></ol>
    {!wallet && <button disabled={busy} onClick={() => run(() => connect())}>Connect wallet</button>}
    <HookWalletSignIn genesisHash={genesisHash} session={session}/>
    {/* While an owner-approved coin waits for its invite, the request form above is the only coin form. */}
    {!awaitingInvite && <section className="inner-card"><h2>New coin</h2><p>Choose a max-wallet cap and creator fee explicitly. Final costs and cap are shown from the verified server review. Virtual quote is a pricing input, not deposited SOL.</p>
      {Object.entries({ label: 'Internal label', name: 'Coin name', symbol: 'Symbol', uri: 'Metadata HTTPS URL', capBps: 'Maximum wallet cap (basis points)', creatorFeeBps: 'Creator fee (basis points)', virtualQuote: 'Virtual quote (integer base units)' }).map(([key, label]) => <label key={key} style={{ display: 'block', marginBottom: 12 }}>{label}<input style={{ display: 'block', width: '100%' }} value={Object.hasOwn(locked, key) ? locked[key] : form[key]} disabled={busy || !!reservation || !!operation || Object.hasOwn(locked, key)} inputMode={['capBps', 'creatorFeeBps', 'virtualQuote'].includes(key) ? 'numeric' : undefined} onChange={event => setForm({ ...form, [key]: event.target.value })}/></label>)}
      <button disabled={!activeWallet || busy || !!operation || !!reservation || uncertain} onClick={reserve}>{busy ? 'Working…' : 'Reserve mint and check availability'}</button>
      {reservation && <><p>Reserved mint: {reservation.mint}</p><button disabled={!canAct} onClick={() => reviewStage('preparation')}>Get exact preparation review</button></>}
    </section>}
    <section className="inner-card"><h2>Resume your operation</h2><p>Keep these IDs. Resume the original operation after a timeout or reload; never create a replacement to bypass an uncertain outcome.</p>
      {recoveryFields}
    </section>
    {completedIds && <details><summary>Last completed launch IDs</summary><dl><dt>Operation</dt><dd>{completedIds.operationId}</dd><dt>Preparation</dt><dd>{completedIds.preparationId}</dd><dt>Launch</dt><dd>{completedIds.launchId}</dd></dl></details>}
    {blockers.length > 0 && (awaitingInvite
      ? <section className="hooks-notice" role="status"><div><h2>Waiting for repo.ing’s invite</h2><p>{blockers[0].message} You sign nothing until then.</p></div></section>
      : <section className="hooks-notice" role="status"><div><h2>Launch unavailable</h2><ul>{blockers.map(item => <li key={item.code}>{item.message} ({item.code})</li>)}</ul><p>No wallet signing is offered while these server gates are closed.</p></div></section>)}
    {error && <p role="alert">{error}</p>}
    {uncertain && <p role="alert">The last action needs a status refresh. Keep the original IDs; do not retry signing or submission.</p>}
    {operationCard}
  </div>
}
