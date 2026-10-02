'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Wallet } from 'lucide-react'
import { useWallet } from './wallet'
import { referralStatus } from '../lib/referral.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import '../refer-link.css'

async function post(body) {
  const response = await fetch('/api/referral', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
  const result = await response.json()
  if (!response.ok) throw Error(result.error || 'Referral payout setup failed')
  return result
}

// Payout status (WSOL ATA + balance) and its one-time setup; shared by token pages and /wallet.
export function useReferralPayouts(wallet, provider) {
  const [status, setStatus] = useState(null)
  const [setup, setSetup] = useState('')
  useEffect(() => {
    if (!wallet) return
    const controller = new AbortController()
    setStatus(null); setSetup('')
    fetch(`/api/referral?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : null).then(result => setStatus(referralStatus(result) ?? false))
      .catch(() => { if (!controller.signal.aborted) setStatus(false) })
    return () => controller.abort()
  }, [wallet])
  async function enable() {
    if (setup === 'busy' || !wallet) return
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
  return { status, setup, enable }
}

// Share menu footer. A connected wallet's shared links already carry its ?ref; payouts land in its own wrapped-SOL ATA
// (4% of the trading fee, from Meteora's protocol share), which needs a one-time setup. /referrals has the rest.
export function ReferLink() {
  const { wallet, provider } = useWallet() ?? {}
  const { status, setup, enable } = useReferralPayouts(wallet, provider)
  const more = <Link href="/referrals">Referrals →</Link>
  if (!wallet) return <div className="refer-link"><small>Connect your wallet and the links you share earn you 4% of the trading fee on trades they bring. {more}</small></div>
  const enabled = status?.enabled
  return <div className="refer-link">
    {status && !enabled && <div className="refer-link-actions"><button className="button outline" type="button" onClick={enable} disabled={setup === 'busy'}><Wallet size={15}/>{setup === 'busy' ? 'Enabling…' : 'Enable payouts'}</button></div>}
    <small role="status">{setup && setup !== 'busy' ? setup : `These links include your referral: earn 4% of the trading fee on trades they bring, paid in SOL.${status && !enabled ? ` Enable payouts first (≈${(Number(status.setupLamports) / 1e9).toFixed(4)} SOL once, refundable).` : ''}`} {more}</small>
    {enabled && <small className="refer-link-earned"><Check size={12}/> Payouts enabled · {formatSolDisplay(status.earningsLamports)} SOL earned so far</small>}
  </div>
}
