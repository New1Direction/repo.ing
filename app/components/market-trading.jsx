'use client'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { useEffect, useState } from 'react'
import { PriceChart } from './price-chart'
import { TradePanel } from './trade-panel'
import { GraduationProgress } from './graduation-progress'

export function MarketTrading({ market, available, usdPerSol }) {
  const [solPrice, setSolPrice] = useState(usdPerSol)
  const [curve, setCurve] = useState(null), [error, setError] = useState(false)
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
        if (active) { setCurve(result); setError(false) }
      } catch { if (active) {setError(true);setCurve(null)} } finally { running = false }
    }
    const stopPolling = visiblePolling(refresh, 15000)
    const onTrade = event => { if (event.detail?.mint === market.mint) void refresh() }
    window.addEventListener('repoing:trade-confirmed', onTrade)
    return () => { active = false; controller.abort(); stopPolling(); window.removeEventListener('repoing:trade-confirmed', onTrade) }
  }, [market.mint])
  return <><GraduationProgress curve={verifiedCurve} error={error||Boolean(curve&&!verifiedCurve)}/>
    <div className="market-grid"><PriceChart key={market.mint} mint={market.mint} symbol={market.symbol} curveStatus={verifiedCurve?.status} onSolUsd={setSolPrice}/><TradePanel key={market.mint} market={market} available={available} usdPerSol={solPrice} curve={verifiedCurve}/></div></>
}
