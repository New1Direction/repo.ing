'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Info } from 'lucide-react'
import { CopyAddress } from '../copy-address'
import { useWallet } from '../wallet'
import { WalletExplainer } from '../claim-checklist'
import { PasteAddressForm, PayoutDestination, pasteSavedMessage } from '../payout-address'
import { formatUnits } from '../../lib/format.mjs'
import { walletSignatureBytes } from '../../lib/solana-wallet.mjs'
import { bindingLabel, formatUtcDateTime } from '../../../src/payout-address-policy.mjs'
import styles from './model-authority.module.css'

// A model market's claim steps (app/components/hf/claim-page.jsx): sign in with Hugging Face, set a payout wallet, claim.
// Presentation and requests only; /api/hf/bind and /api/hf/claim check the model's current owner on Hugging Face again.
// Short labels: the checklist is one row on a phone; each step's heading says it in full.
const STEPS = ['Sign in', 'Set payout wallet', 'Claim']
const BIND_ENDPOINT = '/api/hf/bind'
const ERRORS = {
  'payout-unavailable': 'Payouts are paused while the network-cost wallet is replenished. Your fees remain in the pool.',
  'payout-address-pending': 'Your pasted payout address is still in its 48-hour hold. Claims open when it becomes active.',
  'review-changed': 'The amount or payout details changed. Review the updated fees below, then claim again.',
  'claim-failed': 'The payout could not be confirmed. Check the receipt and available balance before trying again.',
  'verification-failed': 'Hugging Face ownership could not be confirmed. Sign in again to continue.',
  'owner-changed': 'The model has a new owner since its payout wallet was set. The current owner must set a payout wallet before claiming.',
  'model-moved': 'The model is no longer at its last known address on Hugging Face. Paste its new URL below.',
  'hf-unavailable': 'Hugging Face sign-in is unavailable right now. Try again later.',
  'hf-denied': 'Hugging Face sign-in was cancelled.',
  'hf-sign-in-failed': 'Hugging Face sign-in could not finish. Try again.',
  'rate-limited': 'Too many claim attempts. Try again later.',
}

async function post(body) {
  const response = await fetch(BIND_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'This could not be saved. Refresh and try again.')
  return result
}

function Checklist({ current }) {
  return <ol className="claim-checklist" aria-label="Claim progress">{STEPS.map((label, index) => {
    const state = index + 1 < current ? 'done' : index + 1 === current ? 'current' : 'upcoming'
    return <li key={label} className={state} aria-current={state === 'current' ? 'step' : undefined}>
      <span className="claim-checklist-mark" aria-hidden="true">{state === 'done' ? <Check size={12} strokeWidth={3}/> : index + 1}</span>
      <span>{label}<span className="sr-only"> ({state === 'done' ? 'done' : state === 'current' ? 'current step' : 'not started'})</span></span>
    </li>
  })}</ol>
}

// "Model moved?": the market follows its model to a new URL only if that URL is the same model (the same Hugging Face _id).
function Repoint({ repoId, onMoved }) {
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try { onMoved(await post({ action: 'repoint', marketId: repoId, url })) } catch (cause) { setError(cause.message) } finally { setBusy(false) }
  }
  return <form className={styles.repoint} onSubmit={submit} noValidate>
    <label htmlFor="model-new-url"><strong>Model moved?</strong> Paste its new Hugging Face URL. It is accepted only if it is the same model.</label>
    <input id="model-new-url" className="field-input" value={url} onChange={event => setUrl(event.target.value)} placeholder="huggingface.co/owner/name"
      autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy} maxLength={300}/>
    <button className="button outline" type="submit" disabled={busy || !url.trim()}>{busy ? 'Checking…' : 'Use this URL'}</button>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </form>
}

