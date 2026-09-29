'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Menu, X } from 'lucide-react'

// Phone-only disclosure for the header links that don't fit beside the Launch CTA (hidden ≥701px in CSS).
export function MobileNav({ links, active = '' }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  const toggle = useRef(null)

  useEffect(() => {
    if (!open) return
    const closeOutside = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    const closeEscape = event => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus() } }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [open])

  return <div ref={root} className="mobile-nav">
    <button ref={toggle} type="button" className="mobile-nav-toggle" aria-expanded={open} aria-controls="mobile-nav-panel" onClick={() => setOpen(value => !value)}>
      {open ? <X size={18} aria-hidden="true"/> : <Menu size={18} aria-hidden="true"/>}<span>Menu</span>
    </button>
    <ul id="mobile-nav-panel" className={`mobile-nav-panel${open ? ' open' : ''}`}>
      {links.map(link => <li key={link.key}><Link href={link.href} className={active === link.key ? 'active' : undefined} aria-current={active === link.key ? 'page' : undefined}
        onClick={() => { setOpen(false); toggle.current?.focus() }}>{link.label}</Link></li>)}
    </ul>
  </div>
}
