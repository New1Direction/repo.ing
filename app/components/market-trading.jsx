'use client'
import { watchMarketEvents } from '../lib/market-events.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { marketCurveUrl } from '../lib/market-chart-urls.mjs'
import { useEffect, useRef, useState } from 'react'
import { PriceChart } from './price-chart'
import { TradePanel } from './trade-panel'
import { GraduationProgress } from './graduation-progress'

// `aside` (server-rendered, e.g. the tip card) sits under the trade panel: right column on desktop, right after it on mobile.
// `below` (server-rendered, e.g. holder notes) sits under recent trades on desktop and after the side column on mobile.
export function MarketTrading({ market, available, usdPerSol, aside = null, below = null }) {
  useEffect(() => watchMarketEvents(market.mint), [market.mint])
  const [solPrice, setSolPrice] = useState(usdPerSol)
  const [curve, setCurve] = useState(null), [error, setError] = useState(false)
  const curveEnded = useRef(null)
  const [now,setNow]=useState(Date.now())
  const verifiedCurve=curve&&Date.parse(curve.validUntil)>now?curve:null
  useEffect(() => {
    const update = () => setNow(Date.now())
    update()
    const expires = Date.parse(curve?.validUntil)
    const timer = Number.isFinite(expires) ? setTimeout(update, Math.max(0, expires - Date.now()) + 1) : null
    document.addEventListener('visibilitychange', update)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', update) }
  }, [curve])
  useEffect(() => {
    let active = true, running = false, queuedFresh = false
    const controller = new AbortController()
    // fresh: prompted by a live hint or the viewer's own trade, so the API skips any shared edge copy. A hint that lands
    // while a read is running gets one more fresh read after it.
    async function refresh(fresh = false) {
      if (running) { queuedFresh ||= fresh === true; return }
      running = true
      try {
        const response = await fetch(marketCurveUrl(market.mint, { fresh: fresh === true }), { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
        if (!response.ok) throw Error()
        const result = await response.json()
        if (active) { if (result.status !== 'active') curveEnded.current = market.mint; setCurve(result); setError(false) }
      } catch { if (active) {setError(true);setCurve(null)} } finally {
        running = false
        if (active && queuedFresh) { queuedFresh = false; void refresh(true) }
      }
    }
    // Trades and ~30 s graduation observations arrive over SSE; polling is only the fallback.
    const stopPolling = visiblePolling(refresh, 60000)
    const onTrade = event => { if (event.detail?.mint === market.mint) void refresh(true) }
    window.addEventListener('repoing:trade-confirmed', onTrade)
    window.addEventListener('repoing:market-updated', onTrade)
    return () => { active = false; controller.abort(); stopPolling(); window.removeEventListener('repoing:trade-confirmed', onTrade); window.removeEventListener('repoing:market-updated', onTrade) }
  }, [market.mint])
  return <><GraduationProgress curve={verifiedCurve} error={error||Boolean(curve&&!verifiedCurve)}/>
    <div className="market-grid"><PriceChart key={`chart:${market.mint}`} mint={market.mint} symbol={market.symbol} curveStatus={verifiedCurve?.status} onSolUsd={setSolPrice}/><div className="market-side"><TradePanel key={`trade:${market.mint}`} market={market} available={available} usdPerSol={solPrice} curve={verifiedCurve || (curveEnded.current === market.mint ? {status:'migrating'} : null)}/>{aside}</div>{below}</div></>
}
