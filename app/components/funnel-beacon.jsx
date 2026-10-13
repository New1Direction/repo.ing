'use client'
import { useEffect } from 'react'
import { FUNNEL_ENDPOINT, funnelSource } from '../lib/claim-funnel.mjs'

// One claim funnel page view per mount (app/lib/claim-funnel.mjs): the event, the ?src= it was opened with and, on a claim
// page, the public repository id. Nothing else leaves the page. Reporting never affects it.
export function FunnelBeacon({ event, repoId = null }) {
  useEffect(() => {
    let source = null
    try { source = funnelSource(new URLSearchParams(window.location.search).get('src')) } catch {}
    const body = JSON.stringify({ event, source, repoId: repoId === null ? null : String(repoId) })
    try {
      if (!navigator.sendBeacon?.(FUNNEL_ENDPOINT, body)) void fetch(FUNNEL_ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {})
    } catch { /* Reporting must never affect the page. */ }
  }, [event, repoId])
  return null
}
