'use client'
import { useEffect, useRef } from 'react'
import { sendMarketEvent } from '../lib/market-funnel.mjs'

export function MarketFunnel({ page }) {
  const seen = useRef(new Set())
  useEffect(() => {
    const record = event => {
      if (seen.current.has(event)) return
      seen.current.add(event)
      sendMarketEvent(event, page)
    }
    record('view')
    const click = event => {
      const target = event.target.closest?.('[data-market-event]')
      if (target) record(target.dataset.marketEvent)
      // Existing trade submit control: intent only, never a claim that a trade succeeded.
      if (page === 'token' && event.target.closest?.('.trade-submit:not(:disabled)')) record('trade_intent')
    }
    document.addEventListener('click', click)
    return () => document.removeEventListener('click', click)
  }, [page])
  return null
}
