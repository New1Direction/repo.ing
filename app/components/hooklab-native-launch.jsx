'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useWallet } from './wallet'
import { HookWalletSignIn } from './hooklab-wallet-signin'

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

async function request(body) {
  const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let value
  try { value = await response.json() } catch { throw Error('The server response was interrupted. Preserve your IDs and refresh the retained operation before any further action.') }
  if (value.status === 'blocked') return value
  if (!response.ok) throw Error(value.error || 'The operation could not finish. Preserve your IDs and refresh the retained operation.')
  if (value.status !== 'available') throw Error('Unexpected server response. No further signing is allowed until the retained operation is refreshed.')
  return value
}

function Review({ operation, quote }) {
  const review = operation.review
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

export function HookNativeLaunch({ genesisHash, initialBlockers = [], approvedIntent = null }) {
  const { wallet, connect, provider } = useWallet()
  const walletRef = useRef(wallet); walletRef.current = wallet
  const running = useRef(false)
  const [identity, setIdentity] = useState(null)
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
      const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved && ['operationId', 'preparationId', 'launchId'].every(key => saved[key] === '' || uuid(saved[key]))) setIds(saved)
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
  useEffect(() => {
    if (!activeWallet || !operation || !pendingStatuses.has(operation.status)) return
    const timer = setInterval(() => {
      run(async () => { const value = await request({ action: 'reconcile', signingId: operation.id }); if (receive(value)) setUncertain(false) })
    }, 8000)
    return () => clearInterval(timer)
  }, [activeWallet, operation?.id, operation?.status, ids.operationId])
  const reserve = () => run(async () => {
    if (!activeWallet) throw Error('Connect and sign in with the same wallet first.')
    if (!/^\d{1,4}$/.test(form.capBps) || +form.capBps < 1 || +form.capBps > 9999) throw Error('Max-wallet cap must be 1–9999 basis points.')
    if (!/^\d{1,4}$/.test(form.creatorFeeBps) || +form.creatorFeeBps > 9999) throw Error('Enter an explicit creator fee from 0–9999 basis points.')
    if (!/^(0|[1-9][0-9]*)$/.test(form.virtualQuote)) throw Error('Enter the virtual quote amount in integer base units.')
    for (const [key, limit] of Object.entries({ label: 32, name: 32, symbol: 10, uri: 200 })) {
      if (!form[key].trim()) throw Error(`Enter ${key}.`)
      if (new TextEncoder().encode(form[key]).length > limit) throw Error(`${key} must be at most ${limit} UTF-8 bytes.`)
    }
    if (new URL(form.uri).protocol !== 'https:') throw Error('Use an HTTPS metadata URL.')
    const next = { ...ids, operationId: ids.operationId || crypto.randomUUID() }; retain(next)
    const value = await request({ action: 'reserve', operationId: next.operationId, ...form, capBps: Number(form.capBps), creatorFeeBps: Number(form.creatorFeeBps), ...(approvedIntent ?? {}) })
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
  return <div style={{ overflowWrap: 'anywhere' }}>
    <ol aria-label="Launch steps"><li>Connect and authenticate wallet</li><li>Reserve your mint and review exact economics</li><li>Sign and confirm preparation</li><li>Review, sign and confirm launch</li></ol>
    {!wallet && <button disabled={busy} onClick={() => run(() => connect())}>Connect wallet</button>}
    <HookWalletSignIn genesisHash={genesisHash} onIdentity={setIdentity}/>
    <section className="inner-card"><h2>New coin</h2><p>Choose a max-wallet cap and creator fee explicitly. Final costs and cap are shown from the verified server review. Virtual quote is a pricing input, not deposited SOL.</p>
      {Object.entries({ label: 'Internal label', name: 'Coin name', symbol: 'Symbol', uri: 'Metadata HTTPS URL', capBps: 'Maximum wallet cap (basis points)', creatorFeeBps: 'Creator fee (basis points)', virtualQuote: 'Virtual quote (integer base units)' }).map(([key, label]) => <label key={key} style={{ display: 'block', marginBottom: 12 }}>{label}<input style={{ display: 'block', width: '100%' }} value={approvedIntent && Object.hasOwn(approvedIntent, key) ? approvedIntent[key] : form[key]} disabled={busy || !!reservation || !!operation || (!!approvedIntent && Object.hasOwn(approvedIntent, key))} inputMode={['capBps', 'creatorFeeBps', 'virtualQuote'].includes(key) ? 'numeric' : undefined} onChange={event => setForm({ ...form, [key]: event.target.value })}/></label>)}
      <button disabled={!activeWallet || busy || !!operation || !!reservation || uncertain} onClick={reserve}>{busy ? 'Working…' : 'Reserve mint and check availability'}</button>
      {reservation && <><p>Reserved mint: {reservation.mint}</p><button disabled={!canAct} onClick={() => reviewStage('preparation')}>Get exact preparation review</button></>}
    </section>
    <section className="inner-card"><h2>Resume your operation</h2><p>Keep these IDs. Resume the original operation after a timeout or reload; never create a replacement to bypass an uncertain outcome.</p>
      {Object.entries({ operationId: 'Operation ID', preparationId: 'Preparation signing ID', launchId: 'Launch signing ID' }).map(([key, label]) => <label key={key} style={{ display: 'block' }}>{label}<input style={{ display: 'block', width: '100%' }} value={ids[key]} disabled={busy || !!operation} onChange={event => { const next = { ...ids, [key]: event.target.value }; setIds(next); setAccepted(false) }}/></label>)}
      <button disabled={!activeWallet || busy || !uuid(signingId)} onClick={() => { try { retain(ids); refresh() } catch { setError('Browser storage is unavailable. Save the IDs before proceeding.') } }}>Refresh / resume retained operation</button>
      {/* Re-review the same retained ID; the server returns an existing request rather than replacing it. */}
      {!operation && uuid(ids.operationId) && !ids.launchId && <button disabled={!activeWallet || busy} onClick={() => reviewStage('preparation')}>Resume retained preparation review</button>}
      {!operation && uuid(ids.operationId) && uuid(ids.launchId) && <button disabled={!activeWallet || busy} onClick={() => reviewStage('launch')}>Resume retained launch review</button>}
    </section>
    {completedIds && <details><summary>Last completed launch IDs</summary><dl><dt>Operation</dt><dd>{completedIds.operationId}</dd><dt>Preparation</dt><dd>{completedIds.preparationId}</dd><dt>Launch</dt><dd>{completedIds.launchId}</dd></dl></details>}
    {blockers.length > 0 && <section className="hooks-notice" role="status"><div><h2>Launch unavailable</h2><ul>{blockers.map(item => <li key={item.code}>{item.message} ({item.code})</li>)}</ul><p>No wallet signing is offered while these server gates are closed.</p></div></section>}
    {error && <p role="alert">{error}</p>}
    {uncertain && <p role="alert">The last action needs a status refresh. Keep the original IDs; do not retry signing or submission.</p>}
    {operation && <section className="inner-card" aria-live="polite"><h2>{operation.stage === 'preparation' ? 'Mint preparation' : 'Coin launch'}</h2><p>{statusLabels[operation.status] || `Retained status: ${operation.status}`}</p>
      <p>Signing ID: {operation.id}</p>
      <Review operation={operation} quote={quote}/>
      {expired && !waiting && operation.status !== 'finalized-success' && <p role="alert">This exact review has expired. The server must resolve the retained operation before new signing or submission.</p>}
      {operation.status === 'reviewed' && expired && !operation.walletRequestIssued && <button disabled={!activeWallet || busy || uncertain} onClick={() => action('refresh-review')}>Refresh unsigned review</button>}
      {['reviewed', 'partial'].includes(operation.status) && !operation.signedBy?.includes(wallet) && <><label><input type="checkbox" checked={accepted} disabled={!canAct || expired || !quote} onChange={event => setAccepted(event.target.checked)}/> I reviewed this exact transaction, fees, debit limit and wallet cap.</label><button disabled={!canAct || !accepted || expired || !quote} onClick={sign}>Sign {operation.stage} in wallet</button></>}
      {operation.status === 'partial' && operation.signedBy?.includes(wallet) && <button disabled={!canAct || expired} onClick={() => action('cosign')}>Complete next server signature</button>}
      {operation.status === 'reviewed' && expired && operation.walletRequestIssued && <p role="alert">The original message was issued to your wallet. Preserve this signing ID; a new review is blocked until the original outcome is resolved.</p>}
      {operation.status === 'signed' && <button disabled={!canAct || expired} onClick={() => action('submit')}>Submit signed {operation.stage} transaction once</button>}
      {expired && ['reviewed', 'partial', 'signed', 'signing-claimed', 'signing-unknown'].includes(operation.status) && !operation.signature && <><p>This attempt's deadline has passed and it was never sent. Closing it is checked against the chain first, so the old transaction can never land.</p><button disabled={!activeWallet || busy} onClick={() => action('expire')}>Close expired attempt (nothing was sent)</button></>}
      {operation.status === 'expired' && <button disabled={!canAct} onClick={() => freshReview(operation.stage)}>Start a fresh {operation.stage} review</button>}
      {waiting && <><p>The original transaction is checked every 8 seconds while this page is open.</p><button disabled={busy || !activeWallet} onClick={() => action('reconcile')}>Check original transaction now</button></>}
      {operation.signature && <p>Transaction receipt: {genesisHash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' ? <a href={`https://explorer.solana.com/tx/${encodeURIComponent(operation.signature)}`} target="_blank" rel="noreferrer">{operation.signature}</a> : <code>{operation.signature}</code>}</p>}
      {operation.status === 'finalized-success' && operation.stage === 'preparation' && <button disabled={!canAct} onClick={() => reviewStage('launch')}>Review launch with confirmed preparation</button>}
      {operation.status === 'finalized-success' && operation.stage === 'launch' && <><p>Your launch is finalized. Keep both signing IDs and the transaction receipt for your records. <Link href="/hooks/trade">Open buy / sell and check trading availability</Link>.</p><button disabled={!canAct} onClick={startSeparateLaunch}>Start a separate launch</button></>}
    </section>}
  </div>
}
