'use client'
import { useEffect } from 'react'

// Analytics streams after the page shell. Retry its fragment once the actual
// receipt section mounts, when Next's initial navigation could not find it.
export function PayoutAnchor() {
  useEffect(() => {
    let frame
    function reveal() {
      if (window.location.hash !== '#builder-payouts') return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const section = document.getElementById('builder-payouts')
        section?.focus({ preventScroll: true })
        section?.scrollIntoView({ block: 'start', behavior: 'instant' })
      })
    }
    reveal()
    window.addEventListener('hashchange', reveal)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('hashchange', reveal) }
  }, [])
  return null
}
