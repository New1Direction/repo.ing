'use client'
import { useEffect } from 'react'

// The fine print on /how-it-works is folded into <details>. A link to one of them (/how-it-works#builder-collections from
// a claim page, #discovery from the launch list) opens it and scrolls to it, on load and on later hash changes.
export function OpenHashDetails() {
  useEffect(() => {
    function open() {
      const id = decodeURIComponent(window.location.hash.slice(1))
      const target = id ? document.getElementById(id) : null
      if (!(target instanceof HTMLDetailsElement)) return
      target.open = true
      target.scrollIntoView({ block: 'start' })
    }
    open()
    window.addEventListener('hashchange', open)
    return () => window.removeEventListener('hashchange', open)
  }, [])
  return null
}
