'use client'
import { useEffect, useRef } from 'react'

export function MenuDetails({ className = '', summary, label, children, onToggle }) {
  const ref = useRef(null)
  useEffect(() => {
    const dismiss = event => { if (ref.current?.open && !ref.current.contains(event.target)) ref.current.open = false }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss) }
  }, [])
  return <details onToggle={onToggle} ref={ref} className={`menu-details ${className}`} name="repo-menus" onKeyDown={event => {
    if (event.key === 'Escape' && ref.current.open) { ref.current.open = false; ref.current.querySelector('summary').focus(); event.stopPropagation() }
  }}><summary className="button outline" aria-label={label}>{summary}</summary>{children}</details>
}
