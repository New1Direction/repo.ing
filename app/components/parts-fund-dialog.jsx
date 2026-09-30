'use client'

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

// Modal shell shared by the parts-fund dialogs (same look and keyboard behavior as the tip dialog): focus moves in,
// Tab stays inside, Escape closes unless `busy`, the page behind does not scroll.
export function PartsDialog({ eyebrow, title, busy = false, onClose, children, wide = false }) {
  const dialog = useRef(null), closing = useRef(onClose), working = useRef(busy)
  closing.current = onClose; working.current = busy
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.querySelector('input, textarea, button:not([data-close])')?.focus()
    const onKey = event => {
      if (event.key === 'Escape' && !working.current) { event.preventDefault(); closing.current() }
      if (event.key !== 'Tab' || !dialog.current) return
      const items = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea, select, a[href]')]
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', onKey) }
  }, [])
  return <div className="wallet-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={dialog} className={`wallet-dialog parts-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="parts-dialog-title">
      <div className="wallet-dialog-heading"><div><span>{eyebrow}</span><h2 id="parts-dialog-title">{title}</h2></div>
        <button type="button" data-close aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={21}/></button></div>
      {children}
    </div>
  </div>
}

export async function postJson(url, body, fallback) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || fallback)
  return result
}

export { formatCents as centsLabel } from '../lib/format.mjs'
