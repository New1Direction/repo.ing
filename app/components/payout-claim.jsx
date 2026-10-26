'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useWallet } from './wallet'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import { formatUtcDateTime } from '../../src/payout-address-policy.mjs'

// What the server's PayoutRefused codes mean to a builder (src/builder-payouts.mjs).
const REFUSALS = Object.freeze({
  'payouts-off': 'Builder payouts are paused. Your fees keep accruing and wait for you.',
  'payouts-unavailable': 'Payouts are not available right now. Your fees keep accruing and wait for you.',
  'claims-not-open': 'Claims are not open for this repository yet.',
  'github-admin-required': 'GitHub admin access needs checking. Verify GitHub again, then claim.',
  'invalid-signature': 'The payout wallet did not sign this claim. Connect the payout wallet shown above.',
  'invalid-challenge': 'The claim expired. Start the claim again.',
  'challenge-used': 'That claim was already used. Start a new claim.',
  'challenge-mismatch': 'The claim expired. Start the claim again.',
  'nothing-owed': 'Nothing is owed right now. New trades add more.',
  'daily-cap': 'Today\'s payout limit is reached. Try again tomorrow.',
  'payout-wallet-low': 'Payouts are paused while the payout wallet is refilled.',
  'payout-wallet-over-cap': 'Payouts are paused for a safety check.',
  'below-new-wallet-minimum': 'The amount is too small to open a new wallet. Let more fees accrue first.',
  'claim-pending': 'A previous claim is still settling. Refresh in a minute.',
  'payout-failed': 'The payout failed on chain, so nothing was paid. Try again.',
  'preflight-failed': 'The payout could not be prepared. Try again shortly.',
})
const message = code => REFUSALS[code] ?? 'The claim could not finish. Refresh and try again.'

async function post(body) {
  const response = await fetch('/api/claim/payout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({ error: 'claim-failed' }))
  if (!response.ok) throw Object.assign(new Error(message(result.error)), { code: result.error })
  return result
}

/** The claim rules every builder sees (owner rules, 2026-10-26). */
export function ClaimRules({ claimWindow }) {
  return <ul className="claim-rules">
    <li>A claim needs current GitHub admin access to this repository and a signature from your payout wallet. Each signature works once.</li>
    <li>Changing the payout wallet takes effect 24 hours later, and the maintainer is emailed about it.</li>
    <li>{claimWindow
      ? `Claims opened ${formatUtcDateTime(claimWindow.openedAt)}. Anything still unclaimed on ${formatUtcDateTime(claimWindow.unclaimedAfter)} goes to the repo.ing multisig vault and is used to grow repo.ing.`
      : 'Once claims open for this repository, any balance still unclaimed 12 months later goes to the repo.ing multisig vault and is used to grow repo.ing.'}</li>
  </ul>
}

/** Step 3: the payout wallet signs a one-use claim; the server pays what the repository is owed, within the caps. */
export function PayoutClaim({ repoId, payoutWallet, owedLamports, claimWindow, paused }) {
  const router = useRouter()
  const { wallet, connect, provider } = useWallet()
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [paid, setPaid] = useState(null)

  async function claim() {
    setBusy(true); setError(''); setPaid(null)
    try {
      const address = wallet || await connect()
      if (address !== payoutWallet) throw new Error('Connect the payout wallet shown above to sign this claim.')
      setStage('Preparing your claim message…')
      const challenge = await post({ action: 'challenge', githubRepoId: repoId })
      setStage('Approve the message in your wallet. It does not spend SOL.')
      const signature = walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(challenge.message)))
      setStage('Checking GitHub and sending your payout…')
      const result = await post({ action: 'claim', githubRepoId: repoId, nonce: challenge.nonce, signature: btoa(String.fromCharCode(...signature)) })
      setPaid(result); setStage(''); router.refresh()
    } catch (cause) { setError(cause.message || 'The claim could not finish.'); setStage('') }
    finally { setBusy(false) }
  }

  const owed = BigInt(owedLamports ?? '0')
  return <div className="claim-review">
    <strong className="claim-review-amount">{formatSolDisplay(owed.toString())} SOL owed</strong>
    {paid ? <p className="positive" role="status">Paid {formatSolDisplay(paid.lamports)} SOL. <a href={`https://solscan.io/tx/${paid.signature}`} target="_blank" rel="noreferrer">View the payout</a></p>
      : paused ? <p className="claim-next" role="status">{REFUSALS['payouts-off']}</p>
      : !claimWindow ? <p className="claim-next" role="status">{REFUSALS['claims-not-open']} Your fees keep accruing and wait for you.</p>
      : owed <= 0n ? <p className="claim-next" role="status">{REFUSALS['nothing-owed']}</p>
      : <button className="button primary" type="button" disabled={busy} onClick={claim}>{busy ? 'Claiming…' : 'Sign and claim'}</button>}
    {stage && <p className="claim-step-hint" role="status">{stage}</p>}
    {error && <p className="claim-error" role="alert">{error}</p>}
    <ClaimRules claimWindow={claimWindow}/>
  </div>
}
