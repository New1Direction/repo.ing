'use client'
import { useEffect, useState } from 'react'
import { useWallet } from './wallet'
import { loadReferralStatus, peekReferralStatus, readShareReferralChoice, shareReferral, subscribeReferralStatus,
  writeShareReferralChoice } from '../lib/referral-status.mjs'
import '../share-referral.css'

const CHOICE_EVENT = 'repoing:share-referral'
function storage() { try { return window.localStorage } catch { return null } }

// What a share control may add as ?ref: the connected wallet, only once its referral payouts are set up and only while
// the sharer keeps it on (remembered per browser). The payout status is read only while `active` (a menu, card or
// result is showing), through the shared per-wallet cache.
export function useShareReferral(active = true) {
  const { wallet } = useWallet() ?? {}
  const [status, setStatus] = useState(null)
  const [include, setInclude] = useState(true)
  useEffect(() => {
    const sync = () => setInclude(readShareReferralChoice(storage()))
    sync()
    window.addEventListener(CHOICE_EVENT, sync)
    return () => window.removeEventListener(CHOICE_EVENT, sync)
  }, [])
  useEffect(() => {
    setStatus(wallet ? peekReferralStatus(wallet) : null)
    if (!wallet || !active) return
    let live = true
    loadReferralStatus(wallet).then(value => { if (live) setStatus(value) })
    const stop = subscribeReferralStatus(wallet, value => { if (live) setStatus(value) })
    return () => { live = false; stop() }
  }, [wallet, active])
  function choose(next) {
    writeShareReferralChoice(storage(), next)
    window.dispatchEvent(new Event(CHOICE_EVENT))
  }
  return { wallet, status, include, choose, ref: shareReferral({ wallet, status, include }), available: Boolean(wallet && status?.enabled) }
}

// The visible one-line disclosure beside every share control that can carry a referral, with the switch to share
// without it. Nothing is shown when no referral could be included.
export function ShareReferralNote({ referral, className = '' }) {
  if (!referral.available) return null
  return <small className={`share-referral-note ${className}`.trim()} role="status">{referral.include
    ? <>Includes your referral link — it contains your wallet address. <button type="button" onClick={() => referral.choose(false)}>Share without it</button></>
    : <>Your referral link is left out of these shares. <button type="button" onClick={() => referral.choose(true)}>Include it</button></>}</small>
}
