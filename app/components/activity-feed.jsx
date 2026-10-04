'use client'

import { useEffect, useState } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { formatCents, formatTokenAmount, formatUnits, formatSolDisplay } from '../lib/format.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { stockAmountLabel, stockDisplayUnits } from '../lib/stock-display.mjs'
import { ContentSkeleton } from './loading-skeleton'
import { XHandleLink } from './x-handle-link'

const tokenAmount = raw => BigInt(raw) > 0n && BigInt(raw) < 10_000n ? '<0.01' : formatUnits(raw, 6, 2)

// A stock pair's rows (app/lib/stock-market-activity.mjs): trades in its stock, each curve fee's split, launcher payouts, all
// shown as wallets show the stock with the units the response carries ('—' without them).
function stockEventText(event, symbol, units) {
  const stock = raw => stockAmountLabel(raw, units)
  if (event.type === 'buy') return { label: 'Buy', detail: `${stock(event.inputBaseUnits)} → ${tokenAmount(event.outputBaseUnits)} ${symbol}` }
  if (event.type === 'sell') return { label: 'Sell', detail: `${tokenAmount(event.inputBaseUnits)} ${symbol} → ${stock(event.outputBaseUnits)}` }
  if (event.type === 'stock-fee') return { label: 'Trading fee', detail: `${stock(event.launcherBaseUnits)} to the launcher · ${stock(event.accumulatorBaseUnits)} to the ${units?.symbol ?? 'stock'} accumulator` }
  // Styled as the payout it is (the SOL feed's "Claim paid").
  if (event.type === 'launcher-payout') return { label: 'Launcher paid', kind: 'claim', detail: `${stock(event.amountBaseUnits)} sent to the launcher wallet` }
  return eventText(event, symbol)
}

function eventText(event, symbol) {
  if (event.type === 'buy') return { label: 'Buy', detail: `${formatSolDisplay(event.inputBaseUnits)} SOL → ${tokenAmount(event.outputBaseUnits)} ${symbol}` }
  if (event.type === 'sell') return { label: 'Sell', detail: `${tokenAmount(event.inputBaseUnits)} ${symbol} → ${formatSolDisplay(event.outputBaseUnits)} SOL` }
  if (event.type === 'fee') return { label: 'Creator fee', detail: `${formatSolDisplay(event.amountBaseUnits)} SOL earned` }
  if (event.type === 'parts-pledge') return { label: 'Parts pledge', detail: `${formatTokenAmount(event.amountBaseUnits, event.decimals)} ${event.symbol} (${formatCents(event.usdCents)}) pledged to the parts fund` }
  if (event.type === 'parts-update') return { label: 'Build update', detail: event.body }
  return { label: 'Claim paid', detail: `${formatSolDisplay(event.amountBaseUnits)} SOL sent to the payout wallet` }
}

// quote: a stock pair (marketQuoteView); its rows come with the stock's units. Absent for SOL markets.
export function ActivityFeed({ mint, symbol, quote = null }) {
  const [events, setEvents] = useState(null), [units, setUnits] = useState(null)
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
        if (active) { setEvents(result.events); setUnits(quote && result.quote?.assetId === quote.assetId ? stockDisplayUnits(result.quote) : null); setError(false) }
      } catch { if (active) setError(true) } finally { if (active) setLoading(false) }
    }
    const stop = visiblePolling(refresh, 30_000)
    return () => { active = false; controller.abort(); stop() }
  }, [mint, refreshKey, quote])
  return <section className="activity-card" aria-label="Repository market activity"><div className="activity-heading"><div><h2>Activity</h2><p>{`${quote ? `Finalized trades, fee splits and launcher payouts from this market, in ${quote.symbol ?? 'its stock'} as wallets show it.` : 'Finalized trades, creator fees, and settled payouts from this market.'} Traders who linked X show as their account.`}</p></div><button type="button" className="button outline" disabled={loading} onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={15} className={loading ? 'is-spinning' : ''}/>{loading ? 'Updating…' : 'Refresh'}</button></div>
    {error && <p className="activity-message" role="alert">Activity is temporarily unavailable. You can retry or return later.</p>}
    {!error && events === null && <ContentSkeleton label="Loading finalized activity" rows={4}/>}
    {!error && events?.length === 0 && <p className="activity-message">No finalized activity yet. Trades and fee payouts appear here once indexed.</p>}
    {events?.length > 0 && <div className="activity-list">{events.map((event, index) => {
      const copy = quote ? stockEventText(event, symbol, units) : eventText(event, symbol)
      return <div className="activity-row" key={`${event.type}-${event.signature ?? event.ref}-${event.eventIndex ?? index}`}><span className={`activity-type ${copy.kind ?? event.type}`}>{copy.label}</span><span className="activity-detail">{event.x && <XHandleLink link={event.x} avatar className="activity-x"/>}{copy.detail}</span><time dateTime={event.occurredAt} title={new Date(event.occurredAt).toLocaleString()}>{new Date(event.occurredAt).toLocaleString()}</time>
        {event.signature ? <a href={`https://explorer.solana.com/tx/${event.signature}`} target="_blank" rel="noopener noreferrer" aria-label={`View ${copy.label.toLowerCase()} transaction on Solana Explorer`}>Explorer<ArrowUpRight size={14}/></a>
          : <a href={`/token/${encodeURIComponent(mint)}#parts-update-${event.ref}`} aria-label="Open this build update on the market page">View<ArrowUpRight size={14}/></a>}</div>
    })}</div>}
  </section>
}
