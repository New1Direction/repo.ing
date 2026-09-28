'use client'
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { marketPrefetch } from '../lib/market-prefetch.mjs'

export function MarketLink({ mint, children, ...props }) {
  const timer = useRef(null)
  const cancel = () => clearTimeout(timer.current)
  useEffect(() => cancel, [])
  function warm(delay = 0) {
    cancel()
    const connection = navigator.connection
    if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return
    timer.current = setTimeout(() => void marketPrefetch.warm(mint), delay)
  }
  return <Link {...props} href={`/token/${mint}`} onPointerEnter={() => warm(100)} onPointerLeave={cancel} onFocus={() => warm()} onBlur={cancel} onTouchStart={() => warm()}>{children}</Link>
}
