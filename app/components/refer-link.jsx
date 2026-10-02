'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Wallet } from 'lucide-react'
import { useWallet } from './wallet'
import { ShareReferralNote } from './share-referral'
import { loadReferralStatus, peekReferralStatus, setReferralStatus, subscribeReferralStatus } from '../lib/referral-status.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import '../refer-link.css'

async function post(body) {
  const response = await fetch('/api/referral', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
  const result = await response.json()
  if (!response.ok) throw Error(result.error || 'Referral payout setup failed')
  return result
}

// Payout status (WSOL ATA + balance) and its one-time setup; shared by token pages, /referrals and /wallet through the
// per-wallet status cache, so completing setup here updates every share control on the page.
export function useReferralPayouts(wallet, provider) {
  const [status, setStatus] = useState(null)
  const [setup, setSetup] = useState('')
  useEffect(() => {
    if (!wallet) return
    let live = true
    setStatus(peekReferralStatus(wallet)); setSetup('')
    loadReferralStatus(wallet).then(value => { if (live) setStatus(value) })
    const stop = subscribeReferralStatus(wallet, value => { if (live) setStatus(value) })
    return () => { live = false; stop() }
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
      setReferralStatus(wallet, { ...(peekReferralStatus(wallet) || status || { earningsLamports: '0', setupLamports: '0' }), enabled: true })
      setSetup('')
    } catch (error) { setSetup(error?.message || 'Setup failed. Try again.') }
  }
  return { status, setup, enable }
}

// Share menu footer: whether these links carry the wallet's referral (and the switch to share without it), or what is
// still needed before they can. /referrals has the rest.
export function ReferLink({ referral }) {
  const { wallet, provider } = useWallet() ?? {}
  const { status, setup, enable } = useReferralPayouts(wallet, provider)
  const more = <Link href="/referrals">Referrals →</Link>
  if (!wallet) return <div className="refer-link"><small>Connect your wallet and the links you share can earn you 4% of the trading fee on trades they bring. {more}</small></div>
  if (!status) return <div className="refer-link"><small role="status">{status === false ? 'Referral status is unavailable right now, so these links are shared without it.' : 'Checking your referral setup…'} {more}</small></div>
  if (!status.enabled) return <div className="refer-link">
    <div className="refer-link-actions"><button className="button outline" type="button" onClick={enable} disabled={setup === 'busy'}><Wallet size={15}/>{setup === 'busy' ? 'Enabling…' : 'Enable payouts'}</button></div>
    <small role="status">{setup && setup !== 'busy' ? setup : `Enable referral payouts (≈${(Number(status.setupLamports) / 1e9).toFixed(4)} SOL once, refundable) and your shared links can earn 4% of the trading fee on trades they bring.`} {more}</small>
  </div>
  return <div className="refer-link">
    <ShareReferralNote referral={referral}/>
    <small className="refer-link-earned"><Check size={12}/> Payouts enabled · {formatSolDisplay(status.earningsLamports)} SOL earned so far · {more}</small>
  </div>
}
