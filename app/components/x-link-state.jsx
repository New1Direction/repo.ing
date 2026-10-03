'use client'
import { useEffect, useState } from 'react'

// The connected wallet's public X link for the header and its menu: read once per wallet per page load, and updated as
// soon as /wallet links or unlinks (xLinkChanged). off: Connect X is disabled (its API answers 404), so the header never
// suggests it. known: this wallet's read has finished, so nothing is suggested before then. A failed read is forgotten
// so the next mount tries again; until then the wallet shows as an address.
export const X_LINK_EVENT = 'repoing:x-link'
const reads = new Map()

export async function readXLink(wallet, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/x/link?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store' })
  if (response.status === 404) return { off: true, link: null }
  if (!response.ok) throw new Error('X link unavailable')
  const { link } = await response.json()
  return { off: false, link: link ?? null }
}

export function xLinkChanged(wallet, link) {
  reads.set(wallet, Promise.resolve({ off: false, link: link ?? null }))
  window.dispatchEvent(new CustomEvent(X_LINK_EVENT, { detail: { wallet, link: link ?? null } }))
}

const EMPTY = { off: false, link: null }
export function useXLink(wallet) {
  const [state, setState] = useState({ wallet: null, ...EMPTY })
  useEffect(() => {
    if (!wallet) return
    let active = true
    if (!reads.has(wallet)) reads.set(wallet, readXLink(wallet).catch(error => { reads.delete(wallet); throw error }))
    reads.get(wallet).then(result => { if (active) setState({ wallet, ...result }) }, () => {})
    const changed = event => { if (event.detail?.wallet === wallet) setState({ wallet, off: false, link: event.detail.link }) }
    window.addEventListener(X_LINK_EVENT, changed)
    return () => { active = false; window.removeEventListener(X_LINK_EVENT, changed) }
  }, [wallet])
  return state.wallet === wallet ? { ...state, known: true } : { ...EMPTY, known: false }
}