export function ModelClaimSteps({ summary, repoId, signedIn, authority, beneficiaryWallet, beneficiaryMethod = 'signature', beneficiaryBoundAt = null, staleBinding = false,
  pendingAddress = null, claimable, usdEstimate, feeStatus, payoutReady, settledClaim, justClaimed, errorCode, review }) {
  const router = useRouter()
  const { wallet, connect, changeWallet, provider } = useWallet()
  const [bound, setBound] = useState(beneficiaryWallet)
  const [boundMethod, setBoundMethod] = useState(beneficiaryMethod)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [stage, setStage] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmChange, setConfirmChange] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState(ERRORS[errorCode] ?? (errorCode ? 'This step could not finish. Refresh and try again.' : ''))
  const ready = Boolean(signedIn && !expired && authority?.ok)
  const walletMatches = Boolean(wallet && bound && wallet === bound)
  const pastedActive = Boolean(bound && boundMethod === 'pasted')
  const destinationReady = (walletMatches || pastedActive) && !staleBinding
  const current = !ready ? 1 : !destinationReady ? 2 : 3
  const canClaim = Boolean(current === 3 && claimable && claimable !== '0' && feeStatus === 'MATCH' && payoutReady && review)
  const claimAmount = claimable === null ? '—' : `${formatUnits(claimable)} SOL`
  const moved = authority?.code === 'HF_MODEL_MOVED' || errorCode === 'model-moved'
  const signIn = `/api/hf/start?mode=claim&market=${repoId}`
  const role = authority?.role === 'owner' ? 'owner' : authority?.role === 'admin' ? `admin of ${authority.ownerHandle}` : null

  useEffect(() => { setBound(beneficiaryWallet); setBoundMethod(beneficiaryMethod); setStage('') }, [beneficiaryWallet, beneficiaryMethod, review])
  useEffect(() => {
    setExpired(false)
    if (!signedIn) return
    const timer = setTimeout(() => setExpired(true), Math.max(0, signedIn.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [signedIn?.expiresAt])

  async function bind() {
    setBusy(true); setError('')
    try {
      if (!ready) throw new Error('Sign in with Hugging Face first')
      const address = wallet || await connect()
      setStage('Checking Hugging Face ownership and preparing your wallet message…')
      const challenge = await post({ action: 'challenge', marketId: repoId, wallet: address })
      setStage('Approve the message in your wallet. This does not spend SOL.')
      const signature = walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(challenge.message)))
      setStage('Verifying and saving your payout wallet…')
      const result = await post({ action: 'bind', marketId: repoId, wallet: address, nonce: challenge.nonce, signature: btoa(String.fromCharCode(...signature)) })
      setBound(result.wallet); setBoundMethod('signature'); setPasteOpen(false); setConfirmChange(false)
      setStage('Payout wallet set. Refreshing your claim review…'); router.refresh()
    } catch (cause) { setError(cause.message || 'Could not set the payout wallet'); setStage('') }
    finally { setBusy(false) }
  }

  return <><Checklist current={current}/>{summary}<div className="claim-steps">
    {(busy || claiming) && <div className="claim-progress" role="status" aria-live="polite"><span><strong>{claiming ? 'Processing your claim…' : stage}</strong>
      <small>{claiming ? 'Checking current Hugging Face ownership and settling the payout on Solana. Keep this page open.' : 'Wait for confirmation here.'}</small></span></div>}
    {settledClaim && <div className="claim-receipt" role="status"><Check size={24} aria-hidden="true"/><div>
      <h2>{justClaimed ? 'Claim complete' : 'Latest payout'}</h2><p>{formatUnits(settledClaim.amount)} SOL paid to the verified payout wallet.</p>
      <CopyAddress address={settledClaim.wallet} label="payout wallet"/>
      <a href={`https://explorer.solana.com/tx/${settledClaim.signature}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>
    </div></div>}

    <div className={`claim-step ${current === 1 ? 'current' : ''}`}>
      <div className={`step-number ${ready ? 'done' : ''}`}>{ready ? <Check size={18}/> : 1}</div>
      <div className="step-content"><div className="claim-step-heading"><div><h2>Sign in with Hugging Face</h2></div></div>
        <p>Only the model’s current owner on Hugging Face, or an admin of the organization that owns it, can claim. Signing in only tells repo.ing who you are and which organizations you share; it grants no access to your models.</p>
        {ready ? <p className="positive"><Check size={17}/>Signed in as {signedIn.username}{role ? ` · ${role}` : ''}</p> : <>
          {signedIn && !expired && authority && !authority.ok && <p className="inline-error" role="alert">{authority.message}</p>}
          {moved && <Repoint repoId={repoId} onMoved={result => { setError(''); setStage(`Following the model to ${result.path}…`); router.refresh() }}/>}
          <a className="button primary" href={signIn}>{signedIn && !expired ? 'Sign in with Hugging Face again' : 'Sign in with Hugging Face'}</a>
          {authority?.code === 'HF_NOT_AUTHORIZED' && authority.ownerKind === 'org' && <p className="claim-step-hint">On Hugging Face’s consent screen, share {authority.ownerHandle} with repo.ing.</p>}
        </>}
        {ready && <p className="claim-step-hint">Your session lasts up to one hour. Ownership is checked with Hugging Face again before every change and payout.</p>}
      </div>
    </div>

    <div className={`claim-step ${current === 2 ? 'current' : ''}`}>
      <div className={`step-number ${destinationReady ? 'done' : ''}`}>{destinationReady ? <Check size={18}/> : 2}</div>
      <div className="step-content"><div className="claim-step-heading"><div><h2>Set payout wallet</h2></div></div>
        <p>Choose the Solana wallet that receives the model’s SOL. You sign a message to prove it’s yours; it does not spend SOL. No wallet extension? Paste the address instead; a pasted address starts receiving payouts after a 48-hour hold.</p>
        {staleBinding && <p className="claim-wallet-warning" role="alert">This payout wallet was set when the model had a different owner. It will not be paid; set a payout wallet as the current owner.</p>}
        {!bound && !pendingAddress && <WalletExplainer/>}
        <PayoutDestination repoId={repoId} active={bound ? { wallet: bound, method: boundMethod, boundAt: beneficiaryBoundAt } : null} pending={pendingAddress}
          canManage={ready} onChanged={() => router.refresh()} endpoint={BIND_ENDPOINT} noun="model"/>
        {!wallet ? <button className="button primary" type="button" disabled={!ready} onClick={() => connect().catch(cause => setError(cause.message))}>Connect wallet</button>
          : !bound || staleBinding ? <button className="button primary" type="button" disabled={!ready || busy} onClick={bind}>{busy ? 'Setting wallet…' : 'Use this wallet for payouts'}</button>
            : <button className={`button ${wallet !== bound && !confirmChange ? 'primary' : 'outline'}`} type="button" onClick={() => changeWallet().catch(cause => setError(cause.message))}>Switch connected wallet</button>}
        {wallet && bound && !staleBinding && wallet !== bound && <div className="claim-wallet-warning"><p>The connected wallet differs from the payout address. Switch wallets or explicitly replace the payout address.</p>
          {!confirmChange ? <button className="claim-text-button" type="button" disabled={!ready} onClick={() => setConfirmChange(true)}>Change payout address instead</button> : <>
            <p>Replace it with <strong>{wallet.slice(0, 6)}…{wallet.slice(-4)}</strong>? This needs a fresh Hugging Face ownership check and a wallet signature.</p>
            <button className="button primary" type="button" disabled={!ready || busy} onClick={bind}>{busy ? 'Setting wallet…' : 'Confirm payout wallet change'}</button>
            <button className="claim-text-button" type="button" onClick={() => setConfirmChange(false)}>Cancel</button></>}
        </div>}
        {ready && (pasteOpen ? <PasteAddressForm repoIds={[repoId]} replacing={Boolean(bound)} endpoint={BIND_ENDPOINT} noun="model"
          onSaved={result => { setPasteOpen(false); setStage(pasteSavedMessage(result)); router.refresh() }} onClose={() => setPasteOpen(false)}/> :
          <p className="claim-paste-toggle"><button className="claim-text-button" type="button" onClick={() => { setError(''); setPasteOpen(true) }}>
            {bound || pendingAddress ? 'Paste a different payout address' : 'No Solana wallet extension? Paste a payout address instead'}</button></p>)}
      </div>
    </div>

    <div className={`claim-step last ${current === 3 ? 'current' : ''}`}>
      <div className="step-number">3</div><div className="step-content"><div className="claim-step-heading"><div><h2>Review and claim</h2></div></div>
        {current === 3 && <div className="claim-review"><strong className="claim-review-amount">{claimAmount}</strong>{usdEstimate && <span className="muted">≈ {usdEstimate}</span>}
          <div className="claim-wallet-details"><span>Paid to</span><CopyAddress address={bound} label="payout wallet"/><small>{bindingLabel({ wallet: bound, method: boundMethod, boundAt: beneficiaryBoundAt })}</small></div>
          <p>SOL is sent only to this payout wallet. Hugging Face ownership and pool fees are checked again before payout.</p>
          {pendingAddress && <p className="claim-next">A pasted address replaces this one from {formatUtcDateTime(pendingAddress.activeAt)} unless it is cancelled. Claims before then still pay the address above.</p>}
          {canClaim ? <form action="/api/hf/claim" method="post" onSubmit={() => setClaiming(true)}><input type="hidden" name="repoId" value={repoId}/><input type="hidden" name="review" value={review}/>
            <button className="button primary" type="submit" disabled={claiming || busy}>{claiming ? 'Processing claim…' : `Claim ${claimAmount}`}</button></form> :
            <p className="claim-next" role="status">{claimable === '0' ? 'All available fees are claimed. New trades can add more.' : feeStatus === 'PENDING_REVIEW' ? 'A previous payout needs settlement review before another claim.' : feeStatus !== 'MATCH' ? 'Current fees could not be verified. Refresh to check again.' : !payoutReady ? 'Payouts are paused while the network-cost wallet is replenished. Your fees remain in the pool.' : 'Refreshing your claim review…'}</p>}
          <button className="claim-text-button" type="button" disabled={claiming} onClick={() => router.refresh()}>Refresh available fees</button>
        </div>}
      </div>
    </div>
    <p className="claim-disclaimer"><Info size={18}/>Fees settle in SOL. USD values are estimates. A payout receipt appears only after settlement is confirmed.</p>
    {stage && !busy && <p className="transaction-status" role="status">{stage}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div></>
}
