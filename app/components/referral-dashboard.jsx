'use client'
import { useState } from 'react'
import { Check, Copy, Wallet } from 'lucide-react'
import { useWallet } from './wallet'
import { useReferralPayouts } from './refer-link'
import { siteReferralLink } from '../lib/referral.mjs'
import { formatSolDisplay, formatUnits } from '../lib/format.mjs'

// /referrals: the connected wallet's link, its one-time payout setup and what it has earned (the wrapped-SOL balance the
// referral fees accrue in, the same reading as /wallet).
function Payouts({ status, setup, enable }) {
  const error = setup && setup !== 'busy' ? <small className="referral-payout-error" role="alert">{setup}</small> : null
  if (status === null) return <p className="referral-payout-state" role="status">Checking your payout setup…</p>
  if (status === false) return <p className="referral-payout-state" role="status">Payout status is temporarily unavailable. Refresh to try again.</p>
  if (!status.enabled) return <div className="referral-payout-setup">
    <p><strong>One step left: enable payouts.</strong> Referral fees are paid into your wallet’s wrapped-SOL account. Until it exists,
      trades from your link still go through, but no fee can reach you.</p>
    <button className="button primary" type="button" onClick={enable} disabled={setup === 'busy'}><Wallet size={16} aria-hidden="true"/>
      {setup === 'busy' ? 'Enabling…' : `Enable payouts (≈${formatUnits(status.setupLamports, 9, 5)} SOL once, refundable)`}</button>
    {error}
  </div>
  return <div className="referral-payout-on">
    <p className="referral-payout-state"><Check size={15} aria-hidden="true"/> Payouts enabled</p>
    <div className="referral-earned"><span>Referral earnings</span><strong>{formatSolDisplay(status.earningsLamports)} SOL</strong>
      <small>Held as wrapped SOL in your wallet. Your next trade on repo.ing unwraps it to SOL.</small></div>
    {error}
  </div>
}

export function ReferralDashboard() {
  const { wallet, connect, provider, restoring } = useWallet() ?? {}
  const { status, setup, enable } = useReferralPayouts(wallet, provider)
  const [copied, setCopied] = useState('')
  if (!wallet) return <section className="inner-card referral-dashboard is-empty" aria-labelledby="referral-link-title">
    <div><h2 id="referral-link-title">Your referral link</h2>
      <p>Connect the wallet that should receive referral fees. Your link is built from its address: there is nothing else to sign up for.</p></div>
    <button className="button primary" type="button" disabled={restoring} onClick={() => connect?.().catch(() => {})}>
      <Wallet size={16} aria-hidden="true"/>{restoring ? 'Connecting…' : 'Connect wallet'}</button>
  </section>
  const link = siteReferralLink(window.location.origin, wallet)
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied('Link copied') }
    catch { setCopied('Copy failed. Select the link and copy it.') }
  }
  return <section className="inner-card referral-dashboard" aria-labelledby="referral-link-title">
    <div className="referral-link-panel">
      <h2 id="referral-link-title">Your referral link</h2>
      <div className="referral-link-row">
        <input aria-label="Your referral link" readOnly value={link} onFocus={event => event.target.select()} spellCheck={false}/>
        <button className="button outline" type="button" onClick={copy}>{copied === 'Link copied' ? <Check size={15} aria-hidden="true"/> : <Copy size={15} aria-hidden="true"/>}Copy</button>
      </div>
      <small role="status">{copied || 'Once payouts are set up, the market links, X posts and Blink links you share carry it too. Each share menu says so and lets you leave it out.'}</small>
    </div>
    <div className="referral-payout-panel"><h2>Payouts</h2><Payouts status={status} setup={setup} enable={enable}/></div>
  </section>
}
