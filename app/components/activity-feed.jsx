'use client'

import { useEffect, useState } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { formatUnits, formatSolDisplay } from '../lib/format.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { ContentSkeleton } from './loading-skeleton'

const tokenAmount = raw => BigInt(raw) > 0n && BigInt(raw) < 10_000n ? '<0.01' : formatUnits(raw, 6, 2)

function eventText(event, symbol) {
  if (event.type === 'buy') return { label: 'Buy', detail: `${formatSolDisplay(event.inputBaseUnits)} SOL → ${tokenAmount(event.outputBaseUnits)} ${symbol}` }
  if (event.type === 'sell') return { label: 'Sell', detail: `${tokenAmount(event.inputBaseUnits)} ${symbol} → ${formatSolDisplay(event.outputBaseUnits)} SOL` }
  if (event.type === 'fee') return { label: 'Creator fee', detail: `${formatSolDisplay(event.amountBaseUnits)} SOL earned` }
  return { label: 'Claim paid', detail: `${formatSolDisplay(event.amountBaseUnits)} SOL sent to the payout wallet` }
}

export function ActivityFeed({ mint, symbol }) {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    async function refresh() {
      setLoading(true)
      try {
        const response = await fetch(`/api/market/${encodeURIComponent(mint)}/activity`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
        if (!response.ok) throw new Error('Activity unavailable')
        const result = await response.json()
        if (active) { setEvents(result.events); setError(false) }
      } catch { if (active) setError(true) } finally { if (active) setLoading(false) }
    }
    const stop = visiblePolling(refresh, 30_000)
    return () => { active = false; controller.abort(); stop() }
  }, [mint, refreshKey])
  return <section className="activity-card" aria-label="Repository market activity"><div className="activity-heading"><div><h2>Activity</h2><p>Finalized trades, creator fees, and settled payouts from this market.</p></div><button type="button" className="button outline" disabled={loading} onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={15} className={loading ? 'is-spinning' : ''}/>{loading ? 'Updating…' : 'Refresh'}</button></div>
    {error && <p className="activity-message" role="alert">Activity is temporarily unavailable. You can retry or return later.</p>}
    {!error && events === null && <ContentSkeleton label="Loading finalized activity" rows={4}/>}
    {!error && events?.length === 0 && <p className="activity-message">No finalized activity yet. Trades and fee payouts appear here once indexed.</p>}
    {events?.length > 0 && <div className="activity-list">{events.map((event, index) => {
      const copy = eventText(event, symbol)
      return <div className="activity-row" key={`${event.type}-${event.signature}-${event.eventIndex ?? index}`}><span className={`activity-type ${event.type}`}>{copy.label}</span><span className="activity-detail">{copy.detail}</span><time dateTime={event.occurredAt} title={new Date(event.occurredAt).toLocaleString()}>{new Date(event.occurredAt).toLocaleString()}</time><a href={`https://explorer.solana.com/tx/${event.signature}`} target="_blank" rel="noopener noreferrer" aria-label={`View ${copy.label.toLowerCase()} transaction on Solana Explorer`}>Explorer<ArrowUpRight size={14}/></a></div>
    })}</div>}
  </section>
}
