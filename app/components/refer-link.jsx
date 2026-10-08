'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Wallet } from 'lucide-react'
import { useWallet } from './wallet'
import { ShareReferralNote } from './share-referral'
import { loadReferralStatus, peekReferralStatus, setReferralStatus, subscribeReferralStatus } from '../lib/referral-status.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
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
    if (status?.free) return enableFree()
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
  // Free setup: the wallet signs a plain-text message (no transaction, no SOL); repo.ing creates the account and pays.
  async function enableFree() {
    try {
      const prepared = await post({ action: 'free-prepare', wallet })
      const signature = walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(prepared.message)))
      const { default: bs58 } = await import('bs58')
      const result = await post({ action: 'free-submit', wallet, message: prepared.message, seal: prepared.seal, signature: bs58.encode(signature) })
      if (result.status !== 'settled') { setSetup('Your payout account is on its way. Check again in a minute.'); return }
      setReferralStatus(wallet, { ...(peekReferralStatus(wallet) || status || { earningsLamports: '0', setupLamports: '0' }), enabled: true, free: false })
      setSetup('')
    } catch (error) {
      // The next click uses the paid setup: free places can run out, and some wallets cannot sign messages.
      setReferralStatus(wallet, { ...(peekReferralStatus(wallet) || status || { enabled: false, earningsLamports: '0', setupLamports: '0' }), free: false })
      setSetup(`${error?.message || 'The free setup failed.'} You can still enable payouts yourself.`)
    }
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
    <small role="status">{setup && setup !== 'busy' ? setup : status.free
      ? 'Enable referral payouts (free: repo.ing pays the setup) and your shared links can earn 4% of the trading fee on trades they bring.'
      : `Enable referral payouts (≈${(Number(status.setupLamports) / 1e9).toFixed(4)} SOL once, refundable) and your shared links can earn 4% of the trading fee on trades they bring.`} {more}</small>
  </div>
  return <div className="refer-link">
    <ShareReferralNote referral={referral}/>
    <small className="refer-link-earned"><Check size={12}/> Payouts enabled · {formatSolDisplay(status.earningsLamports)} SOL earned so far · {more}</small>
  </div>
}
