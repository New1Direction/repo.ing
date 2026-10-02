'use client'
import { useEffect } from 'react'
import { captureReferral } from '../lib/referral.mjs'

// Any page opened from a ?ref=<wallet> link (the /referrals link points at the home page) remembers that referrer in
// this browser for 30 days, last touch wins. Trades send it as a hint; the server decides whether it pays.
export function ReferralCapture() {
  useEffect(() => { try { captureReferral(window.location.search, window.localStorage) } catch { /* Storage is optional. */ } }, [])
  return null
}
