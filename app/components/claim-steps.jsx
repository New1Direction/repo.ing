'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Info } from 'lucide-react'
import { CopyAddress } from './copy-address'
import { ReadmeBadge } from './readme-badge'
import { useWallet } from './wallet'
import { formatUnits } from '../lib/format.mjs'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { MarketShareCard } from './market-share-card'
import { SharePayout, ShareRow } from './payout-share'
import { LoadingSignal } from './loading-signal'
import { BuilderReinvest } from './builder-reinvest'
import { ClaimChecklist, WalletExplainer } from './claim-checklist'
import { claimPageStep } from '../lib/claim-checklist.mjs'
import { PasteAddressForm, PayoutDestination, pasteSavedMessage } from './payout-address'
import { bindingLabel, formatUtcDateTime } from '../../src/payout-address-policy.mjs'

export function ClaimSteps({ summary, reinvestEnabled = false, reinvestAfterClaim = false, graduated = false, repoId, mint, repoName, appAccess, appSettingsUrl, verifiedUser, beneficiaryWallet, beneficiaryMethod = 'signature', beneficiaryBoundAt = null, pendingAddress = null, claimable, usdEstimate, feeStatus, payoutReady, settledClaim, justClaimed, errorCode, review }) {
  const router = useRouter()
  const { wallet, connect, changeWallet, provider } = useWallet()
  const [bound, setBound] = useState(beneficiaryWallet)
  const [boundMethod, setBoundMethod] = useState(beneficiaryMethod)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [stage, setStage] = useState('')
  const [confirmChange, setConfirmChange] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [expired, setExpired] = useState(false)
  const [awaitingReview, setAwaitingReview] = useState(false)
  const [error, setError] = useState(errorCode === 'payout-unavailable' ? 'Payouts are paused while the network-cost wallet is replenished. Your fees remain in the pool.' :
    errorCode === 'payout-address-pending' ? 'Your pasted payout address is still in its 48-hour hold. Claims open when it becomes active.' :
    errorCode === 'review-changed' ? 'The amount or payout details changed. Review the updated fees below, then claim again.' :
    errorCode === 'claim-failed' ? 'The payout could not be confirmed. Check the receipt and available balance before trying again.' :
    errorCode === 'verification-failed' ? 'GitHub access could not be verified. Verify again to continue.' :
    errorCode === 'app-access-required' ? 'Add this repository to repo.ing’s read-only GitHub App access, then return here.' :
    errorCode ? 'This step could not finish. Refresh and try again.' : '')
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState('')
  const [reinvestChosen, setReinvestChosen] = useState(reinvestAfterClaim)
  const githubReady = Boolean(verifiedUser && !expired && errorCode !== 'verification-failed')
  const walletMatches = Boolean(wallet && bound && wallet === bound)
  const walletDiffers = Boolean(wallet && bound && wallet !== bound)
  // A pasted address past its hold has no wallet to connect; a signature-bound one still asks for its wallet, as before.
  const pastedActive = Boolean(bound && boundMethod === 'pasted')
  const destinationReady = walletMatches || pastedActive
  const appReady = appAccess === 'installed'
  const appMissing = appAccess === 'missing'
  const currentStep = claimPageStep({ githubReady, appReady, walletMatches, pastedActive })
  const canClaim = Boolean(currentStep === 3 && claimable && claimable !== '0' && feeStatus === 'MATCH' && payoutReady && review && !awaitingReview)
  const claimAmount = claimable === null ? '—' : `${formatUnits(claimable)} SOL`
  const open = step => currentStep === step || expanded === step
  const short = address => `${address.slice(0, 6)}…${address.slice(-4)}`

  useEffect(() => { setBound(beneficiaryWallet); setBoundMethod(beneficiaryMethod); setAwaitingReview(false); setStage('') }, [beneficiaryWallet, beneficiaryMethod, review])
  useEffect(() => {
    setExpired(false)
    if (!verifiedUser) return
    const timer = setTimeout(() => setExpired(true), Math.max(0, verifiedUser.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [verifiedUser?.expiresAt])
  useEffect(() => {
    if (!appMissing) return
    let leftPage = false
    const markAway = () => { leftPage = true }
    const recheck = () => { if (leftPage && document.visibilityState === 'visible') { leftPage = false; router.refresh() } }
    window.addEventListener('blur', markAway); window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => { window.removeEventListener('blur', markAway); window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', recheck) }
  }, [appMissing, router])

  async function connectWallet(change = false) {
    setError(''); setConfirmChange(false)
    try { await (change ? changeWallet() : connect()) } catch (cause) { setError(cause.message || 'Wallet connection failed') }
  }
  async function bind() {
    setBusy(true); setError('')
    try {
      if (!githubReady) throw new Error('Verify GitHub first')
      const address = wallet || await connect()
      setStage('Checking access and preparing your wallet message…')
      const challengeResponse = await fetch('/api/bind', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', githubRepoId: repoId, wallet: address }) })
      const challenge = await challengeResponse.json()
      if (!challengeResponse.ok) throw new Error(challenge.error)
      setStage('Approve the message in your wallet. This does not spend SOL.')
      const signature = walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(challenge.message)))
      const signatureBase64 = btoa(String.fromCharCode(...signature))
      setStage('Verifying and saving your payout wallet…')
      const response = await fetch('/api/bind', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'bind', githubRepoId: repoId, wallet: address, nonce: challenge.nonce, signature: signatureBase64 }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setAwaitingReview(true); setBound(result.wallet); setBoundMethod('signature'); setConfirmChange(false); setPasteOpen(false); setExpanded(null)
      setStage('Payout wallet set. Refreshing your claim review…'); router.refresh()
    } catch (cause) { setError(cause.message || 'Could not set payout wallet'); setStage('') }
    finally { setBusy(false) }
  }
  function pasteSaved(result) {
    setPasteOpen(false); setError(''); setStage(pasteSavedMessage(result)); router.refresh()
  }
  // Cancelled, or its hold just ended: the server activates a due address before rendering.
  function destinationChanged(reason) {
    setPasteOpen(false)
    if (reason === 'cancelled') setStage('Pasted address cancelled.')
    router.refresh()
  }
  function startNavigation(action, event) {
    if (pendingAction) { event.preventDefault(); return }
    if (action === 'verify' && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return
    setError(''); setPendingAction(action)
  }
  function stepHeading(step, label, done, summary) {
    return <div className="claim-step-heading"><div><h2>{label}</h2>{!open(step) && <p>{summary}</p>}</div>
      {done && currentStep !== step && <button type="button" className="claim-text-button" aria-expanded={expanded === step} aria-controls={`claim-step-${step}`} onClick={() => setExpanded(expanded === step ? null : step)}>{expanded === step ? 'Done' : 'Review'}</button>}</div>
  }

  return <><ClaimChecklist current={currentStep}/>{summary}<div className="claim-steps">
    {(pendingAction || busy) && <div className="claim-progress" role="status" aria-live="polite"><LoadingSignal/><span><strong>{pendingAction === 'claim' ? 'Processing your claim…' : pendingAction === 'verify' ? 'Opening GitHub…' : stage}</strong><small>{pendingAction === 'claim' ? 'Checking current admin access and settling the payout on Solana. Keep this page open.' : pendingAction === 'verify' ? 'You’ll return here after GitHub verification.' : 'Wait for confirmation here.'}</small></span></div>}
    {settledClaim && <div className="claim-receipt" role="status"><Check size={24} aria-hidden="true"/><div>
      <h2>{justClaimed ? 'Claim complete' : 'Latest payout'}</h2><p>{formatUnits(settledClaim.amount)} SOL paid to your verified payout wallet.</p>
      <CopyAddress address={settledClaim.wallet} label="payout wallet"/>
      <a href={`https://explorer.solana.com/tx/${settledClaim.signature}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>
      <ShareRow>{justClaimed && <SharePayout amount={settledClaim.amount} fullName={repoName} mint={mint} className="button primary"/>}<MarketShareCard mint={mint} signature={settledClaim.signature}/></ShareRow>
      {justClaimed && !reinvestChosen && <div className="claim-badge-next"><p>Show your repository’s earnings in its README.</p><ReadmeBadge repoId={repoId} mint={mint}/></div>}
      {reinvestEnabled && graduated && !reinvestChosen && <button className="button outline" type="button" onClick={() => setReinvestChosen(true)}>Reinvest this payout</button>}
    </div></div>}
    {(reinvestEnabled || reinvestAfterClaim) && reinvestChosen && githubReady && settledClaim && settledClaim.wallet === bound && <BuilderReinvest key={`${repoId}:${settledClaim.signature}`} repoId={repoId} claim={settledClaim} onClose={() => setReinvestChosen(false)}/>}
    <div className={`claim-step ${currentStep === 1 ? 'current' : ''}`}>
      <div className={`step-number ${githubReady && appReady ? 'done' : ''}`}>{githubReady && appReady ? <Check size={18}/> : 1}</div>
      <div className="step-content">{stepHeading(1, 'Verify GitHub', githubReady && appReady, `Verified as ${verifiedUser?.githubLogin || 'repository admin'}`)}
        <div id="claim-step-1" hidden={!open(1)}>
          <p>Only a current repository admin can claim. repo.ing requests read-only metadata access and cannot change your code.</p>
          {appMissing ? <div className="claim-app-access"><p>Allow repo.ing to read <strong>{repoName}</strong> in GitHub’s Repository access settings, then return here. This page checks again automatically.</p><a className="button primary" href={appSettingsUrl} target="_blank" rel="noopener noreferrer">Set up read-only access ↗</a><button className="claim-text-button" type="button" onClick={() => router.refresh()}>Check again</button></div> :
            !appReady ? <><p>GitHub access is temporarily unavailable.</p><button className="button primary" type="button" onClick={() => router.refresh()}>Retry access check</button></> :
              githubReady ? <p className="positive"><Check size={17}/>Verified as {verifiedUser.githubLogin}</p> :
                <a className={`button primary ${pendingAction ? 'disabled-link' : ''}`} aria-disabled={Boolean(pendingAction)} onClick={event => startNavigation('verify', event)} href={`/api/github/start?repo=${repoId}&mode=verify`}>{pendingAction === 'verify' ? 'Opening GitHub…' : 'Verify with GitHub'}</a>}
          {githubReady && <p className="claim-step-hint">Your session lasts up to one hour. Current admin access is checked again before every payout.</p>}
        </div>
      </div>
    </div>
    <div className={`claim-step ${currentStep === 2 ? 'current' : ''}`}>
      <div className={`step-number ${destinationReady ? 'done' : ''}`}>{destinationReady ? <Check size={18}/> : 2}</div>
      <div className="step-content">{stepHeading(2, 'Set payout wallet', destinationReady, walletMatches ? `Wallet set · ${short(bound)}` : pastedActive ? `Pasted address · ${short(bound)}` :
        pendingAddress ? `Pasted address waiting · active from ${formatUtcDateTime(pendingAddress.activeAt)}` : 'Connect a wallet after verifying GitHub.')}
        <div id="claim-step-2" hidden={!open(2)}><p>Choose the Solana wallet that receives your SOL. You sign a message to prove it’s yours; it does not spend SOL or grant access to your funds. No wallet extension? Paste your wallet’s address instead; a pasted address starts receiving payouts after a 48-hour hold.</p>
          {!bound && !pendingAddress && <WalletExplainer/>}
          <PayoutDestination repoId={repoId} active={bound ? { wallet: bound, method: boundMethod, boundAt: beneficiaryBoundAt } : null} pending={pendingAddress}
            canManage={githubReady} onChanged={destinationChanged}/>
          {pastedActive && !wallet ? <button className="claim-text-button claim-sign-instead" type="button" onClick={() => connectWallet()}>Connect a wallet to sign instead</button> :
            !wallet ? <button className="button primary" type="button" onClick={() => connectWallet()}>Connect wallet</button> :
            !bound ? <button className="button primary" type="button" disabled={!githubReady || busy} onClick={bind}>{busy ? 'Setting wallet…' : 'Use this wallet for payouts'}</button> :
              <button className={`button ${walletDiffers && !confirmChange ? 'primary' : 'outline'}`} type="button" onClick={() => connectWallet(true)}>Switch connected wallet</button>}
          {!bound && wallet && <div className="claim-wallet-details"><span>Connected wallet</span><CopyAddress address={wallet} label="connected wallet"/></div>}
          {walletDiffers && <div className="claim-wallet-warning"><p>The connected wallet differs from the payout address. Switch wallets or explicitly replace the payout address.</p>
            {!confirmChange ? <button className="claim-text-button" type="button" disabled={!githubReady} onClick={() => setConfirmChange(true)}>Change payout address instead</button> : <><p>Replace it with <strong>{wallet.slice(0, 6)}…{wallet.slice(-4)}</strong>? This requires a fresh admin check and wallet signature.</p><button className="button primary" type="button" disabled={!githubReady || busy} onClick={bind}>Confirm payout wallet change</button><button className="claim-text-button" type="button" onClick={() => setConfirmChange(false)}>Cancel</button></>}
          </div>}
          {githubReady && (pasteOpen ? <PasteAddressForm repoIds={[repoId]} replacing={Boolean(bound)} onSaved={pasteSaved} onClose={() => setPasteOpen(false)}/> :
            <p className="claim-paste-toggle"><button className="claim-text-button" type="button" onClick={() => { setError(''); setPasteOpen(true) }}>
              {bound || pendingAddress ? 'Paste a different payout address' : 'No Solana wallet extension? Paste a payout address instead'}</button></p>)}
        </div>
      </div>
    </div>
    <div className={`claim-step last ${currentStep === 3 ? 'current' : ''}`}>
      <div className="step-number">3</div><div className="step-content">{stepHeading(3, 'Review and claim', false, 'Review your fees and payout address before claiming.')}
        {currentStep === 3 && <div className="claim-review"><strong className="claim-review-amount">{claimAmount}</strong>{usdEstimate && <span className="muted">≈ {usdEstimate}</span>}
          <div className="claim-wallet-details"><span>Paid to</span><CopyAddress address={bound} label="payout wallet"/><small>{bindingLabel({ wallet: bound, method: boundMethod, boundAt: beneficiaryBoundAt })}</small></div>
          <p>SOL is sent only to this payout wallet. GitHub admin access and pool fees are checked again before payout.{graduated && ' Graduated pool payouts include all SOL fees accrued before confirmation.'}</p>
          {pendingAddress && <p className="claim-next">A pasted address replaces this one from {formatUtcDateTime(pendingAddress.activeAt)} unless an admin cancels it. Claims before then still pay the address above.</p>}
          {canClaim ? <form action="/api/claim" method="post" onSubmit={event => startNavigation('claim', event)}><input type="hidden" name="repoId" value={repoId}/><input type="hidden" name="review" value={review}/>
            {reinvestEnabled && <p>Claim pays your wallet. Reinvest claims first, then lets you choose an amount and approve a separate liquidity transaction.</p>}
            <div className="reinvest-actions"><button className="button primary" type="submit" disabled={Boolean(pendingAction) || busy}>{pendingAction === 'claim' ? 'Processing claim…' : reinvestEnabled ? 'Claim' : `Claim ${claimAmount}`}</button>
            {reinvestEnabled && <button className="button outline" type="submit" name="next" value="reinvest" disabled={!graduated || Boolean(pendingAction) || busy}>Reinvest</button>}</div>
            {reinvestEnabled && !graduated && <p className="muted">Reinvest is available after graduation.</p>}</form> :
            <p className="claim-next" role="status">{claimable === '0' ? 'All available fees are claimed. New trades can add more.' : feeStatus === 'PENDING_REVIEW' ? 'A previous payout needs settlement review before another claim.' : feeStatus !== 'MATCH' ? 'Current fees could not be verified. Refresh to check again.' : !payoutReady ? 'Payouts are paused while the network-cost wallet is replenished. Your fees remain in the pool.' : 'Refreshing your claim review…'}</p>}
          <button className="claim-text-button" type="button" disabled={Boolean(pendingAction)} onClick={() => router.refresh()}>Refresh available fees</button>
        </div>}
      </div>
    </div>
    <p className="claim-disclaimer"><Info size={18}/>Fees settle in SOL. USD values are estimates. A payout receipt appears only after settlement is confirmed.</p>
    {stage && !busy && <p className="transaction-status" role="status">{stage}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div></>
}
