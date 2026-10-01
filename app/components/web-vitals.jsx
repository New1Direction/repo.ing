'use client'
import { useEffect } from 'react'
import { useReportWebVitals } from 'next/web-vitals'
import { VITALS_ENDPOINT, VITAL_METRICS, sampleVitals, vitalsRoute } from '../lib/web-vitals.mjs'

// Real-user Core Web Vitals for ~25% of page loads (one decision per document). Metrics queue until the page is hidden,
// then leave in one beacon: the route pattern of the landing page (e.g. /token/[mint]) and the values, nothing else.
// CLS and INP keep accumulating across client-side navigations, so they are attributed to the landing route too.
const browser = typeof window !== 'undefined'
const sampled = browser && sampleVitals()
const route = browser ? vitalsRoute(window.location.pathname) : null
const queued = new Map()

function report(metric) {
  if (sampled && VITAL_METRICS.includes(metric.name) && Number.isFinite(metric.value)) queued.set(metric.name, metric.value)
}

function flush() {
  if (!queued.size) return
  const body = JSON.stringify({ route, metrics: [...queued].map(([name, value]) => ({ name, value })) })
  queued.clear()
  try {
    if (!navigator.sendBeacon?.(VITALS_ENDPOINT, body)) void fetch(VITALS_ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {})
  } catch { /* Reporting must never affect the page. */ }
}

export function WebVitals() {
  useReportWebVitals(report)
  // Registered after the web-vitals listeners above, so the final CLS/INP/LCP are queued before this flushes.
  useEffect(() => {
    if (!sampled) return undefined
    const onHidden = () => { if (document.visibilityState === 'hidden') flush() }
    addEventListener('visibilitychange', onHidden)
    addEventListener('pagehide', flush)
    return () => { removeEventListener('visibilitychange', onHidden); removeEventListener('pagehide', flush) }
  }, [])
  return null
}
