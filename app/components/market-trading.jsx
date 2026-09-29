'use client'
import { watchMarketEvents } from '../lib/market-events.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { useEffect, useRef, useState } from 'react'
import { PriceChart } from './price-chart'
import { TradePanel } from './trade-panel'
import { GraduationProgress } from './graduation-progress'

export function MarketTrading({ market, available, usdPerSol }) {
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
    let active = true, running = false
    const controller = new AbortController()
    async function refresh() {
      if (running) return
      running = true
      try {
        const response = await fetch(`/api/market/${market.mint}/curve`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
        if (!response.ok) throw Error()
        const result = await response.json()
        if (active) { if (result.status !== 'active') curveEnded.current = market.mint; setCurve(result); setError(false) }
      } catch { if (active) {setError(true);setCurve(null)} } finally { running = false }
    }
    // Trades and ~30 s graduation observations arrive over SSE; polling is only the fallback.
    const stopPolling = visiblePolling(refresh, 60000)
    const onTrade = event => { if (event.detail?.mint === market.mint) void refresh() }
    window.addEventListener('repoing:trade-confirmed', onTrade)
    window.addEventListener('repoing:market-updated', onTrade)
    return () => { active = false; controller.abort(); stopPolling(); window.removeEventListener('repoing:trade-confirmed', onTrade); window.removeEventListener('repoing:market-updated', onTrade) }
  }, [market.mint])
  return <><GraduationProgress curve={verifiedCurve} error={error||Boolean(curve&&!verifiedCurve)}/>
    <div className="market-grid"><PriceChart key={`chart:${market.mint}`} mint={market.mint} symbol={market.symbol} curveStatus={verifiedCurve?.status} onSolUsd={setSolPrice}/><TradePanel key={`trade:${market.mint}`} market={market} available={available} usdPerSol={solPrice} curve={verifiedCurve || (curveEnded.current === market.mint ? {status:'migrating'} : null)}/></div></>
}
