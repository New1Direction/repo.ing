'use client'
import { useEffect, useState } from 'react'
import { Check, Gift, Wallet } from 'lucide-react'
import { useWallet } from './wallet'
import { referralLink } from '../lib/referral.mjs'
import { formatSolDisplay, formatUnits } from '../lib/format.mjs'

async function post(body) {
  const response = await fetch('/api/referral', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
  const result = await response.json()
  if (!response.ok) throw Error(result.error || 'Referral payout setup failed')
  return result
}

// Payouts land in the referrer's own wrapped-SOL ATA (4% of the trading fee, from Meteora's protocol share).
export function ReferLink({ mint }) {
  const { wallet, provider } = useWallet() ?? {}
  const [copied, setCopied] = useState('')
  const [status, setStatus] = useState(null)
  const [setup, setSetup] = useState('')

  useEffect(() => {
    if (!wallet) return
    const controller = new AbortController()
    setStatus(null); setSetup('')
    fetch(`/api/referral?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : null).then(result => {
        if (result && typeof result.enabled === 'boolean' && /^\d+$/.test(result.earningsLamports) && /^\d+$/.test(result.setupLamports)) setStatus(result)
      }).catch(() => {})
    return () => controller.abort()
  }, [wallet])

  if (!wallet) return null
  async function copy() {
    try { await navigator.clipboard.writeText(referralLink(window.location.origin, mint, wallet)); setCopied('Referral link copied') }
    catch { setCopied('Copy failed. Try again.') }
  }
  async function enable() {
    if (setup === 'busy') return
    setSetup('busy')
    try {
      const [{ PublicKey, Transaction }, { assertWsolSetupTransaction }] = await Promise.all([import('@solana/web3.js'), import('../../src/wsol-account.mjs')])
      const owner = new PublicKey(wallet)
      const prepared = await post({ action: 'setup', wallet })
      const tx = Transaction.from(Uint8Array.from(atob(prepared.transaction), c => c.charCodeAt(0)))
      // Never sign anything but the one instruction creating this wallet's own WSOL account.
      assertWsolSetupTransaction(tx, owner)
      const signed = await provider().signTransaction(tx)
      assertWsolSetupTransaction(signed, owner)
      await post({ action: 'submit', wallet, lastValidBlockHeight: prepared.lastValidBlockHeight,
        transaction: btoa(String.fromCharCode(...signed.serialize())) })
      setStatus(current => ({ ...current, enabled: true }))
      setSetup('')
    } catch (error) { setSetup(error?.message || 'Setup failed. Try again.') }
  }
  const enabled = status?.enabled
  return <div className="refer-link">
    <div className="refer-link-actions">
      <button className="button outline" type="button" onClick={copy}>{copied === 'Referral link copied' ? <Check size={15}/> : <Gift size={15}/>}Copy referral link</button>
      {status && !enabled && <button className="button outline" type="button" onClick={enable} disabled={setup === 'busy'}><Wallet size={15}/>{setup === 'busy' ? 'Enabling…' : `Enable referral payouts (~${formatUnits(status.setupLamports, 9, 5)} SOL one-time, refundable)`}</button>}
    </div>
    <small role="status">{copied || (setup && setup !== 'busy' ? setup : 'Earn 4% of the trading fee on trades from your link, paid in SOL.')}</small>
    {enabled && <small className="refer-link-earned"><Check size={12}/> Referral payouts enabled · {formatSolDisplay(status.earningsLamports)} SOL earned so far, held as wrapped SOL in your wallet. Trading on repo.ing unwraps your referral earnings to SOL.</small>}
  </div>
}
